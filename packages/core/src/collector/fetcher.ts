import type { SourceDef, SourceState } from '@aidaily/contracts';
import { type ParsedFeedItem, parseFeedXml } from './feed-parser.js';

const DEFAULT_FEED_TIMEOUT_MS = 15_000;
const DEFAULT_FEED_RETRIES = 2;
const DEFAULT_RETRY_DELAY_MS = 1_000;
const MAX_FEED_BYTES = 10 * 1024 * 1024;
const FEED_USER_AGENT = 'aidaily-collector/0.1 (+https://github.com/aidaily)';

/** 单个订阅源单次拉取返回的结果结构 */
export interface FetchFeedResult {
  notModified: boolean;
  statusCode: number;
  items: ParsedFeedItem[];
  etag: string | null;
  lastModified: string | null;
}

/** 支持响应取消信号的异步短暂等待函数 */
export async function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) {
    return;
  }
  if (signal?.aborted) {
    throw new DOMException('已取消', 'AbortError');
  }
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException('已取消', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** 带字节上限控制地读取订阅 XML 文本内容 */
async function readFeedXmlWithLimit(res: Response, maxBytes: number): Promise<string> {
  if (!res.body) {
    return '';
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      if (!value) {
        continue;
      }
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error(`订阅内容超过大小上限 (${maxBytes} bytes)`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  return Buffer.concat(chunks).toString('utf8');
}

/**
 * 抓取单个 RSS 或 Atom 订阅源并解析条目列表：
 * 自动附带 ETag / Last-Modified 进行增量条件请求（返回 304 视为无新增成功），
 * 并在网络抖动或服务端异常时按指定次数自动重试。
 */
export async function fetchFeedWithRetry(
  source: SourceDef,
  state: SourceState | null,
  opts: {
    fetchImpl: typeof fetch;
    timeoutMs?: number;
    retries?: number;
    retryDelayMs?: number;
    useConditionalHeaders?: boolean;
    timezone?: string;
    signal?: AbortSignal;
  },
): Promise<FetchFeedResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_FEED_TIMEOUT_MS;
  const maxAttempts = 1 + Math.max(0, opts.retries ?? DEFAULT_FEED_RETRIES);
  const retryDelayMs = opts.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const useConditional = opts.useConditionalHeaders !== false;

  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (opts.signal?.aborted) {
      throw new DOMException('已取消', 'AbortError');
    }

    const headers: Record<string, string> = {
      'User-Agent': FEED_USER_AGENT,
      Accept:
        'application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.8',
    };
    if (useConditional) {
      if (state?.etag) {
        headers['If-None-Match'] = state.etag;
      }
      if (state?.lastModified) {
        headers['If-Modified-Since'] = state.lastModified;
      }
    }

    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const combinedSignal = opts.signal
      ? AbortSignal.any([opts.signal, timeoutSignal])
      : timeoutSignal;

    try {
      const res = await opts.fetchImpl(source.url, {
        headers,
        signal: combinedSignal,
        redirect: 'follow',
      });

      if (res.status === 304) {
        await res.body?.cancel().catch(() => undefined);
        return {
          notModified: true,
          statusCode: 304,
          items: [],
          etag: res.headers.get('etag'),
          lastModified: res.headers.get('last-modified'),
        };
      }

      if (!res.ok) {
        await res.body?.cancel().catch(() => undefined);
        throw new Error(`HTTP ${res.status} ${res.statusText}`.trim());
      }

      const xml = await readFeedXmlWithLimit(res, MAX_FEED_BYTES);
      const items = parseFeedXml(xml, source.url, opts.timezone);
      return {
        notModified: false,
        statusCode: res.status,
        items,
        etag: res.headers.get('etag'),
        lastModified: res.headers.get('last-modified'),
      };
    } catch (err) {
      if (opts.signal?.aborted) {
        throw err;
      }
      lastError = err;
      if (attempt < maxAttempts) {
        await sleepWithAbort(retryDelayMs * attempt, opts.signal);
      }
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
