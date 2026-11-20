import fs from 'node:fs/promises';
import path from 'node:path';
import type { Settings } from '@aidaily/contracts';
import type { CoreContext } from '../context.js';
import { inTransaction } from '../storage/db.js';
import { PIPELINE_LOCK_NAME } from '../workflow/lock.js';

const CLEANABLE_RUN_STATUSES = new Set(['published', 'skipped', 'abandoned']);
const SAFE_DIR_ID_PATTERN = /^[a-zA-Z0-9._-]+$/;
const TMP_RETENTION_MS = 24 * 3600_000;

/** 清理历史任务目录与过期日志时的可选参数 */
export interface CleanupStorageOptions {
  /** 至少保留最近多少期历史任务，默认取全局配置 */
  keepRuns?: number;
  /** 超过多少天的已完结历史任务允许清理，默认取全局配置 */
  maxAgeDays?: number;
  /** 超过多少天的游离日志与调用记录允许清理，默认取全局配置 */
  maxLogAgeDays?: number;
  /** 为 true 时仅预演统计待回收范围，不实际删除任何数据或文件 */
  dryRun?: boolean;
  /** 可选指定配置快照覆盖全局配置中的保留参数 */
  settings?: Settings;
}

/** 执行或预演存储清理后返回的统计汇总 */
export interface CleanupStorageResult {
  dryRun: boolean;
  removedRunIds: string[];
  removedOrphanDirs: string[];
  removedRunEvents: number;
  removedLlmCalls: number;
  removedTmpEntries: number;
  reclaimedBytes: number;
}

/** 递归统计文件或目录占用的磁盘字节数，路径不存在时返回 0 */
async function measurePathBytes(targetPath: string): Promise<number> {
  try {
    const st = await fs.lstat(targetPath);
    if (!st.isDirectory()) {
      return st.size;
    }
    const entries = await fs.readdir(targetPath, { withFileTypes: true });
    let total = 0;
    for (const entry of entries) {
      total += await measurePathBytes(path.join(targetPath, entry.name));
    }
    return total;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return 0;
    }
    throw err;
  }
}

/** 校验正整数清理阈值参数 */
function assertPositiveRetentionParam(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new RangeError(`${label} 必须为正整数，当前传入: ${String(value)}`);
  }
  return value;
}

/**
 * 按保留策略安全清理过期历史任务产物、关联数据库日志与长期残留的临时文件：
 * - 始终保留最近 `keepRuns` 期任务以及所有进行中、待审核、状态不明、处于重试宽限期或仍占用新闻文章的任务；
 * - 对确认可清理的历史任务，在单事务内按外键依赖顺序级联删除数据库记录并清理对应磁盘目录；
 * - 清理超出保留窗口的孤立任务目录、游离事件/模型调用日志及超过 24 小时的临时目录残留。
 */
