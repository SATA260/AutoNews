import type { RunEvent, RunEventLevel, Stage } from '@aidaily/contracts';
import type { CoreContext } from '../context.js';

const ACTIVE_WATCH_STATUSES = new Set(['queued', 'running', 'publishing']);

/** 向数据库写入一条运行日志事件，并同步输出到核心日志记录器 */
export function emitRunEvent(
  ctx: CoreContext,
  input: {
    runId: string;
    level: RunEventLevel;
    stage?: Stage | null;
    itemId?: string | null;
    type: string;
    message: string;
    data?: unknown;
  },
): number {
  const id = ctx.repos.runEvents.append({
    runId: input.runId,
    ts: ctx.now().toISOString(),
    level: input.level,
    stage: input.stage ?? null,
    itemId: input.itemId ?? null,
    type: input.type,
    message: input.message,
    data: input.data,
  });

  ctx.logger[input.level](
    {
      runId: input.runId,
      stage: input.stage ?? undefined,
      itemId: input.itemId ?? undefined,
      type: input.type,
    },
    input.message,
  );

  return id;
}

/** 支持被取消信号提前唤醒的短暂休眠 */
async function sleepPoll(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted || ms <= 0) {
    return;
  }
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * 持续轮询并推送某期任务的增量运行事件：
 * 默认每 1 秒拉取新增事件回调给客户端，当收到取消信号或任务进入终态（且新日志已读空）时自动结束监听。
 */
export async function watchRunEvents(
  ctx: CoreContext,
  runId: string,
  onEvent: (event: RunEvent) => void | Promise<void>,
  signal: AbortSignal,
  opts?: {
    afterId?: number;
    pollMs?: number;
    stopWhenTerminal?: boolean;
  },
): Promise<void> {
  let cursor = opts?.afterId ?? 0;
  const pollMs = opts?.pollMs ?? 1_000;
  const stopWhenTerminal = opts?.stopWhenTerminal ?? true;

  while (!signal.aborted) {
    const batch = ctx.repos.runEvents.listAfter(runId, cursor, 200);
    for (const ev of batch) {
      if (signal.aborted) {
        return;
      }
      await onEvent(ev);
      cursor = ev.id;
    }

    if (stopWhenTerminal) {
      const run = ctx.repos.runs.getById(runId);
      if (!run || (!ACTIVE_WATCH_STATUSES.has(run.status) && batch.length === 0)) {
        return;
      }
    }

    await sleepPoll(pollMs, signal);
  }
}
