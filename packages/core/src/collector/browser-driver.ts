import fs from 'node:fs/promises';
import { isAllowedUrlTarget, type SourceDef } from '@aidaily/contracts';
import { type Browser, type BrowserContext, chromium } from 'playwright';
import { closeBrowserSafely, resolveChromiumExecutablePath } from '../media/browser.js';
import { assertSafeFetchTarget } from './ssrf.js';
import { extractTweetsFromGraphQlPayload, parseXCookiesFromText } from './x-collector.js';

/** 从 X 时间线抓取或公开接口查询得到的单条推文结构化数据 */
export interface RawXTweet {
  tweetId: string;
  url: string;
  handle: string;
  authorName: string;
  avatarUrl: string | null;
  text: string;
  publishedAt: string | null;
  isReply: boolean;
  isRetweet: boolean;
  mediaUrls: string[];
  quotedTweet?: {
    handle: string;
    authorName: string;
    text: string;
  } | null;
}

/** 渲染推文截图卡片时的输入数据 */
export interface TweetRenderInput {
  tweetId: string;
  url: string;
  handle: string;
  authorName: string;
  avatarUrl?: string | null;
  text: string;
  publishedAt?: string | null;
  quotedTweet?: {
    handle: string;
    authorName: string;
    text: string;
  } | null;
  preferEmbed?: boolean;
}

/** 从原网页正文提取出的待局部截图的表格或矢量图表片段 */
export interface DomChartFragment {
  kind: 'table' | 'svg';
  html: string;
  titleHint?: string;
}

/** 采集阶段共用的浏览器抓取与局部截图驱动接口（便于测试环境离线注入模拟实现） */
export interface CollectorBrowserDriver {
  /** 加载并渲染动态网页列表后返回完整 HTML 文本 */
  fetchRenderedHtml(
    url: string,
    opts?: { timeoutMs?: number; allowedOrigins?: readonly string[]; signal?: AbortSignal },
  ): Promise<string>;
  /** 使用本机保存的 X 登录凭证读取指定账号或列表时间线推文 */
  fetchXTimeline(
    source: SourceDef,
    cookieFileAbs: string,
    opts?: { signal?: AbortSignal },
  ): Promise<RawXTweet[]>;
  /** 将单条推文渲染为 2 倍分辨率高清卡片 PNG 截图 */
  renderTweetCardPng(
    tweet: TweetRenderInput,
    opts?: { signal?: AbortSignal },
  ): Promise<{ png: Buffer; width: number; height: number } | null>;
  /** 将原网页评测或定价表格及矢量图表片段渲染为白底高清 PNG 截图 */
  renderDomFragmentPng(
    fragment: DomChartFragment,
    opts?: { signal?: AbortSignal },
  ): Promise<{ png: Buffer; width: number; height: number } | null>;
  /** 释放本次采集过程中复用的无头浏览器实例 */
  close(): Promise<void>;
}

