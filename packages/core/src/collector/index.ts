import path from 'node:path';
import type { Settings, SourceDef, SourcePool } from '@aidaily/contracts';
import pLimit from 'p-limit';
import type { CoreContext } from '../context.js';
import { PipelineError } from '../errors.js';
import { writeJsonAtomic } from '../storage/files.js';
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

/** 抓取单个启用信源、提取新增文章正文与配图、落盘并推进信源抓取进度 */
async function collectSingleSource(
  ctx: CoreContext,
  source: SourceDef,
  seenCanonicalIds: Set<string>,
  articleLimit: ReturnType<typeof pLimit>,
  opts: {
    runId?: string;
    signal?: AbortSignal;
    retryDelayMs?: number;
  },
): Promise<string[]> {
  const prevState = ctx.repos.sourceState.get(source.id);
  const feedResult = await fetchFeedWithRetry(source, prevState, {
    fetchImpl: ctx.fetchImpl,
    retryDelayMs: opts.retryDelayMs,
    signal: opts.signal,
  });

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
  const overlapStartMs = Number.isNaN(prevCursorMs)
    ? Number.NEGATIVE_INFINITY
    : prevCursorMs - OVERLAP_WINDOW_MS;

  let maxItemPublishedMs = Number.NaN;
  const pendingItems: Array<{
    articleId: string;
    canonicalUrl: string;
    title: string;
    publishedAt: string | null;
    summary: string | null;
    content: string | null;
  }> = [];

  for (const item of feedResult.items) {
    if (item.publishedAt !== null) {
      const itemMs = Date.parse(item.publishedAt);
      if (!Number.isNaN(itemMs)) {
        if (Number.isNaN(maxItemPublishedMs) || itemMs > maxItemPublishedMs) {
          maxItemPublishedMs = itemMs;
        }
        if (itemMs < overlapStartMs) {
          continue;
        }
      }
    }

    let canonicalUrl: string;
    try {
      canonicalUrl = canonicalizeUrl(item.url, source.url);
    } catch {
      continue;
    }

    const articleId = computeArticleId(canonicalUrl);
    if (seenCanonicalIds.has(articleId) || ctx.repos.articles.getById(articleId)) {
      continue;
    }
    seenCanonicalIds.add(articleId);

    pendingItems.push({
      articleId,
      canonicalUrl,
      title: item.title,
      publishedAt: item.publishedAt,
      summary: item.summary,
      content: item.content,
    });
  }

  const createdIds = await Promise.all(
    pendingItems.map((entry) =>
      articleLimit(async () => {
        if (opts.signal?.aborted) {
          throw new DOMException('已取消', 'AbortError');
        }

        const html = await fetchArticleHtml(entry.canonicalUrl, ctx.fetchImpl, {
          signal: opts.signal,
        });
        const extracted = extractArticleContent({
          url: entry.canonicalUrl,
          html,
          feedContent: entry.content,
          feedSummary: entry.summary,
        });

        const firstSeenAt = ctx.now().toISOString();
        const publishedAt = entry.publishedAt ?? firstSeenAt;

        let contentPath: string | null = null;
        let imagePath: string | null = null;

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
          contentPath = path.relative(ctx.paths.rootDir, contentFile);

          if (extracted.ogImageUrl) {
            imagePath = await downloadArticleImage({
              articleId: entry.articleId,
              imageUrl: extracted.ogImageUrl,
              imagesDir: ctx.paths.imagesDir,
              rootDir: ctx.paths.rootDir,
              fetchImpl: ctx.fetchImpl,
              signal: opts.signal,
            });
          }
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

        return inserted && extracted.extractStatus !== 'failed' ? entry.articleId : null;
      }),
    ),
  );

  // 所有新文章正文与记录安全落盘后，再推进该信源的抓取时间游标
  const latestItemIso = Number.isNaN(maxItemPublishedMs)
    ? null
    : new Date(maxItemPublishedMs).toISOString();
  ctx.repos.sourceState.upsertSuccess({
    sourceId: source.id,
    lastFetchedAt: ctx.now().toISOString(),
    lastItemPublishedAt: latestItemIso,
    etag: feedResult.etag,
    lastModified: feedResult.lastModified,
    preserveConditionalHeaders: false,
  });

  return createdIds.filter((id): id is string => id !== null);
}

/**
 * 执行新闻信源增量采集流程：
 * 并发拉取指定分组的启用信源，过滤重抓重叠窗口与重复链接，提取正文与配图落盘，
 * 更新信源健康状态并在全部主力信源失败时返回明确错误。
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
  const pool = opts?.pool ?? 'primary';
  const effectiveSettings = opts?.settings ?? ctx.settings;
  const targetSources = ctx.sources.filter((s) => s.enabled && s.kind === 'rss' && s.pool === pool);

  const feedLimit = pLimit(FEED_CONCURRENCY);
  const articleLimit = pLimit(ARTICLE_CONCURRENCY);
  const seenCanonicalIds = new Set<string>();

  const sourcesOk: string[] = [];
  const sourcesFailed: Array<{ sourceId: string; error: string }> = [];
  const newArticleIds: string[] = [];

  await Promise.all(
    targetSources.map((source) =>
      feedLimit(async () => {
        if (opts?.signal?.aborted) {
          throw new DOMException('已取消', 'AbortError');
        }
        try {
          const added = await collectSingleSource(ctx, source, seenCanonicalIds, articleLimit, {
            runId: opts?.runId,
            signal: opts?.signal,
            retryDelayMs: opts?.retryDelayMs,
          });
          sourcesOk.push(source.id);
          newArticleIds.push(...added);
        } catch (err) {
          if (err instanceof Error && err.name === 'AbortError') {
            throw err;
          }
          const msg = err instanceof Error ? err.message : String(err);
          sourcesFailed.push({ sourceId: source.id, error: msg });
          const failures = ctx.repos.sourceState.recordFailure(source.id, msg);
          if (failures >= SOURCE_UNHEALTHY_THRESHOLD) {
            const alertMsg = `信源 ${source.name} (${source.id}) 已连续抓取失败 ${failures} 次: ${msg}`;
            if (opts?.runId) {
              ctx.repos.runEvents.append({
                runId: opts.runId,
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
              runId: opts?.runId,
              message: alertMsg,
              data: { sourceId: source.id, consecutiveFailures: failures, error: msg },
            });
          }
        }
      }),
    ),
  );

  if (targetSources.length > 0 && sourcesOk.length === 0) {
    throw new PipelineError(
      'collect_all_failed',
      `所有信源抓取均失败: ${sourcesFailed.map((f) => `${f.sourceId}(${f.error})`).join('; ')}`,
    );
  }

  const expiredCount =
    pool === 'primary'
      ? expireOldArticles(ctx, effectiveSettings.issue.refill.maxLookbackHours)
      : 0;

  return {
    sourcesOk,
    sourcesFailed,
    newArticleIds,
    expiredCount,
  };
}
