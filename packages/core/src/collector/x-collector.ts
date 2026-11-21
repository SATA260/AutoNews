import fs from 'node:fs/promises';
import type { SourceDef } from '@aidaily/contracts';
import { chromium } from 'playwright';
import { resolveChromiumExecutablePath } from '../media/browser.js';
import { writeFileAtomic } from '../storage/files.js';
import type { CollectorBrowserDriver, RawXTweet } from './browser-driver.js';
import type { ParsedFeedItem } from './feed-parser.js';

/** X 平台会话凭证缺失时抛出的专用提示异常（不计入信源连续故障告警） */
export class XCookieMissingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'XCookieMissingError';
  }
}

/** 规范化后的浏览器 Cookie 条目结构 */
export interface NormalizedBrowserCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  sameSite: 'Strict' | 'Lax' | 'None';
  expires?: number;
}

/** 本机 X 会话凭证检查结果 */
export interface XAuthStatus {
  configured: boolean;
  cookiePath: string;
  cookieCount: number;
  hasAuthToken: boolean;
  hasCt0: boolean;
  detail: string;
}

/** 带原始推文结构化数据的订阅条目 */
export interface ParsedXFeedItem extends ParsedFeedItem {
  tweetData: RawXTweet;
}

/** 从单个推文或引用推文链接中解析出的账号与推文编号 */
export interface TweetLinkRef {
  handle: string;
  tweetId: string;
  url: string;
}

const DEFAULT_X_COOKIE_TIMEOUT_MS = 180_000;
const DEFAULT_SYNDICATION_TIMEOUT_MS = 10_000;

/** 从 X / Twitter 状态链接中提取博主账号与推文数字编号 */
export function extractTweetIdFromUrl(rawUrl: string): TweetLinkRef | null {
  try {
    const parsed = new URL(rawUrl.trim());
    const host = parsed.hostname.replace(/^www\./i, '').toLowerCase();
    if (host !== 'x.com' && host !== 'twitter.com' && host !== 'mobile.twitter.com') {
      return null;
    }
    const match = /^\/([A-Za-z0-9_]{1,20})\/status\/(\d+)/.exec(parsed.pathname);
    if (!match?.[1] || !match[2]) {
      return null;
    }
    const handle = match[1];
    const tweetId = match[2];
    return {
      handle,
      tweetId,
      url: `https://x.com/${handle}/status/${tweetId}`,
    };
  } catch {
    return null;
  }
}

/** 将浏览器插件或 Playwright 导出的 `sameSite` 字符串统一转为标准值 */
function normalizeSameSite(raw: unknown): 'Strict' | 'Lax' | 'None' {
  if (typeof raw !== 'string') {
    return 'Lax';
  }
  const lower = raw.trim().toLowerCase();
  if (lower === 'strict') {
    return 'Strict';
  }
  if (lower === 'no_restriction' || lower === 'none') {
    return 'None';
  }
  return 'Lax';
}

/** 将单条 Cookie 原始记录标准化为 Playwright 可加载格式 */
function normalizeSingleCookie(raw: Record<string, unknown>): NormalizedBrowserCookie | null {
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  const value = typeof raw.value === 'string' ? raw.value : '';
  if (!name || !value) {
    return null;
  }
  let domain = typeof raw.domain === 'string' ? raw.domain.trim() : '.x.com';
  if (!domain) {
    domain = '.x.com';
  }
  if (domain === 'x.com' || domain === 'twitter.com') {
    domain = `.${domain}`;
  }
  const cookiePath =
    typeof raw.path === 'string' && raw.path.trim().startsWith('/') ? raw.path.trim() : '/';
  const rawExpires =
    typeof raw.expires === 'number'
      ? raw.expires
      : typeof raw.expirationDate === 'number'
        ? raw.expirationDate
        : undefined;
  const expires =
    rawExpires !== undefined && Number.isFinite(rawExpires) && rawExpires > 0
      ? Math.floor(rawExpires)
      : undefined;

  return {
    name,
    value,
    domain,
    path: cookiePath,
    secure: typeof raw.secure === 'boolean' ? raw.secure : true,
    httpOnly: typeof raw.httpOnly === 'boolean' ? raw.httpOnly : name === 'auth_token',
    sameSite: normalizeSameSite(raw.sameSite),
    ...(expires !== undefined ? { expires } : {}),
  };
}

