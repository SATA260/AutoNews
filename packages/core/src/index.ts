import path from 'node:path';
import type { CliBridge } from '@aidaily/cli-bridge';
import type { TtsService } from '@aidaily/tts';
import type { CoreContext } from './context.js';
import { createCoreContext } from './context.js';
import type { Notifier } from './notify/index.js';
import {
  type ConfigService,
  createConfigService,
  createPublishService,
  createSchedulerService,
  createSourceService,
  createSystemService,
  createTaskService,
  type LaunchctlExecutor,
  type PublishService,
  type SchedulerService,
  type SourceService,
  type SystemService,
  type TaskService,
} from './services/index.js';
import { spawnDetachedWorker } from './worker/spawn.js';
import { recoverStaleRuns } from './workflow/recovery.js';

export const CORE_VERSION = '0.1.0';

export * from './collector/index.js';
export * from './config/loader.js';
export * from './config/writer.js';
export * from './context.js';
export * from './editorial/index.js';
export * from './errors.js';
export * from './media/index.js';
export * from './notify/index.js';
export * from './paths.js';
export * from './publish/index.js';
export * from './services/index.js';
export * from './storage/db.js';
export * from './storage/files.js';
export * from './storage/migrate.js';
export * from './storage/repos/index.js';
export * from './templates/index.js';
export * from './worker/spawn.js';
export * from './workflow/index.js';

/** 对命令行和网页后台暴露的核心业务引擎实例 */
export interface Core {
  context: CoreContext;
  tasks: TaskService;
  publish: PublishService;
  config: ConfigService;
  scheduler: SchedulerService;
  sources: SourceService;
  system: SystemService;
  /** 关闭数据库连接并释放底层资源 */
  close(): Promise<void>;
}

/**
 * 创建并初始化核心业务引擎（供命令行工具和网页后台共用）。
 */
export async function createCore(opts?: {
  rootDir?: string;
  notifier?: Notifier;
  fetchImpl?: typeof fetch;
  bridge?: CliBridge;
  tts?: TtsService;
  now?: () => Date;
  launchAgentsDir?: string;
  launchctlExec?: LaunchctlExecutor;
  cliScriptPath?: string;
}): Promise<Core> {
  const context = await createCoreContext(opts);
  recoverStaleRuns(context);

  const tasks = createTaskService(context);
  const publish = createPublishService(context, {
    spawnDetachedPublish: async ({ action, runId, dtimeUnixSec }) => {
      const args = ['--root', context.paths.rootDir, '--action', action, '--run-id', runId];
      if (dtimeUnixSec !== undefined) {
        args.push('--dtime', String(Math.floor(dtimeUnixSec)));
      }
      await spawnDetachedWorker(args, {
        rootDir: context.paths.rootDir,
        logFile: path.join(context.paths.logsDir, 'worker.log'),
      });
    },
  });
  const config = createConfigService(context);
  const scheduler = createSchedulerService(context, {
    launchAgentsDir: opts?.launchAgentsDir,
    launchctlExec: opts?.launchctlExec,
    cliScriptPath: opts?.cliScriptPath,
  });
  const sources = createSourceService(context);
  const system = createSystemService(context);

  return {
    context,
    tasks,
    publish,
    config,
    scheduler,
    sources,
    system,
    /** 安全关闭核心引擎持有的 SQLite 数据库连接 */
    async close() {
      context.db.close();
    },
  };
}
