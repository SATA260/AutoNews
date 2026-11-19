import path from 'node:path';
import type {
  ArticleMediaAsset,
  ArticleMediaKind,
  ExtractStatus,
  SourceLang,
} from '@aidaily/contracts';
import { Readability } from '@mozilla/readability';
import { JSDOM, VirtualConsole } from 'jsdom';
import { readJsonOrNull } from '../storage/files.js';
import type { DomChartFragment } from './browser-driver.js';
import { parsePublishedAt } from './feed-parser.js';
import { sleepWithAbort } from './fetcher.js';
import { extractTweetIdFromUrl, type TweetLinkRef } from './x-collector.js';

const DEFAULT_HTML_TIMEOUT_MS = 15_000;
const DEFAULT_HTML_RETRIES = 2;
const DEFAULT_HTML_RETRY_DELAY_MS = 500;
const RETRYABLE_HTML_STATUS_CODES = new Set([408, 425, 429, 500, 502, 503, 504]);
const MAX_HTML_BYTES = 5 * 1024 * 1024;
const BROWSER_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const CHART_SIGNAL_REGEX =
  /\b(?:benchmark|benchmarks|eval|evals|swe-bench|gpqa|mmlu|aime|livecodebench|humaneval|arena|elo|leaderboard|score|scores|accuracy|pricing|price|cost|costs|tokens?|throughput|latency|ttft|comparison|compare|vs|chart|graph|plot|table)\b|跑分|评测|测评|基准|榜单|得分|准确率|性能|对比|比较|成本|价格|定价|费用|百万\s*token|输入|输出|吞吐|延迟|图表/i;

const SCREENSHOT_SIGNAL_REGEX =
  /\b(?:architecture|diagram|pipeline|workflow|interface|screenshot|terminal|console|demo|preview|ui)\b|架构|流程|原理|界面|截图|实测|演示|终端/i;

const NOISE_IMAGE_REGEX =
  /(?:avatar|gravatar|author[-_]?photo|emoji|favicon|sprite|qrcode|qr[-_]?code|wechat[-_]?qr|follow[-_]?us|badge|pixel|1x1|spacer|tracking|share[-_]?btn)/i;

const TABLE_NUMERIC_REGEX =
  /(?:\d+(?:\.\d+)?\s*%|\$\s*\d+|¥\s*\d+|￥\s*\d+|\d+\s*(?:ms|s|tok\/s|tps|B|M|K)\b|1M\s*tokens?|pass@1|elo)/i;

const TABLE_TOPIC_REGEX =
  /(?:model|benchmark|eval|score|accuracy|swe-bench|gpqa|mmlu|aime|price|pricing|cost|input|output|token|latency|throughput|gpt|claude|gemini|deepseek|qwen|llama|grok|模型|跑分|评测|基准|得分|价格|定价|成本|输入|输出|百万)/i;

/** 从文章或订阅片段中抽取出的单张候选配图及价值评分 */
export interface ExtractedImageCandidate {
  url: string;
  kind: ArticleMediaKind;
  captionHint: string;
  contextSnippet: string;
  score: number;
  width?: number;
  height?: number;
}

/** 文章正文与配图提取后的结构化结果 */
export interface ExtractedArticleContent {
  extractStatus: ExtractStatus;
  text: string;
  excerpt: string;
  contentChars: number;
  ogImageUrl: string | null;
  detectedPublishedAt: string | null;
  candidateImages: ExtractedImageCandidate[];
  domChartFragments: DomChartFragment[];
  embeddedTweets: TweetLinkRef[];
}

/** 写入本地磁盘缓存的文章正文完整 JSON 结构 */
export interface StoredArticleContent {
  url: string;
  title: string;
  lang: SourceLang;
  publishedAt: string | null;
  hasExplicitPublishedAt?: boolean;
  text: string;
  feedContent: string | null;
  mediaAssets?: ArticleMediaAsset[];
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

/** 解包 Next.js 图片代理路径并升级 Twitter 原图链接至高清晰度版本 */
function normalizeImageCandidateUrl(resolved: URL): string {
  if (resolved.pathname === '/_next/image' && resolved.searchParams.has('url')) {
    const inner = resolved.searchParams.get('url');
    if (inner) {
      try {
        const innerUrl = new URL(inner, resolved.origin);
        if (innerUrl.protocol === 'http:' || innerUrl.protocol === 'https:') {
          return normalizeImageCandidateUrl(innerUrl);
        }
      } catch {
        // 内部路径无法独立解析时保留原地址
      }
    }
  }
  if (resolved.hostname.endsWith('twimg.com') && resolved.pathname.startsWith('/media/')) {
    if (!resolved.searchParams.get('name')) {
      resolved.searchParams.set('name', 'large');
    }
  }
  return resolved.toString();
}

/** 将疑似相对链接解析为安全的 http/https 地址，无效或内联数据返回 null */
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
    return normalizeImageCandidateUrl(resolved);
  } catch {
    return null;
  }
}

