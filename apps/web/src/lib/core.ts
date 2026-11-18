import fs from 'node:fs/promises';
import 'server-only';
import { CORE_VERSION, type Core, createCore } from '@aidaily/core';

const CORE_SLOT_GENERATION = 2;

/** 全局单实例缓存记录结构，用于在同一进程与根目录复用核心引擎 */
interface GlobalCoreSlot {
  generation: number;
  rootDirKey: string;
  corePromise: Promise<Core>;
  configFingerprint?: string;
  reloadPromise?: Promise<void>;
}

const globalSlotHost = globalThis as typeof globalThis & {
  __aidailyCoreSlot?: GlobalCoreSlot;
  __aidailyCoreClosing?: Promise<void>;
};

/** 读取配置文件与信源清单的修改时间戳指纹，用于感知外部或跨进程配置更新 */
async function readConfigFingerprint(core: Core): Promise<string | null> {
  try {
    const [settingsStat, sourcesStat] = await Promise.all([
      fs.stat(core.context.paths.settingsFile),
      fs.stat(core.context.paths.sourcesFile).catch(() => null),
    ]);
    return `${settingsStat.mtimeMs}:${sourcesStat?.mtimeMs ?? 0}`;
  } catch {
    return null;
  }
}

/** 返回当前加载的核心引擎版本号，供服务端渲染与接口健康检查使用 */
export function getCoreVersion(): string {
  return CORE_VERSION;
}

/**
 * 获取或初始化全局核心业务引擎单例；
 * 支持通过 `AIDAILY_ROOT` 环境变量切换目标工作区，并在根目录变更、代码代际升级或磁盘配置更新时自动刷新实例或重载配置。
 */
export async function getCore(): Promise<Core> {
  const rootDir = process.env.AIDAILY_ROOT?.trim() || undefined;
  const rootDirKey = rootDir ?? '<auto>';
  const existing = globalSlotHost.__aidailyCoreSlot;

  if (
    existing &&
    existing.generation === CORE_SLOT_GENERATION &&
    existing.rootDirKey === rootDirKey
  ) {
    const core = await existing.corePromise;
    const latestFingerprint = await readConfigFingerprint(core);
    if (
      latestFingerprint &&
      existing.configFingerprint &&
      latestFingerprint !== existing.configFingerprint
    ) {
      if (!existing.reloadPromise) {
        existing.reloadPromise = core.context
          .reloadConfig()
          .then(async () => {
            existing.configFingerprint = (await readConfigFingerprint(core)) ?? latestFingerprint;
          })
          .finally(() => {
            existing.reloadPromise = undefined;
          });
      }
      await existing.reloadPromise;
    } else if (latestFingerprint && !existing.configFingerprint) {
      existing.configFingerprint = latestFingerprint;
    }
    return core;
  }

  const prevCloseChain = (globalSlotHost.__aidailyCoreClosing ?? Promise.resolve()).then(
    async () => {
      if (existing) {
        const oldCore = await existing.corePromise.catch(() => null);
        await oldCore?.close().catch(() => undefined);
      }
    },
  );
  globalSlotHost.__aidailyCoreClosing = prevCloseChain;

  const slot: GlobalCoreSlot = {
    generation: CORE_SLOT_GENERATION,
    rootDirKey,
    corePromise: prevCloseChain.then(async () => {
      const created = await createCore(rootDir ? { rootDir } : undefined);
      slot.configFingerprint = (await readConfigFingerprint(created)) ?? undefined;
      return created;
    }),
  };
  globalSlotHost.__aidailyCoreSlot = slot;

  try {
    return await slot.corePromise;
  } catch (err) {
    if (globalSlotHost.__aidailyCoreSlot === slot) {
      globalSlotHost.__aidailyCoreSlot = undefined;
    }
    throw err;
  }
}

/** 关闭并清理全局核心引擎单例（供测试收尾时释放 SQLite 文件句柄） */
export async function closeCoreSingleton(): Promise<void> {
  const existing = globalSlotHost.__aidailyCoreSlot;
  globalSlotHost.__aidailyCoreSlot = undefined;
  const closeTask = (globalSlotHost.__aidailyCoreClosing ?? Promise.resolve()).then(async () => {
    if (!existing) {
      return;
    }
    const core = await existing.corePromise.catch(() => null);
    await core?.close().catch(() => undefined);
  });
  globalSlotHost.__aidailyCoreClosing = closeTask;
  await closeTask;
}
