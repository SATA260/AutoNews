import type { CoreContext } from '../context.js';
import { PIPELINE_LOCK_NAME } from './lock.js';

const DEFAULT_HEARTBEAT_INTERVAL_MS = 10_000;

/** 运行中心跳定时器控制句柄 */
export interface HeartbeatHandle {
  /** 立即刷新一次心跳时间 */
  beat(): void;
  /** 停止定时心跳 */
  stop(): void;
}

/**
 * 启动后台心跳更新器：定期同时刷新任务表与运行锁表里的存活时间戳；
 * 若检测到运行锁已被其他进程接管则触发失去锁权回调，避免双进程继续写入冲突。
 */
export function startRunHeartbeat(
  ctx: CoreContext,
  runId: string,
  opts?: { intervalMs?: number; onLockLost?: () => void },
): HeartbeatHandle {
  const intervalMs = opts?.intervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
  let stopped = false;
  let notifiedLost = false;

  const beat = () => {
    if (stopped) {
      return;
    }
    const ts = ctx.now().toISOString();
    try {
      const hasLock = ctx.repos.locks.updateHeartbeat(PIPELINE_LOCK_NAME, runId, ts, process.pid);
      if (!hasLock && !notifiedLost) {
        notifiedLost = true;
        opts?.onLockLost?.();
        return;
      }
      ctx.repos.runs.setHeartbeat(runId, ts);
    } catch {
      // 忽略数据库已关闭等收尾阶段的心跳更新异常
    }
  };

  beat();
  const timer = setInterval(beat, intervalMs);
  timer.unref();

  return {
    beat,
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}