/** 从响应式 `srcset` 属性中挑出分辨率最高的一张图片链接 */
function pickBestSrcFromSrcset(srcset: string | null, articleUrl: string): string | null {
  if (!srcset) {
    return null;
  }
  let bestUrl: string | null = null;
  let bestWeight = -1;
  for (const part of srcset.split(',')) {
    const tokens = part.trim().split(/\s+/);
    const rawUrl = tokens[0];
    if (!rawUrl) {
      continue;
    }
    const resolved = resolveHttpImageUrl(rawUrl, articleUrl);
    if (!resolved) {
      continue;
    }
    const descriptor = tokens[1] ?? '';
    let weight = 1;
    if (descriptor.endsWith('w')) {
      weight = Number.parseFloat(descriptor) || 1;
    } else if (descriptor.endsWith('x')) {
      weight = (Number.parseFloat(descriptor) || 1) * 1000;
    }
    if (weight > bestWeight) {
      bestWeight = weight;
      bestUrl = resolved;
    }
  }
  return bestUrl;
}

/** 解析 HTML 元素上的整型像素尺寸属性值 */
function parsePositiveDimension(raw: string | null): number | undefined {
  if (!raw) {
    return undefined;
  }
  const parsed = Number.parseInt(raw.trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

/** 过滤头像、小图标、装饰分隔条及跟踪像素等无效噪声图片 */
function isNoiseImage(opts: {
  url: string;
  alt: string;
  className: string;
  id: string;
  width?: number;
  height?: number;
}): boolean {
  try {
    const pathname = new URL(opts.url).pathname.toLowerCase();
    if (pathname.endsWith('.svg') || pathname.endsWith('.ico')) {
      return true;
    }
  } catch {
    return true;
  }

  if (opts.width !== undefined && opts.width < 220) {
    return true;
  }
  if (opts.height !== undefined && opts.height < 110) {
    return true;
  }
  if (opts.width && opts.height && opts.width / opts.height > 5.5) {
    return true;
  }

  const combined = `${opts.url} ${opts.alt} ${opts.className} ${opts.id}`;
  if (NOISE_IMAGE_REGEX.test(combined)) {
    return true;
  }
  if (
    /\blogo\b/i.test(`${opts.className} ${opts.id} ${opts.alt}`) &&
    !CHART_SIGNAL_REGEX.test(combined)
  ) {
    return true;
  }
  return false;
}

/** 为候选图片根据位置、图注和周边文字线索计算信息价值分与素材类别 */
function scoreImageCandidate(opts: {
  url: string;
  captionHint: string;
  contextSnippet: string;
  inFigure: boolean;
  fromMetaOg: boolean;
  fromFeed: boolean;
  width?: number;
}): { kind: ArticleMediaKind; score: number } {
  const signalText = `${opts.url} ${opts.captionHint} ${opts.contextSnippet}`;
  let base = opts.fromMetaOg ? 20 : opts.inFigure ? 60 : opts.fromFeed ? 40 : 45;
  let kind: ArticleMediaKind = opts.fromMetaOg ? 'cover' : 'screenshot';

  if (CHART_SIGNAL_REGEX.test(signalText)) {
    kind = 'chart';
    base += 32;
  } else if (SCREENSHOT_SIGNAL_REGEX.test(signalText)) {
    kind = 'screenshot';
    base += 20;
  }

  if (opts.width && opts.width >= 900) {
    base += 5;
  }

  return {
    kind,
    score: Math.min(98, Math.max(10, base)),
  };
}

/** 从 DOM 中收集图注和相邻标题或段落上下文文本 */
function readImageContext(img: Element): { captionHint: string; contextSnippet: string } {
  const figure = img.closest('figure');
  const figcaption = normalizeSingleLineText(
    figure?.querySelector('figcaption')?.textContent ?? '',
  );
  const alt = normalizeSingleLineText(img.getAttribute('alt') ?? '');
  const titleAttr = normalizeSingleLineText(img.getAttribute('title') ?? '');
  const captionHint = (figcaption || alt || titleAttr).slice(0, 80);

  const anchorEl = figure ?? img.parentElement ?? img;
  const parts: string[] = [];
  let sibling = anchorEl.previousElementSibling;
  for (let i = 0; i < 2 && sibling; i++) {
    const txt = normalizeSingleLineText(sibling.textContent ?? '');
    if (txt) {
      parts.unshift(txt.slice(0, 120));
    }
    sibling = sibling.previousElementSibling;
  }
  const nextTxt = normalizeSingleLineText(anchorEl.nextElementSibling?.textContent ?? '');
  if (nextTxt) {
    parts.push(nextTxt.slice(0, 100));
  }

  return {
    captionHint,
    contextSnippet: parts.join(' ').slice(0, 220),
  };
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

/**
 * 从网页元信息、JSON-LD 结构化数据及正文 `<time>` 标签中提取真实发布时间（UTC ISO 格式）。
 */
export function extractPublishedAtFromDom(doc: Document, defaultTimezone = 'UTC'): string | null {
  const metaSelectors = [
    'meta[property="article:published_time"]',
    'meta[name="article:published_time"]',
    'meta[property="og:published_time"]',
    'meta[name="pubdate"]',
    'meta[name="publishdate"]',
    'meta[name="publish-date"]',
    'meta[name="date"]',
    'meta[name="DC.date.issued"]',
  ];
  for (const selector of metaSelectors) {
    const raw = doc.querySelector(selector)?.getAttribute('content') ?? null;
    const parsed = parsePublishedAt(raw, defaultTimezone);
    if (parsed) {
      return parsed;
    }
  }

  for (const script of doc.querySelectorAll('script[type="application/ld+json"]')) {
    const raw = script.textContent?.trim();
    if (!raw) {
      continue;
    }
    try {
      const queue: unknown[] = [JSON.parse(raw)];
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
        for (const key of ['datePublished', 'dateCreated']) {
          if (typeof rec[key] === 'string') {
            const parsed = parsePublishedAt(rec[key], defaultTimezone);
            if (parsed) {
              return parsed;
            }
          }
        }
        for (const val of Object.values(rec)) {
          if (val && typeof val === 'object') {
            queue.push(val);
          }
        }
      }
    } catch {
      // 忽略异常格式的 JSON-LD 脚本
    }
  }

  for (const timeEl of doc.querySelectorAll(
    'article time[datetime], main time[datetime], time[datetime]',
  )) {
    const parsed = parsePublishedAt(timeEl.getAttribute('datetime'), defaultTimezone);
    if (parsed) {
      return parsed;
    }
  }

  return null;
}

/**
 * 提取网页正文与订阅片段中的全部有效配图，过滤装饰图标后按图表/截图价值降序评分。
 */
export function extractCandidateImagesFromDom(
  doc: Document,
  articleUrl: string,
  opts?: { feedContent?: string | null; feedSummary?: string | null; ogImageUrl?: string | null },
): ExtractedImageCandidate[] {
  const byUrl = new Map<string, ExtractedImageCandidate>();

  const registerImg = (img: Element, fromFeed: boolean) => {
    if (!fromFeed && img.closest('header, footer, nav, aside')) {
      return;
    }
    const picture = img.closest('picture');
    const sourceSrcset = picture?.querySelector('source')?.getAttribute('srcset') ?? null;
    const bestFromSrcset =
      pickBestSrcFromSrcset(
        img.getAttribute('srcset') ?? img.getAttribute('data-srcset'),
        articleUrl,
      ) ?? pickBestSrcFromSrcset(sourceSrcset, articleUrl);
    const rawSrc =
      bestFromSrcset ??
      img.getAttribute('data-src') ??
      img.getAttribute('data-original') ??
      img.getAttribute('src');
    const resolvedUrl = resolveHttpImageUrl(rawSrc, articleUrl);
    if (!resolvedUrl) {
      return;
    }

    const alt = img.getAttribute('alt') ?? '';
    const className = img.getAttribute('class') ?? '';
    const id = img.getAttribute('id') ?? '';
    const width = parsePositiveDimension(img.getAttribute('width'));
    const height = parsePositiveDimension(img.getAttribute('height'));
    if (isNoiseImage({ url: resolvedUrl, alt, className, id, width, height })) {
      return;
    }

    const inFigure = Boolean(img.closest('figure'));
    const { captionHint, contextSnippet } = readImageContext(img);
    const { kind, score } = scoreImageCandidate({
      url: resolvedUrl,
      captionHint,
      contextSnippet,
      inFigure,
      fromMetaOg: false,
      fromFeed,
      width,
    });

    const prev = byUrl.get(resolvedUrl);
    if (!prev || score > prev.score) {
      byUrl.set(resolvedUrl, {
        url: resolvedUrl,
        kind,
        captionHint,
        contextSnippet,
        score,
        ...(width ? { width } : {}),
        ...(height ? { height } : {}),
      });
    }
  };

  const mainScopes = doc.querySelectorAll(
    'article, main, [role="main"], .post-content, .article-content, .entry-content',
  );
  if (mainScopes.length > 0) {
    for (const scope of mainScopes) {
      for (const img of scope.querySelectorAll('img')) {
        registerImg(img, false);
      }
    }
  } else {
    for (const img of doc.querySelectorAll('body img')) {
      registerImg(img, false);
    }
  }

  for (const fragment of [opts?.feedContent ?? null, opts?.feedSummary ?? null]) {
    if (!fragment) {
      continue;
    }
    const fragDom = new JSDOM(`<body>${fragment}</body>`, {
      url: articleUrl,
      virtualConsole: createSilentVirtualConsole(),
    });
    try {
      for (const img of fragDom.window.document.querySelectorAll('img')) {
        registerImg(img, true);
      }
    } finally {
      fragDom.window.close();
    }
  }

  const ogUrl = opts?.ogImageUrl ?? extractOgImageFromDom(doc, articleUrl);
  if (ogUrl && !byUrl.has(ogUrl)) {
    const scored = scoreImageCandidate({
      url: ogUrl,
      captionHint: '',
      contextSnippet: '',
      inFigure: false,
      fromMetaOg: true,
      fromFeed: false,
    });
    byUrl.set(ogUrl, {
      url: ogUrl,
      kind: scored.kind,
      captionHint: '',
      contextSnippet: '',
      score: scored.score,
    });
  }

  return Array.from(byUrl.values()).sort((a, b) => b.score - a.score);
}

/** 清理将送入局部截图页面的 HTML 表格或 SVG 节点，剥离脚本与危险属性 */
function sanitizeFragmentNode(node: Element): string {
  const clone = node.cloneNode(true) as Element;
  for (const unsafe of clone.querySelectorAll('script, iframe, object, embed')) {
    unsafe.remove();
  }
  const allEls = [clone, ...Array.from(clone.querySelectorAll('*'))];
  for (const el of allEls) {
    for (const attr of Array.from(el.attributes)) {
      if (attr.name.toLowerCase().startsWith('on')) {
        el.removeAttribute(attr.name);
      }
    }
  }
  return clone.outerHTML;
}

/**
 * 识别网页正文中的模型评测跑分表格、API 价格对比表以及带数据标签的矢量图表片段。
 */
export function extractDomChartFragments(doc: Document): DomChartFragment[] {
  const fragments: DomChartFragment[] = [];
  const rootScopes = doc.querySelectorAll('article, main, [role="main"], body');
  const seenHtml = new Set<string>();

  for (const scope of rootScopes) {
    for (const table of scope.querySelectorAll('table')) {
      if (fragments.length >= 2) {
        return fragments;
      }
      if (table.closest('header, footer, nav, td, th')) {
        continue;
      }
      const rows = table.querySelectorAll('tr');
      if (rows.length < 2 || rows.length > 32) {
        continue;
      }
      let maxCols = 0;
      for (const row of rows) {
        const cols = row.querySelectorAll('th, td').length;
        if (cols > maxCols) {
          maxCols = cols;
        }
      }
      if (maxCols < 2) {
        continue;
      }
      const text = normalizeSingleLineText(table.textContent ?? '');
      if (text.length < 20 || text.length > 6000) {
        continue;
      }
      if (!TABLE_NUMERIC_REGEX.test(text) || !TABLE_TOPIC_REGEX.test(text)) {
        continue;
      }

      const caption = normalizeSingleLineText(table.querySelector('caption')?.textContent ?? '');
      const prevHeading = table.previousElementSibling?.matches('h1,h2,h3,h4,strong,p')
        ? normalizeSingleLineText(table.previousElementSibling.textContent ?? '').slice(0, 80)
        : '';
      const titleHint = (caption || prevHeading).slice(0, 60) || undefined;
      const html = sanitizeFragmentNode(table);
      if (!seenHtml.has(html)) {
        seenHtml.add(html);
        fragments.push({ kind: 'table', html, titleHint });
      }
    }

    for (const fig of scope.querySelectorAll('figure')) {
      if (fragments.length >= 2) {
        return fragments;
      }
      if (fig.closest('header, footer, nav')) {
        continue;
      }
      const svg = fig.querySelector('svg');
      if (!svg) {
        continue;
      }
      const textNodes = svg.querySelectorAll('text').length;
      if (textNodes < 4) {
        continue;
      }
      const viewBox = svg.getAttribute('viewBox') ?? '';
      const vbParts = viewBox
        .trim()
        .split(/[\s,]+/)
        .map(Number);
      const vbWidth =
        vbParts.length === 4 ? vbParts[2] : parsePositiveDimension(svg.getAttribute('width'));
      const vbHeight =
        vbParts.length === 4 ? vbParts[3] : parsePositiveDimension(svg.getAttribute('height'));
      if ((vbWidth !== undefined && vbWidth < 280) || (vbHeight !== undefined && vbHeight < 140)) {
        continue;
      }
      const titleHint =
        normalizeSingleLineText(fig.querySelector('figcaption')?.textContent ?? '').slice(0, 60) ||
        undefined;
      const html = sanitizeFragmentNode(svg);
      if (!seenHtml.has(html)) {
        seenHtml.add(html);
        fragments.push({ kind: 'svg', html, titleHint });
      }
    }
  }

  return fragments;
}

/**
 * 提取文章正文及订阅内容中嵌入或引用的 X / Twitter 状态链接（单篇最多保留前 2 条）。
 */
export function extractEmbeddedTweetRefs(
  doc: Document,
  feedContent?: string | null,
  feedSummary?: string | null,
): TweetLinkRef[] {
  const byId = new Map<string, TweetLinkRef>();

  const scanContainer = (container: ParentNode) => {
    for (const anchor of container.querySelectorAll(
      'blockquote.twitter-tweet a[href], article a[href], main a[href], a[href]',
    )) {
      if (anchor.closest('header, footer, nav')) {
        continue;
      }
      const href = anchor.getAttribute('href');
      if (!href) {
        continue;
      }
      const ref = extractTweetIdFromUrl(href);
      if (ref && !byId.has(ref.tweetId)) {
        byId.set(ref.tweetId, ref);
        if (byId.size >= 2) {
          return;
        }
      }
    }
  };

  scanContainer(doc);
  if (byId.size < 2) {
    for (const frag of [feedContent ?? null, feedSummary ?? null]) {
      if (!frag) {
        continue;
      }
      const fragDom = new JSDOM(`<body>${frag}</body>`, {
        virtualConsole: createSilentVirtualConsole(),
      });
      try {
        scanContainer(fragDom.window.document);
      } finally {
        fragDom.window.close();
      }
      if (byId.size >= 2) {
        break;
      }
    }
  }

  return Array.from(byId.values()).slice(0, 2);
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
export async function readTextWithLimit(res: Response, maxBytes: number): Promise<string> {
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

/**
 * 下载文章原网页 HTML，遇到临时网络错误、超时或服务端拥堵状态码时按次数退避重试；
 * 对永久不存在或非网页响应直接返回 null（若外层主动取消则抛出取消异常）。
 */
export async function fetchArticleHtml(
  url: string,
  fetchImpl: typeof fetch,
  opts?: { timeoutMs?: number; retries?: number; retryDelayMs?: number; signal?: AbortSignal },
): Promise<string | null> {
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_HTML_TIMEOUT_MS;
  const maxAttempts = 1 + Math.max(0, opts?.retries ?? DEFAULT_HTML_RETRIES);
  const retryDelayMs = opts?.retryDelayMs ?? DEFAULT_HTML_RETRY_DELAY_MS;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (opts?.signal?.aborted) {
      throw new DOMException('已取消', 'AbortError');
    }

    const timeoutSignal = AbortSignal.timeout(timeoutMs);
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
        if (RETRYABLE_HTML_STATUS_CODES.has(res.status) && attempt < maxAttempts) {
          await sleepWithAbort(retryDelayMs * attempt, opts?.signal);
          continue;
        }
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
      if (attempt < maxAttempts) {
        await sleepWithAbort(retryDelayMs * attempt, opts?.signal);
        continue;
      }
      return null;
    }
  }

  return null;
}

/**
 * 提取文章可用正文、真实发布时间、多张候选配图、原生数据表片段及文内引用推文：
 * 默认优先解析原网页正文（满 400 字标记为 ok），不足时回退订阅全文或摘要（满 200 字标记为 feed_only）；
 * 针对 X 短贴等显式传入自定义最小字数门槛的来源，达到门槛即放行入库。
 */
export function extractArticleContent(opts: {
  url: string;
  html: string | null;
  feedContent: string | null;
  feedSummary: string | null;
  minContentChars?: number;
  defaultTimezone?: string;
}): ExtractedArticleContent {
  let readabilityText = '';
  let ogImageUrl: string | null = null;
  let detectedPublishedAt: string | null = null;
  let candidateImages: ExtractedImageCandidate[] = [];
  let domChartFragments: DomChartFragment[] = [];
  let embeddedTweets: TweetLinkRef[] = [];

  if (opts.html && opts.html.trim().length > 0) {
    const dom = new JSDOM(opts.html, {
      url: opts.url,
      virtualConsole: createSilentVirtualConsole(),
    });
    try {
      const doc = dom.window.document;
      ogImageUrl = extractOgImageFromDom(doc, opts.url);
      detectedPublishedAt = extractPublishedAtFromDom(doc, opts.defaultTimezone);
      candidateImages = extractCandidateImagesFromDom(doc, opts.url, {
        feedContent: opts.feedContent,
        feedSummary: opts.feedSummary,
        ogImageUrl,
      });
      domChartFragments = extractDomChartFragments(doc);
      embeddedTweets = extractEmbeddedTweetRefs(doc, opts.feedContent, opts.feedSummary);

      const parsed = new Readability(doc).parse();
      if (parsed?.textContent) {
        readabilityText = normalizeMultilineText(parsed.textContent);
      }
    } catch {
      // Readability 遇到畸形页面结构时降级走订阅内容回退逻辑
    } finally {
      dom.window.close();
    }
  } else {
    const emptyDom = new JSDOM('<body></body>', {
      url: opts.url,
      virtualConsole: createSilentVirtualConsole(),
    });
    try {
      candidateImages = extractCandidateImagesFromDom(emptyDom.window.document, opts.url, {
        feedContent: opts.feedContent,
        feedSummary: opts.feedSummary,
      });
      embeddedTweets = extractEmbeddedTweetRefs(
        emptyDom.window.document,
        opts.feedContent,
        opts.feedSummary,
      );
    } finally {
      emptyDom.window.close();
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
      detectedPublishedAt,
      candidateImages,
      domChartFragments,
      embeddedTweets,
    };
  }

  const feedContentText = opts.feedContent ? htmlToPlainText(opts.feedContent, opts.url) : '';
  const feedSummaryText = opts.feedSummary ? htmlToPlainText(opts.feedSummary, opts.url) : '';
  const fallbackText =
    feedContentText.length >= feedSummaryText.length ? feedContentText : feedSummaryText;

  if (opts.minContentChars !== undefined && fallbackText.length >= opts.minContentChars) {
    const excerpt = normalizeSingleLineText(fallbackText).slice(0, 300);
    return {
      extractStatus: 'ok',
      text: fallbackText,
      excerpt,
      contentChars: fallbackText.length,
      ogImageUrl,
      detectedPublishedAt,
      candidateImages,
      domChartFragments,
      embeddedTweets,
    };
  }

  if (fallbackText.length >= 200) {
    const excerpt = normalizeSingleLineText(fallbackText).slice(0, 300);
    return {
      extractStatus: 'feed_only',
      text: fallbackText,
      excerpt,
      contentChars: fallbackText.length,
      ogImageUrl,
      detectedPublishedAt,
      candidateImages,
      domChartFragments,
      embeddedTweets,
    };
  }

  const excerpt = normalizeSingleLineText(fallbackText).slice(0, 300);
  return {
    extractStatus: 'failed',
    text: fallbackText,
    excerpt,
    contentChars: fallbackText.length,
    ogImageUrl,
    detectedPublishedAt,
    candidateImages,
    domChartFragments,
    embeddedTweets,
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
