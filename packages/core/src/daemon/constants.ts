/** 后台守护进程与按需网页网关的共享默认参数配置。 */
export const DAEMON_DEFAULTS = {
  webHost: '127.0.0.1',
  webPort: 3000,
  webIdleTimeoutSec: 900,
  maxSleepSliceMs: 30_000,
  maxEmptyScheduleSliceMs: 60_000,
  maxLogBytes: 5 * 1024 * 1024,
} as const;

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/** 判断给定的监听主机地址是否属于本机回环网卡，避免未授权暴露到局域网。 */
export function isLoopbackWebHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host.trim().toLowerCase());
}

/** 将 `0.0.0.0`、`::` 等通配绑定地址规范化为浏览器可直接访问的本机回环地址。 */
export function normalizeBrowserWebHost(host: string): string {
  const trimmed = host.trim();
  const lower = trimmed.toLowerCase();
  if (lower === '0.0.0.0' || lower === '::' || lower === '[::]') {
    return '127.0.0.1';
  }
  return trimmed;
}
