import fs from 'node:fs/promises';
import path from 'node:path';
import type { Settings, SourceDef, SourcePool } from '@aidaily/contracts';
import pLimit from 'p-limit';
import type { CoreContext } from '../context.js';
import { PipelineError } from '../errors.js';
import { writeJsonAtomic } from '../storage/files.js';
import { emitRunEvent } from '../workflow/events.js';
import type { CollectorBrowserDriver, RawXTweet } from './browser-driver.js';
import { canonicalizeUrl, computeArticleId, normalizeTitle } from './canonical-url.js';
import { expireOldArticles } from './expiry.js';
import { extractArticleContent, fetchArticleHtml, type StoredArticleContent } from './extractor.js';
import type { ParsedFeedItem } from './feed-parser.js';
import { fetchFeedWithRetry } from './fetcher.js';
import { fetchHtmlListWithRetry } from './html-list-fetcher.js';
import { captureArticleVisualMedia } from './visual-capture.js';
import { fetchXSourceItems, XCookieMissingError } from './x-collector.js';

export * from './browser-driver.js';
export * from './canonical-url.js';
export * from './expiry.js';
export * from './extractor.js';
export * from './feed-parser.js';
export * from './fetcher.js';
export * from './html-list-fetcher.js';
export * from './images.js';
export * from './visual-capture.js';
export * from './x-collector.js';

const FEED_CONCURRENCY = 4;
const ARTICLE_CONCURRENCY = 4;
const OVERLAP_WINDOW_MS = 2 * 3600_000;
const SOURCE_UNHEALTHY_THRESHOLD = 3;
const MAX_UNDATED_HTML_DETAIL_FETCH = 16;

/** 增量采集单期执行结束后保存的检查点结果 */
export interface CollectCheckpoint {
  sourcesOk: string[];
  sourcesFailed: Array<{ sourceId: string; error: string }>;
  sourcesSkipped?: string[];
  newArticleIds: string[];
  expiredCount: number;
}

/** 构造标准取消异常 */
function createAbortError(): DOMException {
  return new DOMException('已取消', 'AbortError');
}

/** 判断异常是否为外部触发的取消信号 */
function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}

/** 根据信源语言决定无时区日期的解析时区（中文源按配置时区解释，海外源按 UTC 解释） */
export function resolveSourceTimezone(
  source: Pick<SourceDef, 'lang'>,
  settingsTimezone: string,
): string {
  return source.lang === 'zh' ? settingsTimezone : 'UTC';
}

/** 对网页列表条目优先保留精确时刻，当列表仅给出纯日期且详情页识别出具体时刻时采用详情时间 */
function mergeListAndDetailPublishedAt(
  listIso: string | null,
  detailIso: string | null,
  kind: SourceDef['kind'],
): string | null {
  if (!listIso) {
    return detailIso;
  }
  if (!detailIso || kind !== 'html-list') {
    return listIso;
  }
  if (listIso.endsWith('T00:00:00.000Z') && !detailIso.endsWith('T00:00:00.000Z')) {
    const diffMs = Math.abs(Date.parse(detailIso) - Date.parse(listIso));
    if (!Number.isNaN(diffMs) && diffMs <= 36 * 3600_000) {
      return detailIso;
    }
  }
  return listIso;
}

