import type {
  Article,
  ArticleStatus,
  ExtractStatus,
  SourceLang,
  SourceState,
} from '@aidaily/contracts';
import { type DatabaseSync, inTransaction } from '../db.js';

/** 将输入时间戳统一转为精确到毫秒的标准 UTC ISO 字符串 */
function normalizeIsoTimestamp(value: string | null): string | null {
  if (!value) {
    return null;
  }
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? value : new Date(ms).toISOString();
}

/** 校验分页上限参数为不超过指定最大值的正整数 */
function clampLimit(limit: number, maxLimit = 500): number {
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new RangeError(`查询数量上限 limit 必须为正整数: ${String(limit)}`);
  }
  return Math.min(limit, maxLimit);
}

/** 数据库 `source_state` 表行结构 */
interface SourceStateRow {
  source_id: string;
  last_fetched_at: string | null;
  last_item_published_at: string | null;
  etag: string | null;
  last_modified: string | null;
  consecutive_failures: number;
  last_error: string | null;
}

/** 数据库 `articles` 表行结构 */
interface ArticleRow {
  id: string;
  source_id: string;
  canonical_url: string;
  title: string;
  title_norm: string;
  lang: SourceLang;
  published_at: string | null;
  first_seen_at: string;
  excerpt: string | null;
  content_path: string | null;
  content_chars: number | null;
  image_path: string | null;
  extract_status: ExtractStatus;
  status: ArticleStatus;
  reserved_by_run: string | null;
}

/** 曾经制作并播报过的历史事件记录，用于跨天避免重复播报 */
export interface PublishedHistoryRecord {
  eventId: string;
  runId: string;
  title: string;
  titleNorm: string;
  entity: string | null;
  articleUrls: string[];
  publishedAt: string;
}

/** 将数据库行转换为信源状态业务对象 */
function mapSourceState(row: SourceStateRow): SourceState {
  return {
    sourceId: row.source_id,
    lastFetchedAt: row.last_fetched_at,
    lastItemPublishedAt: row.last_item_published_at,
    etag: row.etag,
    lastModified: row.last_modified,
    consecutiveFailures: row.consecutive_failures,
    lastError: row.last_error,
  };
}

/** 将数据库行转换为文章业务对象 */
function mapArticle(row: ArticleRow): Article {
  return {
    id: row.id,
    sourceId: row.source_id,
    canonicalUrl: row.canonical_url,
    title: row.title,
    titleNorm: row.title_norm,
    lang: row.lang,
    publishedAt: row.published_at,
    firstSeenAt: row.first_seen_at,
    excerpt: row.excerpt,
    contentPath: row.content_path,
    contentChars: row.content_chars,
    imagePath: row.image_path,
    extractStatus: row.extract_status,
    status: row.status,
    reservedByRun: row.reserved_by_run,
  };
}

/** 创建信源抓取进度读写对象，管理各信源游标、缓存标识与失败次数 */
export function createSourceStateRepo(db: DatabaseSync) {
  return {
    /** 查询单个信源的抓取状态 */
    get(sourceId: string): SourceState | null {
      const row = db.prepare('SELECT * FROM source_state WHERE source_id = ?').get(sourceId) as
        | SourceStateRow
        | undefined;
      return row ? mapSourceState(row) : null;
    },

    /** 查询全部信源的抓取状态 */
    listAll(): SourceState[] {
      const rows = db.prepare('SELECT * FROM source_state').all() as unknown as SourceStateRow[];
      return rows.map(mapSourceState);
    },

    /** 信源抓取成功后更新其最新抓取时间、最新文章发布时间并清零连续失败计数 */
    upsertSuccess(input: {
      sourceId: string;
      lastFetchedAt: string;
      lastItemPublishedAt: string | null;
      etag: string | null;
      lastModified: string | null;
      preserveConditionalHeaders?: boolean;
    }): void {
      const normalizedLastItemAt = normalizeIsoTimestamp(input.lastItemPublishedAt);
      const etagExpr = input.preserveConditionalHeaders
        ? 'COALESCE(excluded.etag, source_state.etag)'
        : 'excluded.etag';
      const lastModExpr = input.preserveConditionalHeaders
        ? 'COALESCE(excluded.last_modified, source_state.last_modified)'
        : 'excluded.last_modified';

      db.prepare(`
        INSERT INTO source_state (
          source_id, last_fetched_at, last_item_published_at, etag, last_modified, consecutive_failures, last_error
        ) VALUES (?, ?, ?, ?, ?, 0, NULL)
        ON CONFLICT(source_id) DO UPDATE SET
          last_fetched_at = excluded.last_fetched_at,
          last_item_published_at = CASE
            WHEN excluded.last_item_published_at IS NOT NULL AND (
              source_state.last_item_published_at IS NULL OR
              julianday(excluded.last_item_published_at) > julianday(source_state.last_item_published_at)
            ) THEN excluded.last_item_published_at
            ELSE source_state.last_item_published_at
          END,
          etag = ${etagExpr},
          last_modified = ${lastModExpr},
          consecutive_failures = 0,
          last_error = NULL
      `).run(
        input.sourceId,
        input.lastFetchedAt,
        normalizedLastItemAt,
        input.etag,
        input.lastModified,
      );
    },

    /** 记录一次信源抓取失败并返回累加后的连续失败次数 */
    recordFailure(sourceId: string, errorMsg: string): number {
      const row = db
        .prepare(`
          INSERT INTO source_state (source_id, consecutive_failures, last_error)
          VALUES (?, 1, ?)
          ON CONFLICT(source_id) DO UPDATE SET
            consecutive_failures = source_state.consecutive_failures + 1,
            last_error = excluded.last_error
          RETURNING consecutive_failures
        `)
        .get(sourceId, errorMsg) as { consecutive_failures: number };
      return row.consecutive_failures;
    },
  };
}

