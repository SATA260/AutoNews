import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export async function ensureDir(dirPath: string): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true });
}

export async function ensurePrivateDir(dirPath: string): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true, mode: 0o700 });
}

/**
 * Write a file atomically using a temporary file in the same directory followed by rename.
 */
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

export async function writeJsonAtomic(filePath: string, data: unknown): Promise<void> {
  await writeFileAtomic(filePath, `${JSON.stringify(data, null, 2)}\n`);
}

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

/**
 * Move existing invalidated artifacts into `runs/<id>/archive/<archiveName>/` instead of deleting them.
 */
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