/**
 * 解析并校验本地保存或外部导入的 X Cookie 内容。
 * 兼容 Netscape `cookies.txt`、Playwright storageState、浏览器插件导出数组以及 `{ auth_token, ct0 }` 键值简写格式。
 */
export function parseXCookiesFromText(rawJson: string): NormalizedBrowserCookie[] {
  const trimmed = rawJson.trim();
  const rawEntries: Array<Record<string, unknown>> = [];

  if (trimmed && !trimmed.startsWith('{') && !trimmed.startsWith('[')) {
    for (const rawLine of trimmed.split(/\r?\n/)) {
      let line = rawLine.trim();
      if (!line) {
        continue;
      }
      let httpOnly = false;
      if (line.startsWith('#HttpOnly_')) {
        httpOnly = true;
        line = line.slice('#HttpOnly_'.length);
      } else if (line.startsWith('#')) {
        continue;
      }
      const cols = line.split('\t');
      if (cols.length >= 7 && cols[0] && cols[5] && cols[6]) {
        const expNum = Number(cols[4]);
        rawEntries.push({
          domain: cols[0],
          path: cols[2] || '/',
          secure: cols[3]?.toUpperCase() === 'TRUE',
          httpOnly,
          ...(Number.isFinite(expNum) && expNum > 0 ? { expires: expNum } : {}),
          name: cols[5],
          value: cols[6],
        });
      }
    }
  }

  if (rawEntries.length === 0) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawJson);
    } catch (err) {
      throw new Error(
        `X Cookie 文件不是合法的 JSON 或 Netscape cookies.txt: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }

    if (Array.isArray(parsed)) {
      for (const item of parsed) {
        if (item && typeof item === 'object' && !Array.isArray(item)) {
          rawEntries.push(item as Record<string, unknown>);
        }
      }
    } else if (parsed && typeof parsed === 'object') {
      const obj = parsed as Record<string, unknown>;
      if (Array.isArray(obj.cookies)) {
        for (const item of obj.cookies) {
          if (item && typeof item === 'object' && !Array.isArray(item)) {
            rawEntries.push(item as Record<string, unknown>);
          }
        }
      } else {
        for (const [k, v] of Object.entries(obj)) {
          if (typeof v === 'string' && v.trim()) {
            rawEntries.push({ name: k, value: v.trim(), domain: '.x.com', path: '/' });
          }
        }
      }
    }
  }

  const deduped = new Map<string, NormalizedBrowserCookie>();
  for (const entry of rawEntries) {
    const normalized = normalizeSingleCookie(entry);
    if (!normalized) {
      continue;
    }
    // 仅保留 X / Twitter 相关域的 Cookie，避免无关站点 Cookie 污染会话
    const lowerDomain = normalized.domain.toLowerCase();
    if (!lowerDomain.includes('x.com') && !lowerDomain.includes('twitter.com')) {
      continue;
    }
    deduped.set(`${normalized.domain}:${normalized.name}`, normalized);
  }

  const result = Array.from(deduped.values());
  if (!result.some((c) => c.name === 'auth_token')) {
    throw new Error('X Cookie 中缺少必需的登录令牌 auth_token，请确认已完整登录 X 后再导出');
  }

  // 若仅有 .x.com 核心令牌，同时补齐 .twitter.com 以兼容嵌入式跳转与旧接口域
  for (const coreName of ['auth_token', 'ct0']) {
    const xEntry = result.find((c) => c.name === coreName && c.domain.includes('x.com'));
    const hasTwitter = result.some((c) => c.name === coreName && c.domain.includes('twitter.com'));
    if (xEntry && !hasTwitter) {
      result.push({ ...xEntry, domain: '.twitter.com' });
    }
  }

  return result;
}

/** 读取并检查本地 X 登录凭证文件状态 */
export async function inspectXCookieFile(cookieFileAbs: string): Promise<XAuthStatus> {
  try {
    const raw = await fs.readFile(cookieFileAbs, 'utf8');
    const cookies = parseXCookiesFromText(raw);
    const hasAuthToken = cookies.some((c) => c.name === 'auth_token');
    const hasCt0 = cookies.some((c) => c.name === 'ct0');
    return {
      configured: hasAuthToken,
      cookiePath: cookieFileAbs,
      cookieCount: cookies.length,
      hasAuthToken,
      hasCt0,
      detail: hasCt0
        ? `已配置 X 登录凭证（共 ${cookies.length} 条 Cookie，含 auth_token 与 ct0）`
        : `已配置 X 登录凭证（含 auth_token，建议同时登录获取 ct0）`,
    };
  } catch (err) {
    const isMissing = (err as NodeJS.ErrnoException)?.code === 'ENOENT';
    return {
      configured: false,
      cookiePath: cookieFileAbs,
      cookieCount: 0,
      hasAuthToken: false,
      hasCt0: false,
      detail: isMissing
        ? `未找到 X 登录凭证文件 (${cookieFileAbs})`
        : `X 登录凭证不可用：${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/** 校验并原子保存外部导入的 X Cookie 到私有密钥目录（权限 600） */
export async function importXCookieFile(
  rawJson: string,
  cookieFileAbs: string,
): Promise<XAuthStatus> {
  const cookies = parseXCookiesFromText(rawJson);
  await writeFileAtomic(cookieFileAbs, `${JSON.stringify({ cookies }, null, 2)}\n`, {
    mode: 0o600,
  });
  return inspectXCookieFile(cookieFileAbs);
}

/** 打开本地可视浏览器引导用户登录 X，并在检测到完整登录令牌后自动保存 Cookie */
export async function interactiveXLogin(
  cookieFileAbs: string,
  opts?: { timeoutMs?: number },
): Promise<XAuthStatus> {
  const executablePath = await resolveChromiumExecutablePath();
  const browser = await chromium.launch({
    headless: false,
    ...(executablePath ? { executablePath } : {}),
  });

  const timeoutMs = opts?.timeoutMs ?? DEFAULT_X_COOKIE_TIMEOUT_MS;
  try {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 860 },
    });
    const page = await context.newPage();
    await page.goto('https://x.com/i/flow/login', {
      waitUntil: 'domcontentloaded',
      timeout: 30_000,
    });

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (page.isClosed()) {
        throw new Error('登录窗口已被提前关闭，未检测到 X 登录凭证');
      }
      const cookies = await context.cookies(['https://x.com', 'https://twitter.com']);
      const hasAuth = cookies.some((c) => c.name === 'auth_token' && c.value.trim().length > 0);
      const hasCt0 = cookies.some((c) => c.name === 'ct0' && c.value.trim().length > 0);
      if (hasAuth && hasCt0) {
        const normalized = cookies
          .map((c) =>
            normalizeSingleCookie({
              name: c.name,
              value: c.value,
              domain: c.domain,
              path: c.path,
              secure: c.secure,
              httpOnly: c.httpOnly,
              sameSite: c.sameSite,
              expires: c.expires,
            }),
          )
          .filter((c): c is NormalizedBrowserCookie => c !== null);
        await writeFileAtomic(
          cookieFileAbs,
          `${JSON.stringify({ cookies: normalized }, null, 2)}\n`,
          { mode: 0o600 },
        );
        return inspectXCookieFile(cookieFileAbs);
      }
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    throw new Error('等待 X 登录超时，请重新执行命令并在打开的浏览器中完成登录');
  } finally {
    await browser.close().catch(() => undefined);
  }
}

