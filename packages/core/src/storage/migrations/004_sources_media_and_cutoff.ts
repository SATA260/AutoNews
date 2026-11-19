import type { Migration } from './001_init.js';

/** 为任务记录与定时任务补充最早新闻时间限制字段，并为单条新闻补充副图与选图配置字段 */
export const MIGRATION_004: Migration = {
  version: 4,
  name: '004_sources_media_and_cutoff',
  sql: `
    ALTER TABLE runs ADD COLUMN not_before_at TEXT;
    ALTER TABLE schedules ADD COLUMN cutoff_mode TEXT NOT NULL DEFAULT 'none';
    ALTER TABLE schedules ADD COLUMN max_age_hours INTEGER;
    ALTER TABLE run_items ADD COLUMN secondary_custom_image_path TEXT;
    ALTER TABLE run_items ADD COLUMN selected_media_ids TEXT;
  `,
};
