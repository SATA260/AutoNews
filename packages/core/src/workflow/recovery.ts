import type { Settings } from '@aidaily/contracts';
import type { CoreContext } from '../context.js';
import { inTransaction } from '../storage/db.js';
import { emitRunEvent } from './events.js';
import {
  DEFAULT_LOCK_STALE_MS,
  isProcessAlive,
  markTakenOverRunInterrupted,
  PIPELINE_LOCK_NAME,
} from './lock.js';

/** 自动巡检并修复遗留故障后的结果汇总 */
export interface RecoverySummary {
  interruptedRunIds: string[];
  uncertainPublishRunIds: string[];
  abandonedRunIds: string[];
  releasedExpiredArticlesCount: number;
}

/** 判断一个处于运行中或发布中的任务是否已经失联（进程消失或心跳超过有效窗口） */
function isRunStale(opts: {
  pid: number | null;
  heartbeatAt: string | null;
  startedAt: string | null;
  nowMs: number;
  staleMs: number;
  isProcessAliveFn: (pid: number) => boolean;
}): boolean {
  if (opts.pid === null || !opts.isProcessAliveFn(opts.pid)) {
    return true;
  }
  const refTs = opts.heartbeatAt ?? opts.startedAt;
  if (!refTs) {
    return true;
  }
  const refMs = Date.parse(refTs);
  return Number.isNaN(refMs) || opts.nowMs - refMs > opts.staleMs;
}

/**
 * 核心引擎启动时执行的故障巡检与自动清理：
 * 1) 识别并修复因进程强杀或崩溃遗留的无效运行锁与失联任务（标记为 `interrupted` 或 `publish_uncertain`，完整保留预留文章与检查点）；
 * 2) 清理已超出保留重跑截止期限的失败/中断/取消/拒绝任务，将其标记为 `abandoned` 并释放占用的新闻回候选池。
 */
export function recoverStaleRuns(
  ctx: CoreContext,
  opts?: {
    staleMs?: number;
    isProcessAliveFn?: (pid: number) => boolean;
  },
): RecoverySummary {
  const staleMs = opts?.staleMs ?? DEFAULT_LOCK_STALE_MS;
  const isProcessAliveFn = opts?.isProcessAliveFn ?? isProcessAlive;
  const nowDate = ctx.now();
  const nowMs = nowDate.getTime();
  const nowIso = nowDate.toISOString();

  const interruptedRunIds: string[] = [];
  const uncertainPublishRunIds: string[] = [];
  const abandonedRunIds: string[] = [];
  let releasedExpiredArticlesCount = 0;

  // 1. 巡检所有标为 running / publishing 但进程已死亡或心跳超时的任务
  const activeRuns = ctx.repos.runs.list({ status: ['running', 'publishing'], limit: 200 });
  for (const summary of activeRuns) {
    const detail = ctx.repos.runs.getById(summary.id);
    if (!detail) {
      continue;
    }
    if (
      !isRunStale({
        pid: detail.pid,
        heartbeatAt: detail.heartbeatAt,
        startedAt: detail.startedAt,
        nowMs,
        staleMs,
        isProcessAliveFn,
      })
    ) {
      continue;
    }

    let snapSettings: Settings = ctx.settings;
    try {
      snapSettings = JSON.parse(detail.configSnapshotJson) as Settings;
    } catch {
      // 若配置快照意外损坏则回退全局配置获取保留时长
    }

    const wasPublishing = detail.status === 'publishing';
    markTakenOverRunInterrupted(ctx, snapSettings, detail.id, nowIso);
    ctx.repos.locks.releaseLock(PIPELINE_LOCK_NAME, detail.id);

    if (wasPublishing) {
      uncertainPublishRunIds.push(detail.id);
    } else {
      interruptedRunIds.push(detail.id);
    }
  }

  // 2. 清理无对应活跃任务但仍残留无效锁的情况
  const lock = ctx.repos.locks.get(PIPELINE_LOCK_NAME);
  if (lock?.ownerRun) {
    const lockHeartbeatMs = lock.heartbeatAt ? Date.parse(lock.heartbeatAt) : Number.NaN;
    const lockStale =
      lock.pid === null ||
      !isProcessAliveFn(lock.pid) ||
      Number.isNaN(lockHeartbeatMs) ||
      nowMs - lockHeartbeatMs > staleMs;
    if (lockStale) {
      ctx.repos.locks.releaseLock(PIPELINE_LOCK_NAME, lock.ownerRun);
    }
  }

  // 3. 对超过重试保留截止时间的失联/失败/取消/拒绝任务自动放弃并释放新闻文章
  const expiredRuns = ctx.repos.runs.listExpiredRetryable(nowIso);
  for (const expRun of expiredRuns) {
    inTransaction(ctx.db, () => {
      const released = ctx.repos.articles.releaseByRun(expRun.id);
      releasedExpiredArticlesCount += released;
      ctx.repos.runs.updateStatus(expRun.id, 'abandoned', {
        finishedAt: nowIso,
        pid: null,
      });
      emitRunEvent(ctx, {
        runId: expRun.id,
        level: 'info',
        type: 'run_abandoned',
        message: `已超出重试保留截止时间，系统自动放弃本期并释放 ${released} 篇占用新闻`,
        data: { releasedArticles: released, autoExpired: true },
      });
    });
    abandonedRunIds.push(expRun.id);
  }

  return {
    interruptedRunIds,
    uncertainPublishRunIds,
    abandonedRunIds,
    releasedExpiredArticlesCount,
  };
}