/** 抓取单个启用信源、提取新增文章正文与视觉素材、落盘并推进信源抓取进度 */
async function collectSingleSource(
  ctx: CoreContext,
  source: SourceDef,
  seenCanonicalIds: Set<string>,
  articleLimit: ReturnType<typeof pLimit>,
  driver: CollectorBrowserDriver,
  opts: {
    signal?: AbortSignal;
    retryDelayMs?: number;
    settings: Settings;
    lookbackCutoffMs: number;
  },
): Promise<string[]> {
  const prevState = ctx.repos.sourceState.get(source.id);
  const sourceTimezone = resolveSourceTimezone(source, opts.settings.timezone);
  const lookbackCutoffIso = new Date(opts.lookbackCutoffMs).toISOString();
  const hasRecentFailed =
    source.kind === 'rss' &&
    ctx.repos.articles.hasRecentFailedForSource(source.id, lookbackCutoffIso);

  let notModified = false;
  let feedItems: Array<ParsedFeedItem & { tweetData?: RawXTweet }> = [];
  let etag: string | null = null;
  let lastModified: string | null = null;

  if (source.kind === 'rss') {
    const feedResult = await fetchFeedWithRetry(source, prevState, {
      fetchImpl: ctx.fetchImpl,
      retryDelayMs: opts.retryDelayMs,
      useConditionalHeaders: !hasRecentFailed,
      timezone: sourceTimezone,
      signal: opts.signal,
    });
    notModified = feedResult.notModified;
    feedItems = feedResult.items;
    etag = feedResult.etag;
    lastModified = feedResult.lastModified;
  } else if (source.kind === 'html-list') {
    const listResult = await fetchHtmlListWithRetry(source, {
      fetchImpl: ctx.fetchImpl,
      driver,
      retryDelayMs: opts.retryDelayMs,
      timezone: sourceTimezone,
      signal: opts.signal,
    });
    feedItems = listResult.items;
  } else {
    const cookieFileAbs = path.resolve(ctx.paths.rootDir, opts.settings.collector.xCookieFile);
    feedItems = await fetchXSourceItems(source, {
      cookieFileAbs,
      driver,
      signal: opts.signal,
    });
  }

  if (opts.signal?.aborted) {
    throw createAbortError();
  }

  const nowIso = ctx.now().toISOString();
  if (notModified) {
    ctx.repos.sourceState.upsertSuccess({
      sourceId: source.id,
      lastFetchedAt: nowIso,
      lastItemPublishedAt: null,
      etag,
      lastModified,
      preserveConditionalHeaders: true,
    });
    return [];
  }

  const prevCursorMs = prevState?.lastItemPublishedAt
    ? Date.parse(prevState.lastItemPublishedAt)
    : Number.NaN;
  const hasPrevCursor = !Number.isNaN(prevCursorMs);
  const earliestItemMs = hasPrevCursor
    ? Math.max(opts.lookbackCutoffMs, prevCursorMs - OVERLAP_WINDOW_MS)
    : opts.lookbackCutoffMs;

  let confirmedMaxMs = Number.NaN;
  let undatedHtmlQueued = 0;
  const pendingItems: Array<{
    articleId: string;
    canonicalUrl: string;
    title: string;
    publishedAt: string | null;
    itemMs: number | null;
    summary: string | null;
    content: string | null;
    tweetData?: RawXTweet;
    retryExistingFailed: boolean;
  }> = [];

  for (const item of feedItems) {
    const parsedMs = item.publishedAt !== null ? Date.parse(item.publishedAt) : Number.NaN;
    const itemMs = Number.isNaN(parsedMs) ? null : parsedMs;

    if (itemMs !== null && itemMs < opts.lookbackCutoffMs) {
      continue;
    }

    // 链接不合法的条目不得推进抓取时间游标
    let canonicalUrl: string;
    try {
      canonicalUrl = canonicalizeUrl(item.url, source.url);
    } catch {
      continue;
    }

    const articleId = computeArticleId(canonicalUrl);
    const existingArticle = ctx.repos.articles.getById(articleId);
    const retryExistingFailed = Boolean(
      existingArticle &&
        existingArticle.status === 'new' &&
        existingArticle.extractStatus === 'failed',
    );

    if (existingArticle && !retryExistingFailed) {
      if (itemMs !== null && itemMs >= earliestItemMs) {
        if (Number.isNaN(confirmedMaxMs) || itemMs > confirmedMaxMs) {
          confirmedMaxMs = itemMs;
        }
      }
      continue;
    }

    if (!retryExistingFailed) {
      if (itemMs === null) {
        // 网页列表页常把发布日期放在详情页中，先允许少量未见过的网页详情抓回后再按详情页真实日期过滤
        if (source.kind === 'html-list') {
          if (undatedHtmlQueued >= MAX_UNDATED_HTML_DETAIL_FETCH) {
            continue;
          }
        } else if (hasPrevCursor) {
          // 已建立时间游标时忽略无发布时间条目，防止无日期旧闻换链后反复入库
          continue;
        }
      } else if (itemMs < earliestItemMs) {
        continue;
      }
    }

    if (seenCanonicalIds.has(articleId)) {
      continue;
    }
    seenCanonicalIds.add(articleId);
    if (itemMs === null && source.kind === 'html-list' && !retryExistingFailed) {
      undatedHtmlQueued += 1;
    }

    pendingItems.push({
      articleId,
      canonicalUrl,
      title: item.title,
      publishedAt: itemMs !== null ? item.publishedAt : null,
      itemMs,
      summary: item.summary,
      content: item.content,
      tweetData: item.tweetData,
      retryExistingFailed,
    });
  }

  const processed = await Promise.all(
    pendingItems.map((entry) =>
      articleLimit(async () => {
        if (opts.signal?.aborted) {
          throw createAbortError();
        }

        const preferRenderedHtml =
          source.kind === 'html-list' && Boolean(source.listConfig?.renderJs);
        let html =
          source.kind === 'x-timeline'
            ? null
            : await fetchArticleHtml(entry.canonicalUrl, ctx.fetchImpl, {
                retries: preferRenderedHtml ? 0 : 2,
                retryDelayMs: opts.retryDelayMs,
                signal: opts.signal,
              });
        if (opts.signal?.aborted) {
          throw createAbortError();
        }

        const minContentChars =
          source.kind === 'x-timeline' ? (source.xConfig?.minChars ?? 20) : undefined;
        let extracted = extractArticleContent({
          url: entry.canonicalUrl,
          html,
          feedContent: entry.content,
          feedSummary: entry.summary,
          minContentChars,
          defaultTimezone: sourceTimezone,
        });

        // 对明确需要动态渲染的网页来源，当普通抓取被拦截或正文不足时自动改用无头浏览器加载详情页
        if (preferRenderedHtml && (html === null || extracted.extractStatus === 'failed')) {
          const renderedHtml = await driver
            .fetchRenderedHtml(entry.canonicalUrl, {
              timeoutMs: 25_000,
              signal: opts.signal,
            })
            .catch((err: unknown) => {
              if (isAbortError(err) || opts.signal?.aborted) {
                throw err;
              }
              return '';
            });
          if (renderedHtml.trim().length > 0) {
            html = renderedHtml;
            extracted = extractArticleContent({
              url: entry.canonicalUrl,
              html,
              feedContent: entry.content,
              feedSummary: entry.summary,
              minContentChars,
              defaultTimezone: sourceTimezone,
            });
          }
        }

        if (opts.signal?.aborted) {
          throw createAbortError();
        }

        const resolvedPublishedAt = mergeListAndDetailPublishedAt(
          entry.publishedAt,
          extracted.detectedPublishedAt,
          source.kind,
        );
        const resolvedMs = resolvedPublishedAt ? Date.parse(resolvedPublishedAt) : Number.NaN;
        const finalItemMs = Number.isNaN(resolvedMs) ? null : resolvedMs;
        const minWindowMs = entry.retryExistingFailed ? opts.lookbackCutoffMs : earliestItemMs;

        // 详情页识别到真实发布时间且明显早于本次抓取窗口下限时，直接跳过不入库
        if (finalItemMs !== null && finalItemMs < minWindowMs) {
          return {
            articleId: null,
            itemMs: null,
            transientFetchFailed: false,
          };
        }

        const transientFetchFailed =
          source.kind !== 'x-timeline' && html === null && extracted.extractStatus === 'failed';
        if (entry.retryExistingFailed && extracted.extractStatus === 'failed') {
          return {
            articleId: null,
            itemMs: null,
            transientFetchFailed,
          };
        }

        const firstSeenAt = ctx.now().toISOString();
        const publishedAt = resolvedPublishedAt ?? null;

        let contentPath: string | null = null;
        let writtenContentFile: string | null = null;
        let primaryImagePath: string | null = null;
        let writtenVisualFiles: string[] = [];

        try {
          if (extracted.extractStatus !== 'failed') {
            const visualResult = await captureArticleVisualMedia({
              articleId: entry.articleId,
              source,
              extracted,
              tweetData: entry.tweetData,
              imagesDir: ctx.paths.imagesDir,
              rootDir: ctx.paths.rootDir,
              settings: opts.settings,
              fetchImpl: ctx.fetchImpl,
              driver,
              signal: opts.signal,
            });
            primaryImagePath = visualResult.primaryImagePath;
            writtenVisualFiles = visualResult.writtenFiles;

            if (opts.signal?.aborted) {
              throw createAbortError();
            }

            const contentFile = path.join(ctx.paths.articlesDir, `${entry.articleId}.json`);
            const storedPayload: StoredArticleContent = {
              url: entry.canonicalUrl,
              title: entry.title,
              lang: source.lang,
              publishedAt,
              hasExplicitPublishedAt: publishedAt !== null,
              text: extracted.text,
              feedContent: entry.content ?? entry.summary,
              ...(visualResult.mediaAssets.length > 0
                ? { mediaAssets: visualResult.mediaAssets }
                : {}),
            };
            await writeJsonAtomic(contentFile, storedPayload);
            writtenContentFile = contentFile;
            contentPath = path.relative(ctx.paths.rootDir, contentFile);
          }

          if (opts.signal?.aborted) {
            throw createAbortError();
          }

          const articleRecord = {
            id: entry.articleId,
            sourceId: source.id,
            canonicalUrl: entry.canonicalUrl,
            title: entry.title,
            titleNorm: normalizeTitle(entry.title),
            lang: source.lang,
            publishedAt,
            excerpt: extracted.excerpt || null,
            contentPath,
            contentChars: extracted.contentChars,
            imagePath: primaryImagePath,
            extractStatus: extracted.extractStatus,
          };

          const saved = entry.retryExistingFailed
            ? ctx.repos.articles.upgradeFailedExtraction(articleRecord)
            : ctx.repos.articles.insertIfAbsent({
                ...articleRecord,
                firstSeenAt,
              });

          return {
            articleId: saved && extracted.extractStatus !== 'failed' ? entry.articleId : null,
            itemMs: transientFetchFailed ? null : finalItemMs,
            transientFetchFailed,
          };
        } catch (err) {
          if (isAbortError(err)) {
            if (writtenContentFile) {
              await fs.rm(writtenContentFile, { force: true }).catch(() => undefined);
            }
            for (const filePath of writtenVisualFiles) {
              await fs.rm(filePath, { force: true }).catch(() => undefined);
            }
          }
          throw err;
        }
      }),
    ),
  );

  if (opts.signal?.aborted) {
    throw createAbortError();
  }

  let hasTransientFetchFailure = false;
  for (const res of processed) {
    if (res.transientFetchFailed) {
      hasTransientFetchFailure = true;
    }
    if (res.itemMs !== null && (Number.isNaN(confirmedMaxMs) || res.itemMs > confirmedMaxMs)) {
      confirmedMaxMs = res.itemMs;
    }
  }

  // 本信源文章任务全部确认落盘且未收到取消信号后，再推进该信源的抓取时间游标；若本轮存在临时网络失败则不保存条件缓存头以便下次重试自愈
  const latestItemIso = Number.isNaN(confirmedMaxMs)
    ? null
    : new Date(confirmedMaxMs).toISOString();
  ctx.repos.sourceState.upsertSuccess({
    sourceId: source.id,
    lastFetchedAt: ctx.now().toISOString(),
    lastItemPublishedAt: latestItemIso,
    etag: hasTransientFetchFailure ? null : etag,
    lastModified: hasTransientFetchFailure ? null : lastModified,
    preserveConditionalHeaders: false,
  });

  return processed.map((entry) => entry.articleId).filter((id): id is string => id !== null);
}

