import path from 'node:path';
import type { ExtractStatus, SourceLang } from '@aidaily/contracts';
import { Readability } from '@mozilla/readability';
import { JSDOM, VirtualConsole } from 'jsdom';
import { readJsonOrNull } from '../storage/files.js';

const DEFAULT_HTML_TIMEOUT_MS = 15_000;
const MAX_HTML_BYTES = 5 * 1024 * 1024;
const BROWSER_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** 文章正文与配图提取后的结构化结果 */
export interface ExtractedArticleContent {
  extractStatus: ExtractStatus;
  text: string;
  excerpt: string;
  contentChars: number;
  ogImageUrl: string | null;
}

/** 写入本地磁盘缓存的文章正文完整 JSON 结构 */
export interface StoredArticleContent {
  url: string;
  title: string;
  lang: SourceLang;
  publishedAt: string | null;
  text: string;
  feedContent: string | null;
}

/** 构造静默虚拟控制台，屏蔽第三方网页 CSS 解析警告 */
function createSilentVirtualConsole(): VirtualConsole {
  return new VirtualConsole();
}

/** 规范化多行文章正文，保留段落换行并压缩多余空格 */
function normalizeMultilineText(raw: string): string {
  return raw
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** 将多行文本压成单行，用于生成文章短摘要 */
function normalizeSingleLineText(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim();
}

/** 将疑似相对链接解析为安全的 http/https 地址，无效返回 null */
function resolveHttpImageUrl(rawUrl: string | null, articleUrl: string): string | null {
  if (!rawUrl) {
    return null;
  }
  const trimmed = rawUrl.trim();
  if (!trimmed || trimmed.startsWith('data:')) {
    return null;
  }
  try {
    const resolved = new URL(trimmed, articleUrl);
    if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') {
      return null;
    }
    return resolved.toString();
  } catch {
    return null;
  }
}

/** 在 Readability 改写 DOM 前提前提取页面元信息里的代表配图链接 */
function extractOgImageFromDom(doc: Document, articleUrl: string): string | null {
  const selectors = [
    'meta[property="og:image"]',
    'meta[property="og:image:secure_url"]',
    'meta[name="og:image"]',
    'meta[property="twitter:image"]',
    'meta[name="twitter:image"]',
    'meta[name="twitter:image:src"]',
  ];
  for (const selector of selectors) {
    const el = doc.querySelector(selector);
    const content = el?.getAttribute('content') ?? el?.getAttribute('value');
    const resolved = resolveHttpImageUrl(content ?? null, articleUrl);
    if (resolved) {
      return resolved;
    }
  }
  return null;
}

/** 从订阅正文 HTML 片段中提取第一张有效配图地址（作为网页无配图时的兜底） */
function extractFirstFeedImage(htmlFragment: string | null, articleUrl: string): string | null {
  if (!htmlFragment) {
    return null;
  }
  const dom = new JSDOM(`<body>${htmlFragment}</body>`, {
    url: articleUrl,
    virtualConsole: createSilentVirtualConsole(),
  });
  try {
    const imgs = dom.window.document.querySelectorAll('img');
    for (const img of imgs) {
      const src = img.getAttribute('src') ?? img.getAttribute('data-src');
      const resolved = resolveHttpImageUrl(src, articleUrl);
      if (resolved) {
        return resolved;
      }
    }
    return null;
  } finally {
    dom.window.close();
  }
}

/** 将 HTML 片段清理为纯文本，自动剔除脚本、样式与不可见嵌入标签 */
export function htmlToPlainText(html: string, url?: string): string {
  const trimmed = html.trim();
  if (!trimmed) {
    return '';
  }
  const dom = new JSDOM(trimmed, {
    ...(url ? { url } : {}),
    virtualConsole: createSilentVirtualConsole(),
  });
  try {
    const doc = dom.window.document;
    for (const el of doc.querySelectorAll('script, style, noscript, svg, iframe')) {
      el.remove();
    }
    const raw = doc.body?.textContent ?? doc.documentElement?.textContent ?? '';
    return normalizeMultilineText(raw);
  } finally {
    dom.window.close();
  }
}

/** 读取有大小上限控制的响应文本内容 */
async function readTextWithLimit(res: Response, maxBytes: number): Promise<string> {
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
      if (total + value.byteLength > maxBytes) {
        const remaining = maxBytes - total;
        if (remaining > 0) {
          chunks.push(value.subarray(0, remaining));
        }
        await reader.cancel().catch(() => undefined);
        break;
      }
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }

  return Buffer.concat(chunks).toString('utf8');
}