export async function cleanupStorage(
  ctx: CoreContext,
  opts?: CleanupStorageOptions,
): Promise<CleanupStorageResult> {
  const effectiveRetention = (opts?.settings ?? ctx.settings).retention;
  const keepRuns = assertPositiveRetentionParam(
    opts?.keepRuns ?? effectiveRetention.keepRuns,
    'keepRuns',
  );
  const maxAgeDays = assertPositiveRetentionParam(
    opts?.maxAgeDays ?? effectiveRetention.maxAgeDays,
    'maxAgeDays',
  );
  const maxLogAgeDays = assertPositiveRetentionParam(
    opts?.maxLogAgeDays ?? effectiveRetention.maxLogAgeDays,
    'maxLogAgeDays',
  );
  const dryRun = Boolean(opts?.dryRun);

  const nowMs = ctx.now().getTime();
  const runCutoffIso = new Date(nowMs - maxAgeDays * 86_400_000).toISOString();
  const logCutoffIso = new Date(nowMs - maxLogAgeDays * 86_400_000).toISOString();
  const tmpCutoffMs = nowMs - TMP_RETENTION_MS;

  const lock = ctx.repos.locks.get(PIPELINE_LOCK_NAME);
  const lockedRunId = lock?.ownerRun ?? null;

  const allRuns = ctx.db
    .prepare('SELECT id, status, created_at FROM runs ORDER BY created_at DESC')
    .all() as Array<{ id: string; status: string; created_at: string }>;
  const knownRunIds = new Set(allRuns.map((row) => row.id));

  const candidateRuns: Array<{ id: string; bytes: number }> = [];
  for (let idx = 0; idx < allRuns.length; idx++) {
    const row = allRuns[idx];
    if (!row || idx < keepRuns) {
      continue;
    }
    if (!CLEANABLE_RUN_STATUSES.has(row.status) || row.id === lockedRunId) {
      continue;
    }
    if (row.created_at >= runCutoffIso) {
      continue;
    }
    const reservedRow = ctx.db
      .prepare('SELECT 1 AS found FROM articles WHERE reserved_by_run = ? LIMIT 1')
      .get(row.id) as { found: number } | undefined;
    if (reservedRow?.found) {
      continue;
    }
    const dirBytes = await measurePathBytes(ctx.paths.runDir(row.id));
    candidateRuns.push({ id: row.id, bytes: dirBytes });
  }

  let removedRunEvents = 0;
  let removedLlmCalls = 0;
  let reclaimedBytes = candidateRuns.reduce((sum, entry) => sum + entry.bytes, 0);

  if (dryRun) {
    for (const candidate of candidateRuns) {
      const evCount = ctx.db
        .prepare('SELECT COUNT(*) AS cnt FROM run_events WHERE run_id = ?')
        .get(candidate.id) as { cnt: number };
      const callCount = ctx.db
        .prepare('SELECT COUNT(*) AS cnt FROM llm_calls WHERE run_id = ?')
        .get(candidate.id) as { cnt: number };
      removedRunEvents += evCount.cnt;
      removedLlmCalls += callCount.cnt;
    }
    const orphanEvCount = ctx.db
      .prepare(
        'SELECT COUNT(*) AS cnt FROM run_events WHERE ts < ? AND run_id NOT IN (SELECT id FROM runs)',
      )
      .get(logCutoffIso) as { cnt: number };
    const orphanCallCount = ctx.db
      .prepare(
        'SELECT COUNT(*) AS cnt FROM llm_calls WHERE created_at < ? AND (run_id IS NULL OR run_id NOT IN (SELECT id FROM runs))',
      )
      .get(logCutoffIso) as { cnt: number };
    removedRunEvents += orphanEvCount.cnt;
    removedLlmCalls += orphanCallCount.cnt;
  } else {
    inTransaction(ctx.db, () => {
      for (const candidate of candidateRuns) {
        const resCalls = ctx.db.prepare('DELETE FROM llm_calls WHERE run_id = ?').run(candidate.id);
        const resEvents = ctx.db
          .prepare('DELETE FROM run_events WHERE run_id = ?')
          .run(candidate.id);
        removedLlmCalls += Number(resCalls.changes);
        removedRunEvents += Number(resEvents.changes);

        ctx.db
          .prepare(
            'DELETE FROM item_versions WHERE item_id IN (SELECT id FROM run_items WHERE run_id = ?)',
          )
          .run(candidate.id);
        ctx.db.prepare('DELETE FROM run_items WHERE run_id = ?').run(candidate.id);
        ctx.db.prepare('DELETE FROM run_stages WHERE run_id = ?').run(candidate.id);
        ctx.db.prepare('DELETE FROM events WHERE run_id = ?').run(candidate.id);
        ctx.db.prepare('DELETE FROM publish_records WHERE run_id = ?').run(candidate.id);
        ctx.db.prepare('DELETE FROM runs WHERE id = ?').run(candidate.id);
      }

      const orphanEvRes = ctx.db
        .prepare('DELETE FROM run_events WHERE ts < ? AND run_id NOT IN (SELECT id FROM runs)')
        .run(logCutoffIso);
      const orphanCallRes = ctx.db
        .prepare(
          'DELETE FROM llm_calls WHERE created_at < ? AND (run_id IS NULL OR run_id NOT IN (SELECT id FROM runs))',
        )
        .run(logCutoffIso);
      removedRunEvents += Number(orphanEvRes.changes);
      removedLlmCalls += Number(orphanCallRes.changes);
    });

    for (const candidate of candidateRuns) {
      await fs.rm(ctx.paths.runDir(candidate.id), { recursive: true, force: true });
    }
  }

  const removedOrphanDirs: string[] = [];
  try {
    const runDirEntries = await fs.readdir(ctx.paths.runsDir, { withFileTypes: true });
    const orphanCutoffMs = nowMs - maxAgeDays * 86_400_000;
    for (const entry of runDirEntries) {
      if (!entry.isDirectory() || !SAFE_DIR_ID_PATTERN.test(entry.name)) {
        continue;
      }
      if (knownRunIds.has(entry.name) || entry.name === lockedRunId) {
        continue;
      }
      const fullDir = path.join(ctx.paths.runsDir, entry.name);
      const st = await fs.lstat(fullDir).catch(() => null);
      if (!st || st.mtimeMs >= orphanCutoffMs) {
        continue;
      }
      const bytes = await measurePathBytes(fullDir);
      removedOrphanDirs.push(entry.name);
      reclaimedBytes += bytes;
      if (!dryRun) {
        await fs.rm(fullDir, { recursive: true, force: true });
      }
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw err;
    }
  }

  let removedTmpEntries = 0;
  try {
    const tmpEntries = await fs.readdir(ctx.paths.tmpDir, { withFileTypes: true });
    for (const entry of tmpEntries) {
      const fullPath = path.join(ctx.paths.tmpDir, entry.name);
      const st = await fs.lstat(fullPath).catch(() => null);
      if (!st || st.mtimeMs >= tmpCutoffMs) {
        continue;
      }
      const bytes = await measurePathBytes(fullPath);
      removedTmpEntries += 1;
      reclaimedBytes += bytes;
      if (!dryRun) {
        await fs.rm(fullPath, { recursive: true, force: true });
      }
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw err;
    }
  }

  return {
    dryRun,
    removedRunIds: candidateRuns.map((c) => c.id),
    removedOrphanDirs,
    removedRunEvents,
    removedLlmCalls,
    removedTmpEntries,
    reclaimedBytes,
  };
}
