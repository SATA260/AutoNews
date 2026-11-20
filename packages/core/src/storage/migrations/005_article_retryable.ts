import type { Migration } from './001_init.js';

/** 为文章表补充抓取失败是否可重试标志与已重试次数，避免永久失效文章长期阻塞订阅缓存 */
export const MIGRATION_005: Migration = {
  version: 5,
  name: '005_article_retryable',
  sql: `
    ALTER TABLE articles ADD COLUMN extract_retryable INTEGER NOT NULL DEFAULT 1;
    ALTER TABLE articles ADD COLUMN extract_attempts INTEGER NOT NULL DEFAULT 0;
  `,
};
