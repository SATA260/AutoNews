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

export interface Core {
  context: CoreContext;
  close(): Promise<void>;
}

/**
 * Initialize the core engine runtime (config, WAL SQLite DB, migrations, repositories).
 * Service layers (tasks, publish, config, scheduler, sources, system) attach in M8.
 */
export async function createCore(opts?: {
  rootDir?: string;
  notifier?: Notifier;
  now?: () => Date;
}): Promise<Core> {
  const context = await createCoreContext(opts);
  return {
    context,
    async close() {
      context.db.close();
    },
  };
}
