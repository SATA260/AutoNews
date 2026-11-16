/** 轻量并发控制信号量，用于限制同一命令行工具同时运行的最大进程数，并支持排队期间响应取消信号 */
export class Semaphore {
  private readonly maxConcurrency: number;
  private active = 0;
  private readonly waitQueue: Array<() => void> = [];

  constructor(maxConcurrency: number) {
    this.maxConcurrency = Math.max(1, Math.floor(maxConcurrency));
  }

  /** 申请一个并发槽位并执行异步任务，结束后自动释放 */
  async run<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    await this.acquire(signal);
    try {
      return await task();
    } finally {
      this.release();
    }
  }

  /** 若当前运行数已达上限，则将等待回调放入队列挂起，并在取消信号触发时立即移出队列 */
  private acquire(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) {
      return Promise.reject(new DOMException('已取消', 'AbortError'));
    }
    if (this.active < this.maxConcurrency) {
      this.active += 1;
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const wake = () => {
        signal?.removeEventListener('abort', onAbort);
        this.active += 1;
        resolve();
      };
      const onAbort = () => {
        const idx = this.waitQueue.indexOf(wake);
        if (idx !== -1) {
          this.waitQueue.splice(idx, 1);
        }
        reject(new DOMException('已取消', 'AbortError'));
      };
      this.waitQueue.push(wake);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  /** 释放当前槽位并唤醒下一个排队中的任务 */
  private release(): void {
    this.active = Math.max(0, this.active - 1);
    const next = this.waitQueue.shift();
    if (next) {
      next();
    }
  }
}
