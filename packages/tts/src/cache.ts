import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { TtsSettings } from '@aidaily/contracts';

/** 根据合成引擎名称、引擎配置、音频处理参数与单句文本生成唯一的缓存键 */
export function computeTtsCacheKey(
  providerId: string,
  providerConfig: Record<string, unknown>,
  postprocess: Pick<TtsSettings['postprocess'], 'sampleRate' | 'trimSilence'> & {
    denoise?: boolean;
    loudnessLUFS?: number;
    fadeInMs?: number;
    fadeOutMs?: number;
    tailPadMs?: number;
  },
  text: string,
): string {
  const payload = JSON.stringify({
    providerId,
    providerConfig,
    sampleRate: postprocess.sampleRate,
    trimSilence: postprocess.trimSilence,
    denoise: postprocess.denoise,
    loudnessLUFS: postprocess.loudnessLUFS,
    fadeInMs: postprocess.fadeInMs,
    fadeOutMs: postprocess.fadeOutMs,
    tailPadMs: postprocess.tailPadMs,
    text,
  });
  return crypto.createHash('sha1').update(payload, 'utf8').digest('hex');
}

/** 转发原子文件写入函数，保证缓存与语音服务配置均采用临时文件加原子重命名方式 */
export { writeTtsFileAtomic } from './atomic.mjs';

/** 通过先拷贝至同目录临时文件再原子重命名的方式复制文件，防止中途崩溃产生残缺文件 */
async function copyFileAtomic(srcFile: string, destFile: string): Promise<void> {
  await fs.mkdir(path.dirname(destFile), { recursive: true });
  const tmpFile = path.join(
    path.dirname(destFile),
    `.${path.basename(destFile)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`,
  );
  try {
    await fs.copyFile(srcFile, tmpFile);
    await fs.rename(tmpFile, destFile);
  } catch (err) {
    await fs.rm(tmpFile, { force: true }).catch(() => undefined);
    throw err;
  }
}

/** 尝试从本地缓存目录读取已合成过的音频文件并原子写入目标路径 */
export async function tryRestoreFromCache(
  cacheDir: string,
  key: string,
  destFile: string,
): Promise<boolean> {
  const cachedFile = path.join(cacheDir, `${key}.wav`);
  try {
    await fs.access(cachedFile);
    await copyFileAtomic(cachedFile, destFile);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }
    throw err;
  }
}

/** 将标准化后的音频文件以原子写方式存入本地缓存目录，供后续断点续跑复用 */
export async function saveToCache(cacheDir: string, key: string, srcFile: string): Promise<void> {
  const target = path.join(cacheDir, `${key}.wav`);
  await copyFileAtomic(srcFile, target);
}
