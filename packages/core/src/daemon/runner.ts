import { spawn } from 'node:child_process';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Settings } from '@aidaily/contracts';
import { loadSettings } from '../config/loader.js';
import { resolveStageChannelPlan } from '../editorial/llm.js';
import { type RepoPaths, resolveDefaultRepoRoot, resolveRepoPaths } from '../paths.js';
import { ensureDir } from '../storage/files.js';
import { listSchedulesReadOnlyFromDb } from '../storage/repos/ops-repo.js';
import { resolveWorkerScriptPath } from '../worker/spawn.js';
import { DAEMON_DEFAULTS } from './constants.js';
import {
  type DaemonRuntimeState,
  getDaemonLogFile,
  getDaemonReloadSignalFile,
  getDaemonStorageDir,
  getDaemonWebLogFile,
  isPidAlive,
  readDaemonRuntimeState,
  writeDaemonRuntimeState,
} from './runtime-state.js';
import {
  type DaemonScheduleEntry,
  type DueScheduleTrigger,
  evaluateDueSchedules,
} from './schedule-planner.js';
import { type WebBackendLauncher, WebOnDemandProxy } from './web-proxy.js';

/** 启动后台守护宿主进程的选项 */
export interface DaemonHostOptions {
  rootDir?: string;
  webEnabled?: boolean;
  webHost?: string;
  webPort?: number;
  webIdleTimeoutSec?: number;
  catchUpGraceMs?: number;
  maxSleepSliceMs?: number;
  maxEmptyScheduleSliceMs?: number;
  registerSignals?: boolean;
  now?: () => number;
  backendLauncher?: WebBackendLauncher;
  triggerScheduleRunner?: (due: DueScheduleTrigger, env: NodeJS.ProcessEnv) => Promise<void>;
}

/** 运行中的后台守护宿主控制句柄 */
export interface DaemonHostHandle {
  pid: number;
  webHost: string;
  webPort: number;
  waitUntilStopped: Promise<void>;
  triggerCheckNow: (forceReload?: boolean) => Promise<void>;
  sleepWebIfIdle: (force?: boolean) => Promise<boolean>;
  stop: () => Promise<void>;
}

/** 轻量只读查询数据库里的定时任务列表，无表或未初始化时安全返回空数组 */
export function loadSchedulesReadOnly(dbFile: string): DaemonScheduleEntry[] {
  return listSchedulesReadOnlyFromDb(dbFile).map((job) => ({
    id: job.id,
    name: job.name,
    time: job.time,
    itemCount: job.itemCount,
    bgmFile: job.bgmFile ?? null,
    enabled: job.enabled,
    lastTriggeredAt: job.lastTriggeredAt,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  }));
}

/** 为后台派生任务拼装包含本地工具链路径和配置的时区环境变量 */
export function buildDaemonChildEnv(settings: Settings, rootDir: string): NodeJS.ProcessEnv {
  const extraBins: string[] = [];
  const existingPathDirs = process.env.PATH
    ? process.env.PATH.split(path.delimiter).filter(Boolean)
    : [];
  for (const cliCfg of Object.values(settings.clis)) {
    const bin = cliCfg.bin.trim();
    if (!bin) {
      continue;
    }
    if (bin.includes('/') || bin.includes('\\')) {
      extraBins.push(path.dirname(bin));
    } else {
      for (const dir of [
        ...existingPathDirs,
        path.join(os.homedir(), '.local', 'bin'),
        '/opt/homebrew/bin',
        '/usr/local/bin',
      ]) {
        if (fsSync.existsSync(path.join(dir, bin))) {
          extraBins.push(dir);
        }
      }
    }
  }

  const mergedPath = Array.from(
    new Set(
      [
        path.dirname(process.execPath),
        ...extraBins,
        ...existingPathDirs,
        path.join(os.homedir(), '.local', 'bin'),
        '/opt/homebrew/bin',
        '/usr/local/bin',
        '/usr/bin',
        '/bin',
        '/usr/sbin',
        '/sbin',
      ].filter(Boolean),
    ),
  ).join(path.delimiter);

  return {
    ...process.env,
    PATH: mergedPath,
    TZ: settings.timezone,
    AIDAILY_ROOT: rootDir,
  };
}

