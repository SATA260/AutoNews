import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { CoreContext } from '../context.js';

/** 列出曲库中可供选择的音频文件名。 */
export async function listBgmFiles(ctx: CoreContext): Promise<string[]> {
  try {
    return (
      await fs.readdir(path.join(ctx.paths.rootDir, 'assets', 'bgm'), { withFileTypes: true })
    )
      .filter((entry) => entry.isFile() && /\.(mp3|wav|flac|m4a)$/i.test(entry.name))
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

/** 为本期固定一首曲目；没有曲库时保留无背景音乐。 */
export async function lockRunBgm(ctx: CoreContext, runId: string): Promise<string | null> {
  const current = ctx.db.prepare('SELECT bgm_file FROM runs WHERE id = ?').get(runId) as
    | { bgm_file: string | null }
    | undefined;
  if (!current) throw new Error(`未找到任务记录: ${runId}`);
  if (current.bgm_file) return current.bgm_file;
  const files = await listBgmFiles(ctx);
  if (!files.length) return null;
  const previous = ctx.db
    .prepare(
      'SELECT bgm_file FROM runs WHERE id != ? AND bgm_file IS NOT NULL ORDER BY created_at DESC LIMIT 1',
    )
    .get(runId) as { bgm_file: string } | undefined;
  const remaining = files.filter((file) => file !== previous?.bgm_file);
  const pool = remaining.length ? remaining : files;
  const selected = pool[crypto.randomInt(pool.length)];
  if (!selected) return null;
  ctx.db
    .prepare('UPDATE runs SET bgm_file = ? WHERE id = ? AND bgm_file IS NULL')
    .run(selected, runId);
  const locked = ctx.db.prepare('SELECT bgm_file FROM runs WHERE id = ?').get(runId) as {
    bgm_file: string | null;
  };
  return locked.bgm_file;
}
