import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  type Article,
  type ArticleDetail,
  ArticleDetailSchema,
  type ArticleListItem,
  type ArticleListQuery,
  ArticleListQuerySchema,
  type ArticleListResult,
  ArticleListResultSchema,
  type DeleteArticlesInput,
  DeleteArticlesInputSchema,
  type DeleteArticlesResult,
  DeleteArticlesResultSchema,
  type MarkArticlesUnplayedInput,
  MarkArticlesUnplayedInputSchema,
  type MarkArticlesUnplayedResult,
  MarkArticlesUnplayedResultSchema,
} from '@aidaily/contracts';
import { readStoredArticleContent, type StoredArticleContent } from '../collector/extractor.js';
import type { CoreContext } from '../context.js';
import { NotFoundError } from '../errors.js';
import { inTransaction } from '../storage/db.js';
import { resolveTimeRangeBounds } from './time-filter.js';

/** 已抓取文章查询与删除管理服务接口 */
export interface ArticleService {
  /** 分页并按条件筛选查询本地已抓取的新闻文章列表 */
  list(query?: ArticleListQuery): Promise<ArticleListResult>;
  /** 获取单篇已抓取文章的完整正文、摘要及关联候选配图明细 */
  getDetail(articleId: string): Promise<ArticleDetail>;
  /** 预演或执行选择性及按条件批量删除文章，并安全回收关联的本地缓存文件 */
  delete(input: DeleteArticlesInput): Promise<DeleteArticlesResult>;
  /** 将已播放的文章手动重置为未播放状态，并清理关联的历史已播去重记录 */
  markUnplayed(input: MarkArticlesUnplayedInput): Promise<MarkArticlesUnplayedResult>;
}

interface CandidateLocalFile {
  absPath: string;
  column: 'content_path' | 'image_path';
  dbKeys: Set<string>;
  bytes: number;
}

/** 根据配置信源清单构建文章列表项中的信源显示名称 */
function buildSourceNameLookup(ctx: CoreContext): Map<string, string> {
  return new Map(ctx.sources.map((src) => [src.id, src.name]));
}

/** 为基础文章记录补充可读的信源名称 */
function attachSourceName(article: Article, sourceNames: Map<string, string>): ArticleListItem {
  return {
    ...article,
    sourceName: sourceNames.get(article.sourceId) ?? article.sourceId,
  };
}

/** 校验待删除文件严格位于允许的存储子目录内部，拒绝越界路径与软链接 */
async function resolveSafeRegularFileForDelete(
  rootDir: string,
  allowedDir: string,
  relFromRoot: string | null | undefined,
  column: 'content_path' | 'image_path',
): Promise<CandidateLocalFile | null> {
  if (!relFromRoot || relFromRoot.includes('\0')) {
    return null;
  }
  const baseAllowed = path.resolve(allowedDir);
  const absCandidate = path.resolve(rootDir, relFromRoot);
  if (!absCandidate.startsWith(`${baseAllowed}${path.sep}`)) {
    return null;
  }

  let st: fsSync.Stats;
  try {
    st = await fs.lstat(absCandidate);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw err;
  }

  if (st.isSymbolicLink() || !st.isFile()) {
    return null;
  }

  try {
    const realAllowed = fsSync.realpathSync(baseAllowed);
    const realFile = fsSync.realpathSync(absCandidate);
    if (!realFile.startsWith(`${realAllowed}${path.sep}`)) {
      return null;
    }
  } catch {
    return null;
  }

  const normalizedRel = path.relative(rootDir, absCandidate).split(path.sep).join('/');
  return {
    absPath: absCandidate,
    column,
    dbKeys: new Set([relFromRoot, normalizedRel]),
    bytes: st.size,
  };
}

/** 仅在文件仍位于文章缓存目录且不是软链接时读取已存储的文章内容用于清理附属配图 */
async function readStoredContentSafelyForDelete(
  ctx: CoreContext,
  contentPath: string | null,
): Promise<StoredArticleContent | null> {
  if (!contentPath || contentPath.includes('\0')) {
    return null;
  }
  const baseAllowed = path.resolve(ctx.paths.articlesDir);
  const absCandidate = path.resolve(ctx.paths.rootDir, contentPath);
  if (!absCandidate.startsWith(`${baseAllowed}${path.sep}`)) {
    return null;
  }
  try {
    const st = await fs.lstat(absCandidate);
    if (st.isSymbolicLink() || !st.isFile()) {
      return null;
    }
  } catch {
    return null;
  }
  return readStoredArticleContent(ctx.paths.rootDir, contentPath).catch(() => null);
}