/** 创建文章数据库操作对象，负责去重入库、候选检索与占用消费状态流转 */
export function createArticlesRepo(db: DatabaseSync) {
  return {
    /** 若标准化链接尚未入库则插入新文章，已存在时静默跳过并返回 false */
    insertIfAbsent(article: Omit<Article, 'status' | 'reservedByRun'>): boolean {
      const res = db
        .prepare(`
          INSERT OR IGNORE INTO articles (
            id, source_id, canonical_url, title, title_norm, lang, published_at, first_seen_at,
            excerpt, content_path, content_chars, image_path, extract_status, status, reserved_by_run
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', NULL)
        `)
        .run(
          article.id,
          article.sourceId,
          article.canonicalUrl,
          article.title,
          article.titleNorm,
          article.lang,
          article.publishedAt,
          article.firstSeenAt,
          article.excerpt,
          article.contentPath,
          article.contentChars,
          article.imagePath,
          article.extractStatus,
        );
      return Number(res.changes) > 0;
    },

    /** 按文章 ID 查询单篇文章 */
    getById(id: string): Article | null {
      const row = db.prepare('SELECT * FROM articles WHERE id = ?').get(id) as
        | ArticleRow
        | undefined;
      return row ? mapArticle(row) : null;
    },

    /** 按文章 ID 列表批量查询文章 */
    getByIds(ids: string[]): Article[] {
      if (ids.length === 0) {
        return [];
      }
      const placeholders = ids.map(() => '?').join(', ');
      const rows = db
        .prepare(`SELECT * FROM articles WHERE id IN (${placeholders})`)
        .all(...ids) as unknown as ArticleRow[];
      return rows.map(mapArticle);
    },

    /** 按发布时间窗口筛选可供选题使用的候选文章列表（开启严格下限校验时不再用采集时间覆盖明确更早的发布时间） */
    listCandidates(
      sinceIso: string,
      includeExpired = false,
      opts?: { strictNotBefore?: boolean },
    ): Article[] {
      const allowedStatuses = includeExpired ? "('new', 'expired')" : "('new')";
      if (opts?.strictNotBefore) {
        const rows = db
          .prepare(`
            SELECT * FROM articles
            WHERE status IN ${allowedStatuses}
              AND extract_status IN ('ok', 'feed_only')
              AND (
                (published_at IS NOT NULL AND published_at >= ?)
                OR (published_at IS NULL AND first_seen_at >= ?)
              )
            ORDER BY COALESCE(published_at, first_seen_at) DESC
          `)
          .all(sinceIso, sinceIso) as unknown as ArticleRow[];
        return rows.map(mapArticle);
      }
      const rows = db
        .prepare(`
          SELECT * FROM articles
          WHERE status IN ${allowedStatuses}
            AND extract_status IN ('ok', 'feed_only')
            AND COALESCE(published_at, first_seen_at) >= ?
          ORDER BY COALESCE(published_at, first_seen_at) DESC
        `)
        .all(sinceIso) as unknown as ArticleRow[];
      return rows.map(mapArticle);
    },

    /** 查询指定时间范围内已入库的最新文章样本，用于判断二手报道是否源自早于最早时间的一手旧闻 */
    listRecentForOriginCheck(sinceIso: string, beforeIso: string, limit = 300): Article[] {
      const safeLimit = clampLimit(limit, 500);
      const rows = db
        .prepare(`
          SELECT * FROM articles
          WHERE published_at IS NOT NULL
            AND published_at >= ?
            AND published_at < ?
          ORDER BY published_at DESC
          LIMIT ?
        `)
        .all(sinceIso, beforeIso, safeLimit) as unknown as ArticleRow[];
      return rows.map(mapArticle);
    },

    /** 查询指定时间点之后已消费播出的近期文章记录，用于辅助防止跨期重复选题 */
    listRecentConsumed(sinceIso: string, limit = 300): Article[] {
      const safeLimit = clampLimit(limit, 500);
      const rows = db
        .prepare(`
          SELECT * FROM articles
          WHERE status = 'consumed'
            AND COALESCE(published_at, first_seen_at) >= ?
          ORDER BY COALESCE(published_at, first_seen_at) DESC
          LIMIT ?
        `)
        .all(sinceIso, safeLimit) as unknown as ArticleRow[];
      return rows.map(mapArticle);
    },

    /** 检查指定信源是否存在尚处于回溯窗口内但此前详情抽取失败的待选文章 */
    hasRecentFailedForSource(sourceId: string, sinceIso: string): boolean {
      const row = db
        .prepare(`
          SELECT 1 AS found FROM articles
          WHERE source_id = ?
            AND status = 'new'
            AND extract_status = 'failed'
            AND COALESCE(published_at, first_seen_at) >= ?
          LIMIT 1
        `)
        .get(sourceId, sinceIso) as { found: number } | undefined;
      return Boolean(row?.found);
    },

    /** 对此前详情抓取失败的待选文章执行原地正文与配图元信息补全升级 */
    upgradeFailedExtraction(article: {
      id: string;
      title: string;
      titleNorm: string;
      publishedAt: string | null;
      excerpt: string | null;
      contentPath: string | null;
      contentChars: number | null;
      imagePath: string | null;
      extractStatus: ExtractStatus;
    }): boolean {
      if (article.extractStatus === 'failed') {
        return false;
      }
      const res = db
        .prepare(`
          UPDATE articles
          SET title = ?,
              title_norm = ?,
              published_at = COALESCE(?, published_at),
              excerpt = ?,
              content_path = ?,
              content_chars = ?,
              image_path = ?,
              extract_status = ?
          WHERE id = ? AND status = 'new' AND extract_status = 'failed'
        `)
        .run(
          article.title,
          article.titleNorm,
          article.publishedAt,
          article.excerpt,
          article.contentPath,
          article.contentChars,
          article.imagePath,
          article.extractStatus,
          article.id,
        );
      return Number(res.changes) > 0;
    },

    /** 将选中的文章在事务内全部标记为被指定期次占用，避免被其他期次重复挑选 */
    markReserved(articleIds: string[], runId: string): void {
      const uniqueIds = Array.from(new Set(articleIds));
      if (uniqueIds.length === 0) {
        return;
      }
      inTransaction(db, () => {
        const placeholders = uniqueIds.map(() => '?').join(', ');
        const res = db
          .prepare(`
            UPDATE articles
            SET status = 'reserved', reserved_by_run = ?
            WHERE id IN (${placeholders})
              AND (status IN ('new', 'expired') OR (status = 'reserved' AND reserved_by_run = ?))
          `)
          .run(runId, ...uniqueIds, runId);
        if (Number(res.changes) !== uniqueIds.length) {
          throw new Error(
            `文章占用失败：预期占用 ${uniqueIds.length} 篇，实际更新 ${String(res.changes)} 篇（可能已被其他任务占用或已消费）`,
          );
        }
      });
    },

    /** 释放某期任务占用的全部文章，使其重新回到待选池 */
    releaseByRun(runId: string): number {
      const res = db
        .prepare(`
          UPDATE articles
          SET status = 'new', reserved_by_run = NULL
          WHERE reserved_by_run = ? AND status = 'reserved'
        `)
        .run(runId);
      return Number(res.changes);
    },

    /**
     * 把已经发布过的这一期关联文章退回可再次使用的状态。
     * 只改无人占用或仍属于本期的文章，不会抢走其他期次正在使用的文章。
     * release_to_new 退回待选；rereserve 重新标成由本期占用。
     */
    reviveArticlesForRun(
      articleIds: string[],
      runId: string,
      mode: 'release_to_new' | 'rereserve',
    ): number {
      const uniqueIds = Array.from(new Set(articleIds.filter((id) => id.trim().length > 0)));
      if (uniqueIds.length === 0) {
        return 0;
      }
      return inTransaction(db, () => {
        const placeholders = uniqueIds.map(() => '?').join(', ');
        const nextStatus = mode === 'release_to_new' ? 'new' : 'reserved';
        const nextOwner = mode === 'release_to_new' ? null : runId;
        const res = db
          .prepare(`
            UPDATE articles
            SET status = ?, reserved_by_run = ?
            WHERE id IN (${placeholders})
              AND (reserved_by_run IS NULL OR reserved_by_run = ?)
          `)
          .run(nextStatus, nextOwner, ...uniqueIds, runId);
        return Number(res.changes);
      });
    },

    /** 在确认发布或人工标记已消费后，将对应文章正式标记为已播出，返回实际更新篇数 */
    markConsumed(articleIds: string[], runId: string): number {
      const uniqueIds = Array.from(new Set(articleIds));
      if (uniqueIds.length === 0) {
        return 0;
      }
      const placeholders = uniqueIds.map(() => '?').join(', ');
      const res = db
        .prepare(`
        UPDATE articles
        SET status = 'consumed', reserved_by_run = NULL
        WHERE id IN (${placeholders}) AND reserved_by_run = ?
      `)
        .run(...uniqueIds, runId);
      return Number(res.changes);
    },

    /** 将超出最久回溯时效仍未入选的待选文章标记为已过期 */
    expireOlderThan(cutoffIso: string): number {
      const res = db
        .prepare(`
          UPDATE articles
          SET status = 'expired'
          WHERE status = 'new' AND COALESCE(published_at, first_seen_at) < ?
        `)
        .run(cutoffIso);
      return Number(res.changes);
    },
  };
}

