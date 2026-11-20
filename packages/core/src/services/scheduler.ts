import crypto from 'node:crypto';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type ScheduleCutoffMode,
  ScheduleCutoffModeSchema,
  type ScheduleJob,
  ScheduleJobSchema,
  ScheduleTimeSchema,
} from '@aidaily/contracts';
import { TZDate } from '@date-fns/tz';
import { execa } from 'execa';
import type { CoreContext } from '../context.js';
import { notifyDaemonReload } from '../daemon/runtime-state.js';
import { computeNextScheduleRunAt } from '../daemon/schedule-planner.js';
import { writeFileAtomic } from '../storage/files.js';
import { validateTemplateItemCount } from '../templates/registry.js';
import { isDaemonServiceInstalledForRoot } from './daemon.js';

const SAFE_SCHEDULE_ID_PATTERN = /^[a-zA-Z0-9._-]+$/;

/** 创建定时任务请求参数（每日执行时间和每期新闻条数均为必填，不设默认值） */
export interface CreateScheduleInput {
  name?: string;
  time: string;
  itemCount: number;
  cutoffMode?: ScheduleCutoffMode;
  maxAgeHours?: number | null;
  bgmFile?: string | null;
  enabled?: boolean;
}

/** 更新定时任务请求参数 */
export interface UpdateSchedulePatch {
  name?: string;
  time?: string;
  itemCount?: number;
  cutoffMode?: ScheduleCutoffMode;
  maxAgeHours?: number | null;
  bgmFile?: string | null;
  enabled?: boolean;
}

/** 定时任务管理服务接口（负责数据库记录维护与 macOS launchd 同步） */
export interface SchedulerService {
  /** 列出全部定时任务及其本地安装状态与下次触发时间 */
  list(): Promise<ScheduleJob[]>;
  /** 新建定时任务（必须显式指定 HH:mm 时间与正整数条数）并自动同步到 launchd */
  create(input: CreateScheduleInput): Promise<ScheduleJob>;
  /** 修改既有定时任务的配置或启停状态，并实时同步更新 launchd */
  update(id: string, patch: UpdateSchedulePatch): Promise<ScheduleJob>;
  /** 删除定时任务并同步卸载对应的 launchd 配置文件 */
  remove(id: string): Promise<void>;
  /** 将数据库中的全部定时任务重新全量同步到 launchd */
  sync(): Promise<void>;
}

/** 执行 `launchctl` 命令的注入回调签名，便于测试中替换真实系统调用 */
export type LaunchctlExecutor = (args: string[]) => Promise<{ exitCode: number; stderr: string }>;

/** 对 XML 文本节点与属性值执行标准实体转义，避免路径含特殊字符破坏 plist 格式 */
function escapeXml(raw: string): string {
  return raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** 解析命令行工具入口脚本的绝对路径 */
function resolveCliScriptPath(rootDir: string, overridePath?: string): string {
  if (overridePath) {
    return overridePath;
  }
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(path.resolve(rootDir), 'apps', 'cli', 'dist', 'index.js'),
    path.resolve(moduleDir, '../../../../apps/cli/dist/index.js'),
    path.resolve(moduleDir, '../../../apps/cli/dist/index.js'),
  ];
  for (const candidate of candidates) {
    if (fsSync.existsSync(candidate)) {
      return candidate;
    }
  }
  return candidates[0] ?? path.join(path.resolve(rootDir), 'apps', 'cli', 'dist', 'index.js');
}

/** 生成指定定时任务对应的 `launchd` 标签名称 */
export function buildScheduleLabel(scheduleId: string): string {
  if (!SAFE_SCHEDULE_ID_PATTERN.test(scheduleId) || scheduleId === '.' || scheduleId === '..') {
    throw new Error(`非法的定时任务 ID: ${scheduleId}`);
  }
  return `com.aidaily.schedule.${scheduleId}`;
}