const X_TIMELINE_GRAPHQL_PATTERN =
  /\/graphql\/[^/]+\/[^/?]*(?:UserOriginalsTimeline|UserTweets(?:AndReplies)?|List(?:Latest)?TweetsTimeline|TweetDetail|UserBy)/i;
const TRUNCATED_TWEET_END_PUNCT_RE = /[.!?。！？"”'’)\]】》…👇✨🚀🔥👀\d]$/u;
const TRUNCATED_TWEET_DANGLING_WORD_RE =
  /\b(?:the|a|an|in|of|to|and|with|for|is|was|are|were|that|on|at|by|from|as|but|or|its|their|our|your|this|these|those|which|where|when|while|into|about|over|under|after|before|between|through|during|without|within|behind|than|per)\s*$/i;

/** 判断网络请求链接是否为 X 时间线或推文详情 GraphQL 接口 */
export function isXTimelineGraphQlUrl(url: string): boolean {
  if (!url.includes('/i/api/graphql/') && !url.includes('/graphql/')) {
    return false;
  }
  return X_TIMELINE_GRAPHQL_PATTERN.test(url);
}

/**
 * 识别推文正文是否在 280 字折叠上限附近于半句话处被硬截断，
 * 用于拦截兜底提取或历史缓存中的残缺折叠推文。
 */
export function looksLikeTruncatedTweetText(text: string): boolean {
  const trimmed = text.trim();
  const len = Array.from(trimmed).length;
  if (len < 235 || len > 290) {
    return false;
  }
  if (TRUNCATED_TWEET_END_PUNCT_RE.test(trimmed)) {
    return false;
  }
  return TRUNCATED_TWEET_DANGLING_WORD_RE.test(trimmed);
}

/** 将正文里的非媒体 t.co 短链替换为 GraphQL 返回的真实展开链接 */
function expandTweetShortUrls(
  text: string,
  urlEntries: ReadonlyArray<{ shortUrl: string; expandedUrl: string }>,
): string {
  let out = text;
  for (const entry of urlEntries) {
    if (entry.shortUrl && entry.expandedUrl) {
      out = out.split(entry.shortUrl).join(entry.expandedUrl);
    }
  }
  return out;
}

/** 清理推文文本中的末尾追踪短链并保留完整段落换行 */
function cleanTweetText(rawText: string, mediaShortUrls: readonly string[]): string {
  let cleaned = rawText.replace(/\r\n?/g, '\n').trim();
  for (const shortUrl of mediaShortUrls) {
    if (shortUrl) {
      cleaned = cleaned.split(shortUrl).join('').trim();
    }
  }
  return cleaned.replace(/\n{3,}/g, '\n\n').trim();
}

/** 将推文配图地址升级为原尺寸高清下载链接 */
function toHighResXMediaUrl(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl.trim());
    if (parsed.hostname.endsWith('twimg.com') && parsed.pathname.startsWith('/media/')) {
      parsed.searchParams.set('name', 'orig');
      return parsed.toString();
    }
    return parsed.toString();
  } catch {
    return rawUrl;
  }
}

