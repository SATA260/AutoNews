import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

/** 确保目录存在，不存在时递归创建 */
export async function ensureDir(dirPath: string): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true });
}

/** 创建仅当前用户可读写访问的私密目录（用于存放平台 Cookie 等凭证） */
export async function ensurePrivateDir(dirPath: string): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true, mode: 0o700 });
}

/** 通过“写同目录临时文件 + 原子重命名”的方式安全写文件，防止程序崩溃留下残缺文件 */
export async function writeFileAtomic(
  filePath: string,
  content: string | Uint8Array,
): Promise<void> {
  const dir = path.dirname(filePath);
  await ensureDir(dir);
  const rand = crypto.randomBytes(4).toString('hex');
  const tmpPath = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${rand}.tmp`);
  try {
    await fs.writeFile(tmpPath, content);
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

/** 将重跑后作废的旧阶段产物移动归档到 `archive/` 子目录，保留历史现场不直接删除 */
export async function archiveRunArtifacts(
  runDir: string,
  archiveName: string,
  relPaths: string[],
): Promise<string[]> {
  const moved: string[] = [];
  const archiveRoot = path.join(runDir, 'archive', archiveName);

  for (const rel of relPaths) {
    const srcPath = path.resolve(runDir, rel);
    if (!srcPath.startsWith(`${path.resolve(runDir)}${path.sep}`)) {
      continue;
    }
    try {
      await fs.access(srcPath);
    } catch {
      continue;
    }
    const destPath = path.join(archiveRoot, rel);
    await ensureDir(path.dirname(destPath));
    await fs.rm(destPath, { recursive: true, force: true });
    await fs.rename(srcPath, destPath);
    moved.push(rel);
  }
  return moved;
}
