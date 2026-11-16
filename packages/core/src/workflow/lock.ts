import { PIPELINE_STAGES, type Settings } from '@aidaily/contracts';
import type { CoreContext } from '../context.js';
import { inTransaction } from '../storage/db.js';
import type { LockRow } from '../storage/repos/runs-repo.js';
import { emitRunEvent } from './events.js';

export const PIPELINE_LOCK_NAME = 'pipeline';
export const DEFAULT_LOCK_STALE_MS = 60_000;

/** 全局运行锁正被另一活跃任务占用时抛出的异常 */
export class LockBusyError extends Error {
  readonly holder: LockRow;

  constructor(holder: LockRow) {
    super(
      `已有任务正在执行（任务 ID: ${holder.ownerRun ?? '未知'}, 进程号: ${String(holder.pid ?? '未知')}），请等待完成后再试`,
    );
    this.name = 'LockBusyError';
    this.holder = holder;
  }
}

/** 检查操作系统进程号是否仍然存活 */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // 若无权限向其他用户进程发信号，说明该进程实际上仍在运行
    if ((err as NodeJS.ErrnoException).code === 'EPERM') {
      return true;
    }
    return false;
  }
}

/** 从旧任务快照解析配置，失败时回退到全局默认配置（避免新任务的保持窗口覆盖旧任务） */
function resolvePreviousRunSettings(rawSnapshot: string, fallback: Settings): Settings {
  try {
    return JSON.parse(rawSnapshot) as Settings;
  } catch {
    return fallback;
  }
}

/** 对被死进程或失联进程遗留的旧任务收尾：通过状态与心跳对比原子标为中断或发布状态不明 */
export function markTakenOverRunInterrupted(
  ctx: CoreContext,
  fallbackSettings: Settings,
  previousRunId: string,
  nowIso: string,
  expectedHeartbeatAt?: string | null,
): void {
  const prevRun = ctx.repos.runs.getById(previousRunId);
  if (!prevRun) {
    return;
  }
  const prevSettings = resolvePreviousRunSettings(prevRun.configSnapshotJson, fallbackSettings);

  inTransaction(ctx.db, () => {
    if (prevRun.status === 'publishing') {
      const updated = ctx.repos.runs.compareAndUpdateStatus(
        prevRun.id,
        ['publishing'],
        expectedHeartbeatAt,
        'publish_uncertain',
        {
          errorCode: 'publish_uncertain',
          error: '投稿上传过程中执行进程失联，无法确认平台是否已收稿，请人工核对后再操作',
          pid: null,
          finishedAt: nowIso,
        },
      );
      if (!updated) {
        return;
      }
      const existingPub = ctx.repos.publish.getByRun(prevRun.id);
      if (existingPub && existingPub.status === 'publishing') {
        ctx.repos.publish.updateStatus(prevRun.id, 'uncertain', {
          error: '上传过程中进程意外中断，禁止自动重传',
          updatedAt: nowIso,
        });
      }
      emitRunEvent(ctx, {
        runId: prevRun.id,
        level: 'error',
        stage: 'publish',
        type: 'publish_uncertain',
        message: '投稿上传期间进程意外退出，已进入状态不明保护，禁止自动重传',
      });
      return;
    }

    if (prevRun.status === 'running' || prevRun.status === 'queued') {
      const deadlineIso = new Date(
        Date.parse(nowIso) + prevSettings.retry.reservationHoldHours * 3600_000,
      ).toISOString();

      const updated = ctx.repos.runs.compareAndUpdateStatus(
        prevRun.id,
        ['running', 'queued'],
        expectedHeartbeatAt,
        'interrupted',
        {
          errorCode: 'interrupted',
          error: '执行进程失联或意外崩溃，已完成工作与预留文章已保留，可随时从中断处继续或重跑',
          pid: null,
          finishedAt: nowIso,
          retryDeadlineAt: deadlineIso,
        },
      );
      if (!updated) {
        return;
      }

      const stages = ctx.repos.runStages.listByRun(prevRun.id);
      for (const stage of stages) {
        if (
          stage.status === 'running' &&
          PIPELINE_STAGES.includes(stage.stage as (typeof PIPELINE_STAGES)[number])
        ) {
          ctx.repos.runStages.markStage(prevRun.id, stage.stage, 'interrupted', {
            finishedAt: nowIso,
            error: '进程在执行本步骤期间中断',
          });
        }
      }

      emitRunEvent(ctx, {
        runId: prevRun.id,
        level: 'warn',
        stage: prevRun.currentStage,
        type: 'run_interrupted',
        message: '检测到旧进程失效，任务已标记为中断状态并接管运行锁',
      });
    }
  });
}

/**
 * 申请全局唯一任务运行锁：
 * 若锁被仍存活且心跳新鲜的其他任务持有则抛出 `LockBusyError`；
 * 若原持锁进程已不存在或心跳已超期未更新，则在事务内接管该锁并将原任务安全标为中断状态。
 */
export function acquirePipelineLock(
  ctx: CoreContext,
  runId: string,
  settings: Settings,
  opts?: {
    staleMs?: number;
    isProcessAliveFn?: (pid: number) => boolean;
  },
): void {
  const nowIso = ctx.now().toISOString();
  const result = ctx.repos.locks.tryAcquire({
    name: PIPELINE_LOCK_NAME,
    ownerRun: runId,
    pid: process.pid,
    now: nowIso,
    staleMs: opts?.staleMs ?? DEFAULT_LOCK_STALE_MS,
    isProcessAlive: opts?.isProcessAliveFn ?? isProcessAlive,
  });

  if (!result.acquired) {
    throw new LockBusyError(result.holder);
  }

  if (result.takenOverFrom?.ownerRun && result.takenOverFrom.ownerRun !== runId) {
    markTakenOverRunInterrupted(ctx, settings, result.takenOverFrom.ownerRun, nowIso);
  }
}

/** 释放当前任务及进程持有的全局互斥运行锁 */
export function releasePipelineLock(ctx: CoreContext, runId: string): void {
  ctx.repos.locks.releaseLock(PIPELINE_LOCK_NAME, runId, process.pid);
}

/**
 * 预检全局互斥运行锁是否空闲（若锁正被仍存活且心跳未超期的其他进程持有则抛出 `LockBusyError`）。
 */
export function assertPipelineLockAvailable(
  ctx: CoreContext,
  opts?: {
    staleMs?: number;
    isProcessAliveFn?: (pid: number) => boolean;
  },
): void {
  const existing = ctx.repos.locks.get(PIPELINE_LOCK_NAME);
  if (!existing || existing.ownerRun === null) {
    return;
  }
  const staleMs = opts?.staleMs ?? DEFAULT_LOCK_STALE_MS;
  const checkAlive = opts?.isProcessAliveFn ?? isProcessAlive;
  const heartbeatMs = existing.heartbeatAt ? Date.parse(existing.heartbeatAt) : Number.NaN;
  const nowMs = ctx.now().getTime();
  const heartbeatStale =
    Number.isNaN(heartbeatMs) || Number.isNaN(nowMs) || nowMs - heartbeatMs > staleMs;
  const pidDead = existing.pid === null || !checkAlive(existing.pid);
  if (!pidDead && !heartbeatStale) {
    throw new LockBusyError(existing);
  }
}
