import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildDaemonLaunchAgentPlist,
  createCore,
  evaluateDueSchedules,
  getGlobalCliStatus,
  installGlobalCli,
  type LaunchctlExecutor,
  resolveDefaultRepoRoot,
  startDaemonHost,
  uninstallGlobalCli,
  updateSettingsFile,
  type WebBackendLauncher,
  WebOnDemandProxy,
} from '../src/index.js';

const execFileAsync = promisify(execFile);
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const CLI_DIST_BIN = path.join(REPO_ROOT, 'apps', 'cli', 'dist', 'index.js');

const tempDirs: string[] = [];
const cleanupCallbacks: Array<() => Promise<void>> = [];
const envSnapshot = { ...process.env };

afterEach(async () => {
  process.env = { ...envSnapshot };
  for (const fn of cleanupCallbacks.splice(0).reverse()) {
    await fn().catch(() => undefined);
  }
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

/** 创建包含最小配置、网页构建标记及隔离调度目录的测试工作区 */
async function createIsolatedWorkspace(opts?: { withWebBuild?: boolean }) {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aidaily-daemon-'));
  tempDirs.push(rootDir);
  const launchAgentsDir = path.join(rootDir, 'LaunchAgents');
  const globalBinDir = path.join(rootDir, 'local-bin');
  await fs.mkdir(path.join(rootDir, 'config'), { recursive: true });
  await fs.mkdir(launchAgentsDir, { recursive: true });
  await fs.mkdir(globalBinDir, { recursive: true });
  await fs.copyFile(
    path.join(REPO_ROOT, 'config', 'settings.yaml'),
    path.join(rootDir, 'config', 'settings.yaml'),
  );
  await fs.copyFile(
    path.join(REPO_ROOT, 'config', 'sources.yaml'),
    path.join(rootDir, 'config', 'sources.yaml'),
  );
  await updateSettingsFile(path.join(rootDir, 'config', 'settings.yaml'), {
    clis: {
      biliup: { adapter: 'generic', bin: 'fixture-disabled-biliup', extraArgs: [] },
    },
    publish: {
      mode: 'manual-review',
      bilibili: { cookieFile: path.join(rootDir, 'test-bili-cookies.json') },
    },
  });
  if (opts?.withWebBuild) {
    const nextDir = path.join(rootDir, 'apps', 'web', '.next');
    await fs.mkdir(nextDir, { recursive: true });
    await fs.writeFile(path.join(nextDir, 'BUILD_ID'), 'test-build-id\n', 'utf8');
  }
  return { rootDir, launchAgentsDir, globalBinDir };
}

describe('root resolution, global CLI launcher, scheduler planning, lazy web proxy, and daemon service', () => {
  it('resolves repo root from AIDAILY_ROOT, cwd, or installation module fallback', async () => {
    const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aidaily-outside-'));
    tempDirs.push(outsideDir);

    delete process.env.AIDAILY_ROOT;
    expect(resolveDefaultRepoRoot({ cwd: path.join(REPO_ROOT, 'apps', 'web') })).toBe(REPO_ROOT);
    expect(
      resolveDefaultRepoRoot({
        cwd: outsideDir,
        moduleUrl: pathToFileURL(path.join(REPO_ROOT, 'packages', 'core', 'src', 'paths.ts')).href,
      }),
    ).toBe(REPO_ROOT);

    const { rootDir } = await createIsolatedWorkspace();
    expect(resolveDefaultRepoRoot({ cwd: outsideDir, envRoot: rootDir })).toBe(rootDir);
    expect(() => resolveDefaultRepoRoot({ cwd: outsideDir, envRoot: outsideDir })).toThrow(
      /AIDAILY_ROOT/,
    );
  });

  it('installs, executes from any cwd, rejects foreign binaries, and uninstalls global CLI', async () => {
    const { rootDir, globalBinDir } = await createIsolatedWorkspace();
    const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aidaily-run-cwd-'));
    tempDirs.push(outsideDir);

    const before = await getGlobalCliStatus({
      rootDir,
      binDir: globalBinDir,
      cliScriptPath: CLI_DIST_BIN,
      pathEnv: `/usr/bin:${globalBinDir}`,
    });
    expect(before.installed).toBe(false);
    expect(before.inPath).toBe(true);

    const installed = await installGlobalCli({
      rootDir,
      binDir: globalBinDir,
      cliScriptPath: CLI_DIST_BIN,
      pathEnv: `/usr/bin:${globalBinDir}`,
    });
    expect(installed.installed).toBe(true);
    expect(installed.managedBySelf).toBe(true);

    // 从项目外部无关目录执行全局包装脚本，应自动绑定到目标工作区而非报找不到根目录
    const { stdout } = await execFileAsync(installed.binPath, ['runs', '--json'], {
      cwd: outsideDir,
    });
    expect(JSON.parse(stdout)).toEqual([]);

    const unRes = await uninstallGlobalCli({ rootDir, binDir: globalBinDir });
    expect(unRes.removed).toBe(true);
    expect((await uninstallGlobalCli({ rootDir, binDir: globalBinDir })).removed).toBe(false);

    // 不允许覆盖非本项目创建的同名命令文件
    await fs.writeFile(path.join(globalBinDir, 'aidaily'), '#!/bin/sh\necho foreign\n', {
      mode: 0o755,
    });
    await expect(
      installGlobalCli({ rootDir, binDir: globalBinDir, cliScriptPath: CLI_DIST_BIN }),
    ).rejects.toThrow(/非本项目创建/);
  });

  it('plans due schedule triggers with missed catch-up window, creation baseline, and same-day dedup', () => {
    const timezone = 'Asia/Shanghai';
    // 2026-11-20 08:30 CST = 2026-11-20T00:30:00.000Z
    const baseJob = {
      id: 'sched-1',
      name: '每日早报',
      time: '08:30',
      itemCount: 5,
      bgmFile: null,
      enabled: true,
      lastTriggeredAt: null,
      createdAt: '2026-11-19T00:00:00.000Z',
      updatedAt: '2026-11-19T00:00:00.000Z',
    };

    // 1. 创建时间晚于当日 08:30（如当天 09:00 新建 08:30 计划）-> 不立即补跑，等待次日
    const createdLaterPlan = evaluateDueSchedules({
      schedules: [
        {
          ...baseJob,
          createdAt: '2026-11-20T01:00:00.000Z',
          updatedAt: '2026-11-20T01:00:00.000Z',
        },
      ],
      timezone,
      nowMs: Date.parse('2026-11-20T01:05:00.000Z'),
      triggeredSlots: {},
    });
    expect(createdLaterPlan.dueJobs).toHaveLength(0);
    expect(createdLaterPlan.nextRunAt).toBe('2026-11-21T00:30:00.000Z');

    // 2. 笔记本在 08:30 前合盖，09:15 开盖唤醒（距触发 45 分钟，在 2 小时宽限内）-> 触发补跑
    const catchUpPlan = evaluateDueSchedules({
      schedules: [baseJob],
      timezone,
      nowMs: Date.parse('2026-11-20T01:15:00.000Z'),
      triggeredSlots: { 'sched-old': '2026-11-19@08:30' },
    });
    expect(catchUpPlan.dueJobs).toHaveLength(1);
    expect(catchUpPlan.dueJobs[0]?.slotKey).toBe('2026-11-20@08:30');
    // 跨天历史槽位记录会被顺便清理
    expect(catchUpPlan.prunedTriggeredSlots).toEqual({});

    // 3. 同一槽位已被记录 -> 再次评估不重复触发
    const dedupPlan = evaluateDueSchedules({
      schedules: [baseJob],
      timezone,
      nowMs: Date.parse('2026-11-20T01:20:00.000Z'),
      triggeredSlots: { 'sched-1': '2026-11-20@08:30' },
    });
    expect(dedupPlan.dueJobs).toHaveLength(0);

    // 4. 超过宽限窗口（5 小时后 13:30）-> 不再补跑过期早晨计划
    const expiredPlan = evaluateDueSchedules({
      schedules: [baseJob],
      timezone,
      nowMs: Date.parse('2026-11-20T05:30:00.000Z'),
      triggeredSlots: {},
    });
    expect(expiredPlan.dueJobs).toHaveLength(0);
  });

  it('wakes web backend lazily on demand, preserves Host headers and open streams, and sleeps on idle', async () => {
    const { rootDir } = await createIsolatedWorkspace();
    let launchCount = 0;
    let stopCount = 0;
    const serversToClose: http.Server[] = [];

    const mockLauncher: WebBackendLauncher = async ({ port }) => {
      launchCount += 1;
      const launchNum = launchCount;
      const srv = http.createServer((req, res) => {
        if (req.url === '/stream') {
          res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
          res.write(': connected\n\n');
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            launchNum,
            host: req.headers.host,
            forwardedHost: req.headers['x-forwarded-host'],
          }),
        );
      });
      await new Promise<void>((resolve) => srv.listen(port, '127.0.0.1', () => resolve()));
      serversToClose.push(srv);
      return {
        port,
        pid: 9000 + launchNum,
        onExit: () => undefined,
        stop: async () => {
          stopCount += 1;
          await new Promise<void>((resolve) => {
            srv.close(() => resolve());
            srv.closeAllConnections?.();
          });
        },
      };
    };

    const proxy = new WebOnDemandProxy({
      rootDir,
      port: 0,
      idleTimeoutMs: 1_000,
      logFile: path.join(rootDir, 'storage', 'logs', 'web.log'),
      backendLauncher: mockLauncher,
    });
    cleanupCallbacks.push(async () => {
      await proxy.close();
      await Promise.all(
        serversToClose.map(
          (s) =>
            new Promise<void>((resolve) => {
              s.close(() => resolve());
              s.closeAllConnections?.();
            }),
        ),
      );
    });

    const bound = await proxy.listen();
    expect(launchCount).toBe(0);
    expect(proxy.getSnapshot().state).toBe('stopped');

    // 并发 3 个请求命中同一休眠态网关：合并为 1 次后端唤醒，并保留原始 Host 与 X-Forwarded-Host
    const baseUrl = `http://127.0.0.1:${bound.port}`;
    const responses = await Promise.all([
      fetch(`${baseUrl}/a`).then(
        (r) => r.json() as Promise<{ launchNum: number; host: string; forwardedHost: string }>,
      ),
      fetch(`${baseUrl}/b`).then(
        (r) => r.json() as Promise<{ launchNum: number; host: string; forwardedHost: string }>,
      ),
      fetch(`${baseUrl}/c`).then(
        (r) => r.json() as Promise<{ launchNum: number; host: string; forwardedHost: string }>,
      ),
    ]);
    expect(launchCount).toBe(1);
    expect(proxy.getSnapshot().state).toBe('running');
    expect(responses[0]?.host).toBe(`127.0.0.1:${bound.port}`);
    expect(responses[0]?.forwardedHost).toBe(`127.0.0.1:${bound.port}`);

    // 存在活跃 SSE 长连接时，持续超过闲置阈值（1 秒）也不会触发休眠
    const streamAbort = new AbortController();
    const streamRes = await fetch(`${baseUrl}/stream`, { signal: streamAbort.signal });
    const reader = streamRes.body?.getReader();
    await reader?.read();
    await new Promise((resolve) => setTimeout(resolve, 1_150));
    expect(stopCount).toBe(0);
    expect(await proxy.sleepIfIdle(false)).toBe(false);

    // 断开流并等待超过 1 秒闲置阈值 -> 自动休眠关闭后端并归零状态；再次访问无缝重新唤醒
    streamAbort.abort();
    await reader?.cancel().catch(() => undefined);
    await vi.waitFor(
      () => {
        expect(stopCount).toBe(1);
        expect(proxy.getSnapshot().state).toBe('stopped');
      },
      { timeout: 3_500 },
    );

    const secondWake = (await fetch(`${baseUrl}/wake-again`).then((r) => r.json())) as {
      launchNum: number;
    };
    expect(secondWake.launchNum).toBe(2);
    expect(launchCount).toBe(2);
  });

  it('installs launchd daemon plist without double-scheduling legacy jobs and restores them on uninstall', async () => {
    const { rootDir, launchAgentsDir, globalBinDir } = await createIsolatedWorkspace({
      withWebBuild: true,
    });
    const launchctlCalls: string[][] = [];
    const launchctlExec: LaunchctlExecutor = async (args) => {
      launchctlCalls.push(args);
      return { exitCode: 0, stderr: '' };
    };

    const core = await createCore({
      rootDir,
      launchAgentsDir,
      launchctlExec,
      cliScriptPath: CLI_DIST_BIN,
      daemonDeps: {
        daemonScriptPath: path.join(REPO_ROOT, 'packages', 'core', 'dist', 'daemon.mjs'),
        globalBinDir,
        spawnDaemonDetached: async () => undefined,
      },
    });
    cleanupCallbacks.push(() => core.close());

    // 先按无守护进程方式创建一个定时任务，生成单条 launchd plist
    const sched = await core.scheduler.create({
      name: '晨间AI播报',
      time: '08:00',
      itemCount: 4,
    });
    const legacyPlist = path.join(launchAgentsDir, `com.aidaily.schedule.${sched.id}.plist`);
    expect(await fs.readFile(legacyPlist, 'utf8')).toContain(sched.id);

    // 安装统一守护进程服务：应挂载 com.aidaily.daemon.plist 并清理旧的单条 plist 避免重复触发
    const installedStatus = await core.daemon.install({ webPort: 3456, webIdleTimeoutSec: 600 });
    expect(installedStatus.serviceInstalled).toBe(true);
    await expect(fs.access(legacyPlist)).rejects.toThrow();

    const daemonPlistXml = await fs.readFile(installedStatus.plistPath, 'utf8');
    expect(daemonPlistXml).toContain('<key>RunAtLoad</key>\n    <true/>');
    expect(daemonPlistXml).toContain('3456');
    expect(daemonPlistXml).toContain('600');

    // 在守护进程接管期间再新建第二个定时任务：不应写出单条 launchd plist，且仍显示已托管
    const sched2 = await core.scheduler.create({
      name: '晚间补充',
      time: '20:00',
      itemCount: 3,
    });
    expect(sched2.installed).toBe(true);
    await expect(
      fs.access(path.join(launchAgentsDir, `com.aidaily.schedule.${sched2.id}.plist`)),
    ).rejects.toThrow();
    expect(launchctlCalls.some((c) => c[0] === 'bootstrap')).toBe(true);

    // 卸载统一守护服务后，自动恢复启用中定时任务的独立 launchd 配置
    const unRes = await core.daemon.uninstall();
    expect(unRes.uninstalled).toBe(true);
    await expect(fs.access(installedStatus.plistPath)).rejects.toThrow();
    expect(await fs.readFile(legacyPlist, 'utf8')).toContain(sched.id);
    expect(
      await fs.readFile(
        path.join(launchAgentsDir, `com.aidaily.schedule.${sched2.id}.plist`),
        'utf8',
      ),
    ).toContain(sched2.id);
  });

  it('starts daemon host loop, runs due scheduled task once, and preserves plist formatting', async () => {
    const fixedNow = new Date('2026-11-20T00:30:05.000Z'); // Asia/Shanghai 08:30:05
    const { rootDir, launchAgentsDir } = await createIsolatedWorkspace();
    const core = await createCore({
      rootDir,
      launchAgentsDir,
      launchctlExec: async () => ({ exitCode: 0, stderr: '' }),
      now: () => fixedNow,
    });
    const job = await core.scheduler.create({
      name: '触发测试计划',
      time: '08:30',
      itemCount: 2,
      enabled: true,
    });
    // 调整创建和更新时间戳早于 08:30 使其落在当天待补触发窗口内
    core.context.db
      .prepare('UPDATE schedules SET created_at = ?, updated_at = ? WHERE id = ?')
      .run('2026-11-19T00:00:00.000Z', '2026-11-19T00:00:00.000Z', job.id);
    await core.close();

    const triggered: Array<{ id: string; time: string }> = [];
    const daemon = await startDaemonHost({
      rootDir,
      webEnabled: false,
      registerSignals: false,
      now: () => fixedNow.getTime(),
      maxSleepSliceMs: 1_000,
      triggerScheduleRunner: async (due) => {
        triggered.push({ id: due.job.id, time: due.job.time });
      },
    });
    cleanupCallbacks.push(() => daemon.stop());

    expect(triggered).toEqual([{ id: job.id, time: '08:30' }]);
    // 再次检查同一时刻不会重复触发
    await daemon.triggerCheckNow(true);
    expect(triggered).toHaveLength(1);

    const samplePlist = buildDaemonLaunchAgentPlist({
      rootDir,
      logsDir: path.join(rootDir, 'storage', 'logs'),
      daemonScriptPath: path.join(REPO_ROOT, 'packages', 'core', 'dist', 'daemon.mjs'),
      timezone: 'Asia/Shanghai',
      webEnabled: true,
      webHost: '127.0.0.1',
      webPort: 3000,
      webIdleTimeoutSec: 900,
    });
    expect(samplePlist).toContain('<key>KeepAlive</key>');
    expect(samplePlist).toContain('<key>AIDAILY_ROOT</key>');
  });

  it('reads updated settings.yaml right before triggering due schedule', async () => {
    const fixedNow = new Date('2026-11-20T00:30:05.000Z');
    const { rootDir, launchAgentsDir } = await createIsolatedWorkspace();
    const core = await createCore({
      rootDir,
      launchAgentsDir,
      launchctlExec: async () => ({ exitCode: 0, stderr: '' }),
      now: () => fixedNow,
    });
    const job = await core.scheduler.create({
      name: '实时配置触发测试',
      time: '08:30',
      itemCount: 2,
      enabled: true,
    });
    core.context.db
      .prepare('UPDATE schedules SET created_at = ?, updated_at = ? WHERE id = ?')
      .run('2026-11-19T00:00:00.000Z', '2026-11-19T00:00:00.000Z', job.id);
    await core.close();

    // 修改配置中的时区，使北京时间 08:30 的任务因最新时区不同而在触发前按新配置构建环境
    const { editSettingsFile } = await import('../src/index.js');
    await editSettingsFile(path.join(rootDir, 'config', 'settings.yaml'), (doc) => {
      doc.setIn(['clis', 'codex', 'bin'], '/custom/live-bin/codex');
    });

    const envs: NodeJS.ProcessEnv[] = [];
    const daemon = await startDaemonHost({
      rootDir,
      webEnabled: false,
      registerSignals: false,
      now: () => fixedNow.getTime(),
      maxSleepSliceMs: 1_000,
      triggerScheduleRunner: async (_due, env) => {
        envs.push(env);
      },
    });
    cleanupCallbacks.push(() => daemon.stop());

    expect(envs).toHaveLength(1);
    expect(envs[0]?.PATH).toContain('/custom/live-bin');
  });
});