/** 解析单个 X GraphQL Tweet 结果节点（兼容可见性包装与新版用户信息结构） */
function parseSingleGraphQlTweetNode(rawNode: unknown): RawXTweet | null {
  if (!rawNode || typeof rawNode !== 'object' || Array.isArray(rawNode)) {
    return null;
  }
  let node = rawNode as Record<string, unknown>;
  if (node.__typename === 'TweetWithVisibilityResults' && node.tweet) {
    if (typeof node.tweet !== 'object' || node.tweet === null) {
      return null;
    }
    node = node.tweet as Record<string, unknown>;
  }

  const tweetId = typeof node.rest_id === 'string' ? node.rest_id.trim() : '';
  const legacy =
    node.legacy && typeof node.legacy === 'object'
      ? (node.legacy as Record<string, unknown>)
      : null;
  if (!tweetId || !legacy) {
    return null;
  }

  const userRes = (
    (node.core as Record<string, unknown> | undefined)?.user_results as
      | Record<string, unknown>
      | undefined
  )?.result as Record<string, unknown> | undefined;
  const userLegacy =
    userRes?.legacy && typeof userRes.legacy === 'object'
      ? (userRes.legacy as Record<string, unknown>)
      : null;
  const userCore =
    userRes?.core && typeof userRes.core === 'object'
      ? (userRes.core as Record<string, unknown>)
      : null;
  const userAvatar =
    userRes?.avatar && typeof userRes.avatar === 'object'
      ? (userRes.avatar as Record<string, unknown>)
      : null;

  const handle =
    (typeof userLegacy?.screen_name === 'string' && userLegacy.screen_name) ||
    (typeof userCore?.screen_name === 'string' && userCore.screen_name) ||
    'unknown';
  const authorName =
    (typeof userLegacy?.name === 'string' && userLegacy.name) ||
    (typeof userCore?.name === 'string' && userCore.name) ||
    handle;
  const avatarUrl =
    (typeof userLegacy?.profile_image_url_https === 'string' &&
      userLegacy.profile_image_url_https) ||
    (typeof userAvatar?.image_url === 'string' && userAvatar.image_url) ||
    null;

  const noteTweetObj =
    node.note_tweet && typeof node.note_tweet === 'object'
      ? (node.note_tweet as Record<string, unknown>)
      : undefined;
  const noteResult = (noteTweetObj?.note_tweet_results as Record<string, unknown> | undefined)
    ?.result as Record<string, unknown> | undefined;
  const noteText = noteResult?.text;
  const hasNoteText = typeof noteText === 'string' && noteText.trim().length > 0;
  const isTruncated = noteTweetObj?.is_expandable === true && !hasNoteText;
  const rawFullText = hasNoteText
    ? noteText
    : typeof legacy.full_text === 'string'
      ? legacy.full_text
      : '';

  const extMedia = (
    legacy.extended_entities as { media?: Array<Record<string, unknown>> } | undefined
  )?.media;
  const entMedia = (legacy.entities as { media?: Array<Record<string, unknown>> } | undefined)
    ?.media;
  const mediaList = extMedia ?? entMedia ?? [];
  const mediaUrls: string[] = [];
  const mediaShortUrls: string[] = [];
  for (const m of mediaList) {
    const mediaType = typeof m.type === 'string' ? m.type : 'photo';
    const mediaHttps = typeof m.media_url_https === 'string' ? m.media_url_https : null;
    if (
      mediaHttps &&
      (mediaType === 'photo' || mediaType === 'video' || mediaType === 'animated_gif')
    ) {
      mediaUrls.push(toHighResXMediaUrl(mediaHttps));
    }
    if (typeof m.url === 'string') {
      mediaShortUrls.push(m.url);
    }
  }

  const urlEntries: Array<{ shortUrl: string; expandedUrl: string }> = [];
  const collectEntityUrls = (rawList: unknown): void => {
    if (!Array.isArray(rawList)) {
      return;
    }
    for (const item of rawList) {
      if (!item || typeof item !== 'object') {
        continue;
      }
      const rec = item as Record<string, unknown>;
      const shortUrl = typeof rec.url === 'string' ? rec.url.trim() : '';
      const expandedUrl = typeof rec.expanded_url === 'string' ? rec.expanded_url.trim() : '';
      if (shortUrl && expandedUrl) {
        urlEntries.push({ shortUrl, expandedUrl });
      }
    }
  };
  collectEntityUrls((noteResult?.entity_set as Record<string, unknown> | undefined)?.urls);
  collectEntityUrls((legacy.entities as Record<string, unknown> | undefined)?.urls);

  const text = expandTweetShortUrls(cleanTweetText(rawFullText, mediaShortUrls), urlEntries);
  if (!text && mediaUrls.length === 0) {
    return null;
  }

  const createdRaw = typeof legacy.created_at === 'string' ? legacy.created_at : null;
  const createdMs = createdRaw ? Date.parse(createdRaw) : Number.NaN;
  const publishedAt = Number.isNaN(createdMs) ? null : new Date(createdMs).toISOString();

  const isRetweet = Boolean(legacy.retweeted_status_result);
  const inReplyTo =
    typeof legacy.in_reply_to_status_id_str === 'string' &&
    legacy.in_reply_to_status_id_str.trim().length > 0;
  const inReplyToUserId =
    typeof legacy.in_reply_to_user_id_str === 'string' ? legacy.in_reply_to_user_id_str : null;
  const selfUserId = typeof legacy.user_id_str === 'string' ? legacy.user_id_str : null;
  // 回复他人视为纯对话回复过滤掉；博主自己续写的串联长贴保留
  const isReply = inReplyTo && (!inReplyToUserId || !selfUserId || inReplyToUserId !== selfUserId);

  let quotedTweet: RawXTweet['quotedTweet'] = null;
  const quotedRaw = (node.quoted_status_result as { result?: unknown } | undefined)?.result;
  if (quotedRaw) {
    const parsedQuote = parseSingleGraphQlTweetNode(quotedRaw);
    if (parsedQuote) {
      quotedTweet = {
        handle: parsedQuote.handle,
        authorName: parsedQuote.authorName,
        text: parsedQuote.text,
      };
    }
  }

  return {
    tweetId,
    url: `https://x.com/${handle}/status/${tweetId}`,
    handle,
    authorName,
    avatarUrl,
    text,
    publishedAt,
    isReply,
    isRetweet,
    isTruncated,
    mediaUrls: Array.from(new Set(mediaUrls)),
    quotedTweet,
  };
}

