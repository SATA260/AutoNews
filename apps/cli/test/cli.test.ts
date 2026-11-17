import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  createCore,
  createRun,
  editSettingsFile,
  updateSettingsFile,
  updateSourcesFile,
} from '@aidaily/core';
import { afterEach, describe, expect, it } from 'vitest';
import { type CliIo, runCli } from '../src/index.js';

const execFileAsync = promisify(execFile);

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const FAKE_AGY_BIN = path.join(REPO_ROOT, 'packages', 'core', 'test', 'fixtures', 'fake-agy.mjs');
const FAKE_BILIUP_BIN = path.join(
  REPO_ROOT,
  'packages',
  'core',
  'test',
  'fixtures',
  'fake-biliup.mjs',
);
const CLI_DIST_BIN = path.join(REPO_ROOT, 'apps', 'cli', 'dist', 'index.js');

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

function createBufferedIo(): { io: CliIo; getOut: () => string; getErr: () => string } {
  let out = '';
  let err = '';
  return {
    io: {
      stdout: (text) => {
        out += text;
      },
      stderr: (text) => {
        err += text;
      },
    },
    getOut: () => out,
    getErr: () => err,
  };
}

async function startFixtureFeedServer(): Promise<string> {
  const pubDate = new Date().toUTCString();
  const body =
    'OpenAI released updated real-time developer tooling supporting 64000 context tokens globally. '.repeat(
      8,
    );
  const server = http.createServer((req, res) => {
    if (req.url === '/rss.xml') {
      res.writeHead(200, { 'Content-Type': 'application/rss+xml; charset=utf-8' });
      res.end(
        `<?xml version="1.0"?><rss version="2.0"><channel><title>CLI Test Feed</title><item><title>OpenAI 推出实时开发者新工具</title><link>${baseUrl}/item-1</link><pubDate>${pubDate}</pubDate><description>OpenAI released updated real-time tooling.</description></item></channel></rss>`,
      );
      return;
    }
    if (req.url === '/item-1') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(
        `<!doctype html><html><head><title>OpenAI 推出实时开发者新工具</title></head><body><article><h1>OpenAI 推出实时开发者新工具</h1><p>${body}</p></article></body></html>`,
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

async function setupCliWorkspace(feedBaseUrl: string) {
  await fs.chmod(FAKE_AGY_BIN, 0o755);
  await fs.chmod(FAKE_BILIUP_BIN, 0o755);

  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aidaily-cli-'));
  tempDirs.push(rootDir);

  await fs.mkdir(path.join(rootDir, 'config'), { recursive: true });
  await fs.mkdir(path.join(rootDir, 'Library', 'LaunchAgents'), { recursive: true });
  await fs.copyFile(
    path.join(REPO_ROOT, 'config', 'settings.yaml'),
    path.join(rootDir, 'config', 'settings.yaml'),
  );

  const biliStateFile = path.join(rootDir, 'bili-state.json');
  await fs.writeFile(
    biliStateFile,
    JSON.stringify({ mode: 'ok', bvid: 'BV1CL411P7a2', calls: [] }),
    'utf8',
  );
  process.env.FAKE_BILIUP_STATE_FILE = biliStateFile;
  process.env.HOME = rootDir;

  const tempSettingsPath = path.join(rootDir, 'config', 'settings.yaml');
  await editSettingsFile(tempSettingsPath, (doc) => {
    doc.setIn(['ai', 'providers'], {});
    doc.setIn(['tts', 'provider'], 'silent');
    doc.deleteIn(['issue', 'minScore']);
  });
  await updateSettingsFile(tempSettingsPath, {
    clis: {
      agy: { adapter: 'agy', bin: FAKE_AGY_BIN, extraArgs: [] },
      biliup: { adapter: 'generic', bin: FAKE_BILIUP_BIN, extraArgs: [] },
    },
    template: {
      active: 'solid-color',
    },
    ai: {
      stages: {
        select: { cli: 'agy', model: 'gemini-3.8-flash-high', retries: 0 },
        summarize: { cli: 'agy', model: 'gemini-3.8-flash-high', retries: 0 },
        polish: { cli: 'agy', model: 'gemini-3.8-flash-high', retries: 0 },
        factcheck: { cli: 'agy', model: 'gemini-4-carbon-high', retries: 0 },
        package: { cli: 'agy', model: 'gemini-3.8-flash-high', retries: 0 },
      },
    },
  });

  await updateSourcesFile(path.join(rootDir, 'config', 'sources.yaml'), [
    {
      id: 'cli-feed',
      name: 'CLI 测试信源',
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

  return { rootDir, biliStateFile };
}

describe('aidaily CLI commands, JSON output, streaming logs, and exit codes', () => {
  it('returns exit code 2 on missing/invalid arguments and supports --version binary check', async () => {
    const versionOut = await execFileAsync(process.execPath, [CLI_DIST_BIN, '--version']);
    expect(versionOut.stdout.trim()).toBe('0.1.0');

    // run 缺省 -n 或 -n <= 0 返回参数错误退出码 2
    const c1 = createBufferedIo();
    expect(await runCli(['run'], c1.io)).toBe(2);

    const c2 = createBufferedIo();
    expect(await runCli(['run', '-n', '0'], c2.io)).toBe(2);

    const cOverflow = createBufferedIo();
    expect(await runCli(['run', '-n', '9007199254740993'], cOverflow.io)).toBe(2);

    const cStatusEmpty = createBufferedIo();
    expect(await runCli(['runs', '--status', ','], cStatusEmpty.io)).toBe(2);

    // schedule create 缺省 --time 或 -n 返回退出码 2
    const c3 = createBufferedIo();
    expect(await runCli(['schedule', 'create', '-n', '5'], c3.io)).toBe(2);

    const c4 = createBufferedIo();
    expect(await runCli(['schedule', 'create', '--time', '09:00'], c4.io)).toBe(2);

    const c5 = createBufferedIo();
    expect(await runCli(['schedule', 'create', '--time', '99:99', '-n', '5'], c5.io)).toBe(2);

    // publish-confirm 同时缺少或同时传入两个互斥参数返回退出码 2
    const c6 = createBufferedIo();
    expect(await runCli(['publish-confirm', '20261116-0001-aaaa'], c6.io)).toBe(2);

    const c7 = createBufferedIo();
    expect(
      await runCli(
        ['publish-confirm', '20261116-0001-aaaa', '--not-published', '--bvid', 'BV1XY4y1a7bC'],
        c7.io,
      ),
    ).toBe(2);
  });

  it('supports config, sources, schedule, models, and doctor with parseable --json output', async () => {
    const feedUrl = await startFixtureFeedServer();
    const { rootDir } = await setupCliWorkspace(feedUrl);

    // config get / set 动态切换模型并保留注释
    const setBuf = createBufferedIo();
    expect(
      await runCli(
        [
          '--root',
          rootDir,
          '--json',
          'config',
          'set',
          'ai.stages.polish.model',
          'gemini-3.8-flash-medium',
        ],
        setBuf.io,
      ),
    ).toBe(0);
    expect(JSON.parse(setBuf.getOut())).toMatchObject({
      path: 'ai.stages.polish.model',
      value: 'gemini-3.8-flash-medium',
    });

    const getBuf = createBufferedIo();
    expect(
      await runCli(
        ['config', 'get', 'ai.stages.polish.model', '--root', rootDir, '--json'],
        getBuf.io,
      ),
    ).toBe(0);
    expect(JSON.parse(getBuf.getOut())).toBe('gemini-3.8-flash-medium');

    // 访问数组 .length 必须被拒绝并返回退出码 2
    const getArrayLenBuf = createBufferedIo();
    expect(
      await runCli(
        ['config', 'get', 'publish.bilibili.defaultTags.length', '--root', rootDir],
        getArrayLenBuf.io,
      ),
    ).toBe(2);

    // models
    const modelsBuf = createBufferedIo();
    expect(await runCli(['--root', rootDir, 'models', '--json'], modelsBuf.io)).toBe(0);
    expect(JSON.parse(modelsBuf.getOut())).toMatchObject({
      cli: 'agy',
      models: ['gemini-4-carbon-high', 'gemini-3.8-flash-high', 'gemini-3.8-flash-medium'],
    });

    // sources & sources test
    const srcListBuf = createBufferedIo();
    expect(await runCli(['--root', rootDir, 'sources', '--json'], srcListBuf.io)).toBe(0);
    expect(JSON.parse(srcListBuf.getOut())).toHaveLength(1);

    const srcTestBuf = createBufferedIo();
    expect(
      await runCli(['--root', rootDir, 'sources', 'test', 'cli-feed', '--json'], srcTestBuf.io),
    ).toBe(0);
    expect(JSON.parse(srcTestBuf.getOut())).toMatchObject({
      sourceId: 'cli-feed',
      ok: true,
      itemCount: 1,
    });

    // schedule create (--disabled 不调用系统 launchctl bootstrap) / list / update / remove
    const schedCreateBuf = createBufferedIo();
    expect(
      await runCli(
        [
          '--root',
          rootDir,
          '--json',
          'schedule',
          'create',
          '--time',
          '09:15',
          '-n',
          '6',
          '--name',
          '测试定时',
          '--disabled',
        ],
        schedCreateBuf.io,
      ),
    ).toBe(0);
    const createdJob = JSON.parse(schedCreateBuf.getOut()) as {
      id: string;
      time: string;
      itemCount: number;
    };
    expect(createdJob.time).toBe('09:15');
    expect(createdJob.itemCount).toBe(6);

    const schedListBuf = createBufferedIo();
    expect(await runCli(['--root', rootDir, 'schedule', 'list', '--json'], schedListBuf.io)).toBe(
      0,
    );
    expect(JSON.parse(schedListBuf.getOut())).toHaveLength(1);

    const schedUpdBuf = createBufferedIo();
    expect(
      await runCli(
        ['--root', rootDir, 'schedule', 'update', createdJob.id, '-n', '8', '--json'],
        schedUpdBuf.io,
      ),
    ).toBe(0);
    expect(JSON.parse(schedUpdBuf.getOut())).toMatchObject({ itemCount: 8 });

    const schedRmBuf = createBufferedIo();
    expect(
      await runCli(
        ['--root', rootDir, 'schedule', 'remove', createdJob.id, '--json'],
        schedRmBuf.io,
      ),
    ).toBe(0);
    expect(JSON.parse(schedRmBuf.getOut())).toMatchObject({ removed: true });

    // doctor
    const docBuf = createBufferedIo();
    expect(await runCli(['--root', rootDir, 'doctor', '--json'], docBuf.io)).toBe(0);
    const docReport = JSON.parse(docBuf.getOut()) as {
      ok: boolean;
      checks: Array<{ name: string }>;
    };
    expect(docReport.ok).toBe(true);
    expect(docReport.checks.some((c) => c.name === 'node')).toBe(true);
  });

  it('streams foreground run events, inspects show/logs/review, consumes, and enforces LockBusyError exit codes', async () => {
    const feedUrl = await startFixtureFeedServer();
    const { rootDir } = await setupCliWorkspace(feedUrl);

    // 1. 前台运行并实时打印阶段日志
    const runBuf = createBufferedIo();
    expect(await runCli(['--root', rootDir, 'run', '-n', '1'], runBuf.io)).toBe(0);
    const stdoutText = runBuf.getOut();
    expect(stdoutText).toContain('开始执行阶段：collect');
    expect(stdoutText).toContain('成片制作与质检已全部完成');

    // runs --json 获取刚完成的 runId
    const runsBuf = createBufferedIo();
    expect(
      await runCli(
        ['--root', rootDir, 'runs', '--status', 'awaiting_review', '--json'],
        runsBuf.io,
      ),
    ).toBe(0);
    const runList = JSON.parse(runsBuf.getOut()) as Array<{ id: string; status: string }>;
    expect(runList).toHaveLength(1);
    const runId = runList[0]?.id ?? '';

    // show --items --json
    const showBuf = createBufferedIo();
    expect(await runCli(['--root', rootDir, 'show', runId, '--items', '--json'], showBuf.io)).toBe(
      0,
    );
    const showData = JSON.parse(showBuf.getOut()) as {
      id: string;
      items: Array<{ id: string }>;
      itemHistories: Array<{ itemId: string }>;
    };
    expect(showData.id).toBe(runId);
    expect(showData.items.length).toBeGreaterThan(0);
    expect(showData.itemHistories.length).toBeGreaterThan(0);

    // logs --json
    const logsBuf = createBufferedIo();
    expect(await runCli(['--root', rootDir, 'logs', runId, '--json'], logsBuf.io)).toBe(0);
    expect((JSON.parse(logsBuf.getOut()) as unknown[]).length).toBeGreaterThan(0);

    // review --json 与 retry-options --json
    const revBuf = createBufferedIo();
    expect(await runCli(['--root', rootDir, 'review', runId, '--json'], revBuf.io)).toBe(0);
    expect(JSON.parse(revBuf.getOut())).toMatchObject({ runId, aiDeclaration: true });

    const retryOptsBuf = createBufferedIo();
    expect(
      await runCli(['--root', rootDir, 'retry-options', runId, '--json'], retryOptsBuf.io),
    ).toBe(0);
    expect(JSON.parse(retryOptsBuf.getOut())).toMatchObject({ resumable: true });

    // approve --json 投稿 B 站成功
    const appBuf = createBufferedIo();
    expect(
      await runCli(
        [
          '--root',
          rootDir,
          'approve',
          runId,
          '--title',
          '命令行审核投稿标题',
          '--tags',
          'OpenAI,AI',
          '--json',
        ],
        appBuf.io,
      ),
    ).toBe(0);
    expect(JSON.parse(appBuf.getOut())).toMatchObject({
      runId,
      publishRecord: { status: 'published', bvid: 'BV1CL411P7a2' },
    });

    // 2. 验证持有活跃锁时：手动触发退出码 3，定时触发退出码 0
    const core = await createCore({ rootDir });
    const busyRunId = createRun(core.context, { itemCount: 1, trigger: 'manual-cli' });
    core.context.repos.locks.upsertLock({
      name: 'pipeline',
      ownerRun: busyRunId,
      pid: process.pid,
      acquiredAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString(),
    });
    await core.close();

    const manualLockBuf = createBufferedIo();
    expect(await runCli(['--root', rootDir, 'run', '-n', '1', '--json'], manualLockBuf.io)).toBe(3);
    expect(JSON.parse(manualLockBuf.getErr())).toMatchObject({ code: 3 });

    const schedLockBuf = createBufferedIo();
    expect(
      await runCli(
        ['--root', rootDir, 'run', '-n', '1', '--trigger', 'schedule', '--json'],
        schedLockBuf.io,
      ),
    ).toBe(0);
    expect(JSON.parse(schedLockBuf.getOut())).toMatchObject({ skipped: true });

    // 清理测试锁后再 abandon 占位任务
    const coreCleanup = await createCore({ rootDir });
    coreCleanup.context.repos.locks.releaseLock('pipeline', busyRunId, process.pid);
    await coreCleanup.close();

    const abandonBuf = createBufferedIo();
    expect(await runCli(['--root', rootDir, 'abandon', busyRunId, '--json'], abandonBuf.io)).toBe(
      0,
    );
    expect(JSON.parse(abandonBuf.getOut())).toMatchObject({ abandoned: true });
  }, 35_000);
});
