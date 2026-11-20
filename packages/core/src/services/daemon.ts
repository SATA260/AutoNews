import { spawn, spawnSync } from 'node:child_process';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DaemonStatus, GlobalCliStatus } from '@aidaily/contracts';
import { execa } from 'execa';
import type { CoreContext } from '../context.js';
import { DAEMON_DEFAULTS, normalizeBrowserWebHost } from '../daemon/constants.js';
import { getGlobalCliStatus, installGlobalCli, uninstallGlobalCli } from '../daemon/global-cli.js';
import { buildDaemonChildEnv } from '../daemon/runner.js';
import {
  clearStaleDaemonState,
  getDaemonLogFile,
  getDaemonWebLogFile,
  isPidAlive,
  notifyDaemonReload,
  readDaemonRuntimeState,
} from '../daemon/runtime-state.js';
import { computeNextScheduleRunAt } from '../daemon/schedule-planner.js';
import { assertWebBuildPresent, resolveNextBinPath } from '../daemon/web-proxy.js';
import { writeFileAtomic } from '../storage/files.js';
import type { LaunchctlExecutor } from './scheduler.js';

/** 统一守护进程在 macOS 系统调度器中的固定服务标识 */
export const DAEMON_SERVICE_LABEL = 'com.aidaily.daemon';

/** 启动守护进程的可选配置参数 */
export interface StartDaemonOptions {
  webEnabled?: boolean;
  webHost?: string;
  webPort?: number;
  webIdleTimeoutSec?: number;
}

/** 在前台直接运行网页控制台的启动参数 */
export interface StartForegroundWebOptions {
  host?: string;
  port?: number;
  dev?: boolean;
  onReadyUrl?: (url: string) => void;
}

/** 守护进程与全局命令行管理服务接口 */
export interface DaemonService {
  /** 查看 `aidaily` 全局命令的本机注册与可用状态 */
  getGlobalCliStatus(): Promise<GlobalCliStatus>;
  /** 将 `aidaily` 注册为本机全局命令，使任意终端目录均可直接启动 */
  installGlobalCli(): Promise<GlobalCliStatus>;
  /** 卸载本机全局命令注册脚本 */
  uninstallGlobalCli(): Promise<{ removed: boolean; binPath: string }>;
  /** 获取守护进程、开机自启服务及按需网页网关的实时运行状态 */
  getStatus(): Promise<DaemonStatus>;
  /** 以分离后台方式启动低占用守护进程 */
  start(opts?: StartDaemonOptions): Promise<DaemonStatus>;
  /** 优雅停止正在运行的守护进程及其托管的网页子进程 */
  stop(): Promise<{ stopped: boolean; pid: number | null }>;
  /** 重启守护进程并应用最新参数 */
  restart(opts?: StartDaemonOptions): Promise<DaemonStatus>;
  /** 安装并启用 macOS 开机自启后台服务，同时接管本项目全部定时任务 */
  install(opts?: StartDaemonOptions): Promise<DaemonStatus>;
  /** 卸载 macOS 开机自启后台服务，并按需恢复独立定时任务挂载 */
  uninstall(): Promise<{ uninstalled: boolean; plistPath: string }>;
  /** 通知运行中的守护进程立即重读最新定时计划 */
  reloadSchedules(): Promise<void>;
  /** 主动预热唤醒按需托管的网页后台进程 */
  wakeWeb(): Promise<DaemonStatus>;
  /** 主动让空闲的网页后台子进程立即休眠回收内存 */
  sleepWeb(): Promise<DaemonStatus>;
  /** 在前台直接运行网页控制台进程，并等待其退出返回退出码 */
  startForegroundWeb(opts?: StartForegroundWebOptions): Promise<{ exitCode: number; url: string }>;
  /** 读取守护进程或网页子进程日志尾部行内容 */
  readLogs(opts?: { web?: boolean; lines?: number }): Promise<{ file: string; lines: string[] }>;
}

