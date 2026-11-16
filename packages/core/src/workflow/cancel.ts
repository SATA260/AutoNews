import type { CoreContext } from '../context.js';

const DEFAULT_CANCEL_POLL_MS = 500;

/** 任务取消信号监听控制句柄 */
export interface CancelMonitorHandle {
  signal: AbortSignal;
  /** 立即检查一次取消标记 */
  checkNow(): boolean;
  /** 停止轮询释放定时器 */
  stop(): void;
}

/**
 * 监听数据库中指定任务的取消请求标记：
 * 一旦其他终端或网页端将 `cancel_requested` 置为 1，立即触发 `AbortSignal` 中止在途网络与大模型子进程。
 */
export function createRunCancelMonitor(
  ctx: CoreContext,
  runId: string,
  opts?: { pollMs?: number },
): CancelMonitorHandle {
  const controller = new AbortController();
  const pollMs = opts?.pollMs ?? DEFAULT_CANCEL_POLL_MS;

  const checkNow = (): boolean => {
    try {
      if (ctx.repos.runs.isCancelRequested(runId)) {
        if (!controller.signal.aborted) {
          controller.abort();
        }
        return true;
      }
    } catch {
      // 数据库连接已关闭时安全退出轮询
    }
    return false;
  };

  checkNow();
  const timer = setInterval(() => {
    if (checkNow()) {
      clearInterval(timer);
    }
  }, pollMs);
  timer.unref();

  return {
    signal: controller.signal,
    checkNow,
    stop() {
      clearInterval(timer);
    },
  };
}
