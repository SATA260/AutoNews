import { ChildProcess } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RunEvent } from '@aidaily/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  computeNextScheduleRunAt,
  createCore,
  type LaunchctlExecutor,
  LockBusyError,
  type Notifier,
  type NotifyEvent,
  updateSettingsFile,
  updateSourcesFile,
} from '../src/index.js';
import { runWorkerMain } from '../src/worker/main.js';
import { confirmRetryStartup } from '../src/worker/retry-startup.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const FAKE_AGY_BIN = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'fake-agy.mjs',
);

const tempDirs: string[] = [];
const activeServers: http.Server[] = [];
const envSnapshot = { ...process.env };

afterEach(async () => {
  process.env = { ...envSnapshot };
  await Promise.all(
    activeServers.splice(0).map(
      (srv) =>
        new Promise<void>((resolve) => {
          srv.close(() => resolve());
        }),
    ),
  );
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

/** 提供本地信源，并允许测试统计订阅请求次数 */
async function startFixtureHttpServer(onFeedRequest?: () => void): Promise<string> {
  const pubDate = new Date().toUTCString();
  const body =
    'Anthropic announced enterprise deployment benchmarks for 200000 context tokens today in production clusters. '.repeat(
      8,
    );
  const server = http.createServer((req, res) => {
    if (req.url === '/rss.xml') {
      onFeedRequest?.();
      res.writeHead(200, { 'Content-Type': 'application/rss+xml; charset=utf-8' });
      res.end(
        `<?xml version="1.0"?><rss version="2.0"><channel><title>Fixture Feed</title><item><title>Anthropic 扩展企业上下文支持</title><link>${baseUrl}/story-1</link><pubDate>${pubDate}</pubDate><description>Anthropic announced enterprise deployment.</description></item></channel></rss>`,
      );
      return;
    }
    if (req.url === '/story-1') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(
        `<!doctype html><html><head><title>Anthropic 扩展企业上下文支持</title></head><body><article><h1>Anthropic 扩展企业上下文支持</h1><p>${body}</p></article></body></html>`,
      );
      return;
    }
    res.writeHead(404);
    res.end('Not found');
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });
  activeServers.push(server);
  const addr = server.address();
  if (!addr || typeof addr === 'string') {
    throw new Error('Failed to start fixture HTTP server');
  }
  const baseUrl = `http://127.0.0.1:${addr.port}`;
  return baseUrl;
}

async function setupServiceWorkspace(feedBaseUrl: string) {
  await fs.chmod(FAKE_AGY_BIN, 0o755);
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aidaily-m8-'));
  const launchAgentsDir = path.join(rootDir, 'launchAgents');
  tempDirs.push(rootDir);

  await fs.mkdir(path.join(rootDir, 'config'), { recursive: true });
  await fs.mkdir(launchAgentsDir, { recursive: true });
  await fs.copyFile(
    path.join(REPO_ROOT, 'config', 'settings.yaml'),
    path.join(rootDir, 'config', 'settings.yaml'),
  );

  await updateSettingsFile(path.join(rootDir, 'config', 'settings.yaml'), {
    clis: {
      agy: { adapter: 'agy', bin: FAKE_AGY_BIN, extraArgs: [] },
    },
    template: {
      active: 'solid-color',
    },
    ai: {
      stages: {
        select: { retries: 0 },
        summarize: { retries: 0 },
        polish: { retries: 0 },
        factcheck: { retries: 0 },
        package: { retries: 0 },
      },
    },
  });

  await updateSourcesFile(path.join(rootDir, 'config', 'sources.yaml'), [
    {
      id: 'fixture-feed',
      name: '测试资讯源',
      lang: 'en',
      tier: 1,
      kind: 'rss',
      pool: 'primary',
      url: `${feedBaseUrl}/rss.xml`,
      enabled: true,
    },
  ]);

  const scriptFile = path.join(rootDir, 'fake-script.json');
  await fs.writeFile(scriptFile, JSON.stringify({ rules: [] }), 'utf8');
  process.env.FAKE_AGY_SCRIPT_FILE = scriptFile;

  return { rootDir, launchAgentsDir };
}

describe('M8 services, detached worker, launchd scheduler, and doctor', () => {
  it('runs detached worker end-to-end, streams watch events, exposes artifacts safely, and enforces schedule skip on busy lock', async () => {
    const baseUrl = await startFixtureHttpServer();
    const { rootDir, launchAgentsDir } = await setupServiceWorkspace(baseUrl);
    const launchctlCalls: string[][] = [];
    const launchctlExec: LaunchctlExecutor = async (args) => {
      launchctlCalls.push(args);
      return { exitCode: 0, stderr: '' };
    };
    const notifications: NotifyEvent[] = [];
    const notifier: Notifier = {
      id: 'm8-test-notifier',
      async notify(ev) {
        notifications.push(ev);
      },
    };

    const core = await createCore({ rootDir, launchAgentsDir, launchctlExec, notifier });

    // 未显式填写正整数条数时必须拒绝启动（无默认值）
    await expect(core.tasks.start({ itemCount: 0 })).rejects.toThrow(/itemCount|正整数/);
    await expect(core.tasks.start({ itemCount: -2 })).rejects.toThrow(/itemCount|正整数/);

    // 先建一条定时任务以验证 scheduleId 触发回写 lastRunId / lastTriggeredAt
    const sched = await core.scheduler.create({
      name: '测试早报',
      time: '08:30',
      itemCount: 1,
    });
    expect(sched.installed).toBe(true);
    expect(sched.nextRunAt).toBeTruthy();
    expect(launchctlCalls.some((c) => c[0] === 'bootstrap')).toBe(true);

    // 使用真实后台工作进程 worker.mjs 分离运行整条生产流水线
    const { runId } = await core.tasks.start({
      itemCount: 1,
      trigger: 'schedule',
      scheduleId: sched.id,
      detach: true,
    });

    // 分离启动刚返回时运行锁已立即绑定子进程，并发重复启动必须立刻被拒绝且不留冗余 queued 行
    await expect(
      core.tasks.start({ itemCount: 1, trigger: 'manual-cli', detach: true }),
    ).rejects.toThrow(LockBusyError);
    expect(await core.tasks.list()).toHaveLength(1);

    const watchedEvents: RunEvent[] = [];
    const abortCtrl = new AbortController();
    const timeoutTimer = setTimeout(() => abortCtrl.abort(), 35_000);
    await core.tasks.watch(
      runId,
      (ev) => {
        watchedEvents.push(ev);
      },
      abortCtrl.signal,
      { pollMs: 100 },
    );
    clearTimeout(timeoutTimer);

    expect(watchedEvents.some((e) => e.type === 'stage_started' && e.stage === 'collect')).toBe(
      true,
    );
    expect(watchedEvents.some((e) => e.type === 'awaiting_review')).toBe(true);

    const detail = await core.tasks.get(runId);
    expect(detail.status).toBe('awaiting_review');
    expect(detail.scheduleId).toBe(sched.id);
    expect(detail.artifacts).toContain('output/video.mp4');
    expect(detail.artifacts).toContain('qa.json');
    expect(detail.artifacts).toContain('worker.log');

    // 验证定时任务已记录最近运行与触发时间
    const updatedSchedList = await core.scheduler.list();
    expect(updatedSchedList[0]?.lastRunId).toBe(runId);
    expect(updatedSchedList[0]?.lastTriggeredAt).toBeTruthy();

    // 验证辅助读方法及目录穿越防护
    expect(() => core.tasks.resolveArtifact(runId, '../../state.sqlite')).toThrow(/禁止访问/);
    expect(await core.tasks.readArtifactJson<{ passed: boolean }>(runId, 'qa.json')).toMatchObject({
      passed: true,
    });
    const runArticles = await core.tasks.getRunArticles(runId);
    expect(runArticles.length).toBeGreaterThan(0);
    expect(runArticles[0]?.contentText).toContain('Anthropic');
    const llmCalls = await core.tasks.getLlmCalls(runId);
    expect(llmCalls.length).toBeGreaterThan(0);
    const firstCallId = llmCalls[0]?.id;
    expect(firstCallId).toBeTypeOf('number');
    const firstLog =
      firstCallId !== undefined ? await core.tasks.getLlmCallLog(runId, firstCallId) : null;
    expect(firstLog).toBeTruthy();

    // 模拟锁被存活进程占用：手动触发抛 LockBusyError，定时触发记录 schedule_skipped 且 worker 以 0 退出
    core.context.repos.locks.upsertLock({
      name: 'pipeline',
      ownerRun: runId,
      pid: process.pid,
      acquiredAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString(),
    });

    await expect(core.tasks.start({ itemCount: 1, trigger: 'manual-cli' })).rejects.toThrow(
      LockBusyError,
    );
    await expect(
      core.tasks.start({ itemCount: 1, trigger: 'schedule', scheduleId: sched.id }),
    ).rejects.toThrow(LockBusyError);
    expect(notifications.some((n) => n.type === 'schedule_skipped')).toBe(true);

    await expect(
      runWorkerMain([
        '--root',
        rootDir,
        '--action',
        'start',
        '-n',
        '1',
        '--trigger',
        'schedule',
        '--schedule-id',
        sched.id,
      ]),
    ).resolves.toBeUndefined();
    expect(process.exitCode ?? 0).toBe(0);
    process.exitCode = undefined;

    core.context.repos.locks.releaseLock('pipeline', runId, process.pid);
    await core.close();
  }, 45_000);

  it('hands off reserved locks to detached retries and waits for confirmed startup', async () => {
    let feedRequests = 0;
    const baseUrl = await startFixtureHttpServer(() => {
      feedRequests += 1;
    });
    const { rootDir } = await setupServiceWorkspace(baseUrl);
    const core = await createCore({ rootDir });
    const settingsFile = path.join(rootDir, 'config', 'settings.yaml');
    const originalModel = core.context.settings.ai.stages.select.model;
    const nextModel = `${originalModel}-fixture`;
    const scriptFile = path.join(rootDir, 'fake-script.json');
    const selectError = '模拟选题服务不可用';
    const editError = '模拟总结服务不可用';

    try {
      await fs.writeFile(
        scriptFile,
        JSON.stringify({
          rules: [
            {
              stage: 'select',
              modelEquals: originalModel,
              actions: [{ mode: 'exit_error', error: selectError }],
            },
            { stage: 'summarize', actions: [{ mode: 'exit_error', error: editError }] },
          ],
        }),
      );

      const { runId } = await core.tasks.start({
        itemCount: 1,
        trigger: 'manual-web',
        detach: true,
      });
      /** 等候模拟模型错误落库和工作进程交还运行锁 */
      const waitForFailure = async (attempt: number, message: string) => {
        await vi.waitFor(
          () => {
            expect(core.context.repos.runs.getById(runId)).toMatchObject({
              attempt,
              status: 'failed',
              error: expect.stringContaining(message),
            });
            expect(core.context.repos.locks.get('pipeline')).toBeNull();
          },
          { timeout: 5_000 },
        );
      };
      await waitForFailure(1, selectError);
      const collectFile = path.join(core.context.paths.runDir(runId), 'stages', 'collect.json');
      const selectFile = path.join(core.context.paths.runDir(runId), 'stages', 'select.json');
      const collected = await fs.readFile(collectFile, 'utf8');

      // 工作进程配置加载失败时，父进程能拿到错误，并可继续尝试本期。
      const originalSettings = await fs.readFile(settingsFile, 'utf8');
      await fs.writeFile(settingsFile, 'invalid: true\n');
      try {
        await expect(
          core.tasks.resume(runId, { fromStage: 'select', detach: true }),
        ).rejects.toThrow('后台重试启动失败');
        await waitForFailure(1, selectError);
      } finally {
        await fs.writeFile(settingsFile, originalSettings);
      }

      await updateSettingsFile(settingsFile, { ai: { stages: { select: { model: nextModel } } } });
      const submissions = await Promise.allSettled([
        core.tasks.resume(runId, { detach: true }),
        core.tasks.resume(runId, { detach: true }),
      ]);
      expect(submissions.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(submissions).toContainEqual({
        status: 'rejected',
        reason: expect.objectContaining({
          message: expect.stringMatching(/已有任务正在执行|状态或执行轮次已变化/),
        }),
      });
      expect(await core.tasks.events(runId)).toContainEqual(
        expect.objectContaining({
          type: 'retry_started',
          stage: 'select',
          data: expect.objectContaining({ granularity: 'resume', attempt: 2 }),
        }),
      );
      await waitForFailure(2, selectError);

      // 指定阶段重跑归档旧产物，使用新配置完成选题，再由受控错误停在编辑阶段。
      await fs.writeFile(selectFile, '{}\n');
      await core.tasks.resume(runId, { fromStage: 'select', useLatestConfig: true, detach: true });
      expect(await core.tasks.events(runId)).toContainEqual(
        expect.objectContaining({
          type: 'retry_started',
          stage: 'select',
          data: expect.objectContaining({ granularity: 'stage', attempt: 3 }),
        }),
      );
      await waitForFailure(3, editError);
      expect(
        await fs.readFile(
          path.join(
            core.context.paths.runDir(runId),
            'archive',
            'attempt-3-select',
            'stages',
            'select.json',
          ),
          'utf8',
        ),
      ).toBe('{}\n');
      expect(
        (await core.tasks.getLlmCalls(runId))
          .filter((call) => call.stage === 'select')
          .map((call) => call.model),
      ).toEqual([originalModel, originalModel, nextModel]);

      const item = core.context.repos.runItems.listByRun(runId)[0];
      if (!item) {
        throw new Error('选题结束后缺少用于验证重试的新闻条目');
      }
      await core.tasks.retryItem(runId, item.id, { detach: true });
      expect(await core.tasks.events(runId)).toContainEqual(
        expect.objectContaining({
          type: 'retry_started',
          stage: 'edit',
          itemId: item.id,
          data: expect.objectContaining({ granularity: 'item', attempt: 4 }),
        }),
      );
      await waitForFailure(4, editError);
      expect(feedRequests).toBe(1);
      expect(await fs.readFile(collectFile, 'utf8')).toBe(collected);
    } finally {
      await core.close();
    }
  }, 20_000);

  it('releases the reservation on early exit and preserves it on confirmation timeout', async () => {
    const firstSend = vi.fn(() => true);
    const secondSend = vi.fn(() => true);
    const firstChild = Object.assign(new ChildProcess(), { pid: 123, send: firstSend });
    const secondChild = Object.assign(new ChildProcess(), { pid: 456, send: secondSend });
    const reserve = vi.fn();
    const release = vi.fn();

    vi.useFakeTimers();
    try {
      const exited = expect(confirmRetryStartup(firstChild, { reserve, release })).rejects.toThrow(
        '退出码 7',
      );
      firstChild.emit('message', { type: 'retry_waiting' });
      expect(firstSend).toHaveBeenCalledWith('retry_granted', expect.any(Function));
      firstChild.emit('exit', 7, null);
      await exited;
      expect(release).toHaveBeenCalledWith(123);

      const timedOut = expect(
        confirmRetryStartup(secondChild, { reserve, release }),
      ).rejects.toThrow('15 秒内未确认后台重试已启动');
      secondChild.emit('message', { type: 'retry_waiting' });
      expect(secondSend).toHaveBeenCalledWith('retry_granted', expect.any(Function));
      await vi.advanceTimersByTimeAsync(15_000);
      await timedOut;
      expect(reserve.mock.calls).toEqual([[123], [456]]);
      expect(release.mock.calls).toEqual([[123]]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('supports ConfigService YAML comment-preserving updates, SchedulerService CRUD/sync, and SystemService doctor', async () => {
    const baseUrl = await startFixtureHttpServer();
    const { rootDir, launchAgentsDir } = await setupServiceWorkspace(baseUrl);
    const launchctlCalls: string[][] = [];
    const launchctlExec: LaunchctlExecutor = async (args) => {
      launchctlCalls.push(args);
      return { exitCode: 0, stderr: '' };
    };

    const fixedNow = new Date('2026-11-16T00:00:00.000Z'); // 北京时间 08:00
    const core = await createCore({
      rootDir,
      launchAgentsDir,
      launchctlExec,
      now: () => fixedNow,
    });

    // 1. ConfigService 动态切换阶段模型并保留 YAML 注释
    const updatedSettings = await core.config.updateSettings({
      ai: { stages: { polish: { model: 'gemini-3.8-flash-medium' } } },
    });
    expect(updatedSettings.ai.stages.polish.model).toBe('gemini-3.8-flash-medium');
    expect(core.config.getSettings().ai.stages.polish.model).toBe('gemini-3.8-flash-medium');
    const rawSettings = await fs.readFile(path.join(rootDir, 'config', 'settings.yaml'), 'utf8');
    expect(rawSettings).toContain('#');

    // 2. SchedulerService 参数校验、plist 生成、launchd 同步与下次触发时间计算
    await expect(core.scheduler.create({ time: '25:00', itemCount: 5 })).rejects.toThrow(/HH:mm/);
    await expect(core.scheduler.create({ time: '09:00', itemCount: 0 })).rejects.toThrow(
      /itemCount|正整数/,
    );

    const job = await core.scheduler.create({
      name: '上午八点半',
      time: '08:30',
      itemCount: 6,
    });
    // 北京时间 08:00 之前创建 08:30 任务 -> 当天 08:30 CST = 00:30 UTC
    expect(job.nextRunAt).toBe('2026-11-16T00:30:00.000Z');
    const plistPath = path.join(launchAgentsDir, `com.aidaily.schedule.${job.id}.plist`);
    const plistXml = await fs.readFile(plistPath, 'utf8');
    expect(plistXml).toContain('<integer>8</integer>');
    expect(plistXml).toContain('<integer>30</integer>');
    expect(plistXml).toContain('apps/cli/dist/index.js');
    expect(plistXml).toContain(`<string>${job.id}</string>`);
    expect(launchctlCalls.some((c) => c[0] === 'bootstrap')).toBe(true);

    // 修改时间为当天已过的 07:00 CST -> 次日 07:00 CST = 前一天 UTC 23:00
    const nextDayIso = computeNextScheduleRunAt('07:00', true, fixedNow, 'Asia/Shanghai');
    expect(nextDayIso).toBe('2026-11-16T23:00:00.000Z');

    // 停用任务 -> 卸载并删除 plist
    const disabled = await core.scheduler.update(job.id, { enabled: false });
    expect(disabled.enabled).toBe(false);
    expect(disabled.installed).toBe(false);
    expect(disabled.nextRunAt).toBeNull();
    await expect(fs.access(plistPath)).rejects.toThrow();

    // 启用并测试 sync() 清理属于本仓库但库中已不存在的残留 plist
    await core.scheduler.update(job.id, { enabled: true });
    const orphanPlist = path.join(launchAgentsDir, 'com.aidaily.schedule.sched-orphan.plist');
    await fs.writeFile(
      orphanPlist,
      `<plist><dict><string>${rootDir}</string></dict></plist>`,
      'utf8',
    );
    await core.scheduler.sync();
    await expect(fs.access(orphanPlist)).rejects.toThrow();

    await core.scheduler.remove(job.id);
    expect(await core.scheduler.list()).toHaveLength(0);

    // 3. SystemService doctor 与 listModels
    const models = await core.system.listModels('agy');
    expect(models).toEqual([
      'gemini-4-carbon-high',
      'gemini-3.8-flash-high',
      'gemini-3.8-flash-medium',
    ]);

    const doctor = await core.system.doctor();
    expect(doctor.ok).toBe(true);
    expect(doctor.checks.find((c) => c.name === 'node')?.ok).toBe(true);
    expect(doctor.checks.find((c) => c.name === 'cli:agy')?.ok).toBe(true);
    expect(doctor.checks.find((c) => c.name === 'ffmpeg')?.ok).toBe(true);
    expect(doctor.checks.find((c) => c.name === 'ffprobe')?.ok).toBe(true);
    expect(doctor.checks.find((c) => c.name === 'playwright_chromium')?.ok).toBe(true);
    expect(doctor.checks.find((c) => c.name === 'tts:silent')?.ok).toBe(true);
    expect(doctor.checks.find((c) => c.name === 'disk_space')?.ok).toBe(true);

    await core.close();
  });
});