/** 构造 macOS `launchd` 定时任务的 XML plist 配置内容，按宿主本地时钟换算触发时刻并注入配置时区环境变量 */
export function buildLaunchAgentPlist(opts: {
  id: string;
  time: string;
  itemCount: number;
  bgmFile?: string | null;
  rootDir: string;
  logsDir: string;
  cliScriptPath: string;
  extraBins?: string[];
  timezone?: string;
  hostTimezone?: string;
  now?: Date;
}): string {
  const [hhStr, mmStr] = ScheduleTimeSchema.parse(opts.time).split(':');
  let hour = Number(hhStr);
  let minute = Number(mmStr);
  if (opts.timezone) {
    const nextIso = computeNextScheduleRunAt(
      opts.time,
      true,
      opts.now ?? new Date(),
      opts.timezone,
    );
    if (nextIso) {
      const nextMs = Date.parse(nextIso);
      const localDate = opts.hostTimezone
        ? new TZDate(nextMs, opts.hostTimezone)
        : new Date(nextMs);
      hour = localDate.getHours();
      minute = localDate.getMinutes();
    }
  }
  const label = buildScheduleLabel(opts.id);
  const logFile = path.join(opts.logsDir, 'scheduler.log');

  const pathList = Array.from(
    new Set(
      [
        path.dirname(process.execPath),
        ...(opts.extraBins ?? []),
        ...(process.env.PATH ? process.env.PATH.split(path.delimiter) : []),
        path.join(os.homedir(), '.local', 'bin'),
        '/opt/homebrew/bin',
        '/usr/local/bin',
        '/usr/bin',
        '/bin',
        '/usr/sbin',
        '/sbin',
      ].filter(Boolean),
    ),
  ).join(':');

  const programArgs = [
    process.execPath,
    opts.cliScriptPath,
    '--root',
    opts.rootDir,
    'run',
    '-n',
    String(opts.itemCount),
    '--trigger',
    'schedule',
    '--schedule-id',
    opts.id,
  ];

  const argLines = programArgs.map((arg) => `      <string>${escapeXml(arg)}</string>`).join('\n');

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '  <dict>',
    '    <key>Label</key>',
    `    <string>${escapeXml(label)}</string>`,
    '    <key>ProgramArguments</key>',
    '    <array>',
    argLines,
    '    </array>',
    '    <key>WorkingDirectory</key>',
    `    <string>${escapeXml(opts.rootDir)}</string>`,
    '    <key>StartCalendarInterval</key>',
    '    <dict>',
    '      <key>Hour</key>',
    `      <integer>${hour}</integer>`,
    '      <key>Minute</key>',
    `      <integer>${minute}</integer>`,
    '    </dict>',
    '    <key>EnvironmentVariables</key>',
    '    <dict>',
    '      <key>PATH</key>',
    `      <string>${escapeXml(pathList)}</string>`,
    ...(opts.timezone
      ? ['      <key>TZ</key>', `      <string>${escapeXml(opts.timezone)}</string>`]
      : []),
    '    </dict>',
    '    <key>StandardOutPath</key>',
    `    <string>${escapeXml(logFile)}</string>`,
    '    <key>StandardErrorPath</key>',
    `    <string>${escapeXml(logFile)}</string>`,
    '    <key>RunAtLoad</key>',
    '    <false/>',
    '  </dict>',
    '</plist>',
    '',
  ].join('\n');
}

/** 创建默认调用系统 `launchctl` 的执行函数 */
function createDefaultLaunchctlExec(): LaunchctlExecutor {
  return async (args: string[]) => {
    const res = await execa('launchctl', args, { reject: false });
    return { exitCode: res.exitCode ?? 1, stderr: res.stderr ?? '' };
  };
}