/** 下载文章原网页 HTML，遇到非网页内容、网络失败或超时返回 null（若外层主动取消则抛出取消异常） */
export async function fetchArticleHtml(
  url: string,
  fetchImpl: typeof fetch,
  opts?: { timeoutMs?: number; signal?: AbortSignal },
): Promise<string | null> {
  if (opts?.signal?.aborted) {
    throw new DOMException('已取消', 'AbortError');
  }

  const timeoutSignal = AbortSignal.timeout(opts?.timeoutMs ?? DEFAULT_HTML_TIMEOUT_MS);
  const combinedSignal = opts?.signal
    ? AbortSignal.any([opts.signal, timeoutSignal])
    : timeoutSignal;

  try {
    const res = await fetchImpl(url, {
      signal: combinedSignal,
      redirect: 'follow',
      headers: {
        'User-Agent': BROWSER_USER_AGENT,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    });
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      return null;
    }
    const contentType = res.headers.get('content-type')?.toLowerCase() ?? '';
    if (
      contentType &&
      !contentType.includes('text/html') &&
      !contentType.includes('application/xhtml+xml') &&
      !contentType.includes('text/plain')
    ) {
      await res.body?.cancel().catch(() => undefined);
      return null;
    }
    return await readTextWithLimit(res, MAX_HTML_BYTES);
  } catch (err) {
    if (opts?.signal?.aborted) {
      throw err;
    }
    return null;
  }
}

/**
 * 提取文章可用正文与代表配图：
 * 优先解析原网页正文（满 400 字标记为 ok）；
 * 原网页抓取失败或正文不足 400 字时改用订阅正文或摘要（正文优先，不足再用摘要；满 200 字标记为 feed_only，不足 200 字则标记为 failed）。
 */
export function extractArticleContent(opts: {
  url: string;
  html: string | null;
  feedContent: string | null;
  feedSummary: string | null;
}): ExtractedArticleContent {
  let readabilityText = '';
  let ogImageUrl: string | null = null;

  if (opts.html && opts.html.trim().length > 0) {
    const dom = new JSDOM(opts.html, {
      url: opts.url,
      virtualConsole: createSilentVirtualConsole(),
    });
    try {
      ogImageUrl = extractOgImageFromDom(dom.window.document, opts.url);
      const parsed = new Readability(dom.window.document).parse();
      if (parsed?.textContent) {
        readabilityText = normalizeMultilineText(parsed.textContent);
      }
    } catch {
      // Readability 遇到畸形页面结构时降级走订阅内容回退逻辑
    } finally {
      dom.window.close();
    }
  }

  if (!ogImageUrl) {
    ogImageUrl =
      extractFirstFeedImage(opts.feedContent, opts.url) ??
      extractFirstFeedImage(opts.feedSummary, opts.url);
  }

  if (readabilityText.length >= 400) {
    const excerpt = normalizeSingleLineText(readabilityText).slice(0, 300);
    return {
      extractStatus: 'ok',
      text: readabilityText,
      excerpt,
      contentChars: readabilityText.length,
      ogImageUrl,
    };
  }

  const feedContentText = opts.feedContent ? htmlToPlainText(opts.feedContent, opts.url) : '';
  const feedSummaryText = opts.feedSummary ? htmlToPlainText(opts.feedSummary, opts.url) : '';
  const fallbackText =
    feedContentText.length >= feedSummaryText.length ? feedContentText : feedSummaryText;

  if (fallbackText.length >= 200) {
    const excerpt = normalizeSingleLineText(fallbackText).slice(0, 300);
    return {
      extractStatus: 'feed_only',
      text: fallbackText,
      excerpt,
      contentChars: fallbackText.length,
      ogImageUrl,
    };
  }

  const excerpt = normalizeSingleLineText(fallbackText).slice(0, 300);
  return {
    extractStatus: 'failed',
    text: fallbackText,
    excerpt,
    contentChars: fallbackText.length,
    ogImageUrl,
  };
}

/** 安全读取磁盘中保存的文章正文 JSON 文件 */
export async function readStoredArticleContent(
  rootDir: string,
  contentPath: string | null,
): Promise<StoredArticleContent | null> {
  if (!contentPath) {
    return null;
  }
  const resolvedRoot = path.resolve(rootDir);
  const absPath = path.resolve(resolvedRoot, contentPath);
  if (!absPath.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error(`禁止读取项目根目录之外的文章文件: ${contentPath}`);
  }
  return readJsonOrNull<StoredArticleContent>(absPath);
}