/** 注入给守护进程管理服务的测试与外部调用钩子 */
export interface DaemonServiceDeps {
  launchAgentsDir?: string;
  launchctlExec?: LaunchctlExecutor;
  daemonScriptPath?: string;
  cliScriptPath?: string;
  globalBinDir?: string;
  pathEnv?: string;
  nodePath?: string;
  onAfterUninstall?: () => Promise<void>;
  spawnDaemonDetached?: (
    args: string[],
    opts: { rootDir: string; logFile: string; env: NodeJS.ProcessEnv },
  ) => Promise<number | undefined>;
}

/** 对 XML 文本节点执行实体转义 */
function escapeXml(raw: string): string {
  return raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** 解析守护进程后台启动脚本 `daemon.mjs` 的绝对路径 */
export function resolveDaemonScriptPath(rootDir: string, overridePath?: string): string {
  if (overridePath) {
    return path.resolve(overridePath);
  }
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(moduleDir, 'daemon.mjs'),
    path.resolve(moduleDir, '../dist/daemon.mjs'),
    path.resolve(moduleDir, '../../dist/daemon.mjs'),
    path.join(path.resolve(rootDir), 'packages', 'core', 'dist', 'daemon.mjs'),
    path.join(process.cwd(), 'packages', 'core', 'dist', 'daemon.mjs'),
  ];
  for (const candidate of candidates) {
    if (fsSync.existsSync(candidate)) {
      return candidate;
    }
  }
  throw new Error(
    `未找到守护进程入口脚本 daemon.mjs（请先运行 npm run build -w @aidaily/core，已查找路径: ${candidates.join(', ')}）`,
  );
}

/** 计算守护进程 macOS 服务配置文件完整路径 */
export function getDaemonPlistPath(launchAgentsDir: string): string {
  return path.join(launchAgentsDir, `${DAEMON_SERVICE_LABEL}.plist`);
}

/** 判断指定调度目录下的守护进程自启配置是否已挂载且归属当前项目根目录 */
export function isDaemonServiceInstalledForRoot(launchAgentsDir: string, rootDir: string): boolean {
  const plistPath = getDaemonPlistPath(launchAgentsDir);
  if (!fsSync.existsSync(plistPath)) {
    return false;
  }
  try {
    const content = fsSync.readFileSync(plistPath, 'utf8');
    return content.includes(`<string>${escapeXml(path.resolve(rootDir))}</string>`);
  } catch {
    return false;
  }
}

/** 生成用于 macOS 登录自启守护进程的 `LaunchAgent` plist 配置 */
export function buildDaemonLaunchAgentPlist(opts: {
  rootDir: string;
  logsDir: string;
  daemonScriptPath: string;
  nodePath?: string;
  envPath?: string;
  timezone?: string;
  webEnabled: boolean;
  webHost: string;
  webPort: number;
  webIdleTimeoutSec: number;
}): string {
  const logFile = path.join(opts.logsDir, 'daemon.log');
  const nodeBin = path.resolve(opts.nodePath ?? process.execPath);
  const programArgs = [
    nodeBin,
    path.resolve(opts.daemonScriptPath),
    '--root',
    path.resolve(opts.rootDir),
    ...(opts.webEnabled
      ? [
          '--host',
          opts.webHost,
          '--port',
          String(opts.webPort),
          '--idle-sec',
          String(opts.webIdleTimeoutSec),
        ]
      : ['--no-web']),
  ];
  const argLines = programArgs.map((arg) => `      <string>${escapeXml(arg)}</string>`).join('\n');

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '  <dict>',
    '    <key>Label</key>',
    `    <string>${DAEMON_SERVICE_LABEL}</string>`,
    '    <key>ProgramArguments</key>',
    '    <array>',
    argLines,
    '    </array>',
    '    <key>WorkingDirectory</key>',
    `    <string>${escapeXml(path.resolve(opts.rootDir))}</string>`,
    '    <key>EnvironmentVariables</key>',
    '    <dict>',
    '      <key>AIDAILY_ROOT</key>',
    `      <string>${escapeXml(path.resolve(opts.rootDir))}</string>`,
    ...(opts.envPath
      ? ['      <key>PATH</key>', `      <string>${escapeXml(opts.envPath)}</string>`]
      : []),
    ...(opts.timezone
      ? ['      <key>TZ</key>', `      <string>${escapeXml(opts.timezone)}</string>`]
      : []),
    '    </dict>',
    '    <key>StandardOutPath</key>',
    `    <string>${escapeXml(logFile)}</string>`,
    '    <key>StandardErrorPath</key>',
    `    <string>${escapeXml(logFile)}</string>`,
    '    <key>RunAtLoad</key>',
    '    <true/>',
    '    <key>KeepAlive</key>',
    '    <dict>',
    '      <key>SuccessfulExit</key>',
    '      <false/>',
    '    </dict>',
    '    <key>ThrottleInterval</key>',
    '    <integer>10</integer>',
    '  </dict>',
    '</plist>',
    '',
  ].join('\n');
}