/** 递归遍历 X 接口响应 JSON 提取全部不重复推文对象 */
export function extractTweetsFromGraphQlPayload(payload: unknown): RawXTweet[] {
  const byId = new Map<string, RawXTweet>();

  function visit(node: unknown, depth: number): void {
    if (depth > 24 || !node || typeof node !== 'object') {
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) {
        visit(item, depth + 1);
      }
      return;
    }
    const rec = node as Record<string, unknown>;
    if ('rest_id' in rec && 'legacy' in rec) {
      const tweet = parseSingleGraphQlTweetNode(rec);
      if (tweet && !byId.has(tweet.tweetId)) {
        byId.set(tweet.tweetId, tweet);
      }
      // 跳过内层 quoted_status_result 避免被单独当作顶层推文入库
      for (const [k, v] of Object.entries(rec)) {
        if (k === 'quoted_status_result' || k === 'retweeted_status_result') {
          continue;
        }
        visit(v, depth + 1);
      }
      return;
    }
    for (const val of Object.values(rec)) {
      visit(val, depth + 1);
    }
  }

  visit(payload, 0);
  return Array.from(byId.values());
}

/** 为推文生成易读的中文标题（附带博主标识和首句核心内容） */
export function formatXTweetTitle(tweet: RawXTweet): string {
  const firstLine = tweet.text.replace(/\s+/g, ' ').trim();
  const chars = Array.from(firstLine);
  const preview = chars.length > 44 ? `${chars.slice(0, 44).join('')}…` : firstLine;
  const authorLabel =
    tweet.authorName && tweet.authorName !== tweet.handle
      ? `${tweet.authorName} (@${tweet.handle})`
      : `@${tweet.handle}`;
  return `${authorLabel}：${preview || '动态更新'}`;
}

