/** 单次数据库结构迁移脚本描述 */
export interface Migration {
  version: number;
  name: string;
  sql: string;
}

/** 初始建表迁移脚本：建立抓取游标、文章池、任务与步骤状态、事件审计、定时及独占锁全部表 */
export const MIGRATION_001: Migration = {
  version: 1,
  name: '001_init',
  sql: `
CREATE TABLE IF NOT EXISTS source_state (
  source_id TEXT PRIMARY KEY,
  last_fetched_at TEXT,
  last_item_published_at TEXT,
  etag TEXT,
  last_modified TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  last_error TEXT
);

CREATE TABLE IF NOT EXISTS articles (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  canonical_url TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  title_norm TEXT NOT NULL,
  lang TEXT NOT NULL,
  published_at TEXT,
  first_seen_at TEXT NOT NULL,
  excerpt TEXT,
  content_path TEXT,
  content_chars INTEGER,
  image_path TEXT,
  extract_status TEXT NOT NULL DEFAULT 'pending',
  status TEXT NOT NULL DEFAULT 'new',
  reserved_by_run TEXT
);
CREATE INDEX IF NOT EXISTS idx_articles_status_pub ON articles(status, published_at);

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  trigger TEXT NOT NULL,
  schedule_id TEXT,
  status TEXT NOT NULL,
  current_stage TEXT,
  item_count INTEGER NOT NULL,
  config_snapshot TEXT NOT NULL,
  cancel_requested INTEGER NOT NULL DEFAULT 0,
  attempt INTEGER NOT NULL DEFAULT 1,
  error_code TEXT,
  error TEXT,
  pid INTEGER,
  heartbeat_at TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  retry_deadline_at TEXT
);

CREATE TABLE IF NOT EXISTS run_stages (
  run_id TEXT NOT NULL REFERENCES runs(id),
  stage TEXT NOT NULL,
  status TEXT NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 0,
  started_at TEXT,
  finished_at TEXT,
  error TEXT,
  checkpoint_path TEXT,
  PRIMARY KEY (run_id, stage)
);

CREATE TABLE IF NOT EXISTS run_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  ts TEXT NOT NULL,
  level TEXT NOT NULL,
  stage TEXT,
  item_id TEXT,
  type TEXT NOT NULL,
  message TEXT NOT NULL,
  data TEXT
);
CREATE INDEX IF NOT EXISTS idx_run_events_run ON run_events(run_id, id);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id),
  rank INTEGER NOT NULL,
  role TEXT NOT NULL,
  title TEXT NOT NULL,
  article_ids TEXT NOT NULL,
  category TEXT,
  entity TEXT,
  score REAL NOT NULL,
  public_appeal REAL,
  reason TEXT,
  refill_round INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS run_items (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id),
  event_id TEXT NOT NULL REFERENCES events(id),
  position INTEGER,
  status TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0,
  drop_reason TEXT,
  final_json TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS item_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id TEXT NOT NULL REFERENCES run_items(id),
  kind TEXT NOT NULL,
  round INTEGER NOT NULL,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS llm_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT,
  stage TEXT,
  item_id TEXT,
  cli TEXT NOT NULL,
  model TEXT,
  attempt INTEGER NOT NULL,
  status TEXT NOT NULL,
  duration_ms INTEGER,
  input_tokens INTEGER,
  output_tokens INTEGER,
  conversation_id TEXT,
  log_path TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS published_history (
  event_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  title TEXT NOT NULL,
  title_norm TEXT NOT NULL,
  entity TEXT,
  article_urls TEXT NOT NULL,
  published_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS publish_records (
  run_id TEXT PRIMARY KEY REFERENCES runs(id),
  platform TEXT NOT NULL DEFAULT 'bilibili',
  title TEXT,
  description TEXT,
  tags TEXT,
  status TEXT NOT NULL,
  bvid TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS schedules (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  time_expr TEXT NOT NULL,
  item_count INTEGER NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  last_run_id TEXT,
  last_triggered_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS locks (
  name TEXT PRIMARY KEY,
  owner_run TEXT,
  pid INTEGER,
  acquired_at TEXT,
  heartbeat_at TEXT
);
`,
};
