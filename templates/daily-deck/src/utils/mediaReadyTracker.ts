class MediaReadyTracker {
  private pending = new Set<string>();
  private listeners = new Set<() => void>();

  markPending(token: string): void {
    this.pending.add(token);
  }

  markSettled(token: string): void {
    if (this.pending.delete(token) && this.pending.size === 0) {
      this.notifyAll();
    }
  }

  private notifyAll(): void {
    const callbacks = Array.from(this.listeners);
    this.listeners.clear();
    callbacks.forEach((cb) => cb());
  }

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

  getPendingCount(): number {
    return this.pending.size;
  }
}

export const mediaReadyTracker = new MediaReadyTracker();