/** 创建历史已播事件库读写对象，用于防止跨天播报同一条旧闻 */
export function createHistoryRepo(db: DatabaseSync) {
  return {
    /** 写入一条已发布或已确认播报的事件记录 */
    insert(record: PublishedHistoryRecord): void {
      db.prepare(`
        INSERT OR REPLACE INTO published_history (
          event_id, run_id, title, title_norm, entity, article_urls, published_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        record.eventId,
        record.runId,
        record.title,
        record.titleNorm,
        record.entity,
        JSON.stringify(record.articleUrls),
        record.publishedAt,
      );
    },

    /** 查询指定时间点之后的近期已播事件记录 */
    listRecent(sinceIso: string, limit = 200): PublishedHistoryRecord[] {
      const safeLimit = clampLimit(limit, 500);
      const rows = db
        .prepare(`
          SELECT * FROM published_history
          WHERE published_at >= ?
          ORDER BY published_at DESC, event_id DESC
          LIMIT ?
        `)
        .all(sinceIso, safeLimit) as unknown as Array<{
        event_id: string;
        run_id: string;
        title: string;
        title_norm: string;
        entity: string | null;
        article_urls: string;
        published_at: string;
      }>;
      return rows.map((row) => ({
        eventId: row.event_id,
        runId: row.run_id,
        title: row.title,
        titleNorm: row.title_norm,
        entity: row.entity,
        articleUrls: JSON.parse(row.article_urls) as string[],
        publishedAt: row.published_at,
      }));
    },

    /** 删除某一期此前写入的已播记录，避免重新选题时被自己上一版结果排掉 */
    deleteByRun(runId: string): number {
      const res = db.prepare('DELETE FROM published_history WHERE run_id = ?').run(runId);
      return Number(res.changes);
    },

    /** 按发布时间倒序查询历史已播事件列表（供后台历史页展示） */
    listAll(limit = 100): PublishedHistoryRecord[] {
      const safeLimit = clampLimit(limit, 500);
      const rows = db
        .prepare(`
          SELECT * FROM published_history
          ORDER BY published_at DESC, event_id DESC
          LIMIT ?
        `)
        .all(safeLimit) as unknown as Array<{
        event_id: string;
        run_id: string;
        title: string;
        title_norm: string;
        entity: string | null;
        article_urls: string;
        published_at: string;
      }>;
      return rows.map((row) => ({
        eventId: row.event_id,
        runId: row.run_id,
        title: row.title,
        titleNorm: row.title_norm,
        entity: row.entity,
        articleUrls: JSON.parse(row.article_urls) as string[],
        publishedAt: row.published_at,
      }));
    },
  };
}