const BROWSER_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** 对注入静态截图 HTML 的文本执行严格转义 */
function escapeHtml(raw: string): string {
  return raw
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/** 格式化推文展示时间为紧凑易读格式 */
function formatTweetDisplayTime(publishedAt: string | null | undefined): string {
  if (!publishedAt) {
    return 'X 原帖';
  }
  const parsed = Date.parse(publishedAt);
  if (Number.isNaN(parsed)) {
    return publishedAt;
  }
  return `${new Date(parsed).toISOString().replace('T', ' ').slice(0, 16)} UTC`;
}

/** 生成用于保真截图的洁净 X 原帖卡片 HTML */
function buildTweetCardHtml(tweet: TweetRenderInput): string {
  const safeName = escapeHtml(tweet.authorName || tweet.handle);
  const safeHandle = escapeHtml(tweet.handle.replace(/^@/, ''));
  const safeText = escapeHtml(tweet.text.trim());
  const safeDate = escapeHtml(formatTweetDisplayTime(tweet.publishedAt));
  const initialChar = escapeHtml(
    (tweet.authorName || tweet.handle || 'X').slice(0, 1).toUpperCase(),
  );
  const safeAvatar =
    tweet.avatarUrl && /^https?:\/\//i.test(tweet.avatarUrl) ? escapeHtml(tweet.avatarUrl) : '';

  const quoteBlock = tweet.quotedTweet
    ? `<div class="quote-box">
        <div class="quote-head">
          <strong>${escapeHtml(tweet.quotedTweet.authorName || tweet.quotedTweet.handle)}</strong>
          <span>@${escapeHtml(tweet.quotedTweet.handle.replace(/^@/, ''))}</span>
        </div>
        <div class="quote-body">${escapeHtml(tweet.quotedTweet.text)}</div>
      </div>`
    : '';

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="script-src 'none';" />
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    background: #ffffff;
    font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Segoe UI", Roboto, sans-serif;
    padding: 16px;
    width: 720px;
  }
  #tweet-card {
    background: #ffffff;
    border: 1.5px solid #cfd9de;
    border-radius: 18px;
    padding: 24px 26px 20px;
    box-shadow: 0 6px 22px rgba(15, 20, 25, 0.06);
  }
  .head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 16px;
  }
  .author {
    display: flex;
    align-items: center;
    gap: 12px;
  }
  .avatar-wrap {
    width: 48px;
    height: 48px;
    border-radius: 999px;
    overflow: hidden;
    background: #0f1419;
    color: #ffffff;
    display: flex;
    align-items: center;
    justify-content: center;
    font-weight: 700;
    font-size: 20px;
    flex-shrink: 0;
  }
  .avatar-wrap img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }
  .name {
    font-size: 18px;
    font-weight: 700;
    color: #0f1419;
    line-height: 1.25;
  }
  .handle {
    font-size: 14px;
    color: #536471;
    margin-top: 2px;
  }
  .x-mark {
    width: 24px;
    height: 24px;
    color: #0f1419;
    flex-shrink: 0;
  }
  .body {
    font-size: 19px;
    line-height: 1.56;
    color: #0f1419;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .quote-box {
    margin-top: 16px;
    border: 1px solid #cfd9de;
    border-radius: 14px;
    padding: 14px 16px;
    background: #f7f9f9;
  }
  .quote-head {
    display: flex;
    gap: 8px;
    align-items: baseline;
    font-size: 14px;
    color: #0f1419;
    margin-bottom: 6px;
  }
  .quote-head span {
    color: #536471;
    font-size: 13px;
  }
  .quote-body {
    font-size: 15px;
    line-height: 1.48;
    color: #0f1419;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .footer {
    margin-top: 16px;
    padding-top: 12px;
    border-top: 1px solid #eff3f4;
    display: flex;
    align-items: center;
    justify-content: space-between;
    font-size: 13px;
    color: #536471;
  }
</style>
</head>
<body>
  <article id="tweet-card">
    <div class="head">
      <div class="author">
        <div class="avatar-wrap">
          ${safeAvatar ? `<img src="${safeAvatar}" alt="" referrerpolicy="no-referrer" />` : initialChar}
        </div>
        <div>
          <div class="name">${safeName}</div>
          <div class="handle">@${safeHandle}</div>
        </div>
      </div>
      <svg class="x-mark" viewBox="0 0 24 24" aria-hidden="true">
        <path fill="currentColor" d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/>
      </svg>
    </div>
    <div class="body">${safeText}</div>
    ${quoteBlock}
    <div class="footer">
      <span>${safeDate}</span>
      <span>x.com/${safeHandle}</span>
    </div>
  </article>
</body>
</html>`;
}

/** 生成用于局部截图网页原生评测表格与矢量图表的纯净白底容器 HTML */
function buildDomFragmentHtml(fragment: DomChartFragment): string {
  const heading = fragment.titleHint
    ? `<h2 class="chart-title">${escapeHtml(fragment.titleHint)}</h2>`
    : '';
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="script-src 'none';" />
<style>
  * { box-sizing: border-box; }
  body {
    margin: 0;
    padding: 16px;
    background: #ffffff;
    font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Segoe UI", Roboto, sans-serif;
    color: #0f172a;
    width: 980px;
  }
  #chart-frame {
    background: #ffffff;
    border: 1.5px solid #cbd5e1;
    border-radius: 16px;
    padding: 20px 22px;
    box-shadow: 0 6px 20px rgba(15, 23, 42, 0.05);
    display: inline-block;
    min-width: 680px;
    max-width: 940px;
  }
  .chart-title {
    margin: 0 0 14px;
    font-size: 18px;
    font-weight: 700;
    color: #0f172a;
    line-height: 1.35;
  }
  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 14px;
    line-height: 1.45;
  }
  th, td {
    border-bottom: 1px solid #e2e8f0;
    padding: 9px 12px;
    text-align: left;
    vertical-align: middle;
  }
  thead th, tr:first-child th {
    background: #f1f5f9;
    font-weight: 700;
    color: #0f172a;
    border-top: 1px solid #cbd5e1;
    border-bottom: 1.5px solid #cbd5e1;
  }
  tbody tr:nth-child(even) {
    background: #f8fafc;
  }
  svg {
    display: block;
    max-width: 100%;
    height: auto;
  }
</style>
</head>
<body>
  <div id="chart-frame">
    ${heading}
    ${fragment.html}
  </div>
</body>
</html>`;
}