/** 按信源配置拉取并过滤 X 账号或列表推文，输出标准订阅条目 */
export async function fetchXSourceItems(
  source: SourceDef,
  opts: {
    cookieFileAbs: string;
    driver: CollectorBrowserDriver;
    signal?: AbortSignal;
  },
): Promise<ParsedXFeedItem[]> {
  const status = await inspectXCookieFile(opts.cookieFileAbs);
  if (!status.configured) {
    throw new XCookieMissingError(
      `信源「${source.name}」跳过：${status.detail}，可执行 aidaily x-login 登录后启用`,
    );
  }

  const rawTweets = await opts.driver.fetchXTimeline(source, opts.cookieFileAbs, {
    signal: opts.signal,
  });

  const cfg = source.xConfig ?? {
    mode: 'user',
    handleOrListId: source.id,
    includeReplies: false,
    includeRetweets: false,
    minChars: 20,
  };

  const results: ParsedXFeedItem[] = [];
  for (const tweet of rawTweets) {
    if (tweet.isTruncated) {
      continue;
    }
    if (!cfg.includeReplies && tweet.isReply) {
      continue;
    }
    if (!cfg.includeRetweets && tweet.isRetweet) {
      continue;
    }
    const textWithoutUrls = tweet.text.replace(/https?:\/\/\S+/g, '').trim();
    const effectiveChars = Array.from(textWithoutUrls).length;
    if (effectiveChars < cfg.minChars && tweet.mediaUrls.length === 0) {
      continue;
    }
    const quotedText = tweet.quotedTweet
      ? `\n\n[引用 @${tweet.quotedTweet.handle}（${tweet.quotedTweet.authorName}）]\n${tweet.quotedTweet.text}`
      : '';
    results.push({
      url: tweet.url,
      title: formatXTweetTitle(tweet),
      publishedAt: tweet.publishedAt,
      summary: tweet.text.slice(0, 280),
      content: `${tweet.text}${quotedText}`,
      tweetData: tweet,
    });
  }

  return results;
}

