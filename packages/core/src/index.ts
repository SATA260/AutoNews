import type { CoreContext } from './context.js';
import { createCoreContext } from './context.js';
import type { Notifier } from './notify/index.js';

export const CORE_VERSION = '0.1.0';

export * from './config/loader.js';
export * from './config/writer.js';
export * from './context.js';
export * from './notify/index.js';
export * from './paths.js';
export * from './storage/db.js';
export * from './storage/files.js';
export * from './storage/migrate.js';
export * from './storage/repos/index.js';

/** 对命令行和网页后台暴露的核心业务引擎实例 */
export interface Core {
  context: CoreContext;
  /** 关闭数据库连接并释放底层资源 */
  close(): Promise<void>;
}

/**
 * 创建并初始化核心业务引擎（供命令行工具和网页后台共用）。
 */
export async function createCore(opts?: {
  rootDir?: string;
  notifier?: Notifier;
  now?: () => Date;
}): Promise<Core> {
  const context = await createCoreContext(opts);
  return {
    context,
    /** 安全关闭核心引擎持有的 SQLite 数据库连接 */
    async close() {
      context.db.close();
    },
  };
}
