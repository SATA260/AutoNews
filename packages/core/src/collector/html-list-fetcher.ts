import type { SourceDef } from '@aidaily/contracts';
import { JSDOM, VirtualConsole } from 'jsdom';
import type { CollectorBrowserDriver } from './browser-driver.js';
import { readTextWithLimit } from './extractor.js';
import { type ParsedFeedItem, parsePublishedAt, resolveHttpUrl } from './feed-parser.js';
import { sleepWithAbort } from './fetcher.js';

const DEFAULT_HTML_LIST_TIMEOUT_MS = 18_000;
const DEFAULT_HTML_LIST_RETRIES = 2;
const DEFAULT_HTML_LIST_RETRY_DELAY_MS = 1_000;
const MAX_LIST_HTML_BYTES = 5 * 1024 * 1024;
const MAX_LIST_ITEMS = 40;
const BROWSER_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** 单次抓取网页列表后返回的规范化结果 */
export interface FetchHtmlListResult {
  items: ParsedFeedItem[];
  statusCode: number;
}

const SKIP_PATH_HINTS =
  /\/(?:tag|tags|topic|topics|category|categories|author|authors|about|contact|careers|jobs|login|signup|signin|privacy|terms|pricing|legal)(?:\/|$)/i;

/** 从列表条目文本中提取可能内嵌的日期片段（兼容将发布日期写在标题或标签中的页面） */
function extractInlineDateFromText(raw: string | null | undefined): string | null {
  if (!raw) {
    return null;
  }
  const isoOrSlash = /\b(20\d{2}[-/]\d{1,2}[-/]\d{1,2})\b/.exec(raw);
  if (isoOrSlash?.[1]) {
    return isoOrSlash[1];
  }
  const cnDate = /(\d{4}\s*年\s*\d{1,2}\s*月\s*\d{1,2}\s*日)/.exec(raw);
  if (cnDate?.[1]) {
    return cnDate[1];
  }
  const enDate =
    /\b((?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?\s+\d{1,2},?\s+20\d{2})\b/i.exec(
      raw,
    );
  if (enDate?.[1]) {
    return enDate[1];
  }
  return null;
}

/** 清理列表条目中的多余空白 */
function normalizeInlineText(raw: string | null | undefined): string {
  return raw ? raw.replace(/\s+/g, ' ').trim() : '';
}

/** 校验候选文章链接是否通过域名、正则与常见导航页过滤 */
function isValidListArticleUrl(
  resolvedUrl: string,
  sourceUrl: string,
  urlPattern: RegExp | null,
): boolean {
  try {
    const target = new URL(resolvedUrl);
    const base = new URL(sourceUrl);
    if (
      target.origin === base.origin &&
      target.pathname.replace(/\/+$/, '') === base.pathname.replace(/\/+$/, '')
    ) {
      return false;
    }
    if (target.hash && target.pathname === base.pathname) {
      return false;
    }
    if (SKIP_PATH_HINTS.test(target.pathname)) {
      return false;
    }
    if (urlPattern && !urlPattern.test(resolvedUrl)) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

/** 从网页内嵌的 JSON-LD 结构化脚本中抽取文章清单 */
function collectFromJsonLd(
  doc: Document,
  sourceUrl: string,
  urlPattern: RegExp | null,
  timezone: string,
): ParsedFeedItem[] {
  const results: ParsedFeedItem[] = [];
  const scripts = doc.querySelectorAll('script[type="application/ld+json"]');
  for (const script of scripts) {
    const text = script.textContent?.trim();
    if (!text) {
      continue;
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      continue;
    }
    const queue: unknown[] = [json];
    while (queue.length > 0) {
      const node = queue.shift();
      if (!node || typeof node !== 'object') {
        continue;
      }
      if (Array.isArray(node)) {
        queue.push(...node);
        continue;
      }
      const rec = node as Record<string, unknown>;
      const rawUrl =
        (typeof rec.url === 'string' && rec.url) ||
        (typeof rec['@id'] === 'string' && rec['@id'].startsWith('http') ? rec['@id'] : null);
      const rawTitle =
        (typeof rec.headline === 'string' && rec.headline) ||
        (typeof rec.name === 'string' && rec.name) ||
        null;
      const rawDate =
        (typeof rec.datePublished === 'string' && rec.datePublished) ||
        (typeof rec.dateCreated === 'string' && rec.dateCreated) ||
        null;
      const rawSummary = typeof rec.description === 'string' ? rec.description : null;

      if (rawUrl && rawTitle) {
        const resolved = resolveHttpUrl(rawUrl, sourceUrl);
        const title = normalizeInlineText(rawTitle);
        if (
          resolved &&
          title.length >= 4 &&
          isValidListArticleUrl(resolved, sourceUrl, urlPattern)
        ) {
          results.push({
            url: resolved,
            title,
            publishedAt: parsePublishedAt(rawDate, timezone),
            summary: rawSummary ? normalizeInlineText(rawSummary) : null,
            content: null,
          });
        }
      }
      for (const val of Object.values(rec)) {
        if (val && typeof val === 'object') {
          queue.push(val);
        }
      }
    }
  }
  return results;
}

/** 从 Next.js 页面脚本数据中递归搜集包含链接与标题的文章条目 */
function collectFromNextData(
  doc: Document,
  sourceUrl: string,
  urlPattern: RegExp | null,
  timezone: string,
): ParsedFeedItem[] {
  const script = doc.querySelector('script#__NEXT_DATA__');
  const raw = script?.textContent?.trim();
  if (!raw) {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }

  const results: ParsedFeedItem[] = [];
  const sourceOriginPath = new URL(sourceUrl).pathname.replace(/\/+$/, '');

  function visit(node: unknown, depth: number): void {
    if (depth > 14 || !node || typeof node !== 'object') {
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) {
        visit(item, depth + 1);
      }
      return;
    }
    const rec = node as Record<string, unknown>;
    const rawSlug =
      (typeof rec.url === 'string' && rec.url) ||
      (typeof rec.href === 'string' && rec.href) ||
      (typeof rec.slug === 'string' && rec.slug) ||
      (rec.slug &&
      typeof rec.slug === 'object' &&
      typeof (rec.slug as Record<string, unknown>).current === 'string'
        ? String((rec.slug as Record<string, unknown>).current)
        : null);
    const rawTitle =
      (typeof rec.title === 'string' && rec.title) ||
      (typeof rec.headline === 'string' && rec.headline) ||
      null;

    if (rawSlug && rawTitle) {
      const candidatePath =
        rawSlug.startsWith('http') || rawSlug.startsWith('/')
          ? rawSlug
          : `${sourceOriginPath}/${rawSlug.replace(/^\/+/, '')}`;
      const resolved = resolveHttpUrl(candidatePath, sourceUrl);
      const title = normalizeInlineText(rawTitle);
      if (resolved && title.length >= 4 && isValidListArticleUrl(resolved, sourceUrl, urlPattern)) {
        const rawDate =
          (typeof rec.publishedAt === 'string' && rec.publishedAt) ||
          (typeof rec.publishedOn === 'string' && rec.publishedOn) ||
          (typeof rec.date === 'string' && rec.date) ||
          (typeof rec.createdAt === 'string' && rec.createdAt) ||
          null;
        const rawSummary =
          (typeof rec.summary === 'string' && rec.summary) ||
          (typeof rec.excerpt === 'string' && rec.excerpt) ||
          (typeof rec.description === 'string' && rec.description) ||
          null;
        results.push({
          url: resolved,
          title,
          publishedAt: parsePublishedAt(rawDate, timezone),
          summary: rawSummary ? normalizeInlineText(rawSummary) : null,
          content: null,
        });
      }
    }

    for (const val of Object.values(rec)) {
      if (val && typeof val === 'object') {
        visit(val, depth + 1);
      }
    }
  }

  visit(parsed, 0);
  return results;
}

/**
 * 解析官网博客或新闻列表页 HTML，合并结构化数据、页面选择器与列表链接后输出统一条目列表。
 */
export function parseHtmlListPage(
  html: string,
  source: SourceDef,
  defaultTimezone = 'UTC',
): ParsedFeedItem[] {
  const trimmed = html.trim();
  if (!trimmed) {
    return [];
  }
  const urlPattern = source.listConfig?.urlPattern
    ? new RegExp(source.listConfig.urlPattern)
    : null;

  const dom = new JSDOM(trimmed, {
    url: source.url,
    virtualConsole: new VirtualConsole(),
  });

  try {
    const doc = dom.window.document;
    const deduped = new Map<string, ParsedFeedItem>();

    const pushCandidate = (item: ParsedFeedItem) => {
      const existing = deduped.get(item.url);
      if (!existing) {
        deduped.set(item.url, item);
        return;
      }
      // 同一链接若后续来源补齐了发布时间或更清晰的标题与摘要，合并保留更完整的一份
      if (!existing.publishedAt && item.publishedAt) {
        existing.publishedAt = item.publishedAt;
      }
      if (!existing.summary && item.summary) {
        existing.summary = item.summary;
      }
    };

    for (const item of collectFromJsonLd(doc, source.url, urlPattern, defaultTimezone)) {
      pushCandidate(item);
    }
    for (const item of collectFromNextData(doc, source.url, urlPattern, defaultTimezone)) {
      pushCandidate(item);
    }

    const cfg = source.listConfig;
    if (cfg?.itemSelector) {
      const containers = doc.querySelectorAll(cfg.itemSelector);
      for (const box of containers) {
        const linkEl = cfg.linkSelector
          ? box.querySelector(cfg.linkSelector)
          : box.matches('a[href]')
            ? box
            : box.querySelector('a[href]');
        const href = linkEl?.getAttribute('href');
        const resolved = resolveHttpUrl(href ?? null, source.url);
        if (!resolved || !isValidListArticleUrl(resolved, source.url, urlPattern)) {
          continue;
        }
        const titleEl = cfg.titleSelector
          ? box.querySelector(cfg.titleSelector)
          : box.querySelector('h1, h2, h3, h4');
        const title = normalizeInlineText(titleEl?.textContent ?? linkEl?.textContent);
        if (title.length < 4) {
          continue;
        }
        const dateEl = cfg.dateSelector
          ? box.querySelector(cfg.dateSelector)
          : box.querySelector('time, [datetime]');
        const dateRaw =
          dateEl?.getAttribute('datetime') ||
          normalizeInlineText(dateEl?.textContent) ||
          extractInlineDateFromText(title) ||
          null;
        const summaryEl = cfg.summarySelector
          ? box.querySelector(cfg.summarySelector)
          : box.querySelector('p');
        const summary = normalizeInlineText(summaryEl?.textContent) || null;
        pushCandidate({
          url: resolved,
          title,
          publishedAt: parsePublishedAt(dateRaw, defaultTimezone),
          summary,
          content: null,
        });
      }
    } else {
      const cards = doc.querySelectorAll(
        'article, [role="article"], main li, .post-card, .blog-post',
      );
      for (const card of cards) {
        const anchor = card.querySelector('a[href]');
        const href = anchor?.getAttribute('href') ?? null;
        const resolved = resolveHttpUrl(href, source.url);
        if (!resolved || !isValidListArticleUrl(resolved, source.url, urlPattern)) {
          continue;
        }
        const titleEl = card.querySelector('h1, h2, h3, h4');
        const title = normalizeInlineText(titleEl?.textContent ?? anchor?.textContent);
        if (title.length < 4) {
          continue;
        }
        const timeEl = card.querySelector('time, [datetime]');
        const dateRaw =
          timeEl?.getAttribute('datetime') ||
          normalizeInlineText(timeEl?.textContent) ||
          extractInlineDateFromText(title) ||
          null;
        const summary = normalizeInlineText(card.querySelector('p')?.textContent) || null;
        pushCandidate({
          url: resolved,
          title,
          publishedAt: parsePublishedAt(dateRaw, defaultTimezone),
          summary,
          content: null,
        });
      }

      // 兜底直接扫描主内容区域的匹配链接，兼容不使用 article 标签的官网新闻页
      if (deduped.size === 0 || urlPattern) {
        const links = doc.querySelectorAll('main a[href], body a[href]');
        for (const anchor of links) {
          const resolved = resolveHttpUrl(anchor.getAttribute('href'), source.url);
          if (!resolved || !isValidListArticleUrl(resolved, source.url, urlPattern)) {
            continue;
          }
          const heading = anchor.querySelector('h1, h2, h3, h4');
          const title = normalizeInlineText(heading?.textContent ?? anchor.textContent);
          if (title.length < 6 || title.length > 220) {
            continue;
          }
          const parentCard = anchor.closest('article, li, section, div');
          const timeEl = parentCard?.querySelector('time, [datetime]');
          const dateRaw =
            timeEl?.getAttribute('datetime') ||
            normalizeInlineText(timeEl?.textContent) ||
            extractInlineDateFromText(title) ||
            null;
          pushCandidate({
            url: resolved,
            title,
            publishedAt: parsePublishedAt(dateRaw, defaultTimezone),
            summary: null,
            content: null,
          });
        }
      }
    }

    return Array.from(deduped.values()).slice(0, MAX_LIST_ITEMS);
  } finally {
    dom.window.close();
  }
}

/** 抓取并解析官方网页新闻列表（必要时自动切换无头浏览器渲染前端动态列表，并在网络波动时自动重试） */
export async function fetchHtmlListWithRetry(
  source: SourceDef,
  opts: {
    fetchImpl: typeof fetch;
    driver?: CollectorBrowserDriver;
    timeoutMs?: number;
    retries?: number;
    retryDelayMs?: number;
    timezone?: string;
    signal?: AbortSignal;
  },
): Promise<FetchHtmlListResult> {
  const renderJs = Boolean(source.listConfig?.renderJs && opts.driver);
  const timeoutMs = opts.timeoutMs ?? (renderJs ? 25_000 : DEFAULT_HTML_LIST_TIMEOUT_MS);
  const maxAttempts = 1 + Math.max(0, opts.retries ?? DEFAULT_HTML_LIST_RETRIES);
  const retryDelayMs = opts.retryDelayMs ?? DEFAULT_HTML_LIST_RETRY_DELAY_MS;
  const timezone = opts.timezone ?? 'UTC';

  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (opts.signal?.aborted) {
      throw new DOMException('已取消', 'AbortError');
    }

    try {
      if (renderJs && opts.driver) {
        const html = await opts.driver.fetchRenderedHtml(source.url, {
          timeoutMs,
          signal: opts.signal,
        });
        return {
          items: parseHtmlListPage(html, source, timezone),
          statusCode: 200,
        };
      }

      const timeoutSignal = AbortSignal.timeout(timeoutMs);
      const combinedSignal = opts.signal
        ? AbortSignal.any([opts.signal, timeoutSignal])
        : timeoutSignal;

      const res = await opts.fetchImpl(source.url, {
        signal: combinedSignal,
        redirect: 'follow',
        headers: {
          'User-Agent': BROWSER_USER_AGENT,
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
      });
      if (!res.ok) {
        await res.body?.cancel().catch(() => undefined);
        throw new Error(`HTTP ${res.status} ${res.statusText}`.trim());
      }
      const html = await readTextWithLimit(res, MAX_LIST_HTML_BYTES);
      const items = parseHtmlListPage(html, source, timezone);
      return { items, statusCode: res.status };
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
