import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  type DeepPartial,
  type Settings,
  SettingsSchema,
  type SourceDef,
  SourcesFileSchema,
} from '@aidaily/contracts';
import { type Document, isMap, isSeq, parseDocument } from 'yaml';
import { writeFileAtomic } from '../storage/files.js';

const fileWriteQueues = new Map<string, Promise<unknown>>();
const FILE_LOCK_STALE_MS = 30_000;
const FILE_LOCK_WAIT_TIMEOUT_MS = 10_000;

/** 检查指定进程号在操作系统中是否仍然存活 */
function isLockProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EPERM') {
      return true;
    }
    return false;
  }
}

/** 异步短暂等待指定毫秒数 */
function delayMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 尝试抢占跨进程独占锁文件并在超时或识别死锁后安全恢复 */
async function acquireCrossProcessFileLock(targetFile: string): Promise<() => Promise<void>> {
  const lockPath = `${targetFile}.lock`;
  const token = `${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  const deadline = Date.now() + FILE_LOCK_WAIT_TIMEOUT_MS;

  while (true) {
    try {
      const handle = await fs.open(lockPath, 'wx', 0o600);
      try {
        await handle.writeFile(
          JSON.stringify({ pid: process.pid, token, createdAt: Date.now() }),
          'utf8',
        );
      } finally {
        await handle.close().catch(() => undefined);
      }
      return async () => {
        try {
          const content = await fs.readFile(lockPath, 'utf8');
          const parsed = JSON.parse(content) as { token?: string };
          if (parsed.token === token) {
            await fs.rm(lockPath, { force: true });
          }
        } catch {
          // 锁文件已被提前清理或内容不可读时忽略
        }
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw err;
      }

      let recoveredStale = false;
      try {
        const [rawLock, st] = await Promise.all([
          fs.readFile(lockPath, 'utf8').catch(() => ''),
          fs.stat(lockPath),
        ]);
        let holderPid: number | undefined;
        try {
          const parsed = JSON.parse(rawLock) as { pid?: unknown };
          if (typeof parsed.pid === 'number') {
            holderPid = parsed.pid;
          }
        } catch {
          // 半截锁文件交给陈旧时间窗口判断
        }
        const ageMs = Date.now() - st.mtimeMs;
        if (
          (holderPid !== undefined && !isLockProcessAlive(holderPid)) ||
          ageMs > FILE_LOCK_STALE_MS
        ) {
          await fs.rm(lockPath, { force: true });
          recoveredStale = true;
        }
      } catch (inspectErr) {
        if ((inspectErr as NodeJS.ErrnoException).code === 'ENOENT') {
          recoveredStale = true;
        }
      }

      if (recoveredStale) {
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(`等待配置文件写锁超时 (${lockPath})`);
      }
      await delayMs(15 + Math.floor(Math.random() * 25));
    }
  }
}

/** 对同一配置文件的写操作在进程内与跨进程间双层串行加锁，防止并发读改写互相覆盖 */
async function withFileWriteLock<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
  const key = path.resolve(filePath);
  const prev = fileWriteQueues.get(key) ?? Promise.resolve();
  const next = prev
    .catch(() => undefined)
    .then(async () => {
      const releaseDiskLock = await acquireCrossProcessFileLock(key);
      try {
        return await fn();
      } finally {
        await releaseDiskLock();
      }
    });
  fileWriteQueues.set(key, next);
  try {
    return await next;
  } finally {
    if (fileWriteQueues.get(key) === next) {
      fileWriteQueues.delete(key);
    }
  }
}

/** 校验 YAML 语法树解析结果，存在语法错误时立即抛出并阻止覆盖损坏文件 */
function assertValidYamlDocument(filePath: string, doc: Document): void {
  if (doc.errors.length > 0) {
    const msg = doc.errors.map((e) => e.message).join('; ');
    throw new Error(`YAML 文件存在语法错误，拒绝修改 (${filePath}): ${msg}`);
  }
}

/** 判断值是否为普通键值对象（非 null 且非数组） */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 递归将局部更新内容写入 YAML 语法树节点，从而完整保留原文件中的注释 */
function applyPatchToDocument(
  doc: Document,
  patch: Record<string, unknown>,
  prefix: string[],
): void {
  for (const [key, val] of Object.entries(patch)) {
    if (val === undefined) {
      continue;
    }
    const pathParts = [...prefix, key];
    const existing = doc.getIn(pathParts, true);
    if (isPlainObject(val) && isMap(existing)) {
      applyPatchToDocument(doc, val, pathParts);
    } else {
      doc.setIn(pathParts, val);
    }
  }
}

/** 串行修改最新的配置文档，保留注释并在校验通过后原子写入 */
export async function editSettingsFile(
  filePath: string,
  edit: (doc: Document) => void | Promise<void>,
  validate?: (settings: Settings) => void,
): Promise<Settings> {
  return withFileWriteLock(filePath, async () => {
    const raw = await fs.readFile(filePath, 'utf8');
    const doc = parseDocument(raw);
    assertValidYamlDocument(filePath, doc);
    await edit(doc);

    const candidate = doc.toJS();
    const parsed = SettingsSchema.safeParse(candidate);
    if (!parsed.success) {
      const details = parsed.error.issues
        .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
        .join('; ');
      throw new Error(`更新配置校验失败 (${filePath}): ${details}`);
    }

    validate?.(parsed.data);
    await writeFileAtomic(filePath, doc.toString());
    return parsed.data;
  });
}

/** 把局部更新写入配置，必要时校验更新后的配置之间是否一致 */
export async function updateSettingsFile(
  filePath: string,
  patch: DeepPartial<Settings>,
  validate?: (settings: Settings) => void,
): Promise<Settings> {
  return editSettingsFile(filePath, (doc) => applyPatchToDocument(doc, patch, []), validate);
}

/** 将校验后的信源清单原位合并写入已解析的 YAML 文档以保留注释与排版 */
async function writeValidatedSourcesDocument(
  filePath: string,
  doc: Document,
  validatedSources: SourceDef[],
): Promise<void> {
  const existingSeq = doc.get('sources', true);
  if (!isSeq(existingSeq)) {
    doc.set('sources', validatedSources);
  } else {
    const existingById = new Map<string, ReturnType<typeof doc.createNode>>();
    for (const item of existingSeq.items) {
      if (isMap(item)) {
        const itemId = item.get('id');
        if (typeof itemId === 'string') {
          existingById.set(itemId, item);
        }
      }
    }

    const nextNodes = validatedSources.map((src) => {
      const existingNode = existingById.get(src.id);
      if (existingNode && isMap(existingNode)) {
        for (const [k, v] of Object.entries(src)) {
          if (v === undefined) {
            continue;
          }
          if (existingNode.get(k) !== v) {
            existingNode.set(k, v);
          }
        }
        return existingNode;
      }
      return doc.createNode(src);
    });
    existingSeq.items = nextNodes;
  }

  await writeFileAtomic(filePath, doc.toString());
}

/** 从磁盘读取当前最新信源配置文件并解析语法树 */
async function readSourcesYamlDocument(filePath: string): Promise<Document> {
  let raw = 'sources: []\n';
  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw err;
    }
  }
  const doc = parseDocument(raw);
  assertValidYamlDocument(filePath, doc);
  return doc;
}

/** 校验并原位合并更新新闻信源清单；在写锁内基于最新磁盘内容修改，避免并发覆盖 */
export async function editSourcesFile(
  filePath: string,
  edit: (current: SourceDef[]) => SourceDef[] | Promise<SourceDef[]>,
): Promise<SourceDef[]> {
  return withFileWriteLock(filePath, async () => {
    const doc = await readSourcesYamlDocument(filePath);
    const currentParsed = SourcesFileSchema.safeParse(doc.toJS());
    if (!currentParsed.success) {
      const details = currentParsed.error.issues
        .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
        .join('; ');
      throw new Error(`读取现存信源配置校验失败 (${filePath}): ${details}`);
    }

    const nextCandidate = await edit(currentParsed.data.sources);
    const nextParsed = SourcesFileSchema.safeParse({ sources: nextCandidate });
    if (!nextParsed.success) {
      const details = nextParsed.error.issues
        .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
        .join('; ');
      throw new Error(`更新信源配置校验失败 (${filePath}): ${details}`);
    }

    await writeValidatedSourcesDocument(filePath, doc, nextParsed.data.sources);
    return nextParsed.data.sources;
  });
}

/** 校验并原子更新新闻信源清单配置文件，按信源 ID 原位合并以保留注释与格式 */
export async function updateSourcesFile(filePath: string, sources: SourceDef[]): Promise<void> {
  const parsed = SourcesFileSchema.safeParse({ sources });
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
      .join('; ');
    throw new Error(`更新信源配置校验失败 (${filePath}): ${details}`);
  }

  await withFileWriteLock(filePath, async () => {
    const doc = await readSourcesYamlDocument(filePath);
    await writeValidatedSourcesDocument(filePath, doc, parsed.data.sources);
  });
}
