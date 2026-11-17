import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { TtsSettings } from '@aidaily/contracts';

/** 根据合成引擎名称、引擎配置、音频处理参数与单句文本生成唯一的缓存键 */
export function computeTtsCacheKey(
  providerId: string,
  providerConfig: Record<string, unknown>,
  postprocess: Pick<TtsSettings['postprocess'], 'sampleRate' | 'trimSilence'> & {
    loudnessLUFS?: number;
    fadeInMs?: number;
    fadeOutMs?: number;
  },
  text: string,
): string {
  const payload = JSON.stringify({
    providerId,
    providerConfig,
    sampleRate: postprocess.sampleRate,
    trimSilence: postprocess.trimSilence,
    loudnessLUFS: postprocess.loudnessLUFS,
    fadeInMs: postprocess.fadeInMs,
    fadeOutMs: postprocess.fadeOutMs,
    text,
  });
  return crypto.createHash('sha1').update(payload, 'utf8').digest('hex');
}

/** 尝试从本地缓存目录读取已合成过的音频文件并复制到目标路径 */
export async function tryRestoreFromCache(
  cacheDir: string,
  key: string,
  destFile: string,
): Promise<boolean> {
  const cachedFile = path.join(cacheDir, `${key}.wav`);
  try {
    await fs.access(cachedFile);
    await fs.mkdir(path.dirname(destFile), { recursive: true });
    await fs.copyFile(cachedFile, destFile);
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
  await fs.mkdir(cacheDir, { recursive: true });
  const target = path.join(cacheDir, `${key}.wav`);
  const tmpFile = path.join(
    cacheDir,
    `.${key}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`,
  );
  try {
    await fs.copyFile(srcFile, tmpFile);
    await fs.rename(tmpFile, target);
  } catch (err) {
    await fs.rm(tmpFile, { force: true }).catch(() => undefined);
    throw err;
  }
}