/** 创建基于 Playwright Chromium 的采集与局部截图驱动（懒启动并在同轮采集中复用同一浏览器） */
/** 在已绑定取消信号监听的浏览器上下文内执行页面任务，确保中止时立即关闭上下文释放资源 */
async function withAbortableContext<T>(
  context: BrowserContext,
  signal: AbortSignal | undefined,
  run: (ctx: BrowserContext) => Promise<T>,
): Promise<T> {
  if (signal?.aborted) {
    await context.close().catch(() => undefined);
    throw new DOMException('已取消', 'AbortError');
  }
  const onAbort = () => {
    void context.close().catch(() => undefined);
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    return await run(context);
  } finally {
    signal?.removeEventListener('abort', onAbort);
    await context.close().catch(() => undefined);
  }
}

/** 创建基于 Playwright Chromium 的默认采集浏览器驱动 */
export function createPlaywrightCollectorDriver(): CollectorBrowserDriver {
  let browserPromise: Promise<Browser> | null = null;
  let browserInstance: Browser | null = null;
  let closed = false;

  const getBrowser = async (signal?: AbortSignal): Promise<Browser> => {
    if (closed || signal?.aborted) {
      throw new DOMException('已取消', 'AbortError');
    }
    if (browserInstance && !browserInstance.isConnected()) {
      browserInstance = null;
      browserPromise = null;
    }
    if (!browserPromise) {
      let pending: Promise<Browser> | null = null;
      pending = (async () => {
        try {
          const executablePath = await resolveChromiumExecutablePath();
          const launched = await chromium.launch({
            headless: true,
            ...(executablePath ? { executablePath } : {}),
          });
          if (closed) {
            await closeBrowserSafely(launched);
            throw new DOMException('已取消', 'AbortError');
          }
          browserInstance = launched;
          launched.once('disconnected', () => {
            if (browserInstance === launched) {
              browserInstance = null;
              browserPromise = null;
            }
          });
          return launched;
        } catch (err) {
          if (pending !== null && browserPromise === pending) {
            browserPromise = null;
            browserInstance = null;
          }
          throw err;
        }
      })();
      browserPromise = pending;
    }

    if (!signal) {
      return browserPromise;
    }
    return await new Promise<Browser>((resolve, reject) => {
      const onAbort = () => reject(new DOMException('已取消', 'AbortError'));
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
      browserPromise?.then(
        (browser) => {
          signal.removeEventListener('abort', onAbort);
          resolve(browser);
        },
        (err) => {
          signal.removeEventListener('abort', onAbort);
          reject(err);
        },
      );
    });
  };

  return {
    /** 打开无头浏览器加载动态网页，等待主内容渲染后返回完整 HTML */
    async fetchRenderedHtml(url, opts) {
      await assertSafeFetchTarget(new URL(url), {
        fetchImpl: globalThis.fetch,
        allowedOrigins: opts?.allowedOrigins,
      });
      const browser = await getBrowser(opts?.signal);
      const context = await browser.newContext({
        userAgent: BROWSER_USER_AGENT,
        viewport: { width: 1366, height: 900 },
      });
      return withAbortableContext(context, opts?.signal, async (ctx) => {
        await ctx.route('**/*', async (route) => {
          const reqUrl = route.request().url();
          if (
            reqUrl.startsWith('data:') ||
            reqUrl.startsWith('blob:') ||
            reqUrl === 'about:blank'
          ) {
            await route.continue();
            return;
          }
          try {
            const parsed = new URL(reqUrl);
            if (!isAllowedUrlTarget(parsed, { allowedOrigins: opts?.allowedOrigins })) {
              await route.abort('blockedbyclient');
              return;
            }
          } catch {
            await route.abort('blockedbyclient');
            return;
          }
          await route.continue();
        });
        const page = await ctx.newPage();
        await page.goto(url, {
          waitUntil: 'domcontentloaded',
          timeout: opts?.timeoutMs ?? 25_000,
        });
        await page
          .locator('article, main, [role="main"], h1, h2')
          .first()
          .waitFor({ state: 'attached', timeout: 5_000 })
          .catch(() => undefined);
        await page.waitForTimeout(1_200);
        return await page.content();
      });
    },

    /** 加载本机 X 登录凭证并抓取账号主页或列表最新推文，优先解析接口结构化数据并以 DOM 提取兜底 */
    async fetchXTimeline(source, cookieFileAbs, opts) {
      if (opts?.signal?.aborted || closed) {
        throw new DOMException('已取消', 'AbortError');
      }
      const rawCookieText = await fs.readFile(cookieFileAbs, 'utf8');
      const cookies = parseXCookiesFromText(rawCookieText);
      const browser = await getBrowser(opts?.signal);
      const context = await browser.newContext({
        userAgent: BROWSER_USER_AGENT,
        viewport: { width: 1366, height: 1100 },
      });

      return withAbortableContext(context, opts?.signal, async (ctx) => {
        const collectedTweets = new Map<string, RawXTweet>();
        await ctx.addCookies(cookies);
        const page = await ctx.newPage();

        page.on('response', async (res) => {
          const resUrl = res.url();
          if (
            !resUrl.includes('/i/api/graphql/') ||
            (!resUrl.includes('UserTweets') &&
              !resUrl.includes('ListLatestTweetsTimeline') &&
              !resUrl.includes('UserBy'))
          ) {
            return;
          }
          try {
            if (!res.ok()) {
              return;
            }
            const json = (await res.json()) as unknown;
            for (const tweet of extractTweetsFromGraphQlPayload(json)) {
              if (!collectedTweets.has(tweet.tweetId)) {
                collectedTweets.set(tweet.tweetId, tweet);
              }
            }
          } catch {
            // 忽略非 JSON 或提前中止的接口响应
          }
        });

        const cfg = source.xConfig;
        const targetUrl =
          cfg?.mode === 'list'
            ? `https://x.com/i/lists/${encodeURIComponent(cfg.handleOrListId)}`
            : cfg?.handleOrListId
              ? `https://x.com/${encodeURIComponent(cfg.handleOrListId.replace(/^@/, ''))}`
              : source.url;

        await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 25_000 });
        await page
          .waitForSelector('article[data-testid="tweet"]', { timeout: 12_000 })
          .catch(() => undefined);
        await page.waitForTimeout(1_500);

        if (collectedTweets.size < 5) {
          await page.evaluate(() => window.scrollBy(0, 1200));
          await page.waitForTimeout(1_200);
        }

        // 若 GraphQL 拦截为空（例如 X 接口结构变化），从已渲染的页面推文卡片中兜底提取
        if (collectedTweets.size === 0) {
          const domTweets = await page.evaluate(() => {
            const articles = Array.from(document.querySelectorAll('article[data-testid="tweet"]'));
            const out: Array<{
              tweetId: string;
              url: string;
              handle: string;
              authorName: string;
              text: string;
              publishedAt: string | null;
              mediaUrls: string[];
              isRetweet: boolean;
            }> = [];
            for (const art of articles) {
              const link = art.querySelector('a[href*="/status/"]') as HTMLAnchorElement | null;
              const href = link?.getAttribute('href') ?? '';
              const match = /^\/([A-Za-z0-9_]{1,20})\/status\/(\d+)/.exec(href);
              if (!match?.[1] || !match[2]) {
                continue;
              }
              const textEl = art.querySelector('[data-testid="tweetText"]');
              const text = textEl?.textContent?.trim() ?? '';
              const timeEl = art.querySelector('time');
              const publishedAt = timeEl?.getAttribute('datetime') ?? null;
              const socialCtx =
                art.querySelector('[data-testid="socialContext"]')?.textContent ?? '';
              const isRetweet = /reposted|retweeted|转推/i.test(socialCtx);
              const userNameEl = art.querySelector('[data-testid="User-Name"]');
              const authorName = userNameEl?.querySelector('span')?.textContent?.trim() || match[1];
              const mediaImgs = Array.from(art.querySelectorAll('[data-testid="tweetPhoto"] img'))
                .map((img) => img.getAttribute('src') ?? '')
                .filter((src) => src.includes('twimg.com/media'));
              out.push({
                tweetId: match[2],
                url: `https://x.com/${match[1]}/status/${match[2]}`,
                handle: match[1],
                authorName,
                text,
                publishedAt,
                mediaUrls: mediaImgs,
                isRetweet,
              });
            }
            return out;
          });

          for (const dt of domTweets) {
            collectedTweets.set(dt.tweetId, {
              ...dt,
              avatarUrl: null,
              isReply: false,
              quotedTweet: null,
            });
          }
        }

        return Array.from(collectedTweets.values());
      });
    },

    /** 优先用官方短推嵌入卡片、在超长或超时时自动用高保真原帖卡片渲染为 2 倍分辨率 PNG */
    async renderTweetCardPng(tweet, opts) {
      const browser = await getBrowser(opts?.signal);
      const charCount = Array.from(tweet.text.trim()).length;

      // 短推文（不会被折叠）先尝试官方嵌入卡片，确保原汁原味
      if (tweet.preferEmbed !== false && charCount <= 240 && /^\d+$/.test(tweet.tweetId)) {
        const embedCtx = await browser.newContext({
          userAgent: BROWSER_USER_AGENT,
          viewport: { width: 720, height: 960 },
          deviceScaleFactor: 2,
        });
        try {
          const embedRes = await withAbortableContext(embedCtx, opts?.signal, async (ctx) => {
            const page = await ctx.newPage();
            const embedUrl = `https://platform.twitter.com/embed/Tweet.html?id=${tweet.tweetId}&theme=light&dnt=true`;
            await page.goto(embedUrl, { waitUntil: 'domcontentloaded', timeout: 5_000 });
            const cardLocator = page.locator('article, .twitter-tweet-rendered, #app').first();
            await cardLocator.waitFor({ state: 'visible', timeout: 5_000 });
            await page.waitForTimeout(400);
            const box = await cardLocator.boundingBox();
            const bodyText = await page.evaluate(() => document.body?.textContent ?? '');
            const looksValid =
              box &&
              box.width >= 280 &&
              box.height >= 120 &&
              !/this post is unavailable|nothing to see here|something went wrong/i.test(bodyText);
            if (!looksValid) {
              return null;
            }
            const png = await cardLocator.screenshot({ type: 'png' });
            return {
              png,
              width: Math.round(box.width * 2),
              height: Math.round(box.height * 2),
            };
          });
          if (embedRes) {
            return embedRes;
          }
        } catch (err) {
          if (opts?.signal?.aborted) {
            throw err;
          }
          // 官方嵌入页超时或网络受阻时无缝切换本地高保真卡片截图
        }
      }

      const fallbackCtx = await browser.newContext({
        viewport: { width: 760, height: 1200 },
        deviceScaleFactor: 2,
        javaScriptEnabled: false,
      });
      try {
        return await withAbortableContext(fallbackCtx, opts?.signal, async (ctx) => {
          const page = await ctx.newPage();
          await page.setContent(buildTweetCardHtml(tweet), { waitUntil: 'load', timeout: 8_000 });
          const locator = page.locator('#tweet-card');
          const box = await locator.boundingBox();
          if (!box || box.width < 100 || box.height < 60) {
            return null;
          }
          const png = await locator.screenshot({ type: 'png' });
          return {
            png,
            width: Math.round(box.width * 2),
            height: Math.round(box.height * 2),
          };
        });
      } catch (err) {
        if (opts?.signal?.aborted) {
          throw err;
        }
        return null;
      }
    },

    /** 在纯净白底画布中以 2 倍缩放渲染原生表格或矢量图表为清晰 PNG 截图 */
    async renderDomFragmentPng(fragment, opts) {
      const browser = await getBrowser(opts?.signal);
      const context = await browser.newContext({
        viewport: { width: 1040, height: 1400 },
        deviceScaleFactor: 2,
        javaScriptEnabled: false,
      });
      try {
        return await withAbortableContext(context, opts?.signal, async (ctx) => {
          const page = await ctx.newPage();
          await page.setContent(buildDomFragmentHtml(fragment), {
            waitUntil: 'load',
            timeout: 8_000,
          });
          const locator = page.locator('#chart-frame');
          const box = await locator.boundingBox();
          if (!box || box.width < 120 || box.height < 60) {
            return null;
          }
          const png = await locator.screenshot({ type: 'png' });
          return {
            png,
            width: Math.round(box.width * 2),
            height: Math.round(box.height * 2),
          };
        });
      } catch (err) {
        if (opts?.signal?.aborted) {
          throw err;
        }
        return null;
      }
    },

    /** 安全销毁复用的无头浏览器进程并阻止后续重复拉起 */
    async close() {
      closed = true;
      const pending = browserPromise;
      const active = browserInstance;
      browserInstance = null;
      browserPromise = null;
      const resolved = active ?? (await pending?.catch(() => null)) ?? null;
      await closeBrowserSafely(resolved);
    },
  };
}