/**
 * 通过公开免登录接口拉取单条 X 推文详情，用于将媒体文章内嵌推文链接转为高清发言截图。
 */
export async function fetchPublicTweetSyndication(
  tweetId: string,
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
): Promise<RawXTweet | null> {
  if (!/^\d+$/.test(tweetId)) {
    return null;
  }
  const token = ((Number(tweetId) / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, '');
  const endpoint = `https://cdn.syndication.twimg.com/tweet-result?id=${tweetId}&lang=en&token=${encodeURIComponent(token)}`;
  const timeoutSignal = AbortSignal.timeout(DEFAULT_SYNDICATION_TIMEOUT_MS);
  const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

  try {
    const res = await fetchImpl(endpoint, {
      signal: combinedSignal,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        Accept: 'application/json',
      },
    });
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      return null;
    }
    const data = (await res.json()) as Record<string, unknown>;
    if (!data || typeof data !== 'object') {
      return null;
    }
    const user =
      data.user && typeof data.user === 'object' ? (data.user as Record<string, unknown>) : null;
    const handle = typeof user?.screen_name === 'string' ? user.screen_name : '';
    const authorName = typeof user?.name === 'string' ? user.name : handle;
    const avatarUrl =
      typeof user?.profile_image_url_https === 'string' ? user.profile_image_url_https : null;
    const rawText = typeof data.text === 'string' ? data.text : '';
    if (!handle || !rawText.trim()) {
      return null;
    }

    const mediaDetails = Array.isArray(data.mediaDetails)
      ? (data.mediaDetails as Array<Record<string, unknown>>)
      : [];
    const mediaUrls: string[] = [];
    const mediaShortUrls: string[] = [];
    for (const item of mediaDetails) {
      if (typeof item.media_url_https === 'string') {
        mediaUrls.push(toHighResXMediaUrl(item.media_url_https));
      }
      if (typeof item.url === 'string') {
        mediaShortUrls.push(item.url);
      }
    }

    const createdMs =
      typeof data.created_at === 'string' ? Date.parse(data.created_at) : Number.NaN;
    const publishedAt = Number.isNaN(createdMs) ? null : new Date(createdMs).toISOString();

    let quotedTweet: RawXTweet['quotedTweet'] = null;
    const rawQuote =
      data.quoted_tweet && typeof data.quoted_tweet === 'object'
        ? (data.quoted_tweet as Record<string, unknown>)
        : null;
    if (rawQuote && typeof rawQuote.text === 'string') {
      const qUser =
        rawQuote.user && typeof rawQuote.user === 'object'
          ? (rawQuote.user as Record<string, unknown>)
          : null;
      quotedTweet = {
        handle: typeof qUser?.screen_name === 'string' ? qUser.screen_name : 'unknown',
        authorName: typeof qUser?.name === 'string' ? qUser.name : 'Unknown',
        text: rawQuote.text.trim(),
      };
    }

    return {
      tweetId,
      url: `https://x.com/${handle}/status/${tweetId}`,
      handle,
      authorName,
      avatarUrl,
      text: cleanTweetText(rawText, mediaShortUrls),
      publishedAt,
      isReply: false,
      isRetweet: false,
      mediaUrls: Array.from(new Set(mediaUrls)),
      quotedTweet,
    };
  } catch (err) {
    if (signal?.aborted) {
      throw err;
    }
    return null;
  }
}
