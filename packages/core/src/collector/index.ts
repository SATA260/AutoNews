import fs from 'node:fs/promises';
import path from 'node:path';
import type { Settings, SourceDef, SourcePool } from '@aidaily/contracts';
import pLimit from 'p-limit';
import type { CoreContext } from '../context.js';
import { PipelineError } from '../errors.js';
import { writeJsonAtomic } from '../storage/files.js';
import { emitRunEvent } from '../workflow/events.js';
import { canonicalizeUrl, computeArticleId, normalizeTitle } from './canonical-url.js';
import { expireOldArticles } from './expiry.js';
import { extractArticleContent, fetchArticleHtml, type StoredArticleContent } from './extractor.js';
import { fetchFeedWithRetry } from './fetcher.js';
import { downloadArticleImage } from './images.js';

export * from './canonical-url.js';
export * from './expiry.js';
export * from './extractor.js';
export * from './feed-parser.js';
export * from './fetcher.js';
export * from './images.js';

const FEED_CONCURRENCY = 4;
const ARTICLE_CONCURRENCY = 4;
const OVERLAP_WINDOW_MS = 2 * 3600_000;
const SOURCE_UNHEALTHY_THRESHOLD = 3;

/** 增量采集单期执行结束后保存的检查点结果 */
export interface CollectCheckpoint {
  sourcesOk: string[];
  sourcesFailed: Array<{ sourceId: string; error: string }>;
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

/** 抓取单个启用信源、提取新增文章正文与配图、落盘并推进信源抓取进度 */
async function collectSingleSource(
  ctx: CoreContext,
  source: SourceDef,
  seenCanonicalIds: Set<string>,
  articleLimit: ReturnType<typeof pLimit>,
  opts: {
    signal?: AbortSignal;
    retryDelayMs?: number;
    timezone: string;
    lookbackCutoffMs: number;
  },
): Promise<string[]> {
  const prevState = ctx.repos.sourceState.get(source.id);
  const feedResult = await fetchFeedWithRetry(source, prevState, {
    fetchImpl: ctx.fetchImpl,
    retryDelayMs: opts.retryDelayMs,
    timezone: opts.timezone,
    signal: opts.signal,
  });

  if (opts.signal?.aborted) {
    throw createAbortError();
  }

  const nowIso = ctx.now().toISOString();
  if (feedResult.notModified) {
    ctx.repos.sourceState.upsertSuccess({
      sourceId: source.id,
      lastFetchedAt: nowIso,
      lastItemPublishedAt: null,
      etag: feedResult.etag,
      lastModified: feedResult.lastModified,
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
  const pendingItems: Array<{
    articleId: string;
    canonicalUrl: string;
    title: string;
    publishedAt: string | null;
    itemMs: number | null;
    summary: string | null;
    content: string | null;
  }> = [];

  for (const item of feedResult.items) {
    const parsedMs = item.publishedAt !== null ? Date.parse(item.publishedAt) : Number.NaN;
    const itemMs = Number.isNaN(parsedMs) ? null : parsedMs;

    if (itemMs === null) {
      // 已建立时间游标时忽略无发布时间条目，防止无日期旧闻换链后反复入库
      if (hasPrevCursor) {
        continue;
      }
    } else if (itemMs < earliestItemMs) {
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
    if (existingArticle) {
      if (itemMs !== null && (Number.isNaN(confirmedMaxMs) || itemMs > confirmedMaxMs)) {
        confirmedMaxMs = itemMs;
      }
      continue;
    }
    if (seenCanonicalIds.has(articleId)) {
      continue;
    }
    seenCanonicalIds.add(articleId);

    pendingItems.push({
      articleId,
      canonicalUrl,
      title: item.title,
      publishedAt: itemMs !== null ? item.publishedAt : null,
      itemMs,
      summary: item.summary,
      content: item.content,
    });
  }

  const processed = await Promise.all(
    pendingItems.map((entry) =>
      articleLimit(async () => {
        if (opts.signal?.aborted) {
          throw createAbortError();
        }

        const html = await fetchArticleHtml(entry.canonicalUrl, ctx.fetchImpl, {
          signal: opts.signal,
        });
        if (opts.signal?.aborted) {
          throw createAbortError();
        }

        const extracted = extractArticleContent({
          url: entry.canonicalUrl,
          html,
          feedContent: entry.content,
          feedSummary: entry.summary,
        });

        if (opts.signal?.aborted) {
          throw createAbortError();
        }

        const firstSeenAt = ctx.now().toISOString();
        const publishedAt = entry.publishedAt ?? firstSeenAt;

        let contentPath: string | null = null;
        let writtenContentFile: string | null = null;
        let imagePath: string | null = null;
        let writtenImageFile: string | null = null;

        try {
          if (extracted.extractStatus !== 'failed') {
            const contentFile = path.join(ctx.paths.articlesDir, `${entry.articleId}.json`);
            const storedPayload: StoredArticleContent = {
              url: entry.canonicalUrl,
              title: entry.title,
              lang: source.lang,
              publishedAt,
              text: extracted.text,
              feedContent: entry.content ?? entry.summary,
            };
            await writeJsonAtomic(contentFile, storedPayload);
            writtenContentFile = contentFile;
            contentPath = path.relative(ctx.paths.rootDir, contentFile);

            if (extracted.ogImageUrl) {
              if (opts.signal?.aborted) {
                throw createAbortError();
              }
              imagePath = await downloadArticleImage({
                articleId: entry.articleId,
                imageUrl: extracted.ogImageUrl,
                imagesDir: ctx.paths.imagesDir,
                rootDir: ctx.paths.rootDir,
                fetchImpl: ctx.fetchImpl,
                signal: opts.signal,
              });
              if (imagePath) {
                writtenImageFile = path.join(ctx.paths.rootDir, imagePath);
              }
            }
          }

          if (opts.signal?.aborted) {
            throw createAbortError();
          }

          const inserted = ctx.repos.articles.insertIfAbsent({
            id: entry.articleId,
            sourceId: source.id,
            canonicalUrl: entry.canonicalUrl,
            title: entry.title,
            titleNorm: normalizeTitle(entry.title),
            lang: source.lang,
            publishedAt,
            firstSeenAt,
            excerpt: extracted.excerpt || null,
            contentPath,
            contentChars: extracted.contentChars,
            imagePath,
            extractStatus: extracted.extractStatus,
          });

          return {
            articleId: inserted && extracted.extractStatus !== 'failed' ? entry.articleId : null,
            itemMs: entry.itemMs,
          };
        } catch (err) {
          if (isAbortError(err)) {
            if (writtenContentFile) {
              await fs.rm(writtenContentFile, { force: true }).catch(() => undefined);
            }
            if (writtenImageFile) {
              await fs.rm(writtenImageFile, { force: true }).catch(() => undefined);
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

  for (const res of processed) {
    if (res.itemMs !== null && (Number.isNaN(confirmedMaxMs) || res.itemMs > confirmedMaxMs)) {
      confirmedMaxMs = res.itemMs;
    }
  }

  // 本信源文章任务全部确认落盘且未收到取消信号后，再推进该信源的抓取时间游标
  const latestItemIso = Number.isNaN(confirmedMaxMs)
    ? null
    : new Date(confirmedMaxMs).toISOString();
  ctx.repos.sourceState.upsertSuccess({
    sourceId: source.id,
    lastFetchedAt: ctx.now().toISOString(),
    lastItemPublishedAt: latestItemIso,
    etag: feedResult.etag,
    lastModified: feedResult.lastModified,
    preserveConditionalHeaders: false,
  });

  return processed.map((entry) => entry.articleId).filter((id): id is string => id !== null);
}

/**
 * 执行新闻信源增量采集流程：
 * 并发拉取指定分组的启用信源，按时间窗口和链接筛选条目，再保存正文和配图。
 * 每个信源结束时记录进度，全部失败时返回明确错误，取消时等待正在采集的信源收尾。
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
  const targetSources = ctx.sources.filter((s) => s.enabled && s.kind === 'rss' && s.pool === pool);
  const totalSources = targetSources.length;
  const sourceLabel = pool === 'primary' ? '主力信源' : '备用信源';

  const feedLimit = pLimit(FEED_CONCURRENCY);
  const articleLimit = pLimit(ARTICLE_CONCURRENCY);
  const seenCanonicalIds = new Set<string>();

  const sourcesOk: string[] = [];
  const sourcesFailed: Array<{ sourceId: string; error: string }> = [];
  const newArticleIds: string[] = [];

  const settled = await Promise.allSettled(
    targetSources.map((source) =>
      feedLimit(async () => {
        if (opts?.signal?.aborted) {
          throw createAbortError();
        }
        let added: string[];
        try {
          added = await collectSingleSource(ctx, source, seenCanonicalIds, articleLimit, {
            signal: opts?.signal,
            retryDelayMs: opts?.retryDelayMs,
            timezone: effectiveSettings.timezone,
            lookbackCutoffMs,
          });
        } catch (err) {
          if (isAbortError(err) || opts?.signal?.aborted) {
            throw isAbortError(err) ? err : createAbortError();
          }
          const msg = err instanceof Error ? err.message : String(err);
          sourcesFailed.push({ sourceId: source.id, error: msg });
          const failures = ctx.repos.sourceState.recordFailure(source.id, msg);
          if (runId) {
            const completedSources = sourcesOk.length + sourcesFailed.length;
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
          const completedSources = sourcesOk.length + sourcesFailed.length;
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

  if (targetSources.length > 0 && sourcesOk.length === 0) {
    throw new PipelineError(
      'collect_all_failed',
      `所有信源抓取均失败: ${sourcesFailed.map((f) => `${f.sourceId}(${f.error})`).join('; ')}`,
    );
  }

  const expiredCount = pool === 'primary' ? expireOldArticles(ctx, maxLookbackHours) : 0;

  return {
    sourcesOk,
    sourcesFailed,
    newArticleIds,
    expiredCount,
  };
}
