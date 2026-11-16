import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const SAFE_ARCHIVE_NAME_PATTERN = /^[a-zA-Z0-9._-]+$/;

/** 确保目录存在，不存在时递归创建 */
export async function ensureDir(dirPath: string): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true });
}

/** 创建仅当前用户可读写访问的私密目录，并在目录已存在时收紧权限 */
export async function ensurePrivateDir(dirPath: string): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true, mode: 0o700 });
  await fs.chmod(dirPath, 0o700);
}

/** 通过“写同目录临时文件 + 原子重命名”的方式安全写文件，防止程序崩溃留下残缺文件 */
export async function writeFileAtomic(
  filePath: string,
  content: string | Uint8Array,
  opts?: { mode?: number },
): Promise<void> {
  const dir = path.dirname(filePath);
  await ensureDir(dir);
  const rand = crypto.randomBytes(4).toString('hex');
  const tmpPath = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${rand}.tmp`);
  try {
    await fs.writeFile(
      tmpPath,
      content,
      opts?.mode !== undefined ? { mode: opts.mode } : undefined,
    );
    if (opts?.mode !== undefined) {
      await fs.chmod(tmpPath, opts.mode);
    }
    await fs.rename(tmpPath, filePath);
  } catch (err) {
    await fs.rm(tmpPath, { force: true }).catch(() => undefined);
    throw err;
  }
}

/** 将对象格式化为 JSON 并原子写入磁盘文件 */
export async function writeJsonAtomic(filePath: string, data: unknown): Promise<void> {
  await writeFileAtomic(filePath, `${JSON.stringify(data, null, 2)}\n`);
}

/** 读取并解析 JSON 文件，若文件不存在则返回 null */
export async function readJsonOrNull<T>(filePath: string): Promise<T | null> {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw err;
  }
}

/** 将重跑后作废的旧阶段产物移动归档到 `archive/` 子目录；若中途失败则自动回滚已移动条目 */
export async function archiveRunArtifacts(
  runDir: string,
  archiveName: string,
  relPaths: string[],
): Promise<string[]> {
  if (!SAFE_ARCHIVE_NAME_PATTERN.test(archiveName) || archiveName === '.' || archiveName === '..') {
    throw new Error(`非法的归档名称: ${archiveName}`);
  }
  const baseRunDir = path.resolve(runDir);
  const archiveRoot = path.resolve(baseRunDir, 'archive', archiveName);
  const movedPairs: Array<{ rel: string; srcPath: string; destPath: string }> = [];

  try {
    const realBase = await fs.realpath(baseRunDir).catch(() => baseRunDir);
    for (const rel of relPaths) {
      if (!rel || rel.includes('\0')) {
        throw new Error(`非法的归档产物路径: ${rel}`);
      }
      const normalizedRel = rel.replace(/^\/+/, '');
      const srcPath = path.resolve(baseRunDir, normalizedRel);
      if (!srcPath.startsWith(`${baseRunDir}${path.sep}`)) {
        throw new Error(`禁止归档任务目录之外的路径: ${rel}`);
      }
      try {
        await fs.access(srcPath);
      } catch {
        continue;
      }
      const realSrc = await fs.realpath(srcPath);
      if (!realSrc.startsWith(`${realBase}${path.sep}`)) {
        throw new Error(`禁止归档指向任务目录之外的软链接: ${rel}`);
      }
      const destPath = path.resolve(archiveRoot, normalizedRel);
      if (!destPath.startsWith(`${archiveRoot}${path.sep}`)) {
        throw new Error(`非法的归档目标路径: ${rel}`);
      }
      await ensureDir(path.dirname(destPath));
      await fs.rm(destPath, { recursive: true, force: true });
      await fs.rename(srcPath, destPath);
      movedPairs.push({ rel: normalizedRel, srcPath, destPath });
    }
    return movedPairs.map((pair) => pair.rel);
  } catch (err) {
    // 任一文件归档失败时按逆序将前面已移走的文件恢复原位
    for (let i = movedPairs.length - 1; i >= 0; i--) {
      const pair = movedPairs[i];
      if (!pair) {
        continue;
      }
      await ensureDir(path.dirname(pair.srcPath)).catch(() => undefined);
      await fs.rename(pair.destPath, pair.srcPath).catch(() => undefined);
    }
    throw err;
  }
}

/** 将已移入指定归档子目录的文件按原相对路径恢复回任务目录（用于数据库写入失败时回滚） */
export async function restoreArchivedArtifacts(
  runDir: string,
  archiveName: string,
  relPaths: string[],
): Promise<void> {
  const baseRunDir = path.resolve(runDir);
  const archiveRoot = path.resolve(baseRunDir, 'archive', archiveName);
  for (let i = relPaths.length - 1; i >= 0; i--) {
    const rel = relPaths[i];
    if (!rel) {
      continue;
    }
    const srcPath = path.resolve(baseRunDir, rel);
    const destPath = path.resolve(archiveRoot, rel);
    await ensureDir(path.dirname(srcPath)).catch(() => undefined);
    await fs.rename(destPath, srcPath).catch(() => undefined);
  }
}