/** 创建默认系统 `launchctl` 执行器 */
function createDefaultLaunchctlExec(): LaunchctlExecutor {
  return async (args: string[]) => {
    const res = await execa('launchctl', args, { reject: false });
    return { exitCode: res.exitCode ?? 1, stderr: res.stderr ?? '' };
  };
}

/** 读取文本日志文件末尾 N 行（仅读取文件末尾最多 64 KB，避免大日志全量读入内存） */
async function readTailLines(filePath: string, limit: number): Promise<string[]> {
  try {
    const handle = await fs.open(filePath, 'r');
    try {
      const stat = await handle.stat();
      if (stat.size === 0) {
        return [];
      }
      const chunkBytes = Math.min(stat.size, 64 * 1024);
      const offset = stat.size - chunkBytes;
      const buf = Buffer.allocUnsafe(chunkBytes);
      const { bytesRead } = await handle.read(buf, 0, chunkBytes, offset);
      let text = buf.subarray(0, bytesRead).toString('utf8');
      if (offset > 0) {
        const firstNewline = text.indexOf('\n');
        text = firstNewline >= 0 ? text.slice(firstNewline + 1) : '';
      }
      const lines = text.split(/\r?\n/).filter((line) => line.length > 0);
      return lines.slice(-Math.max(1, limit));
    } finally {
      await handle.close();
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw err;
  }
}

/** 尽量校验待终止的进程确属本项目守护或运行时进程，降低 PID 复用导致的误杀风险 */
function isExpectedDaemonPid(pid: number, rootDir: string): boolean {
  if (process.platform === 'win32') {
    return true;
  }
  const probe = spawnSync('ps', ['-p', String(pid), '-o', 'command='], {
    encoding: 'utf8',
    timeout: 1_000,
  });
  if (probe.error) {
    // 系统缺少 ps 命令时回退允许按记录停止
    return true;
  }
  if (probe.status !== 0 || !probe.stdout.trim()) {
    return false;
  }
  const cmdLine = probe.stdout.trim();
  const exeName = path.basename(cmdLine.split(/\s+/)[0] ?? '');
  return (
    cmdLine.includes('daemon.mjs') ||
    cmdLine.includes('aidaily') ||
    cmdLine.includes(path.resolve(rootDir)) ||
    exeName === path.basename(process.execPath)
  );
}

/** 默认分离拉起守护进程 */
async function defaultSpawnDaemonDetached(
  args: string[],
  opts: { rootDir: string; logFile: string; env: NodeJS.ProcessEnv },
): Promise<number | undefined> {
  await fs.mkdir(path.dirname(opts.logFile), { recursive: true });
  const outFd = fsSync.openSync(opts.logFile, 'a');
  try {
    const child = spawn(process.execPath, args, {
      cwd: opts.rootDir,
      detached: true,
      stdio: ['ignore', outFd, outFd],
      env: opts.env,
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
    return child.pid;
  } finally {
    fsSync.closeSync(outFd);
  }
}

/**
 * 创建守护进程与全局命令行管理服务：
 * 统一封装 `aidaily` 全局注册、低占用调度守护启停、按需网页进程唤醒与休眠，以及 macOS 开机自启服务安装卸载。
 */
export function createDaemonService(ctx: CoreContext, deps?: DaemonServiceDeps): DaemonService {
  const homeDir = process.env.HOME?.trim() || os.homedir();
  const launchAgentsDir =
    deps?.launchAgentsDir ??
    process.env.AIDAILY_LAUNCH_AGENTS_DIR?.trim() ??
    path.join(homeDir, 'Library', 'LaunchAgents');
  const launchctlExec = deps?.launchctlExec ?? createDefaultLaunchctlExec();
  const spawnDetached = deps?.spawnDaemonDetached ?? defaultSpawnDaemonDetached;

  const domainTarget = (): string => {
    const uid = process.getuid?.();
    if (uid === undefined) {
      throw new Error('当前操作系统不支持按用户 UID 安装 macOS 后台服务');
    }
    if (uid === 0) {
      throw new Error('不支持在 root 会话下自动安装个人后台服务');
    }
    return `gui/${uid}`;
  };

  const globalCliOpts = {
    rootDir: ctx.paths.rootDir,
    binDir: deps?.globalBinDir,
    cliScriptPath: deps?.cliScriptPath,
    nodePath: deps?.nodePath,
    pathEnv: deps?.pathEnv,
  };

  const computeSchedulePreview = (): {
    nextScheduleRunAt: string | null;
    nextScheduleName: string | null;
  } => {
    const jobs = ctx.repos.schedules.list();
    const nowDate = ctx.now();
    let bestMs = Number.POSITIVE_INFINITY;
    let nextScheduleRunAt: string | null = null;
    let nextScheduleName: string | null = null;
    for (const job of jobs) {
      const nextIso = computeNextScheduleRunAt(
        job.time,
        job.enabled,
        nowDate,
        ctx.settings.timezone,
      );
      if (!nextIso) {
        continue;
      }
      const nextMs = Date.parse(nextIso);
      if (nextMs < bestMs) {
        bestMs = nextMs;
        nextScheduleRunAt = nextIso;
        nextScheduleName = job.name;
      }
    }
    return { nextScheduleRunAt, nextScheduleName };
  };

  const getStatus = async (): Promise<DaemonStatus> => {
    const rawState = await readDaemonRuntimeState(ctx.paths);
    const pidAlive = Boolean(rawState && isPidAlive(rawState.pid));
    if (rawState && !pidAlive) {
      await clearStaleDaemonState(ctx.paths);
    }

    const activeState = pidAlive ? rawState : null;
    const webEnabled = activeState ? activeState.webEnabled : true;
    const webHost = activeState ? activeState.webHost : DAEMON_DEFAULTS.webHost;
    const webPort = activeState ? activeState.webPort : DAEMON_DEFAULTS.webPort;
    const webIdleTimeoutSec = activeState
      ? activeState.webIdleTimeoutSec
      : DAEMON_DEFAULTS.webIdleTimeoutSec;
    const webPidAlive = Boolean(activeState?.webPid && isPidAlive(activeState.webPid));
    const webState = activeState
      ? activeState.webState === 'running' && !webPidAlive && activeState.webPid !== null
        ? 'stopped'
        : activeState.webState
      : 'stopped';
    const schedulePreview = computeSchedulePreview();
    const serviceInstalled = isDaemonServiceInstalledForRoot(launchAgentsDir, ctx.paths.rootDir);
    const globalCli = await getGlobalCliStatus(globalCliOpts);

    return {
      running: Boolean(activeState),
      pid: activeState?.pid ?? null,
      startedAt: activeState?.startedAt ?? null,
      serviceInstalled,
      serviceLabel: DAEMON_SERVICE_LABEL,
      plistPath: getDaemonPlistPath(launchAgentsDir),
      webEnabled,
      webHost,
      webPort,
      webUrl: `http://${normalizeBrowserWebHost(webHost)}:${webPort}`,
      webState,
      webPid: webPidAlive ? (activeState?.webPid ?? null) : null,
      webLastActiveAt: activeState?.webLastActiveAt ?? null,
      webIdleTimeoutSec,
      nextScheduleRunAt: activeState?.nextScheduleRunAt ?? schedulePreview.nextScheduleRunAt,
      nextScheduleName: activeState?.nextScheduleName ?? schedulePreview.nextScheduleName,
      lastCheckAt: activeState?.lastCheckAt ?? null,
      logFile: getDaemonLogFile(ctx.paths),
      webLogFile: getDaemonWebLogFile(ctx.paths),
      globalCli,
    };
  };

  const stop = async (): Promise<{ stopped: boolean; pid: number | null }> => {
    const state = await readDaemonRuntimeState(ctx.paths);
    if (!state || !isPidAlive(state.pid)) {
      await clearStaleDaemonState(ctx.paths);
      return { stopped: false, pid: null };
    }

    const targetPid = state.pid;
    if (!isExpectedDaemonPid(targetPid, ctx.paths.rootDir)) {
      ctx.logger.warn(
        { pid: targetPid },
        '状态文件中的守护进程编号对应非本项目进程，已忽略终止并清理过期状态',
      );
      await clearStaleDaemonState(ctx.paths);
      return { stopped: false, pid: null };
    }
    try {
      process.kill(targetPid, 'SIGTERM');
    } catch {
      await clearStaleDaemonState(ctx.paths);
      return { stopped: false, pid: null };
    }

    const deadline = Date.now() + 6_000;
    while (Date.now() < deadline) {
      if (!isPidAlive(targetPid)) {
        await clearStaleDaemonState(ctx.paths);
        return { stopped: true, pid: targetPid };
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    try {
      process.kill(targetPid, 'SIGKILL');
    } catch {
      // 忽略目标进程恰好退出的情况
    }
    await clearStaleDaemonState(ctx.paths);
    return { stopped: true, pid: targetPid };
  };

  const removeLegacyRepoSchedulePlists = async (): Promise<void> => {
    let entries: string[] = [];
    try {
      entries = await fs.readdir(launchAgentsDir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return;
      }
      throw err;
    }
    const expectedRootTag = `<string>${escapeXml(path.resolve(ctx.paths.rootDir))}</string>`;
    const matchedPaths: string[] = [];
    for (const fileName of entries) {
      if (!/^com\.aidaily\.schedule\.(.+)\.plist$/.test(fileName)) {
        continue;
      }
      const fullPath = path.join(launchAgentsDir, fileName);
      const xml = await fs.readFile(fullPath, 'utf8').catch(() => '');
      if (xml.includes(expectedRootTag)) {
        matchedPaths.push(fullPath);
      }
    }
    if (matchedPaths.length === 0) {
      return;
    }
    const domain = domainTarget();
    for (const fullPath of matchedPaths) {
      await launchctlExec(['bootout', domain, fullPath]).catch(() => ({
        exitCode: 0,
        stderr: '',
      }));
      await fs.rm(fullPath, { force: true });
    }
  };

  const start = async (opts?: StartDaemonOptions): Promise<DaemonStatus> => {
    const current = await getStatus();
    if (current.running) {
      return current;
    }

    const webEnabled = opts?.webEnabled ?? true;
    const webHost = opts?.webHost ?? DAEMON_DEFAULTS.webHost;
    const webPort = opts?.webPort ?? DAEMON_DEFAULTS.webPort;
    const webIdleTimeoutSec = opts?.webIdleTimeoutSec ?? DAEMON_DEFAULTS.webIdleTimeoutSec;
    if (webEnabled) {
      assertWebBuildPresent(ctx.paths.rootDir);
    }

    // 手动启动守护进程时同步清理历史独立定时配置，防止双路重复触发
    await removeLegacyRepoSchedulePlists().catch(() => undefined);

    const scriptPath = resolveDaemonScriptPath(ctx.paths.rootDir, deps?.daemonScriptPath);
    const daemonLog = getDaemonLogFile(ctx.paths);
    const args = [
      scriptPath,
      '--root',
      ctx.paths.rootDir,
      ...(webEnabled
        ? ['--host', webHost, '--port', String(webPort), '--idle-sec', String(webIdleTimeoutSec)]
        : ['--no-web']),
    ];

    const pid = await spawnDetached(args, {
      rootDir: ctx.paths.rootDir,
      logFile: daemonLog,
      env: buildDaemonChildEnv(ctx.settings, ctx.paths.rootDir),
    });

    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const state = await readDaemonRuntimeState(ctx.paths);
      if (state && (!pid || state.pid === pid) && isPidAlive(state.pid)) {
        return getStatus();
      }
      if (pid && !isPidAlive(pid)) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 80));
    }

    const tail = await readTailLines(daemonLog, 8);
    throw new Error(
      `后台守护进程启动失败${tail.length > 0 ? `：${tail.join(' | ')}` : '，请检查守护进程日志'}`,
    );
  };

  return {
    getGlobalCliStatus: () => getGlobalCliStatus(globalCliOpts),
    installGlobalCli: () => installGlobalCli(globalCliOpts),
    uninstallGlobalCli: () => uninstallGlobalCli(globalCliOpts),
    getStatus,
    start,
    stop,

    async restart(opts?: StartDaemonOptions): Promise<DaemonStatus> {
      await stop();
      return start(opts);
    },

    async install(opts?: StartDaemonOptions): Promise<DaemonStatus> {
      const webEnabled = opts?.webEnabled ?? true;
      const webHost = opts?.webHost ?? DAEMON_DEFAULTS.webHost;
      const webPort = opts?.webPort ?? DAEMON_DEFAULTS.webPort;
      const webIdleTimeoutSec = opts?.webIdleTimeoutSec ?? DAEMON_DEFAULTS.webIdleTimeoutSec;

      if (webEnabled) {
        assertWebBuildPresent(ctx.paths.rootDir);
      }

      const daemonScriptPath = resolveDaemonScriptPath(ctx.paths.rootDir, deps?.daemonScriptPath);
      const childEnv = buildDaemonChildEnv(ctx.settings, ctx.paths.rootDir);
      const plistPath = getDaemonPlistPath(launchAgentsDir);
      const domain = domainTarget();

      // 安装开机服务前先停掉手动拉起的守护进程，并摘除历史旧服务防止端口冲突
      await stop();
      await launchctlExec(['bootout', domain, plistPath]).catch(() => ({
        exitCode: 0,
        stderr: '',
      }));
      await removeLegacyRepoSchedulePlists();

      const plistXml = buildDaemonLaunchAgentPlist({
        rootDir: ctx.paths.rootDir,
        logsDir: ctx.paths.logsDir,
        daemonScriptPath,
        nodePath: deps?.nodePath ?? process.execPath,
        envPath: childEnv.PATH,
        timezone: ctx.settings.timezone,
        webEnabled,
        webHost,
        webPort,
        webIdleTimeoutSec,
      });

      await writeFileAtomic(plistPath, plistXml, { mode: 0o644 });
      const res = await launchctlExec(['bootstrap', domain, plistPath]);
      if (res.exitCode !== 0) {
        await fs.rm(plistPath, { force: true }).catch(() => undefined);
        throw new Error(
          `安装开机自启守护服务失败 (${DAEMON_SERVICE_LABEL}): ${res.stderr.trim() || `退出码 ${res.exitCode}`}`,
        );
      }

      const deadline = Date.now() + 4_000;
      while (Date.now() < deadline) {
        const state = await readDaemonRuntimeState(ctx.paths);
        if (state && isPidAlive(state.pid)) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }

      return getStatus();
    },

    async uninstall(): Promise<{ uninstalled: boolean; plistPath: string }> {
      const plistPath = getDaemonPlistPath(launchAgentsDir);
      const existed = fsSync.existsSync(plistPath);
      if (existed) {
        await launchctlExec(['bootout', domainTarget(), plistPath]).catch(() => ({
          exitCode: 0,
          stderr: '',
        }));
        await fs.rm(plistPath, { force: true });
      }
      await stop();
      if (existed && deps?.onAfterUninstall) {
        await deps.onAfterUninstall();
      }
      return { uninstalled: existed, plistPath };
    },

    async reloadSchedules(): Promise<void> {
      await notifyDaemonReload(ctx.paths);
    },

    async wakeWeb(): Promise<DaemonStatus> {
      const status = await getStatus();
      if (!status.running) {
        throw new Error(
          '守护进程尚未运行，请先执行 `aidaily daemon start` 或 `aidaily daemon install`',
        );
      }
      if (!status.webEnabled) {
        throw new Error('当前守护进程以无网页模式启动，请使用普通模式重启后再唤醒网页');
      }

      const token = process.env.AIDAILY_WEB_TOKEN?.trim();
      const response = await ctx.fetchImpl(`${status.webUrl}/`, {
        method: 'GET',
        headers: token ? { 'x-aidaily-token': token } : undefined,
        signal: AbortSignal.timeout(25_000),
      });
      await response.arrayBuffer().catch(() => undefined);
      if (response.status >= 500) {
        throw new Error(
          `唤醒网页控制台失败（HTTP ${response.status}），请查看 ${status.webLogFile}`,
        );
      }
      return getStatus();
    },

    async sleepWeb(): Promise<DaemonStatus> {
      const status = await getStatus();
      if (!status.running || !status.pid) {
        throw new Error('守护进程当前未运行');
      }
      if (!status.webEnabled || status.webState === 'stopped') {
        return status;
      }
      process.kill(status.pid, 'SIGUSR2');
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        const nextStatus = await getStatus();
        if (nextStatus.webState === 'stopped') {
          return nextStatus;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return getStatus();
    },

    async readLogs(opts?: {
      web?: boolean;
      lines?: number;
    }): Promise<{ file: string; lines: string[] }> {
      const file = opts?.web ? getDaemonWebLogFile(ctx.paths) : getDaemonLogFile(ctx.paths);
      const lines = await readTailLines(file, opts?.lines ?? 50);
      return { file, lines };
    },

    async startForegroundWeb(
      opts?: StartForegroundWebOptions,
    ): Promise<{ exitCode: number; url: string }> {
      const host = opts?.host?.trim() || DAEMON_DEFAULTS.webHost;
      const port = opts?.port ?? DAEMON_DEFAULTS.webPort;
      const mode: 'dev' | 'start' = opts?.dev ? 'dev' : 'start';
      if (mode === 'start') {
        assertWebBuildPresent(ctx.paths.rootDir);
      }
      const nextBin = resolveNextBinPath(ctx.paths.rootDir);
      const url = `http://${normalizeBrowserWebHost(host)}:${port}`;
      opts?.onReadyUrl?.(url);

      const exitCode = await new Promise<number>((resolve, reject) => {
        const child = spawn(process.execPath, [nextBin, mode, '-H', host, '-p', String(port)], {
          cwd: path.join(ctx.paths.rootDir, 'apps', 'web'),
          stdio: 'inherit',
          env: {
            ...process.env,
            AIDAILY_ROOT: ctx.paths.rootDir,
            ...(mode === 'start' ? { NODE_ENV: 'production' } : {}),
          },
        });
        child.on('error', reject);
        child.on('close', (code) => resolve(code ?? 0));
      });
      return { exitCode, url };
    },
  };
}