/** 创建已抓取文章的浏览、详情读取与安全删除服务 */
export function createArticleService(ctx: CoreContext): ArticleService {
  return {
    /** 按信源、状态、正文提取结果、语言、关键词与时间区间分页查询已抓取新闻 */
    async list(rawQuery?: ArticleListQuery): Promise<ArticleListResult> {
      const parsed = ArticleListQuerySchema.parse(rawQuery ?? {});
      const { fromIso, toIso } = resolveTimeRangeBounds({
        from: parsed.from,
        to: parsed.to,
        timezone: ctx.settings.timezone,
      });

      const offset = (parsed.page - 1) * parsed.pageSize;
      const { items, total, statusCounts } = ctx.repos.articles.listFiltered({
        sourceId: parsed.sourceId,
        status: parsed.status,
        extractStatus: parsed.extractStatus,
        lang: parsed.lang,
        query: parsed.query,
        timeField: parsed.timeField,
        fromIso,
        toIso,
        limit: parsed.pageSize,
        offset,
      });

      const sourceNames = buildSourceNameLookup(ctx);
      return ArticleListResultSchema.parse({
        items: items.map((art) => attachSourceName(art, sourceNames)),
        total,
        page: parsed.page,
        pageSize: parsed.pageSize,
        statusCounts,
      });
    },

    /** 读取单篇已抓取文章及其硬盘缓存正文与候选配图列表 */
    async getDetail(articleId: string): Promise<ArticleDetail> {
      const trimmedId = articleId.trim();
      if (!trimmedId) {
        throw new Error('文章 ID 不能为空');
      }
      const article = ctx.repos.articles.getById(trimmedId);
      if (!article) {
        throw new NotFoundError(`未找到文章记录: ${trimmedId}`);
      }

      const sourceNames = buildSourceNameLookup(ctx);
      const item = attachSourceName(article, sourceNames);
      const stored = await readStoredArticleContent(ctx.paths.rootDir, article.contentPath).catch(
        (err) => {
          if (err instanceof Error && err.message.includes('禁止读取')) {
            return null;
          }
          return null;
        },
      );

      if (!stored) {
        return ArticleDetailSchema.parse({
          article: item,
          contentText: null,
          feedContent: null,
          mediaAssets: [],
          contentFileExists: false,
        });
      }

      return ArticleDetailSchema.parse({
        article: item,
        contentText: stored.text ?? null,
        feedContent: stored.feedContent ?? null,
        mediaAssets: stored.mediaAssets ?? [],
        contentFileExists: true,
      });
    },

    /** 预演或执行文章及本地缓存文件删除，自动跳过并保护仍被任务占用的文章 */
    async delete(rawInput: DeleteArticlesInput): Promise<DeleteArticlesResult> {
      const parsed = DeleteArticlesInputSchema.parse(rawInput ?? {});
      const uniqueIds = parsed.ids
        ? Array.from(new Set(parsed.ids.map((id) => id.trim()).filter(Boolean)))
        : undefined;

      const hasIds = Boolean(uniqueIds && uniqueIds.length > 0);
      const hasFilters = Boolean(
        parsed.sourceId ||
          (parsed.status && parsed.status.length > 0) ||
          (parsed.extractStatus && parsed.extractStatus.length > 0) ||
          parsed.lang ||
          parsed.query ||
          parsed.from ||
          parsed.to,
      );
      if (!hasIds && !hasFilters) {
        throw new Error('请至少勾选具体文章或指定至少一个筛选条件（如时间范围）后再删除');
      }

      const { fromIso, toIso } = resolveTimeRangeBounds({
        from: parsed.from,
        to: parsed.to,
        timezone: ctx.settings.timezone,
      });

      const matched = ctx.repos.articles.findMatching({
        ...(uniqueIds !== undefined ? { ids: uniqueIds } : {}),
        sourceId: parsed.sourceId,
        status: parsed.status,
        extractStatus: parsed.extractStatus,
        lang: parsed.lang,
        query: parsed.query,
        timeField: parsed.timeField,
        fromIso,
        toIso,
      });

      const skippedReservedIds: string[] = [];
      const deletable: Article[] = [];
      for (const art of matched) {
        if (art.status === 'reserved' || art.reservedByRun !== null) {
          skippedReservedIds.push(art.id);
        } else {
          deletable.push(art);
        }
      }

      const filesByArticleId = new Map<string, CandidateLocalFile[]>();
      for (const art of deletable) {
        const candidates: CandidateLocalFile[] = [];
        const contentFile = await resolveSafeRegularFileForDelete(
          ctx.paths.rootDir,
          ctx.paths.articlesDir,
          art.contentPath,
          'content_path',
        );
        if (contentFile) {
          candidates.push(contentFile);
        }

        const stored = await readStoredContentSafelyForDelete(ctx, art.contentPath);
        const imageRelPaths = new Set<string>();
        if (art.imagePath) {
          imageRelPaths.add(art.imagePath);
        }
        for (const asset of stored?.mediaAssets ?? []) {
          if (asset.imagePath) {
            imageRelPaths.add(asset.imagePath);
          }
        }
        for (const imgRel of imageRelPaths) {
          const imgFile = await resolveSafeRegularFileForDelete(
            ctx.paths.rootDir,
            ctx.paths.imagesDir,
            imgRel,
            'image_path',
          );
          if (imgFile) {
            candidates.push(imgFile);
          }
        }
        filesByArticleId.set(art.id, candidates);
      }

      const dryRun = Boolean(parsed.dryRun);
      const mergeCandidateFiles = (
        targetIds: readonly string[],
      ): Map<string, CandidateLocalFile> => {
        const merged = new Map<string, CandidateLocalFile>();
        for (const artId of targetIds) {
          for (const entry of filesByArticleId.get(artId) ?? []) {
            const existing = merged.get(entry.absPath);
            if (existing) {
              for (const k of entry.dbKeys) {
                existing.dbKeys.add(k);
              }
            } else {
              merged.set(entry.absPath, {
                absPath: entry.absPath,
                column: entry.column,
                dbKeys: new Set(entry.dbKeys),
                bytes: entry.bytes,
              });
            }
          }
        }
        return merged;
      };

      const filterUnreferencedFiles = (
        merged: Map<string, CandidateLocalFile>,
        excludeIds?: ReadonlySet<string>,
      ): CandidateLocalFile[] => {
        const contentKeys: string[] = [];
        const imageKeys: string[] = [];
        for (const file of merged.values()) {
          if (file.column === 'content_path') {
            contentKeys.push(...file.dbKeys);
          } else {
            imageKeys.push(...file.dbKeys);
          }
        }
        const stillRefContent = ctx.repos.articles.findReferencedPaths(
          contentKeys,
          'content_path',
          excludeIds,
        );
        const stillRefImages = ctx.repos.articles.findReferencedPaths(
          imageKeys,
          'image_path',
          excludeIds,
        );

        const removable: CandidateLocalFile[] = [];
        for (const file of merged.values()) {
          const refSet = file.column === 'content_path' ? stillRefContent : stillRefImages;
          let inUse = false;
          for (const key of file.dbKeys) {
            if (refSet.has(key)) {
              inUse = true;
              break;
            }
          }
          if (!inUse) {
            removable.push(file);
          }
        }
        return removable;
      };

      if (dryRun) {
        const deletableIds = deletable.map((a) => a.id);
        const merged = mergeCandidateFiles(deletableIds);
        const removable = filterUnreferencedFiles(merged, new Set(deletableIds));
        const reclaimedBytes = removable.reduce((sum, item) => sum + item.bytes, 0);
        return DeleteArticlesResultSchema.parse({
          dryRun: true,
          matchedCount: matched.length,
          deletableCount: deletable.length,
          deletedCount: 0,
          skippedReservedCount: skippedReservedIds.length,
          deletedIds: [],
          skippedReservedIds,
          deletedFileCount: removable.length,
          reclaimedBytes,
        });
      }

      const deletableIds = deletable.map((a) => a.id);
      const actuallyDeletedIds = ctx.repos.articles.deleteUnreservedByIds(deletableIds);
      const deletedIdSet = new Set(actuallyDeletedIds);
      for (const id of deletableIds) {
        if (!deletedIdSet.has(id)) {
          skippedReservedIds.push(id);
        }
      }

      const merged = mergeCandidateFiles(actuallyDeletedIds);
      const removable = filterUnreferencedFiles(merged);
      let deletedFileCount = 0;
      let reclaimedBytes = 0;
      for (const file of removable) {
        try {
          await fs.rm(file.absPath, { force: true });
          deletedFileCount += 1;
          reclaimedBytes += file.bytes;
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
            ctx.logger.warn({ err, path: file.absPath }, '清理已删除文章的本地缓存文件时失败');
          }
        }
      }

      return DeleteArticlesResultSchema.parse({
        dryRun: false,
        matchedCount: matched.length,
        deletableCount: deletable.length,
        deletedCount: actuallyDeletedIds.length,
        skippedReservedCount: skippedReservedIds.length,
        deletedIds: actuallyDeletedIds,
        skippedReservedIds,
        deletedFileCount,
        reclaimedBytes,
      });
    },

    /** 将已播文章手动重置为未播（status = 'new'），并清理关联的已播历史防重记录 */
    async markUnplayed(rawInput: MarkArticlesUnplayedInput): Promise<MarkArticlesUnplayedResult> {
      const parsed = MarkArticlesUnplayedInputSchema.parse(rawInput);
      const uniqueIds = Array.from(new Set(parsed.ids.map((id) => id.trim()).filter(Boolean)));
      if (uniqueIds.length === 0) {
        throw new Error('请至少选择一篇需要标记为未播的文章');
      }

      const { updatedArticles, removedHistoryCount } = inTransaction(ctx.db, () => {
        const updated = ctx.repos.articles.markUnplayedByIds(uniqueIds);
        const urls = updated.map((art) => art.canonicalUrl);
        const removedHistory = ctx.repos.history.deleteByArticleUrls(urls);
        return {
          updatedArticles: updated,
          removedHistoryCount: removedHistory,
        };
      });

      return MarkArticlesUnplayedResultSchema.parse({
        updatedCount: updatedArticles.length,
        updatedIds: updatedArticles.map((art) => art.id),
        removedHistoryCount,
      });
    },
  };
}
