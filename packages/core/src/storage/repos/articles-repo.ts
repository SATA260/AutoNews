import type {
  Article,
  ArticleStatus,
  ExtractStatus,
  SourceLang,
  SourceState,
} from '@aidaily/contracts';
import type { DatabaseSync } from '../db.js';

interface SourceStateRow {
  source_id: string;
  last_fetched_at: string | null;
  last_item_published_at: string | null;
  etag: string | null;
  last_modified: string | null;
  consecutive_failures: number;
  last_error: string | null;
}

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

export interface PublishedHistoryRecord {
  eventId: string;
  runId: string;
  title: string;
  titleNorm: string;
  entity: string | null;
  articleUrls: string[];
  publishedAt: string;
}

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

export function createSourceStateRepo(db: DatabaseSync) {
  return {
    get(sourceId: string): SourceState | null {
      const row = db.prepare('SELECT * FROM source_state WHERE source_id = ?').get(sourceId) as
        | SourceStateRow
        | undefined;
      return row ? mapSourceState(row) : null;
    },

    listAll(): SourceState[] {
      const rows = db.prepare('SELECT * FROM source_state').all() as unknown as SourceStateRow[];
      return rows.map(mapSourceState);
    },

    upsertSuccess(input: {
      sourceId: string;
      lastFetchedAt: string;
      lastItemPublishedAt: string | null;
      etag: string | null;
      lastModified: string | null;
    }): void {
      db.prepare(`
        INSERT INTO source_state (
          source_id, last_fetched_at, last_item_published_at, etag, last_modified, consecutive_failures, last_error
        ) VALUES (?, ?, ?, ?, ?, 0, NULL)
        ON CONFLICT(source_id) DO UPDATE SET
          last_fetched_at = excluded.last_fetched_at,
          last_item_published_at = CASE
            WHEN excluded.last_item_published_at IS NOT NULL AND (
              source_state.last_item_published_at IS NULL OR
              excluded.last_item_published_at > source_state.last_item_published_at
            ) THEN excluded.last_item_published_at
            ELSE source_state.last_item_published_at
          END,
          etag = COALESCE(excluded.etag, source_state.etag),
          last_modified = COALESCE(excluded.last_modified, source_state.last_modified),
          consecutive_failures = 0,
          last_error = NULL
      `).run(
        input.sourceId,
        input.lastFetchedAt,
        input.lastItemPublishedAt,
        input.etag,
        input.lastModified,
      );
    },

    recordFailure(sourceId: string, errorMsg: string): number {
      db.prepare(`
        INSERT INTO source_state (source_id, consecutive_failures, last_error)
        VALUES (?, 1, ?)
        ON CONFLICT(source_id) DO UPDATE SET
          consecutive_failures = source_state.consecutive_failures + 1,
          last_error = excluded.last_error
      `).run(sourceId, errorMsg);
      const row = db
        .prepare('SELECT consecutive_failures FROM source_state WHERE source_id = ?')
        .get(sourceId) as { consecutive_failures: number };
      return row.consecutive_failures;
    },
  };
}

export function createArticlesRepo(db: DatabaseSync) {
  return {
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

    getById(id: string): Article | null {
      const row = db.prepare('SELECT * FROM articles WHERE id = ?').get(id) as
        | ArticleRow
        | undefined;
      return row ? mapArticle(row) : null;
    },

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

    listCandidates(sinceIso: string, includeExpired = false): Article[] {
      const allowedStatuses = includeExpired ? "('new', 'expired')" : "('new')";
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

    markReserved(articleIds: string[], runId: string): void {
      if (articleIds.length === 0) {
        return;
      }
      const placeholders = articleIds.map(() => '?').join(', ');
      db.prepare(`
        UPDATE articles
        SET status = 'reserved', reserved_by_run = ?
        WHERE id IN (${placeholders}) AND status IN ('new', 'expired')
      `).run(runId, ...articleIds);
    },

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

    markConsumed(articleIds: string[], runId: string): void {
      if (articleIds.length === 0) {
        return;
      }
      const placeholders = articleIds.map(() => '?').join(', ');
      db.prepare(`
        UPDATE articles
        SET status = 'consumed', reserved_by_run = NULL
        WHERE id IN (${placeholders}) AND reserved_by_run = ?
      `).run(...articleIds, runId);
    },

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

export function createHistoryRepo(db: DatabaseSync) {
  return {
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

    listRecent(sinceIso: string, limit = 200): PublishedHistoryRecord[] {
      const rows = db
        .prepare(`
          SELECT * FROM published_history
          WHERE published_at >= ?
          ORDER BY published_at DESC
          LIMIT ?
        `)
        .all(sinceIso, limit) as unknown as Array<{
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
