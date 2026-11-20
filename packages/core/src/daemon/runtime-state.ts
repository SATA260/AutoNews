import fs from 'node:fs/promises';
import path from 'node:path';
import { DaemonWebStateSchema } from '@aidaily/contracts';
import { z } from 'zod';
import type { RepoPaths } from '../paths.js';
import { readJsonOrNullWithSchema, writeFileAtomic, writeJsonAtomic } from '../storage/files.js';

/** 守护进程持久化运行状态文件校验规则 */
export const DaemonRuntimeStateSchema = z.object({
  pid: z.number().int().positive(),
  startedAt: z.string(),
  rootDir: z.string(),
  webEnabled: z.boolean(),
  webHost: z.string(),
  webPort: z.number().int().positive(),
  webState: DaemonWebStateSchema,
  webPid: z.number().int().positive().nullable(),
  webLastActiveAt: z.string().nullable(),
  webIdleTimeoutSec: z.number().int().positive(),
  nextScheduleRunAt: z.string().nullable(),
  nextScheduleName: z.string().nullable(),
  lastCheckAt: z.string().nullable(),
  triggeredSlots: z.record(z.string(), z.string()),
});
/** 守护进程运行状态结构体 */
export type DaemonRuntimeState = z.infer<typeof DaemonRuntimeStateSchema>;

/** 返回守护进程专用状态存储目录路径 */
export function getDaemonStorageDir(paths: RepoPaths): string {
  return path.join(paths.storageDir, 'daemon');
}

/** 返回守护进程状态文件路径 */
export function getDaemonStateFile(paths: RepoPaths): string {
  return path.join(getDaemonStorageDir(paths), 'state.json');
}

/** 返回守护进程唤醒重载信号文件路径 */
export function getDaemonReloadSignalFile(paths: RepoPaths): string {
  return path.join(getDaemonStorageDir(paths), 'reload.signal');
}

/** 返回守护进程主日志文件路径 */
export function getDaemonLogFile(paths: RepoPaths): string {
  return path.join(paths.logsDir, 'daemon.log');
}

/** 返回由守护进程按需托管的网页控制台日志文件路径 */
export function getDaemonWebLogFile(paths: RepoPaths): string {
  return path.join(paths.logsDir, 'web.log');
}

/** 判断指定系统进程 ID 当前是否仍然存活 */
export function isPidAlive(pid: number | null | undefined): boolean {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** 安全读取磁盘中保存的守护进程运行状态（损坏或缺失时返回 null） */
export async function readDaemonRuntimeState(paths: RepoPaths): Promise<DaemonRuntimeState | null> {
  return readJsonOrNullWithSchema(getDaemonStateFile(paths), DaemonRuntimeStateSchema, {
    label: '守护进程运行状态',
    fallbackNullOnInvalid: true,
  });
}

/** 原子更新守护进程运行状态文件 */
export async function writeDaemonRuntimeState(
  paths: RepoPaths,
  state: DaemonRuntimeState,
): Promise<void> {
  await writeJsonAtomic(getDaemonStateFile(paths), state);
}

/** 写入唤醒信号文件并向存活守护进程发送 `SIGHUP`，促使其立即刷新定时任务表 */
export async function notifyDaemonReload(paths: RepoPaths): Promise<void> {
  try {
    await writeFileAtomic(getDaemonReloadSignalFile(paths), `${Date.now()}\n`);
    const state = await readDaemonRuntimeState(paths);
    if (state && state.pid !== process.pid && isPidAlive(state.pid)) {
      try {
        process.kill(state.pid, 'SIGHUP');
      } catch {
        // 进程刚退出时忽略信号发送失败
      }
    }
  } catch {
    // 通知失败不影响定时配置本身的保存
  }
}

/** 清除无对应存活进程的过期状态文件或清空已停机进程号字段 */
export async function clearStaleDaemonState(paths: RepoPaths): Promise<void> {
  await fs.rm(getDaemonStateFile(paths), { force: true }).catch(() => undefined);
}
