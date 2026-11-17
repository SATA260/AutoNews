import type { Migration } from './001_init.js';

/** 为任务、定时计划和新闻条目保存主播、音乐与人工配图设置。 */
export const MIGRATION_002: Migration = {
  version: 2,
  name: '002_workflow',
  sql: `
    ALTER TABLE runs ADD COLUMN host_id TEXT;
    ALTER TABLE runs ADD COLUMN bgm_file TEXT;
    ALTER TABLE schedules ADD COLUMN bgm_file TEXT;
    ALTER TABLE run_items ADD COLUMN image_mode TEXT NOT NULL DEFAULT 'auto';
    ALTER TABLE run_items ADD COLUMN custom_image_path TEXT;
    ALTER TABLE run_items ADD COLUMN custom_image_caption TEXT;
  `,
};