/** 创建定时任务管理服务实例，支持注入自定义启动代理目录与 `launchctl` 执行器以便测试 */
export function createSchedulerService(
  ctx: CoreContext,
  opts?: {
    launchAgentsDir?: string;
    launchctlExec?: LaunchctlExecutor;
    cliScriptPath?: string;
  },
): SchedulerService {
  const launchAgentsDir =
    opts?.launchAgentsDir ?? path.join(os.homedir(), 'Library', 'LaunchAgents');
  const launchctlExec = opts?.launchctlExec ?? createDefaultLaunchctlExec();

  const plistPathFor = (id: string): string =>
    path.join(launchAgentsDir, `${buildScheduleLabel(id)}.plist`);

  const domainTarget = (): string => {
    const uid = process.getuid?.();
    if (uid === undefined) {
      throw new Error('当前操作系统不支持按用户 UID 挂载 launchd 定时任务');
    }
    if (uid === 0) {
      throw new Error('不支持在 root 用户会话下自动安装个人 LaunchAgent 定时任务');
    }
    return `gui/${uid}`;
  };

  const collectExtraBins = (): string[] => {
    const dirs: string[] = [];
    const envPathDirs = process.env.PATH
      ? process.env.PATH.split(path.delimiter).filter(Boolean)
      : [];
    for (const cliCfg of Object.values(ctx.settings.clis)) {
      const bin = cliCfg.bin.trim();
      if (!bin) {
        continue;
      }
      if (bin.includes('/') || bin.includes('\\')) {
        dirs.push(path.dirname(bin));
      } else {
        for (const searchDir of [
          ...envPathDirs,
          path.join(os.homedir(), '.local', 'bin'),
          '/opt/homebrew/bin',
          '/usr/local/bin',
        ]) {
          if (fsSync.existsSync(path.join(searchDir, bin))) {
            dirs.push(searchDir);
          }
        }
      }
    }
    return dirs;
  };

  const isDaemonManaged = (): boolean =>
    isDaemonServiceInstalledForRoot(launchAgentsDir, ctx.paths.rootDir);

  const toScheduleJob = (row: ReturnType<typeof ctx.repos.schedules.list>[number]): ScheduleJob => {
    const installed = isDaemonManaged() ? row.enabled : fsSync.existsSync(plistPathFor(row.id));
    return ScheduleJobSchema.parse({
      ...row,
      installed,
      nextRunAt: computeNextScheduleRunAt(row.time, row.enabled, ctx.now(), ctx.settings.timezone),
    });
  };

  const syncSingleJob = async (
    row: ReturnType<typeof ctx.repos.schedules.list>[number],
  ): Promise<void> => {
    const plistPath = plistPathFor(row.id);
    const domain = domainTarget();

    // 统一守护进程已托管时不再额外挂载单条 launchd 配置，防止重复触发，仅清理旧配置并通知守护进程刷新
    if (isDaemonManaged()) {
      await launchctlExec(['bootout', domain, plistPath]).catch(() => ({
        exitCode: 0,
        stderr: '',
      }));
      await fs.rm(plistPath, { force: true }).catch(() => undefined);
      await notifyDaemonReload(ctx.paths);
      return;
    }

    // 先尝试卸载旧任务，未曾挂载时忽略返回错误
    await launchctlExec(['bootout', domain, plistPath]).catch(() => ({
      exitCode: 0,
      stderr: '',
    }));

    if (row.enabled) {
      const plistXml = buildLaunchAgentPlist({
        id: row.id,
        time: row.time,
        itemCount: row.itemCount,
        bgmFile: null,
        rootDir: ctx.paths.rootDir,
        logsDir: ctx.paths.logsDir,
        cliScriptPath: resolveCliScriptPath(ctx.paths.rootDir, opts?.cliScriptPath),
        extraBins: collectExtraBins(),
        timezone: ctx.settings.timezone,
        now: ctx.now(),
      });
      await writeFileAtomic(plistPath, plistXml, { mode: 0o644 });
      const res = await launchctlExec(['bootstrap', domain, plistPath]);
      if (res.exitCode !== 0) {
        await fs.rm(plistPath, { force: true }).catch(() => undefined);
        throw new Error(
          `向系统挂载定时任务失败 (${buildScheduleLabel(row.id)}): ${res.stderr.trim() || `退出码 ${res.exitCode}`}`,
        );
      }
    } else {
      await fs.rm(plistPath, { force: true });
    }
    await notifyDaemonReload(ctx.paths);
  };

  return {
    /** 查询全部定时任务，附带系统代理配置文件是否已安装与下次触发时间 */
    async list(): Promise<ScheduleJob[]> {
      return ctx.repos.schedules.list().map(toScheduleJob);
    },

    /** 新建定时任务（时间与每期条数均为必填）并写入挂载 launchd plist */
    async create(input: CreateScheduleInput): Promise<ScheduleJob> {
      const time = ScheduleTimeSchema.parse(input?.time);
      if (!Number.isInteger(input?.itemCount) || input.itemCount <= 0) {
        throw new RangeError(
          `新建定时任务必须显式指定正整数条数 itemCount，当前传入: ${String(input?.itemCount)}`,
        );
      }

      if (typeof input.bgmFile === 'string' && input.bgmFile.trim().length > 0) {
        throw new Error(
          '定时任务不支持独立指定背景音乐，系统将根据自动选定的主播匹配对应专属背景音乐',
        );
      }
      validateTemplateItemCount(ctx.settings, input.itemCount);
      const cutoffMode = ScheduleCutoffModeSchema.parse(input.cutoffMode ?? 'none');
      let maxAgeHours: number | null = null;
      if (cutoffMode === 'hours') {
        if (
          typeof input.maxAgeHours !== 'number' ||
          !Number.isInteger(input.maxAgeHours) ||
          input.maxAgeHours <= 0
        ) {
          throw new RangeError('按最近小时数过滤时必须填写正整数小时数 maxAgeHours');
        }
        maxAgeHours = input.maxAgeHours;
      } else if (input.maxAgeHours !== undefined && input.maxAgeHours !== null) {
        throw new RangeError('仅当新闻时间策略为 hours 时才允许设置 maxAgeHours');
      }

      const name = input.name?.trim() || `每日定时任务 ${time}`;
      const enabled = input.enabled ?? true;
      const id = `sched-${crypto.randomBytes(4).toString('hex')}`;
      const nowIso = ctx.now().toISOString();

      const created = ctx.repos.schedules.create({
        id,
        name,
        time,
        itemCount: input.itemCount,
        cutoffMode,
        maxAgeHours,
        bgmFile: null,
        enabled,
        now: nowIso,
      });

      try {
        await syncSingleJob(created);
      } catch (err) {
        // 若系统定时挂载失败，清除孤立数据库记录和半成品配置文件
        await fs.rm(plistPathFor(id), { force: true }).catch(() => undefined);
        ctx.repos.schedules.remove(id);
        throw err;
      }

      return toScheduleJob(created);
    },

    /** 修改已有定时任务的执行时间、条数或启停状态并同步到 launchd */
    async update(id: string, patch: UpdateSchedulePatch): Promise<ScheduleJob> {
      const existing = ctx.repos.schedules.getById(id);
      if (!existing) {
        throw new Error(`未找到定时任务: ${id}`);
      }

      const nextTime = patch.time !== undefined ? ScheduleTimeSchema.parse(patch.time) : undefined;
      if (
        patch.itemCount !== undefined &&
        (!Number.isInteger(patch.itemCount) || patch.itemCount <= 0)
      ) {
        throw new RangeError(`每期新闻条数必须为正整数，当前传入: ${String(patch.itemCount)}`);
      }
      if (typeof patch.bgmFile === 'string' && patch.bgmFile.trim().length > 0) {
        throw new Error(
          '定时任务不支持独立指定背景音乐，系统将根据自动选定的主播匹配对应专属背景音乐',
        );
      }
      if (patch.itemCount !== undefined) validateTemplateItemCount(ctx.settings, patch.itemCount);
      const nextName = patch.name !== undefined ? patch.name.trim() : undefined;
      if (nextName !== undefined && !nextName) {
        throw new Error('定时任务名称不能为空');
      }

      const nextCutoffMode =
        patch.cutoffMode !== undefined
          ? ScheduleCutoffModeSchema.parse(patch.cutoffMode)
          : existing.cutoffMode;
      let nextMaxAgeHours: number | null | undefined;
      if (nextCutoffMode === 'hours') {
        const effectiveHours =
          patch.maxAgeHours !== undefined ? patch.maxAgeHours : existing.maxAgeHours;
        if (
          typeof effectiveHours !== 'number' ||
          !Number.isInteger(effectiveHours) ||
          effectiveHours <= 0
        ) {
          throw new RangeError('按最近小时数过滤时必须填写正整数小时数 maxAgeHours');
        }
        nextMaxAgeHours = effectiveHours;
      } else {
        if (
          patch.cutoffMode === undefined &&
          patch.maxAgeHours !== undefined &&
          patch.maxAgeHours !== null
        ) {
          throw new RangeError('仅当新闻时间策略为 hours 时才允许设置 maxAgeHours');
        }
        if (patch.cutoffMode !== undefined || patch.maxAgeHours !== undefined) {
          nextMaxAgeHours = null;
        }
      }

      const updated = ctx.repos.schedules.update(id, {
        name: nextName,
        time: nextTime,
        itemCount: patch.itemCount,
        ...(patch.cutoffMode !== undefined ? { cutoffMode: nextCutoffMode } : {}),
        ...(nextMaxAgeHours !== undefined ? { maxAgeHours: nextMaxAgeHours } : {}),
        bgmFile: patch.bgmFile,
        enabled: patch.enabled,
        now: ctx.now().toISOString(),
      });
      if (!updated) {
        throw new Error(`更新定时任务失败，未找到记录: ${id}`);
      }

      try {
        await syncSingleJob(updated);
      } catch (err) {
        // 系统同步失败时回滚数据库配置与原先的 launchd 状态
        ctx.repos.schedules.update(id, {
          name: existing.name,
          time: existing.time,
          itemCount: existing.itemCount,
          cutoffMode: existing.cutoffMode,
          maxAgeHours: existing.maxAgeHours ?? null,
          bgmFile: existing.bgmFile ?? null,
          enabled: existing.enabled,
          now: ctx.now().toISOString(),
        });
        await syncSingleJob(existing).catch(() => undefined);
        throw err;
      }
      return toScheduleJob(updated);
    },

    /** 删除定时任务记录并卸载移除对应的系统 launchd 配置文件 */
    async remove(id: string): Promise<void> {
      const existing = ctx.repos.schedules.getById(id);
      if (!existing) {
        throw new Error(`未找到定时任务: ${id}`);
      }
      const plistPath = plistPathFor(id);
      await launchctlExec(['bootout', domainTarget(), plistPath]).catch(() => ({
        exitCode: 0,
        stderr: '',
      }));
      await fs.rm(plistPath, { force: true });
      ctx.repos.schedules.remove(id);
      await notifyDaemonReload(ctx.paths);
    },

    /** 将数据库中的定时任务列表全量同步至系统调度器，并在守护进程接管时清理旧有单条配置 */
    async sync(): Promise<void> {
      const jobs = ctx.repos.schedules.list();
      const daemonManaged = isDaemonManaged();
      const activeIds = daemonManaged ? new Set<string>() : new Set(jobs.map((j) => j.id));

      for (const job of jobs) {
        await syncSingleJob(job);
      }

      // 清理属于当前仓库的无效或被守护进程接管的残留 plist 文件
      let entries: string[] = [];
      try {
        entries = await fs.readdir(launchAgentsDir);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          await notifyDaemonReload(ctx.paths);
          return;
        }
        throw err;
      }

      const expectedRootTag = `<string>${escapeXml(ctx.paths.rootDir)}</string>`;
      for (const fileName of entries) {
        const match = /^com\.aidaily\.schedule\.(.+)\.plist$/.exec(fileName);
        const schedId = match?.[1];
        if (!schedId || activeIds.has(schedId)) {
          continue;
        }
        const plistPath = path.join(launchAgentsDir, fileName);
        const xml = await fs.readFile(plistPath, 'utf8').catch(() => '');
        if (!xml.includes(expectedRootTag)) {
          continue;
        }
        await launchctlExec(['bootout', domainTarget(), plistPath]).catch(() => ({
          exitCode: 0,
          stderr: '',
        }));
        await fs.rm(plistPath, { force: true });
      }
      await notifyDaemonReload(ctx.paths);
    },
  };
}
