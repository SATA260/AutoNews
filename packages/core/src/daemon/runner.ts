import { spawn } from 'node:child_process';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Settings } from '@aidaily/contracts';
import { loadSettings } from '../config/loader.js';
import { resolveStageChannelPlan } from '../editorial/llm.js';
import { type RepoPaths, resolveDefaultRepoRoot, resolveRepoPaths } from '../paths.js';
import { ensureDir } from '../storage/files.js';
import { resolveWorkerScriptPath } from '../worker/spawn.js';
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

const DEFAULT_MAX_SLEEP_SLICE_MS = 30_000;
const DEFAULT_EMPTY_SCHEDULE_SLICE_MS = 60_000;

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
  if (!fsSync.existsSync(dbFile)) {
    return [];
  }
  const db = new DatabaseSync(dbFile, { readOnly: true });
  try {
    db.exec('PRAGMA busy_timeout = 2000;');
    const tableRow = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schedules'")
      .get() as { name?: string } | undefined;
    if (!tableRow?.name) {
      return [];
    }
    const rows = db
      .prepare(
        `SELECT id, name, time_expr, item_count, bgm_file, enabled, last_triggered_at, created_at, updated_at
         FROM schedules
         ORDER BY time_expr ASC, created_at ASC`,
      )
      .all() as Array<{
      id: string;
      name: string;
      time_expr: string;
      item_count: number;
      bgm_file: string | null;
      enabled: number;
      last_triggered_at: string | null;
      created_at: string;
      updated_at: string;
    }>;

    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      time: row.time_expr,
      itemCount: row.item_count,
      bgmFile: row.bgm_file,
      enabled: row.enabled === 1,
      lastTriggeredAt: row.last_triggered_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  } finally {
    db.close();
  }
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

/** 写入简明单行守护进程运行日志 */
function appendDaemonLog(logFile: string, level: 'INFO' | 'WARN' | 'ERROR', message: string): void {
  const line = `[${new Date().toISOString()}] [${level}] ${message}\n`;
  try {
    fsSync.mkdirSync(path.dirname(logFile), { recursive: true });
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
  const webHost = opts.webHost ?? '127.0.0.1';
  const requestedWebPort = opts.webPort ?? 3000;
  const webIdleTimeoutSec = Math.max(10, opts.webIdleTimeoutSec ?? 900);
  const maxSleepSliceMs = Math.max(200, opts.maxSleepSliceMs ?? DEFAULT_MAX_SLEEP_SLICE_MS);
  const maxEmptySliceMs = Math.max(
    500,
    opts.maxEmptyScheduleSliceMs ?? DEFAULT_EMPTY_SCHEDULE_SLICE_MS,
  );

  const startedAtIso = new Date(now()).toISOString();
  let triggeredSlots: Record<string, string> = existingState?.triggeredSlots
    ? { ...existingState.triggeredSlots }
    : {};
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
          );
          void enqueueWriteState(snapshot);
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
      void runCheckCycle(false);
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

        for (const due of plan.dueJobs) {
          triggeredSlots[due.job.id] = due.slotKey;
        }
        await enqueueWriteState();

        if (plan.dueJobs.length > 0) {
          cachedSettings = await loadSettings(paths.settingsFile).catch(() => cachedSettings);
          lastSettingsSig = readFileSignatureSync(paths.settingsFile);
        }

        for (const due of plan.dueJobs) {
          const childEnv = buildDaemonChildEnv(cachedSettings, paths.rootDir);
          const primaryChannel = resolveStageChannelPlan(cachedSettings, 'select')[0];
          const routeDesc = primaryChannel
            ? `${primaryChannel.cli}/${primaryChannel.model}`
            : '未配置';
          appendDaemonLog(
            daemonLogFile,
            'INFO',
            `定时任务到点触发：${due.job.name} (${due.job.id}, ${due.job.time}, ${due.job.itemCount} 条, 当前主 AI 渠道: ${routeDesc})`,
          );
          try {
            if (opts.triggerScheduleRunner) {
              await opts.triggerScheduleRunner(due, childEnv);
            } else {
              await spawnScheduledWorkerTask(paths, due, childEnv);
            }
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            appendDaemonLog(
              daemonLogFile,
              'ERROR',
              `拉起定时任务工作进程失败 (${due.job.id})：${msg}`,
            );
          }
        }

        scheduleNextWakeup(nowMs);
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

  // 监听信号文件所在目录变更，Web 或 CLI 修改定时任务时无需等待长定时器即可重算计划
  try {
    signalWatcher = fsSync.watch(getDaemonStorageDir(paths), (_eventType, fileName) => {
      if (fileName === 'reload.signal' && !stopped) {
        void runCheckCycle(true);
      }
    });
    signalWatcher.unref?.();
  } catch {
    signalWatcher = null;
  }

  const onSighup = () => {
    if (!stopped) {
      appendDaemonLog(daemonLogFile, 'INFO', '收到重载信号，立即刷新定时任务计划');
      void runCheckCycle(true);
    }
  };
  const onSigusr2 = () => {
    if (!stopped && webProxy) {
      void webProxy.sleepIfIdle(false).then((slept) => {
        if (slept) {
          appendDaemonLog(daemonLogFile, 'INFO', '收到休眠指令，已暂停空闲网页子进程并回收内存');
        }
      });
    }
  };
  const onStopSignal = () => {
    void stop();
  };

  const useProcessSignals = opts.registerSignals ?? true;
  if (useProcessSignals) {
    process.on('SIGHUP', onSighup);
    process.on('SIGUSR2', onSigusr2);
    process.on('SIGTERM', onStopSignal);
    process.on('SIGINT', onStopSignal);
  }

  const stop = async (): Promise<void> => {
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
    appendDaemonLog(daemonLogFile, 'INFO', `守护进程已安全停止（PID: ${process.pid}）`);
    resolveStopPromise();
  };

  appendDaemonLog(
    daemonLogFile,
    'INFO',
    `守护进程已启动（PID: ${process.pid}${webEnabled ? `, 网页按需网关 http://${webHost}:${actualWebPort}, 闲置 ${webIdleTimeoutSec}s 自动休眠` : ', 仅调度模式'}）`,
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