/**
 * 执行新闻信源增量采集流程：
 * 并发拉取指定分组的所有已启用信源（RSS、网页列表与 X 时间线），按时间窗口与链接去重筛选，
 * 提取全文、多张高质量图表、原生表格截图及 X 发言截图后落盘保存。
 */
export async function collectSources(
  ctx: CoreContext,
  opts?: {
    pool?: SourcePool;
    runId?: string;
    signal?: AbortSignal;
    settings?: Settings;
    retryDelayMs?: number;
  },
): Promise<CollectCheckpoint> {
  if (opts?.signal?.aborted) {
    throw createAbortError();
  }

  const pool = opts?.pool ?? 'primary';
  const runId = opts?.runId;
  const effectiveSettings = opts?.settings ?? ctx.settings;
  const maxLookbackHours = effectiveSettings.issue.refill.maxLookbackHours;
  const lookbackCutoffMs = ctx.now().getTime() - maxLookbackHours * 3600_000;
  const targetSources = ctx.sources.filter((s) => s.enabled && s.pool === pool);
  const totalSources = targetSources.length;
  const sourceLabel = pool === 'primary' ? '主力信源' : '备用信源';

  const feedLimit = pLimit(FEED_CONCURRENCY);
  const articleLimit = pLimit(ARTICLE_CONCURRENCY);
  const seenCanonicalIds = new Set<string>();
  const driver = ctx.createCollectorDriver();

  const sourcesOk: string[] = [];
  const sourcesFailed: Array<{ sourceId: string; error: string }> = [];
  const sourcesSkipped: string[] = [];
  const newArticleIds: string[] = [];

  try {
    const settled = await Promise.allSettled(
      targetSources.map((source) =>
        feedLimit(async () => {
          if (opts?.signal?.aborted) {
            throw createAbortError();
          }
          let added: string[];
          try {
            added = await collectSingleSource(ctx, source, seenCanonicalIds, articleLimit, driver, {
              signal: opts?.signal,
              retryDelayMs: opts?.retryDelayMs,
              settings: effectiveSettings,
              lookbackCutoffMs,
            });
          } catch (err) {
            if (isAbortError(err) || opts?.signal?.aborted) {
              throw isAbortError(err) ? err : createAbortError();
            }
            if (
              err instanceof XCookieMissingError ||
              (err instanceof Error && err.name === 'XCookieMissingError')
            ) {
              const skipMsg = err instanceof Error ? err.message : String(err);
              sourcesSkipped.push(source.id);
              if (runId) {
                const completedSources =
                  sourcesOk.length + sourcesFailed.length + sourcesSkipped.length;
                emitRunEvent(ctx, {
                  runId,
                  level: 'info',
                  stage: 'collect',
                  type: 'source_skipped',
                  message: `${sourceLabel}「${source.name}」已跳过（${completedSources}/${totalSources}）：${skipMsg}`,
                  data: { sourceId: source.id, pool, reason: skipMsg },
                });
              }
              return;
            }
            const msg = err instanceof Error ? err.message : String(err);
            sourcesFailed.push({ sourceId: source.id, error: msg });
            const failures = ctx.repos.sourceState.recordFailure(source.id, msg);
            if (runId) {
              const completedSources =
                sourcesOk.length + sourcesFailed.length + sourcesSkipped.length;
              emitRunEvent(ctx, {
                runId,
                level: 'warn',
                stage: 'collect',
                type: 'source_collect_failed',
                message: `${sourceLabel}「${source.name}」抓取失败（${completedSources}/${totalSources}），原因：${msg}`,
                data: { sourceId: source.id, pool, completedSources, totalSources, error: msg },
              });
            }
            if (failures >= SOURCE_UNHEALTHY_THRESHOLD) {
              const alertMsg = `信源 ${source.name} (${source.id}) 已连续抓取失败 ${failures} 次: ${msg}`;
              if (runId) {
                ctx.repos.runEvents.append({
                  runId,
                  ts: ctx.now().toISOString(),
                  level: 'warn',
                  stage: 'collect',
                  type: 'source_unhealthy',
                  message: alertMsg,
                  data: { sourceId: source.id, consecutiveFailures: failures, error: msg },
                });
              }
              await ctx.notifier.notify({
                type: 'source_unhealthy',
                runId,
                message: alertMsg,
                data: { sourceId: source.id, consecutiveFailures: failures, error: msg },
              });
            }
            return;
          }

          sourcesOk.push(source.id);
          newArticleIds.push(...added);
          if (runId) {
            const completedSources =
              sourcesOk.length + sourcesFailed.length + sourcesSkipped.length;
            emitRunEvent(ctx, {
              runId,
              level: 'info',
              stage: 'collect',
              type: 'source_collected',
              message: `${sourceLabel}「${source.name}」抓取完成（${completedSources}/${totalSources}），新增 ${added.length} 篇可用文章`,
              data: {
                sourceId: source.id,
                pool,
                completedSources,
                totalSources,
                newArticleCount: added.length,
              },
            });
          }
        }),
      ),
    );

    for (const outcome of settled) {
      if (outcome.status === 'rejected') {
        throw outcome.reason;
      }
    }
    if (opts?.signal?.aborted) {
      throw createAbortError();
    }

    if (targetSources.length > 0 && sourcesOk.length === 0 && sourcesFailed.length > 0) {
      throw new PipelineError(
        'collect_all_failed',
        `所有信源抓取均失败: ${sourcesFailed.map((f) => `${f.sourceId}(${f.error})`).join('; ')}`,
      );
    }

    const expiredCount = pool === 'primary' ? expireOldArticles(ctx, maxLookbackHours) : 0;

    return {
      sourcesOk,
      sourcesFailed,
      sourcesSkipped,
      newArticleIds,
      expiredCount,
    };
  } finally {
    await driver.close().catch(() => undefined);
  }
}
