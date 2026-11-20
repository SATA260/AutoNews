import { lookup } from 'node:dns/promises';
import {
  classifyIpAddress,
  classifyTargetHostname,
  isAllowedResolvedIpClass,
  isAllowedUrlTarget,
} from '@aidaily/contracts';

const DEFAULT_MAX_REDIRECTS = 5;

/** 因目标地址命中内网、回环或元数据防护规则而阻断请求的非重试异常 */
export class BlockedSsrfError extends Error {
  readonly code = 'SSRF_BLOCKED';

  constructor(url: string) {
    super(`已拦截指向内网、回环或元数据地址的外部请求: ${url}`);
    this.name = 'BlockedSsrfError';
  }
}

/** 根据配置信源地址提取显式允许本地联调的同源白名单（云元数据网段永不放行） */
export function resolveConfiguredLocalOrigins(sourceUrl: string): string[] {
  try {
    const parsed = new URL(sourceUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return [];
    }
    const cls = classifyTargetHostname(parsed.hostname);
    if (cls === 'loopback' || cls === 'private') {
      return [parsed.origin];
    }
  } catch {
    // 非法地址不生成白名单
  }
  return [];
}

/** 在发起请求前核验 URL 与解析 IP 是否满足外网安全边界 */
export async function assertSafeFetchTarget(
  targetUrl: URL,
  opts?: {
    fetchImpl?: typeof fetch;
    allowedOrigins?: readonly string[];
    allowBenchmarkDns?: boolean;
    lookupImpl?: (hostname: string) => Promise<Array<{ address: string }>>;
  },
): Promise<void> {
  if (!isAllowedUrlTarget(targetUrl, { allowedOrigins: opts?.allowedOrigins })) {
    throw new BlockedSsrfError(targetUrl.toString());
  }

  const shouldLookup = opts?.lookupImpl !== undefined || opts?.fetchImpl === globalThis.fetch;
  if (!shouldLookup || classifyIpAddress(targetUrl.hostname) !== null) {
    return;
  }

  const allowBenchmarkDns = opts?.allowBenchmarkDns ?? true;
  const resolved = opts?.lookupImpl
    ? await opts.lookupImpl(targetUrl.hostname)
    : await lookup(targetUrl.hostname, { all: true, verbatim: true });
  for (const entry of resolved) {
    const cls = classifyIpAddress(entry.address);
    if (
      !cls ||
      !isAllowedResolvedIpClass(cls, targetUrl, {
        allowedOrigins: opts?.allowedOrigins,
        allowBenchmarkDns,
      })
    ) {
      throw new BlockedSsrfError(targetUrl.toString());
    }
  }
}

/**
 * 发起带外网边界防护与逐跳重定向核验的 HTTP 请求：
 * 禁用底层自动跳转，在每一跳 3xx 重定向时重新检验目标主机及解析 IP，阻断通过重定向穿透内网。
 */
export async function fetchWithSsrfGuard(
  rawUrl: string | URL,
  opts: {
    fetchImpl: typeof fetch;
    signal?: AbortSignal;
    headers?: HeadersInit;
    method?: string;
    allowedOrigins?: readonly string[];
    allowBenchmarkDns?: boolean;
    maxRedirects?: number;
    lookupImpl?: (hostname: string) => Promise<Array<{ address: string }>>;
  },
): Promise<Response> {
  let currentUrl = rawUrl instanceof URL ? new URL(rawUrl.toString()) : new URL(rawUrl);
  const maxRedirects = opts.maxRedirects ?? DEFAULT_MAX_REDIRECTS;

  for (let hop = 0; hop <= maxRedirects; hop++) {
    await assertSafeFetchTarget(currentUrl, {
      fetchImpl: opts.fetchImpl,
      allowedOrigins: opts.allowedOrigins,
      allowBenchmarkDns: opts.allowBenchmarkDns,
      lookupImpl: opts.lookupImpl,
    });

    const res = await opts.fetchImpl(currentUrl.toString(), {
      method: opts.method ?? 'GET',
      signal: opts.signal,
      headers: opts.headers,
      redirect: 'manual',
    });

    if (res.status < 300 || res.status >= 400) {
      return res;
    }

    const location = res.headers.get('location');
    await res.body?.cancel().catch(() => undefined);
    if (!location) {
      return res;
    }
    if (hop >= maxRedirects) {
      throw new Error(`HTTP 重定向次数超过上限 (${maxRedirects}): ${currentUrl.toString()}`);
    }

    let nextUrl: URL;
    try {
      nextUrl = new URL(location, currentUrl);
    } catch {
      throw new Error(`无效的重定向目标地址: ${location}`);
    }
    currentUrl = nextUrl;
  }

  throw new Error(`HTTP 重定向次数异常: ${currentUrl.toString()}`);
}
