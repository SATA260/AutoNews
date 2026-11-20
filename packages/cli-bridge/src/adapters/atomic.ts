import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

/** 通过同目录临时文件写盘再原子重命名，防止外部命令行结构文件出现半截写入 */
export async function writeBridgeFileAtomic(
  filePath: string,
  content: string,
  opts?: { mode?: number },
): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  const tmpPath = path.join(
    dir,
    `.${path.basename(filePath)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`,
  );
  try {
    await fs.writeFile(
      tmpPath,
      content,
      opts?.mode !== undefined ? { encoding: 'utf8', mode: opts.mode } : 'utf8',
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
