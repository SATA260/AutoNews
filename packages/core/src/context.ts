import fs from 'node:fs/promises';
import path from 'node:path';
import { CliBridge } from '@aidaily/cli-bridge';
import type { Settings, SourceDef } from '@aidaily/contracts';
import { ModelApi } from '@aidaily/model-api';
import type { CallRecord } from '@aidaily/model-runtime';
import { TtsService } from '@aidaily/tts';
import type { Logger } from 'pino';
import pino from 'pino';
import {
  type CollectorBrowserDriver,
  createPlaywrightCollectorDriver,
} from './collector/browser-driver.js';
import { resolveModelApiKey } from './config/api-credentials.js';
import { loadSettings, loadSources } from './config/loader.js';
import { NoopNotifier, type Notifier } from './notify/index.js';
import { findRepoRoot, type RepoPaths, resolveRepoPaths } from './paths.js';
import { type DatabaseSync, openDatabase } from './storage/db.js';
import { ensureDir, ensurePrivateDir, writeJsonAtomic } from './storage/files.js';
import { runMigrations } from './storage/migrate.js';
import { createRepositories, type Repositories } from './storage/repos/index.js';

/** 清洗用于文件名的安全标识片段 */
function sanitizeLogToken(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9._-]/g, '_');
}

/** 扫描并初始化各期任务下模型调用记录文件的递增序号 */
async function nextLlmSeqForRun(
  llmDir: string,
  seqCounters: Map<string, number>,
  runId: string,
): Promise<number> {
  let curr = seqCounters.get(runId);
  if (curr === undefined) {
    curr = 0;
    try {
      const files = await fs.readdir(llmDir);
      for (const name of files) {
        const match = /^(\d+)-/.exec(name);
        if (match?.[1]) {
          const num = Number.parseInt(match[1], 10);
          if (num > curr) {
            curr = num;
          }
        }
      }
    } catch {
      // 目录尚未创建时从 0 开始编号
    }
  }
  const next = curr + 1;
  seqCounters.set(runId, next);
  return next;
}

/** 创建模型调用审计落盘回调：把完整提示词与原始输出存入文件，并在数据库写入调用索引 */
function createLlmCallRecorder(
  paths: RepoPaths,
  repos: Repositories,
): (record: CallRecord) => Promise<void> {
  const seqCounters = new Map<string, number>();
  let writeChain = Promise.resolve();

  const writeRecord = async (record: CallRecord) => {
    let relLogPath: string | null = null;
    if (record.runId) {
      const llmDir = path.join(paths.runDir(record.runId), 'llm');
      const seq = await nextLlmSeqForRun(llmDir, seqCounters, record.runId);
      const seqLabel = String(seq).padStart(4, '0');
      const stagePart = sanitizeLogToken(record.stage ?? 'general');
      const itemPart = record.itemId ? `-${sanitizeLogToken(record.itemId)}` : '';
      const logFile = path.join(llmDir, `${seqLabel}-${stagePart}${itemPart}.json`);
      await writeJsonAtomic(logFile, record);
      relLogPath = path.relative(paths.rootDir, logFile);
    }

    repos.llmCalls.insert({
      runId: record.runId ?? null,
      stage: record.stage ?? null,
      itemId: record.itemId ?? null,
      cli: record.cli,
      model: record.model ?? null,
      attempt: record.attempt,
      status: record.status,
      durationMs: record.durationMs,
      inputTokens: record.inputTokens ?? null,
      outputTokens: record.outputTokens ?? null,
      conversationId: record.conversationId ?? null,
      logPath: relLogPath,
      createdAt: record.createdAt,
    });
  };

  return (record: CallRecord) => {
    const next = writeChain.catch(() => undefined).then(() => writeRecord(record));
    writeChain = next;
    return next;
  };
}

/** 核心运行上下文，集中管理配置、数据库连接、数据读写对象、外部调用接口、日志、时钟和通知能力 */
export interface CoreContext {
  paths: RepoPaths;
  settings: Settings;
  sources: SourceDef[];
  db: DatabaseSync;
  repos: Repositories;
  logger: Logger;
  notifier: Notifier;
  fetchImpl: typeof fetch;
  bridge: CliBridge;
  modelApi: ModelApi;
  tts: TtsService;
  now: () => Date;
  /** 按需创建采集阶段使用的浏览器抓取与局部截图驱动 */
  createCollectorDriver: () => CollectorBrowserDriver;
  /** 从磁盘重新读取并校验运行配置和信源清单（两份配置均通过校验后才替换内存引用） */
  reloadConfig: () => Promise<void>;
}

/** 初始化项目运行时环境：准备存储目录、加载校验配置、连接数据库、执行建表迁移并装配外部能力适配器 */
export async function createCoreContext(opts?: {
  rootDir?: string;
  notifier?: Notifier;
  logger?: Logger;
  fetchImpl?: typeof fetch;
  bridge?: CliBridge;
  tts?: TtsService;
  now?: () => Date;
  createCollectorDriver?: () => CollectorBrowserDriver;
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
  try {
    runMigrations(db);
  } catch (err) {
    db.close();
    throw err;
  }
  const repos = createRepositories(db);

  const logger = opts?.logger ?? pino({ name: 'aidaily-core', level: 'info' });
  const notifier = opts?.notifier ?? new NoopNotifier();
  const fetchImpl = opts?.fetchImpl ?? globalThis.fetch;
  const now = opts?.now ?? (() => new Date());
  const createCollectorDriver =
    opts?.createCollectorDriver ?? (() => createPlaywrightCollectorDriver());
  const logCall = createLlmCallRecorder(paths, repos);
  const bridge =
    opts?.bridge ??
    new CliBridge({
      configs: settings.clis,
      tmpDir: paths.tmpDir,
      maxConcurrentCalls: settings.ai.maxConcurrentCalls,
      logCall,
      now,
    });
  const modelApi = new ModelApi({
    fetchImpl,
    resolveApiKey: (config) => resolveModelApiKey(paths.secretsDir, config),
    logCall,
    now,
  });
  const tts =
    opts?.tts ??
    new TtsService({
      settings: settings.tts,
      cacheDir: paths.ttsCacheDir,
      rootDir: paths.rootDir,
      bridge,
      fetchImpl,
    });

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
    fetchImpl,
    bridge,
    modelApi,
    tts,
    now,
    createCollectorDriver,
    /** 重新读取最新配置与信源列表，全部校验成功后原子更新内存快照与命令行桥接配置 */
    async reloadConfig() {
      const [nextSettings, nextSources] = await Promise.all([
        loadSettings(paths.settingsFile),
        loadSources(paths.sourcesFile),
      ]);
      settings = nextSettings;
      sources = nextSources;
      if (typeof (bridge as { updateConfigs?: unknown }).updateConfigs === 'function') {
        bridge.updateConfigs(nextSettings.clis);
      }
    },
  };

  return ctx;
}
