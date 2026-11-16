import type { CliBridge } from '@aidaily/cli-bridge';
import type { TtsService } from '@aidaily/tts';
import type { CoreContext } from './context.js';
import { createCoreContext } from './context.js';
import type { Notifier } from './notify/index.js';
import { createSourceService, type SourceService } from './services/source.js';
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
export * from './services/source.js';
export * from './storage/db.js';
export * from './storage/files.js';
export * from './storage/migrate.js';
export * from './storage/repos/index.js';
export * from './workflow/index.js';

/** 对命令行和网页后台暴露的核心业务引擎实例 */
export interface Core {
  context: CoreContext;
  sources: SourceService;
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
}): Promise<Core> {
  const context = await createCoreContext(opts);
  recoverStaleRuns(context);
  const sources = createSourceService(context);
  return {
    context,
    sources,
    /** 安全关闭核心引擎持有的 SQLite 数据库连接 */
    async close() {
      context.db.close();
    },
  };
}
