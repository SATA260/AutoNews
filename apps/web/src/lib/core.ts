import 'server-only';
import { CORE_VERSION, type Core, createCore } from '@aidaily/core';

/** 全局单实例缓存记录结构，用于在同一进程与根目录复用核心引擎 */
interface GlobalCoreSlot {
  rootDirKey: string;
  corePromise: Promise<Core>;
}

const globalSlotHost = globalThis as typeof globalThis & {
  __aidailyCoreSlot?: GlobalCoreSlot;
};

/** 返回当前加载的核心引擎版本号，供服务端渲染与接口健康检查使用 */
export function getCoreVersion(): string {
  return CORE_VERSION;
}

/**
 * 获取或初始化全局核心业务引擎单例；
 * 支持通过 `AIDAILY_ROOT` 环境变量切换目标工作区，并在根目录变更时先安全关闭旧实例。
 */
export async function getCore(): Promise<Core> {
  const rootDir = process.env.AIDAILY_ROOT?.trim() || undefined;
  const rootDirKey = rootDir ?? '<auto>';
  const existing = globalSlotHost.__aidailyCoreSlot;

  if (existing && existing.rootDirKey === rootDirKey) {
    return existing.corePromise;
  }

  if (existing) {
    const oldCore = await existing.corePromise.catch(() => null);
    await oldCore?.close().catch(() => undefined);
    globalSlotHost.__aidailyCoreSlot = undefined;
  }

  const nextPromise = createCore(rootDir ? { rootDir } : undefined);
  const slot: GlobalCoreSlot = { rootDirKey, corePromise: nextPromise };
  globalSlotHost.__aidailyCoreSlot = slot;

  try {
    return await nextPromise;
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
  if (!existing) {
    return;
  }
  globalSlotHost.__aidailyCoreSlot = undefined;
  const core = await existing.corePromise.catch(() => null);
  await core?.close().catch(() => undefined);
}
