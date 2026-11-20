import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

/** 生成同目录临时文件路径并通过原子重命名安全写入磁盘 */
export async function writeTtsFileAtomic(destFile, content) {
  await fs.mkdir(path.dirname(destFile), { recursive: true });
  const tmpFile = path.join(
    path.dirname(destFile),
    `.${path.basename(destFile)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`,
  );
  try {
    await fs.writeFile(tmpFile, content);
    await fs.rename(tmpFile, destFile);
  } catch (err) {
    await fs.rm(tmpFile, { force: true }).catch(() => undefined);
    throw err;
  }
}
