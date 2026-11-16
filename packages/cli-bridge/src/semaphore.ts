/** 轻量并发控制信号量，用于限制同一命令行工具同时运行的最大进程数 */
export class Semaphore {
  private readonly maxConcurrency: number;
  private active = 0;
  private readonly waitQueue: Array<() => void> = [];

  constructor(maxConcurrency: number) {
    this.maxConcurrency = Math.max(1, Math.floor(maxConcurrency));
  }

  /** 申请一个并发槽位并执行异步任务，结束后自动释放 */
  async run<T>(task: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await task();
    } finally {
      this.release();
    }
  }

  /** 若当前运行数已达上限，则将等待回调放入队列挂起 */
  private acquire(): Promise<void> {
    if (this.active < this.maxConcurrency) {
      this.active += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.waitQueue.push(() => {
        this.active += 1;
        resolve();
      });
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
