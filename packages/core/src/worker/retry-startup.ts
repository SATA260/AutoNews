import type { ChildProcess } from 'node:child_process';
import { z } from 'zod';

const RETRY_START_TIMEOUT_MS = 15_000;
const RetryGrantSchema = z.literal('retry_granted');
const RetryStartupResultSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('retry_waiting') }),
  z.object({ type: z.literal('retry_started') }),
  z.object({ type: z.literal('retry_start_failed'), message: z.string() }),
]);

/** 父进程为指定子进程预留运行锁，启动失败时可按进程号收回 */
export interface RetryReservation {
  reserve(pid: number): void;
  release(pid: number): void;
}

/** 先预留锁再允许子进程运行，等子进程确认启动或报告错误 */
export async function confirmRetryStartup(
  child: ChildProcess,
  reservation: RetryReservation,
): Promise<void> {
  const pid = child.pid;
  if (!pid) {
    throw new Error('后台重试进程尚未取得进程号');
  }

  let reserved = false;
  let timedOut = false;
  try {
    await new Promise<void>((resolve, reject) => {
      /** 结束等待并移除本次启动监听 */
      function finish(error?: Error): void {
        clearTimeout(timer);
        child.off('message', onMessage);
        child.off('error', finish);
        child.off('exit', onExit);
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      }

      /** 读取子进程发来的启动结果 */
      const onMessage = (message: unknown): void => {
        const result = RetryStartupResultSchema.safeParse(message);
        if (!result.success) {
          return;
        }
        if (result.data.type !== 'retry_waiting') {
          if (reserved) {
            finish(
              result.data.type === 'retry_started' ? undefined : new Error(result.data.message),
            );
          }
          return;
        }
        if (reserved) {
          return;
        }
        try {
          reservation.reserve(pid);
          reserved = true;
          child.send(RetryGrantSchema.value, (err) => {
            if (err) {
              finish(err);
            }
          });
        } catch (err) {
          finish(err instanceof Error ? err : new Error(String(err)));
        }
      };

      /** 子进程未确认启动就退出时保留退出原因 */
      function onExit(code: number | null, signal: NodeJS.Signals | null): void {
        finish(new Error(`后台重试进程在启动前退出（${signal ?? `退出码 ${String(code)}`}）`));
      }

      const timer = setTimeout(() => {
        timedOut = true;
        finish(new Error('15 秒内未确认后台重试已启动，请刷新页面查看任务状态后再试'));
      }, RETRY_START_TIMEOUT_MS);
      child.on('message', onMessage);
      child.once('error', finish);
      child.once('exit', onExit);
    });
  } catch (err) {
    if (reserved && !timedOut) {
      reservation.release(pid);
    }
    throw err;
  }
}

/** 等待父进程发出运行许可，父进程断开连接时结束等待 */
export async function waitForRetryGrant(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    /** 收到启动许可后结束等待 */
    function onMessage(message: unknown): void {
      if (RetryGrantSchema.safeParse(message).success) {
        process.off('message', onMessage);
        process.off('disconnect', onDisconnect);
        resolve();
      }
    }

    /** 父进程未发出许可即退出时停止启动 */
    function onDisconnect(): void {
      process.off('message', onMessage);
      reject(new Error('后台重试进程未收到启动许可'));
    }

    if (!process.connected) {
      onDisconnect();
      return;
    }
    process.on('message', onMessage);
    process.once('disconnect', onDisconnect);
    reportRetryStartup({ type: 'retry_waiting' });
  });
}

/** 向仍在等待的父进程发送结果，父进程断开后继续执行已获准的重试 */
export function reportRetryStartup(result: z.infer<typeof RetryStartupResultSchema>): void {
  if (process.connected) {
    process.send?.(result, () => undefined);
  }
}