/** 写入简明单行守护进程运行日志；超出单文件体积上限时自动轮转为 `.1` 备份 */
function appendDaemonLog(
  logFile: string,
  level: 'INFO' | 'WARN' | 'ERROR',
  message: string,
  nowMs: number = Date.now(),
): void {
  const line = `[${new Date(nowMs).toISOString()}] [${level}] ${message}\n`;
  try {
    fsSync.mkdirSync(path.dirname(logFile), { recursive: true });
    try {
      const stat = fsSync.statSync(logFile);
      if (stat.size >= DAEMON_DEFAULTS.maxLogBytes) {
        fsSync.renameSync(logFile, `${logFile}.1`);
      }
    } catch {
      // 文件尚未创建或轮转失败时继续追加写入
    }
    fsSync.appendFileSync(logFile, line, 'utf8');
  } catch {
    // 日志文件不可写时回退到标准输出，避免影响调度执行
    process.stderr.write(line);
  }
}

/** 安全读取包含修改时间、文件大小与索引节点的文件指纹，不存在时返回空标识 */
function readFileSignatureSync(filePath: string): string {
  try {
    const stat = fsSync.statSync(filePath);
    return `${stat.mtimeMs}:${stat.size}:${stat.ino}`;
  } catch {
    return '0:0:0';
  }
}

/** 默认的定时任务执行器：以独立工作子进程运行一期任务，跑完即退出交还系统内存 */
async function spawnScheduledWorkerTask(
  paths: RepoPaths,
  due: DueScheduleTrigger,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const workerScript = resolveWorkerScriptPath(paths.rootDir);
  const logFile = path.join(paths.logsDir, 'scheduler.log');
  await ensureDir(path.dirname(logFile));
  const outFd = fsSync.openSync(logFile, 'a');
  const args = [
    workerScript,
    '--root',
    paths.rootDir,
    '--action',
    'start',
    '-n',
    String(due.job.itemCount),
    '--trigger',
    'schedule',
    '--schedule-id',
    due.job.id,
  ];

  try {
    const child = spawn(process.execPath, args, {
      cwd: paths.rootDir,
      detached: true,
      stdio: ['ignore', outFd, outFd],
      env,
    });
    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => {
        child.off('spawn', onSpawn);
        reject(err);
      };
      const onSpawn = () => {
        child.off('error', onError);
        resolve();
      };
      child.once('error', onError);
      child.once('spawn', onSpawn);
    });
    child.unref();
  } finally {
    fsSync.closeSync(outFd);
  }
}

/**
 * 启动极低占用守护进程主控循环：
 * 1. 常驻进程只维护配置读取、定时休眠计算与按需网页代理，不加载浏览器/音视频处理模块；
 * 2. 到达触发时刻或休眠唤醒命中补跑窗口时，派生一次性后台工作进程执行生产任务；
 * 3. 若启用网页按需代理，有访问时自动拉起 Next.js，闲置超时后自动终止网页子进程释放内存。
 */
