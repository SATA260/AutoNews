import type { Settings, SourceDef } from '@aidaily/contracts';
import type { Logger } from 'pino';
import pino from 'pino';
import { loadSettings, loadSources } from './config/loader.js';
import { NoopNotifier, type Notifier } from './notify/index.js';
import { findRepoRoot, type RepoPaths, resolveRepoPaths } from './paths.js';
import { type DatabaseSync, openDatabase } from './storage/db.js';
import { ensureDir, ensurePrivateDir } from './storage/files.js';
import { runMigrations } from './storage/migrate.js';
import { createRepositories, type Repositories } from './storage/repos/index.js';

/** 核心运行上下文，集中管理配置、数据库连接、数据读写对象、日志、时钟和通知能力 */
export interface CoreContext {
  paths: RepoPaths;
  settings: Settings;
  sources: SourceDef[];
  db: DatabaseSync;
  repos: Repositories;
  logger: Logger;
  notifier: Notifier;
  now: () => Date;
  /** 从磁盘重新读取并校验运行配置和信源清单 */
  reloadConfig: () => Promise<void>;
}

/** 初始化项目运行时环境：准备存储目录、加载校验配置、连接数据库并执行建表迁移 */
export async function createCoreContext(opts?: {
  rootDir?: string;
  notifier?: Notifier;
  logger?: Logger;
  now?: () => Date;
}): Promise<CoreContext> {
  const rootDir = opts?.rootDir ?? findRepoRoot();
  const paths = resolveRepoPaths(rootDir);

  await Promise.all([
    ensureDir(paths.storageDir),
    ensureDir(paths.articlesDir),
    ensureDir(paths.imagesDir),
    ensureDir(paths.ttsCacheDir),
    ensureDir(paths.tmpDir),
    ensurePrivateDir(paths.secretsDir),
    ensureDir(paths.logsDir),
    ensureDir(paths.runsDir),
  ]);

  let settings = await loadSettings(paths.settingsFile);
  let sources = await loadSources(paths.sourcesFile);

  const db = openDatabase(paths.dbFile);
  runMigrations(db);
  const repos = createRepositories(db);

  const logger = opts?.logger ?? pino({ name: 'aidaily-core', level: 'info' });
  const notifier = opts?.notifier ?? new NoopNotifier();
  const now = opts?.now ?? (() => new Date());

  const ctx: CoreContext = {
    paths,
    get settings() {
      return settings;
    },
    get sources() {
      return sources;
    },
    db,
    repos,
    logger,
    notifier,
    now,
    /** 重新读取最新配置与信源列表并更新内存快照 */
    async reloadConfig() {
      settings = await loadSettings(paths.settingsFile);
      sources = await loadSources(paths.sourcesFile);
    },
  };

  return ctx;
}
