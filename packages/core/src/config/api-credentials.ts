import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { ModelApiProvider } from '@aidaily/contracts';
import { ModelCallError } from '@aidaily/model-runtime';

/** 从进程环境或私有文件解析 API 密钥引用，供前台和定时任务使用 */
export async function resolveModelApiKey(
  secretsDir: string,
  config: ModelApiProvider,
): Promise<string | undefined> {
  const fromEnv = config.apiKeyEnv ? process.env[config.apiKeyEnv]?.trim() : undefined;
  if (fromEnv) {
    return fromEnv;
  }
  if (!config.apiKeyFile) {
    return undefined;
  }
  const filename = config.apiKeyFile;
  if (path.basename(filename) !== filename || filename === '.' || filename === '..') {
    throw new ModelCallError('模型 API 密钥须引用密钥目录中的文件名', false, 'auth_error');
  }
  const handle = await fs
    .open(
      path.join(secretsDir, filename),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    )
    .catch((err: unknown) => {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return undefined;
      }
      throw new ModelCallError(`无法读取模型 API 密钥文件 ${filename}`, false, 'auth_error');
    });
  if (!handle) {
    return undefined;
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.size > 16 * 1024) {
      throw new ModelCallError(
        `模型 API 密钥文件 ${filename} 须为权限 600 的私有文本文件`,
        false,
        'auth_error',
      );
    }
    return (await handle.readFile('utf8')).trim() || undefined;
  } catch (err) {
    if (err instanceof ModelCallError) {
      throw err;
    }
    throw new ModelCallError(`无法读取模型 API 密钥文件 ${filename}`, false, 'auth_error');
  } finally {
    await handle.close();
  }
}