export async function startDaemonHost(opts: DaemonHostOptions = {}): Promise<DaemonHostHandle> {
  const now = opts.now ?? (() => Date.now());
  const rootDir = opts.rootDir
    ? path.resolve(opts.rootDir)
    : resolveDefaultRepoRoot({ moduleUrl: import.meta.url });
  const paths = resolveRepoPaths(rootDir);
  await Promise.all([ensureDir(paths.logsDir), ensureDir(getDaemonStorageDir(paths))]);

  const existingState = await readDaemonRuntimeState(paths);
  if (existingState && existingState.pid !== process.pid && isPidAlive(existingState.pid)) {
    throw new Error(`守护进程已在运行中（PID: ${existingState.pid}），请勿重复启动`);
  }

  const daemonLogFile = getDaemonLogFile(paths);
  const webLogFile = getDaemonWebLogFile(paths);
  const webEnabled = opts.webEnabled ?? true;
  const webHost = opts.webHost ?? DAEMON_DEFAULTS.webHost;
  const requestedWebPort = opts.webPort ?? DAEMON_DEFAULTS.webPort;
  const webIdleTimeoutSec = Math.max(
    10,
    opts.webIdleTimeoutSec ?? DAEMON_DEFAULTS.webIdleTimeoutSec,
  );
  const maxSleepSliceMs = Math.max(200, opts.maxSleepSliceMs ?? DAEMON_DEFAULTS.maxSleepSliceMs);
  const maxEmptySliceMs = Math.max(
    500,
    opts.maxEmptyScheduleSliceMs ?? DAEMON_DEFAULTS.maxEmptyScheduleSliceMs,
  );

  const startedAtIso = new Date(now()).toISOString();
  let triggeredSlots: Record<string, string> = existingState?.triggeredSlots
    ? { ...existingState.triggeredSlots }
    : {};
  const failedDispatchCooldownUntil = new Map<string, number>();
  let nextScheduleRunAt: string | null = null;
  let nextScheduleName: string | null = null;
  let lastCheckAt: string | null = null;

  let cachedSettings = await loadSettings(paths.settingsFile);
  let cachedSchedules = loadSchedulesReadOnly(paths.dbFile);
  let lastSettingsSig = readFileSignatureSync(paths.settingsFile);
  let lastDbSignature = `${readFileSignatureSync(paths.dbFile)}:${readFileSignatureSync(`${paths.dbFile}-wal`)}`;
  let lastSignalSig = readFileSignatureSync(getDaemonReloadSignalFile(paths));

  let actualWebPort = requestedWebPort;
  let stateWriteChain = Promise.resolve();
  let stopped = false;
  let wakeTimer: ReturnType<typeof setTimeout> | null = null;
  let checkRunning: Promise<void> | null = null;
  let pendingRecheck = false;
  let signalWatcher: fsSync.FSWatcher | null = null;

  let resolveStopPromise!: () => void;
  const waitUntilStopped = new Promise<void>((resolve) => {
    resolveStopPromise = resolve;
  });

  const enqueueWriteState = (webSnapshot?: {
    state: DaemonRuntimeState['webState'];
    pid: number | null;
    lastActiveAt: string | null;
  }): Promise<void> => {
    const snap = webSnapshot ??
      webProxy?.getSnapshot() ?? { state: 'stopped' as const, pid: null, lastActiveAt: null };
    const payload: DaemonRuntimeState = {
      pid: process.pid,
      startedAt: startedAtIso,
      rootDir: paths.rootDir,
      webEnabled,
      webHost,
      webPort: actualWebPort,
      webState: snap.state,
      webPid: snap.pid,
      webLastActiveAt: snap.lastActiveAt,
      webIdleTimeoutSec,
      nextScheduleRunAt,
      nextScheduleName,
      lastCheckAt,
      triggeredSlots,
    };
    stateWriteChain = stateWriteChain
      .catch(() => undefined)
      .then(() => (stopped ? undefined : writeDaemonRuntimeState(paths, payload)));
    return stateWriteChain;
  };

  let webProxy: WebOnDemandProxy | null = null;
  if (webEnabled) {
    webProxy = new WebOnDemandProxy({
      rootDir: paths.rootDir,
      host: webHost,
      port: requestedWebPort,
      idleTimeoutMs: webIdleTimeoutSec * 1000,
      logFile: webLogFile,
      now,
      backendLauncher: opts.backendLauncher,
      onStateChange: (snapshot) => {
        if (!stopped) {
          appendDaemonLog(
            daemonLogFile,
            'INFO',
            `网页控制台状态变更：${snapshot.state}${snapshot.pid ? ` (PID: ${snapshot.pid})` : ''}`,
            now(),
          );
          void enqueueWriteState(snapshot).catch((err) => {
            const msg = err instanceof Error ? err.message : String(err);
            appendDaemonLog(daemonLogFile, 'ERROR', `写入守护状态失败：${msg}`, now());
          });
        }
      },
    });
    const bound = await webProxy.listen();
    actualWebPort = bound.port;
  }

  const refreshDiskCacheIfNeeded = async (forceReload: boolean): Promise<void> => {
    const settingsSig = readFileSignatureSync(paths.settingsFile);
    const dbSig = `${readFileSignatureSync(paths.dbFile)}:${readFileSignatureSync(`${paths.dbFile}-wal`)}`;
    const sigSig = readFileSignatureSync(getDaemonReloadSignalFile(paths));

    if (forceReload || settingsSig !== lastSettingsSig) {
      cachedSettings = await loadSettings(paths.settingsFile).catch(() => cachedSettings);
      lastSettingsSig = settingsSig;
    }
    if (forceReload || dbSig !== lastDbSignature || sigSig !== lastSignalSig) {
      cachedSchedules = loadSchedulesReadOnly(paths.dbFile);
      lastDbSignature = dbSig;
      lastSignalSig = sigSig;
    }
  };

  const clearWakeTimer = () => {
    if (wakeTimer) {
      clearTimeout(wakeTimer);
      wakeTimer = null;
    }
  };

  const runCheckCycleSafe = (forceReload: boolean): void => {
    void runCheckCycle(forceReload).catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      appendDaemonLog(daemonLogFile, 'ERROR', `后台调度循环异常：${msg}`, now());
      if (!stopped) {
        scheduleNextWakeup(now());
      }
    });
  };

  const scheduleNextWakeup = (nowMs: number) => {
    clearWakeTimer();
    if (stopped) {
      return;
    }
    let delayMs = maxEmptySliceMs;
    if (nextScheduleRunAt) {
      const nextMs = Date.parse(nextScheduleRunAt);
      if (Number.isFinite(nextMs)) {
        delayMs = Math.min(Math.max(500, nextMs - nowMs), maxSleepSliceMs);
      }
    }
    wakeTimer = setTimeout(() => {
      wakeTimer = null;
      runCheckCycleSafe(false);
    }, delayMs);
    wakeTimer.unref?.();
  };

  const runCheckCycle = async (forceReload: boolean): Promise<void> => {
    if (stopped) {
      return;
    }
    if (checkRunning) {
      pendingRecheck = true;
      await checkRunning;
      if (forceReload && !stopped) {
        await runCheckCycle(true);
      }
      return;
    }

    checkRunning = (async () => {
      try {
        if (forceReload) {
          failedDispatchCooldownUntil.clear();
        }
        await refreshDiskCacheIfNeeded(forceReload);
        const nowMs = now();
        lastCheckAt = new Date(nowMs).toISOString();

        const plan = evaluateDueSchedules({
          schedules: cachedSchedules,
          timezone: cachedSettings.timezone,
          nowMs,
          triggeredSlots,
          catchUpGraceMs: opts.catchUpGraceMs,
        });

        triggeredSlots = plan.prunedTriggeredSlots;
        nextScheduleRunAt = plan.nextRunAt;
        nextScheduleName = plan.nextScheduleName;

        const jobsToDispatch = plan.dueJobs.filter((due) => {
          const retryAfter = failedDispatchCooldownUntil.get(due.job.id);
          return retryAfter === undefined || nowMs >= retryAfter;
        });

        if (jobsToDispatch.length > 0) {
          cachedSettings = await loadSettings(paths.settingsFile).catch(() => cachedSettings);
          lastSettingsSig = readFileSignatureSync(paths.settingsFile);
        }

        for (const due of jobsToDispatch) {
          const childEnv = buildDaemonChildEnv(cachedSettings, paths.rootDir);
          const primaryChannel = resolveStageChannelPlan(cachedSettings, 'select')[0];
          const routeDesc = primaryChannel
            ? `${primaryChannel.cli}/${primaryChannel.model}`
            : '未配置';
          appendDaemonLog(
            daemonLogFile,
            'INFO',
            `定时任务到点触发：${due.job.name} (${due.job.id}, ${due.job.time}, ${due.job.itemCount} 条, 当前主 AI 渠道: ${routeDesc})`,
            nowMs,
          );
          try {
            if (opts.triggerScheduleRunner) {
              await opts.triggerScheduleRunner(due, childEnv);
            } else {
              await spawnScheduledWorkerTask(paths, due, childEnv);
            }
            // 仅在工作进程确认派生成功后再写入当日已触发槽位，派发失败时保留待补跑状态
            triggeredSlots[due.job.id] = due.slotKey;
            failedDispatchCooldownUntil.delete(due.job.id);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            failedDispatchCooldownUntil.set(due.job.id, nowMs + 30_000);
            appendDaemonLog(
              daemonLogFile,
              'ERROR',
              `拉起定时任务工作进程失败 (${due.job.id})：${msg}`,
              nowMs,
            );
          }
        }

        await enqueueWriteState();
        scheduleNextWakeup(nowMs);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        appendDaemonLog(daemonLogFile, 'ERROR', `定时调度周期执行失败：${msg}`, now());
        scheduleNextWakeup(now());
      } finally {
        checkRunning = null;
      }
    })();

    await checkRunning;
    if (pendingRecheck && !stopped) {
      pendingRecheck = false;
      await runCheckCycle(false);
    }
  };

  let stop = async (): Promise<void> => {
    await waitUntilStopped;
  };
  const onSighup = () => {
    if (!stopped) {
      appendDaemonLog(daemonLogFile, 'INFO', '收到重载信号，立即刷新定时任务计划', now());
      runCheckCycleSafe(true);
    }
  };
  const onSigusr2 = () => {
    if (!stopped && webProxy) {
      void webProxy
        .sleepIfIdle(false)
        .then((slept) => {
          if (slept) {
            appendDaemonLog(
              daemonLogFile,
              'INFO',
              '收到休眠指令，已暂停空闲网页子进程并回收内存',
              now(),
            );
          }
        })
        .catch((err) => {
          const msg = err instanceof Error ? err.message : String(err);
          appendDaemonLog(daemonLogFile, 'ERROR', `网页子进程休眠失败：${msg}`, now());
        });
    }
  };
  const onStopSignal = () => {
    void stop().catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      appendDaemonLog(daemonLogFile, 'ERROR', `守护进程停止流程异常：${msg}`, now());
      resolveStopPromise();
    });
  };

  const useProcessSignals = opts.registerSignals ?? true;
  stop = async (): Promise<void> => {
    if (stopped) {
      await waitUntilStopped;
      return;
    }
    stopped = true;
    clearWakeTimer();
    signalWatcher?.close();
    signalWatcher = null;
    if (useProcessSignals) {
      process.off('SIGHUP', onSighup);
      process.off('SIGUSR2', onSigusr2);
      process.off('SIGTERM', onStopSignal);
      process.off('SIGINT', onStopSignal);
    }
    if (checkRunning) {
      await checkRunning.catch(() => undefined);
    }
    if (webProxy) {
      await webProxy.close();
    }
    await stateWriteChain.catch(() => undefined);
    await fs
      .rm(path.join(getDaemonStorageDir(paths), 'state.json'), { force: true })
      .catch(() => undefined);
    appendDaemonLog(daemonLogFile, 'INFO', `守护进程已安全停止（PID: ${process.pid}）`, now());
    resolveStopPromise();
  };

  // 先完成 stop 句柄赋值再注册目录监听与进程信号，消除竞态异常窗口
  try {
    signalWatcher = fsSync.watch(getDaemonStorageDir(paths), (_eventType, fileName) => {
      if (fileName === 'reload.signal' && !stopped) {
        runCheckCycleSafe(true);
      }
    });
    signalWatcher.unref?.();
  } catch {
    signalWatcher = null;
  }

  if (useProcessSignals) {
    process.on('SIGHUP', onSighup);
    process.on('SIGUSR2', onSigusr2);
    process.on('SIGTERM', onStopSignal);
    process.on('SIGINT', onStopSignal);
  }

  appendDaemonLog(
    daemonLogFile,
    'INFO',
    `守护进程已启动（PID: ${process.pid}${webEnabled ? `, 网页按需网关 http://${webHost}:${actualWebPort}, 闲置 ${webIdleTimeoutSec}s 自动休眠` : ', 仅调度模式'}）`,
    now(),
  );

  await runCheckCycle(true);

  return {
    pid: process.pid,
    webHost,
    webPort: actualWebPort,
    waitUntilStopped,
    triggerCheckNow: (forceReload = true) => runCheckCycle(forceReload),
    sleepWebIfIdle: (force = false) =>
      webProxy ? webProxy.sleepIfIdle(force) : Promise.resolve(true),
    stop,
  };
}
