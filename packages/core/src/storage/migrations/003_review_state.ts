import type { Migration } from './001_init.js';

/** 记录主播是否由用户指定，以及成片是否需要重新合成。 */
export const MIGRATION_003: Migration = {
  version: 3,
  name: '003_review_state',
  sql: `
    ALTER TABLE runs ADD COLUMN host_manual INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE runs ADD COLUMN media_dirty INTEGER NOT NULL DEFAULT 0;
  `,
};
