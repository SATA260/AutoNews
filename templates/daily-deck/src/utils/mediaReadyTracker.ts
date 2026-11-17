/** 跟踪当前页面中的图片与视频加载状态，供跳转后等待画面渲染就绪 */
class MediaReadyTracker {
  private pending = new Set<string>();
  private listeners = new Set<() => void>();

  /** 登记一个正在加载中的媒体资源标识 */
  markPending(token: string): void {
    this.pending.add(token);
  }

  /** 标记指定媒体资源已完成加载或失败降级 */
  markSettled(token: string): void {
    if (this.pending.delete(token) && this.pending.size === 0) {
      this.notifyAll();
    }
  }

  /** 在所有媒体加载完成后唤醒等待中的调用方 */
  private notifyAll(): void {
    const callbacks = Array.from(this.listeners);
    this.listeners.clear();
    for (const cb of callbacks) {
      cb();
    }
  }

  /** 等待当前页所有未完成媒体加载结束，或达到超时上限后放行 */
  waitForAll(timeoutMs = 1500): Promise<void> {
    if (this.pending.size === 0) {
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        this.listeners.delete(done);
        resolve();
      };

      const timer = setTimeout(done, timeoutMs);
      this.listeners.add(done);
    });
  }

  /** 返回当前仍在加载中的媒体数量 */
  getPendingCount(): number {
    return this.pending.size;
  }
}

/** 全局共享的媒体加载状态跟踪实例 */
export const mediaReadyTracker = new MediaReadyTracker();

/** 翻页过渡等待工具，用于在翻页跳转后等待页面动效收尾 */
export const transitionTiming = {
  /** 等待指定毫秒数，时长不大于 0 时立即完成 */
  wait(ms: number): Promise<void> {
    if (!Number.isFinite(ms) || ms <= 0) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
  },
};

/** 等待翻页过渡动画结束的便捷函数 */
export function waitForTransitionSettle(ms: number): Promise<void> {
  return transitionTiming.wait(ms);
}
