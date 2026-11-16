import '@testing-library/jest-dom/vitest';

if (typeof window !== 'undefined' && typeof window.ResizeObserver === 'undefined') {
  class MockResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  window.ResizeObserver = MockResizeObserver as unknown as typeof ResizeObserver;
}

if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'undefined') {
  window.requestAnimationFrame = (cb: FrameRequestCallback) =>
    window.setTimeout(() => cb(Date.now()), 0);
}
