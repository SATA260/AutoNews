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

/** 对同一配置文件的写操作串行排队，避免同进程并发读改写互相覆盖 */
async function withFileWriteLock<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
  const key = path.resolve(filePath);
  const prev = fileWriteQueues.get(key) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(fn);
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
    let raw = 'sources: []\n';
    try {
      raw = await fs.readFile(filePath, 'utf8');
    } catch {
      // 若目标文件尚不存在则使用空模板创建
    }
    const doc = parseDocument(raw);
    assertValidYamlDocument(filePath, doc);

    const existingSeq = doc.get('sources', true);
    if (!isSeq(existingSeq)) {
      doc.set('sources', parsed.data.sources);
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

      const nextNodes = parsed.data.sources.map((src) => {
        const existingNode = existingById.get(src.id);
        if (existingNode && isMap(existingNode)) {
          for (const [k, v] of Object.entries(src)) {
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
  });
}
