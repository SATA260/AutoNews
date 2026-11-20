import { z } from 'zod';

/** 守护进程托管网页后台的当前运行状态 */
export const DaemonWebStateSchema = z.enum(['stopped', 'starting', 'running']);
/** 守护进程托管网页后台状态类型 */
export type DaemonWebState = z.infer<typeof DaemonWebStateSchema>;

/** 命令行全局安装注册状态描述 */
export const GlobalCliStatusSchema = z.object({
  installed: z.boolean(),
  managedBySelf: z.boolean(),
  binPath: z.string(),
  targetScriptPath: z.string(),
  repoRoot: z.string(),
  inPath: z.boolean(),
});
/** 命令行全局安装注册状态类型 */
export type GlobalCliStatus = z.infer<typeof GlobalCliStatusSchema>;

/** 后台守护进程、开机自启服务及按需网页网关的运行状态快照 */
export const DaemonStatusSchema = z.object({
  running: z.boolean(),
  pid: z.number().int().positive().nullable(),
  startedAt: z.string().nullable(),
  serviceInstalled: z.boolean(),
  serviceLabel: z.string().min(1),
  plistPath: z.string(),
  webEnabled: z.boolean(),
  webHost: z.string().min(1),
  webPort: z.number().int().positive(),
  webUrl: z.string(),
  webState: DaemonWebStateSchema,
  webPid: z.number().int().positive().nullable(),
  webLastActiveAt: z.string().nullable(),
  webIdleTimeoutSec: z.number().int().positive(),
  nextScheduleRunAt: z.string().nullable(),
  nextScheduleName: z.string().nullable(),
  lastCheckAt: z.string().nullable(),
  logFile: z.string(),
  webLogFile: z.string(),
  globalCli: GlobalCliStatusSchema,
});
/** 后台守护进程运行状态类型 */
export type DaemonStatus = z.infer<typeof DaemonStatusSchema>;
