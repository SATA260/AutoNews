import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { QaReport } from '@aidaily/contracts';
import { createSilentTtsProvider, type SynthesizeRequest, type TtsProvider } from '@aidaily/tts';
import { execa } from 'execa';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type Core,
  createCore,
  editSettingsFile,
  type PipelineError,
  readJsonOrNull,
  recoverStaleRuns,
  updateSettingsFile,
  updateSourcesFile,
} from '../src/index.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const FAKE_AGY_BIN = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'fake-agy.mjs',
);
const FAKE_BILIUP_BIN = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'fake-biliup.mjs',
);

const tempDirs: string[] = [];
const activeCores: Core[] = [];
const TRACKED_ENV_KEYS = ['FAKE_AGY_SCRIPT_FILE', 'FAKE_BILIUP_STATE_FILE'] as const;
const savedEnv = new Map<string, string | undefined>(
  TRACKED_ENV_KEYS.map((key) => [key, process.env[key]]),
);

afterEach(async () => {
  for (const key of TRACKED_ENV_KEYS) {
    const prev = savedEnv.get(key);
    if (prev === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = prev;
    }
  }
  await Promise.all(activeCores.splice(0).map((core) => core.close().catch(() => undefined)));
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

/** 构造带有足够正文长度的测试文章 HTML */
function buildArticleHtml(title: string, bodySentence: string): string {
  const body = `${bodySentence} `.repeat(16);
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body><article><h1>${title}</h1><p>${body}</p></article></body></html>`;
}

/** 构造故障演练使用的 RSS 与正文模拟请求函数 */
function createDrillFetch(opts: {
  nowFn: () => Date;
  failMode: () => 'none' | 'network_error' | 'http_500';
  includeSecondStory?: () => boolean;
}): typeof fetch {
  return (async (input) => {
    const url = typeof input === 'string' ? input : input.toString();
    const mode = opts.failMode();
    if (mode === 'network_error') {
      throw new Error('模拟网络中断（ECONNREFUSED）');
    }
    if (mode === 'http_500') {
      return new Response('Upstream Service Unavailable', { status: 500 });
    }
    const pubDate = opts.nowFn().toUTCString();
    const storyTwoXml = opts.includeSecondStory?.()
      ? `<item><title>Anthropic 推出本地开发调试沙盒</title><link>https://drill-feed.example.com/story-2</link><pubDate>${pubDate}</pubDate><description>Anthropic launched a local developer sandbox.</description></item>`
      : '';
    if (url === 'https://drill-feed.example.com/rss.xml') {
      return new Response(
        `<?xml version="1.0" encoding="utf-8"?><rss version="2.0"><channel><title>Drill Feed</title><item><title>OpenAI 发布企业模型提速更新</title><link>https://drill-feed.example.com/story-1</link><pubDate>${pubDate}</pubDate><description>OpenAI announced faster enterprise inference.</description></item>${storyTwoXml}</channel></rss>`,
        { status: 200, headers: { 'content-type': 'application/rss+xml; charset=utf-8' } },
      );
    }
    if (url === 'https://drill-feed.example.com/story-1') {
      return new Response(
        buildArticleHtml(
          'OpenAI 发布企业模型提速更新',
          'OpenAI announced faster enterprise model inference benchmarks across production clusters with 2x throughput today.',
        ),
        { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } },
      );
    }
    if (url === 'https://drill-feed.example.com/story-2') {
      return new Response(
        buildArticleHtml(
          'Anthropic 推出本地开发调试沙盒',
          'Anthropic launched a local developer sandbox environment reducing integration debugging cycles by 50 percent today.',
        ),
        { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } },
      );
    }
    return new Response('Not Found', { status: 404 });
  }) as typeof fetch;
}

/** 初始化隔离的故障演练工作区（包含 fake-agy、fake-biliup 与 solid-color 快速测试模板） */
async function setupDrillWorkspace() {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aidaily-m11-drill-'));
  tempDirs.push(rootDir);

  await fs.mkdir(path.join(rootDir, 'config'), { recursive: true });
  await fs.copyFile(
    path.join(REPO_ROOT, 'config', 'settings.yaml'),
    path.join(rootDir, 'config', 'settings.yaml'),
  );

  await editSettingsFile(path.join(rootDir, 'config', 'settings.yaml'), (doc) => {
    doc.setIn(['ai', 'providers'], {});
  });
  await updateSettingsFile(path.join(rootDir, 'config', 'settings.yaml'), {
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
    publish: {
      mode: 'manual-review',
      bilibili: { tid: 231 },
    },
  });

  await updateSourcesFile(path.join(rootDir, 'config', 'sources.yaml'), [
    {
      id: 'drill-feed',
      name: '故障演练主信源',
      lang: 'en',
      tier: 1,
      kind: 'rss',
      pool: 'primary',
      url: 'https://drill-feed.example.com/rss.xml',
      enabled: true,
    },
  ]);

  const biliStateFile = path.join(rootDir, 'biliup-state.json');
  await fs.writeFile(
    biliStateFile,
    JSON.stringify({ mode: 'ok', bvid: 'BV1DR411c7mD', calls: [] }),
    'utf8',
  );
  process.env.FAKE_BILIUP_STATE_FILE = biliStateFile;

  return { rootDir, biliStateFile };
}

/** 打开并登记需要在单测清理阶段统一关闭的核心引擎实例 */
async function openDrillCore(opts: Parameters<typeof createCore>[0]): Promise<Core> {
  const core = await createCore(opts);
  activeCores.push(core);
  return core;
}

describe('M11 fault recovery and resilience drills', () => {
  it('Drill 1: recovers from collect_all_failed after network disconnect and emits run_failed + recovery events', async () => {
    const { rootDir } = await setupDrillWorkspace();
    let currentNow = new Date('2026-11-16T10:00:00.000Z');
    let failMode: 'none' | 'network_error' | 'http_500' = 'network_error';

    const core = await openDrillCore({
      rootDir,
      now: () => currentNow,
      fetchImpl: createDrillFetch({
        nowFn: () => currentNow,
        failMode: () => failMode,
      }),
    });

    let failedRunId = '';
    let caught: PipelineError | null = null;
    try {
      await core.tasks.start({
        itemCount: 1,
        trigger: 'manual-cli',
        onCreated: (id) => {
          failedRunId = id;
        },
      });
    } catch (err) {
      caught = err as PipelineError;
    }

    expect(caught?.code).toBe('collect_all_failed');
    expect(failedRunId).toBeTruthy();
    const afterFail = await core.tasks.get(failedRunId);
    expect(afterFail.status).toBe('failed');
    expect(afterFail.errorCode).toBe('collect_all_failed');
    const eventsAfterFail = await core.tasks.events(failedRunId, 0, 200);
    expect(eventsAfterFail.some((e) => e.type === 'run_failed')).toBe(true);

    failMode = 'none';
    currentNow = new Date('2026-11-16T10:01:00.000Z');
    await core.tasks.resume(failedRunId);

    const recovered = await core.tasks.get(failedRunId);
    expect(recovered.status).toBe('awaiting_review');
    expect(recovered.items.some((it) => it.status === 'passed')).toBe(true);
    const eventsAfterResume = await core.tasks.events(failedRunId, 0, 200);
    expect(eventsAfterResume.some((e) => e.type === 'retry_started')).toBe(true);
    expect(eventsAfterResume.some((e) => e.type === 'awaiting_review')).toBe(true);
  }, 45_000);

  it('Drill 2: preserves collect/select checkpoints and reserved articles on agy auth_error, then resumes from edit without re-calling select', async () => {
    const { rootDir } = await setupDrillWorkspace();
    const scriptFile = path.join(rootDir, 'fake-agy-script.json');
    await fs.writeFile(
      scriptFile,
      JSON.stringify({
        rules: [
          {
            stage: 'summarize',
            actions: [{ mode: 'auth_error' }, { passThrough: true }],
          },
        ],
      }),
      'utf8',
    );
    process.env.FAKE_AGY_SCRIPT_FILE = scriptFile;

    const nowDate = new Date('2026-11-16T10:00:00.000Z');
    const core = await openDrillCore({
      rootDir,
      now: () => nowDate,
      fetchImpl: createDrillFetch({ nowFn: () => nowDate, failMode: () => 'none' }),
    });

    let runId = '';
    let caught: PipelineError | null = null;
    try {
      await core.tasks.start({
        itemCount: 1,
        trigger: 'manual-cli',
        onCreated: (id) => {
          runId = id;
        },
      });
    } catch (err) {
      caught = err as PipelineError;
    }

    expect(caught?.code).toBe('llm_unavailable');
    const detailAfterFail = await core.tasks.get(runId);
    expect(detailAfterFail.status).toBe('failed');
    expect(detailAfterFail.stages.find((s) => s.stage === 'collect')?.status).toBe('done');
    expect(detailAfterFail.stages.find((s) => s.stage === 'select')?.status).toBe('done');
    expect(detailAfterFail.stages.find((s) => s.stage === 'edit')?.status).toBe('failed');

    const runArticles = await core.tasks.getRunArticles(runId);
    expect(runArticles.length).toBeGreaterThan(0);
    expect(runArticles.every((a) => a.status === 'reserved' && a.reservedByRun === runId)).toBe(
      true,
    );

    const retryOptions = await core.tasks.getRetryOptions(runId);
    expect(retryOptions.resumable).toBe(true);
    expect(retryOptions.resumeFrom).toBe('edit');

    const callsLogFile = `${scriptFile}.calls.jsonl`;
    const callsBeforeResumeCount = (await fs.readFile(callsLogFile, 'utf8'))
      .trim()
      .split('\n')
      .filter(Boolean).length;

    await core.tasks.resume(runId);
    const detailAfterResume = await core.tasks.get(runId);
    expect(detailAfterResume.status).toBe('awaiting_review');
    expect(detailAfterResume.attempt).toBe(2);
    expect(detailAfterResume.stages.find((s) => s.stage === 'collect')?.status).toBe('done');
    expect(detailAfterResume.stages.find((s) => s.stage === 'select')?.status).toBe('done');

    const callsAfterLines = (await fs.readFile(callsLogFile, 'utf8'))
      .trim()
      .split('\n')
      .filter(Boolean)
      .slice(callsBeforeResumeCount)
      .map((line) => JSON.parse(line) as { stage: string });
    expect(callsAfterLines.some((c) => c.stage === 'select')).toBe(false);
    expect(callsAfterLines.some((c) => c.stage === 'summarize')).toBe(true);

    const events = await core.tasks.events(runId, 0, 200);
    expect(events.some((e) => e.type === 'run_failed')).toBe(true);
    expect(events.some((e) => e.type === 'retry_started')).toBe(true);
  }, 45_000);

  it('Drill 3: recovers from TtsProvider failure and reuses disk cache for previously synthesized sentences on resume', async () => {
    const { rootDir } = await setupDrillWorkspace();
    const nowDate = new Date('2026-11-16T10:00:00.000Z');

    const core = await openDrillCore({
      rootDir,
      now: () => nowDate,
      fetchImpl: createDrillFetch({ nowFn: () => nowDate, failMode: () => 'none' }),
    });

    const baseSilent = createSilentTtsProvider(core.config.getSettings().tts);
    let shouldFailSecondCall = true;
    let firstCachedText: string | null = null;
    let failedSecondText: string | null = null;
    const synthesizedCallsRun1: string[] = [];
    const synthesizedCallsRun2: string[] = [];
    let isSecondAttempt = false;

    const faultProvider: TtsProvider = {
      id: 'silent',
      async synthesize(req: SynthesizeRequest) {
        if (!isSecondAttempt) {
          synthesizedCallsRun1.push(req.text);
          if (synthesizedCallsRun1.length === 1) {
            firstCachedText = req.text;
          }
          if (shouldFailSecondCall && synthesizedCallsRun1.length === 2) {
            failedSecondText = req.text;
            throw new Error('模拟外部 TTS 网关 502 超时');
          }
        } else {
          synthesizedCallsRun2.push(req.text);
        }
        await baseSilent.synthesize(req);
      },
      async healthcheck() {
        return { ok: true, detail: '演练可注入故障语音引擎就绪' };
      },
    };
    core.context.tts.register(faultProvider);

    let runId = '';
    let caught: PipelineError | null = null;
    try {
      await core.tasks.start({
        itemCount: 1,
        trigger: 'manual-cli',
        onCreated: (id) => {
          runId = id;
        },
      });
    } catch (err) {
      caught = err as PipelineError;
    }

    expect(caught?.code).toBe('tts_failed');
    expect(synthesizedCallsRun1.length).toBe(2);
    expect(firstCachedText).toBeTruthy();
    expect(failedSecondText).toBeTruthy();

    const cacheEntriesAfterFail = await fs.readdir(core.context.paths.ttsCacheDir);
    expect(cacheEntriesAfterFail.length).toBeGreaterThanOrEqual(1);

    const failedDetail = await core.tasks.get(runId);
    expect(failedDetail.status).toBe('failed');
    expect(failedDetail.stages.find((s) => s.stage === 'narrate')?.status).toBe('failed');

    shouldFailSecondCall = false;
    isSecondAttempt = true;
    await core.tasks.resume(runId);

    const resumedDetail = await core.tasks.get(runId);
    expect(resumedDetail.status).toBe('awaiting_review');
    expect(synthesizedCallsRun2).not.toContain(firstCachedText);
    expect(synthesizedCallsRun2).toContain(failedSecondText);

    const events = await core.tasks.events(runId, 0, 200);
    expect(events.some((e) => e.type === 'run_failed' && e.stage === 'narrate')).toBe(true);
    expect(events.some((e) => e.type === 'retry_started')).toBe(true);
  }, 45_000);

  it('Drill 4: detects qa_failed on corrupted video and recovers via fromStage=render archiving the broken mp4', async () => {
    const { rootDir } = await setupDrillWorkspace();
    const nowDate = new Date('2026-11-16T10:00:00.000Z');
    const core = await openDrillCore({
      rootDir,
      now: () => nowDate,
      fetchImpl: createDrillFetch({ nowFn: () => nowDate, failMode: () => 'none' }),
    });

    const { runId } = await core.tasks.start({ itemCount: 1, trigger: 'manual-cli' });
    expect((await core.tasks.get(runId)).status).toBe('awaiting_review');

    const videoPath = path.join(core.context.paths.runDir(runId), 'output', 'video.mp4');
    await execa(
      'ffmpeg',
      [
        '-y',
        '-f',
        'lavfi',
        '-i',
        'color=c=black:s=640x360:d=0.2',
        '-f',
        'lavfi',
        '-i',
        'anullsrc=r=48000:cl=mono:d=0.2',
        '-c:v',
        'libx264',
        '-c:a',
        'aac',
        videoPath,
      ],
      { timeout: 10_000 },
    );

    let qaErr: PipelineError | null = null;
    try {
      await core.tasks.resume(runId, { fromStage: 'qa' });
    } catch (err) {
      qaErr = err as PipelineError;
    }

    expect(qaErr?.code).toBe('qa_failed');
    const failedQaDetail = await core.tasks.get(runId);
    expect(failedQaDetail.status).toBe('failed');
    expect(failedQaDetail.errorCode).toBe('qa_failed');
    const failedQaReport = await readJsonOrNull<QaReport>(
      path.join(core.context.paths.runDir(runId), 'qa.json'),
    );
    expect(failedQaReport?.passed).toBe(false);

    await core.tasks.resume(runId, { fromStage: 'render' });
    const recovered = await core.tasks.get(runId);
    expect(recovered.status).toBe('awaiting_review');
    expect(
      recovered.artifacts.some((rel) =>
        /^archive\/attempt-\d+-render\/output\/video\.mp4$/.test(rel),
      ),
    ).toBe(true);

    const qaReport = await readJsonOrNull<QaReport>(
      path.join(core.context.paths.runDir(runId), 'qa.json'),
    );
    expect(qaReport?.passed).toBe(true);
    const events = await core.tasks.events(runId, 0, 200);
    expect(events.some((e) => e.type === 'run_failed' && e.stage === 'qa')).toBe(true);
    expect(events.some((e) => e.type === 'retry_started')).toBe(true);
  }, 90_000);

  it('Drill 5: keeps articles reserved on publish_failed cookie error and completes publish + consumption via retry', async () => {
    const { rootDir, biliStateFile } = await setupDrillWorkspace();
    const nowDate = new Date('2026-11-16T10:00:00.000Z');
    const core = await openDrillCore({
      rootDir,
      now: () => nowDate,
      fetchImpl: createDrillFetch({ nowFn: () => nowDate, failMode: () => 'none' }),
    });

    const { runId } = await core.tasks.start({ itemCount: 1, trigger: 'manual-cli' });
    await fs.writeFile(biliStateFile, JSON.stringify({ mode: 'fail', calls: [] }), 'utf8');

    let pubErr: PipelineError | null = null;
    try {
      await core.publish.approve(runId, { retryDelaysMs: [0, 0, 0] });
    } catch (err) {
      pubErr = err as PipelineError;
    }

    expect(pubErr?.code).toBe('publish_failed');
    const failedDetail = await core.tasks.get(runId);
    expect(failedDetail.status).toBe('publish_failed');
    expect(failedDetail.publishRecord?.error).toContain('Cookie');

    const recordedFailCalls = JSON.parse(await fs.readFile(biliStateFile, 'utf8')) as {
      calls: string[][];
    };
    expect(recordedFailCalls.calls.length).toBeGreaterThan(0);

    const articlesWhileFailed = await core.tasks.getRunArticles(runId);
    expect(articlesWhileFailed.some((a) => a.status === 'reserved')).toBe(true);
    expect(articlesWhileFailed.every((a) => a.status !== 'consumed')).toBe(true);

    await fs.writeFile(
      biliStateFile,
      JSON.stringify({ mode: 'ok', bvid: 'BV1DR411c7mD', calls: [] }),
      'utf8',
    );
    await core.publish.retry(runId, { retryDelaysMs: [0, 0, 0] });

    const afterRetry = await core.tasks.get(runId);
    expect(afterRetry.status).toBe('published');
    expect(afterRetry.publishRecord?.bvid).toBe('BV1DR411c7mD');

    const articlesAfterRetry = await core.tasks.getRunArticles(runId);
    expect(articlesAfterRetry.some((a) => a.status === 'consumed')).toBe(true);
    const events = await core.tasks.events(runId, 0, 200);
    expect(events.some((e) => e.type === 'publish_failed')).toBe(true);
    expect(events.some((e) => e.type === 'run_published')).toBe(true);
  }, 45_000);

  it('Drill 6: blocks auto-retry on publish_uncertain and completes both confirmUncertain branches', async () => {
    const { rootDir, biliStateFile } = await setupDrillWorkspace();
    let currentNow = new Date('2026-11-16T10:00:00.000Z');
    let enableStory2 = false;
    const core = await openDrillCore({
      rootDir,
      now: () => currentNow,
      fetchImpl: createDrillFetch({
        nowFn: () => currentNow,
        failMode: () => 'none',
        includeSecondStory: () => enableStory2,
      }),
    });

    // 分支 A：publishing 期间进程死亡 -> publish_uncertain -> 禁止直接重传 -> confirmUncertain(false) -> retry 成功
    const { runId: runAId } = await core.tasks.start({ itemCount: 1, trigger: 'manual-cli' });
    await core.publish.getDraft(runAId);

    core.context.repos.runs.updateStatus(runAId, 'publishing', {
      currentStage: 'publish',
      pid: 999998,
      heartbeatAt: '2026-11-16T08:00:00.000Z',
    });

    const recovery = recoverStaleRuns(core.context, { isProcessAliveFn: () => false });
    expect(recovery.uncertainPublishRunIds).toContain(runAId);
    expect((await core.tasks.get(runAId)).status).toBe('publish_uncertain');

    const articlesWhileUncertain = await core.tasks.getRunArticles(runAId);
    expect(articlesWhileUncertain.every((a) => a.status === 'reserved')).toBe(true);

    await expect(core.publish.retry(runAId)).rejects.toThrow(/禁止自动重传/);
    const callsAfterBlockedRetry = JSON.parse(await fs.readFile(biliStateFile, 'utf8')) as {
      calls: string[][];
    };
    expect(callsAfterBlockedRetry.calls).toHaveLength(0);

    await core.publish.confirmUncertain(runAId, { published: false });
    expect((await core.tasks.get(runAId)).status).toBe('publish_failed');

    await fs.writeFile(
      biliStateFile,
      JSON.stringify({ mode: 'ok', bvid: 'BV1AA411c7mA', calls: [] }),
      'utf8',
    );
    await core.publish.retry(runAId, { retryDelaysMs: [0, 0, 0] });
    expect((await core.tasks.get(runAId)).status).toBe('published');
    expect((await core.tasks.get(runAId)).publishRecord?.bvid).toBe('BV1AA411c7mA');
    expect((await core.tasks.getRunArticles(runAId)).some((a) => a.status === 'consumed')).toBe(
      true,
    );

    // 分支 B：启用第二条独立新闻，模拟退出码 0 但未解析到 BV 号 -> publish_uncertain -> 补填 BV 号直接完结并提交已播库
    enableStory2 = true;
    currentNow = new Date('2026-11-16T10:10:00.000Z');
    const { runId: runBId } = await core.tasks.start({ itemCount: 1, trigger: 'manual-cli' });
    await fs.writeFile(biliStateFile, JSON.stringify({ mode: 'missing_bvid', calls: [] }), 'utf8');
    await expect(core.publish.approve(runBId, { retryDelaysMs: [0, 0, 0] })).rejects.toMatchObject({
      code: 'publish_uncertain',
    });
    expect((await core.tasks.get(runBId)).status).toBe('publish_uncertain');

    await core.publish.confirmUncertain(runBId, { published: true, bvid: 'BV1UC411c7mE' });
    const confirmedDetail = await core.tasks.get(runBId);
    expect(confirmedDetail.status).toBe('published');
    expect(confirmedDetail.publishRecord?.bvid).toBe('BV1UC411c7mE');

    const history = await core.publish.listHistory(20);
    expect(history.some((h) => h.runId === runBId)).toBe(true);
    expect((await core.tasks.getRunArticles(runBId)).some((a) => a.status === 'consumed')).toBe(
      true,
    );
  }, 60_000);

  it('Drill 7: transitions expired retryable runs past reservationHoldHours to abandoned and releases articles to new', async () => {
    const { rootDir } = await setupDrillWorkspace();
    const scriptFile = path.join(rootDir, 'fake-agy-drill7.json');
    await fs.writeFile(
      scriptFile,
      JSON.stringify({
        rules: [{ stage: 'summarize', actions: [{ mode: 'auth_error' }] }],
      }),
      'utf8',
    );
    process.env.FAKE_AGY_SCRIPT_FILE = scriptFile;

    let clockMs = Date.parse('2026-11-16T10:00:00.000Z');
    const core = await openDrillCore({
      rootDir,
      now: () => new Date(clockMs),
      fetchImpl: createDrillFetch({ nowFn: () => new Date(clockMs), failMode: () => 'none' }),
    });

    let runId = '';
    let errCaught: PipelineError | null = null;
    try {
      await core.tasks.start({
        itemCount: 1,
        trigger: 'manual-cli',
        onCreated: (id) => {
          runId = id;
        },
      });
    } catch (err) {
      errCaught = err as PipelineError;
    }

    expect(errCaught?.code).toBe('llm_unavailable');
    expect((await core.tasks.get(runId)).status).toBe('failed');

    const beforeExpiry = await core.tasks.getRunArticles(runId);
    expect(beforeExpiry.length).toBeGreaterThan(0);
    expect(beforeExpiry.every((a) => a.status === 'reserved')).toBe(true);

    const holdHours = core.config.getSettings().retry.reservationHoldHours;
    clockMs += (holdHours + 1) * 3600_000;

    const expiryRecovery = recoverStaleRuns(core.context);
    expect(expiryRecovery.abandonedRunIds).toContain(runId);
    expect(expiryRecovery.releasedExpiredArticlesCount).toBeGreaterThan(0);

    expect((await core.tasks.get(runId)).status).toBe('abandoned');
    const afterExpiry = await core.tasks.getRunArticles(runId);
    expect(afterExpiry.every((a) => a.status === 'new' && a.reservedByRun === null)).toBe(true);

    const events = await core.tasks.events(runId, 0, 200);
    expect(events.some((e) => e.type === 'run_abandoned')).toBe(true);
  }, 45_000);

  it('Drill 8: marks crashed running process as interrupted with reserved articles intact and completes via resume', async () => {
    const { rootDir } = await setupDrillWorkspace();
    let clockMs = Date.parse('2026-11-16T10:00:00.000Z');
    const core = await openDrillCore({
      rootDir,
      now: () => new Date(clockMs),
      fetchImpl: createDrillFetch({ nowFn: () => new Date(clockMs), failMode: () => 'none' }),
    });

    const { runId } = await core.tasks.start({ itemCount: 1, trigger: 'manual-cli' });
    // 模拟重跑或运行在 edit 期间进程意外崩溃失联
    core.context.repos.runStages.markStage(runId, 'edit', 'running');
    core.context.repos.runs.updateStatus(runId, 'running', {
      currentStage: 'edit',
      pid: 999999,
      heartbeatAt: new Date(clockMs).toISOString(),
    });
    clockMs += 10 * 60_000;

    const rec = recoverStaleRuns(core.context, { isProcessAliveFn: () => false });
    expect(rec.interruptedRunIds).toContain(runId);
    expect((await core.tasks.get(runId)).status).toBe('interrupted');
    expect((await core.tasks.getRunArticles(runId)).every((a) => a.status === 'reserved')).toBe(
      true,
    );

    await core.tasks.resume(runId);
    expect((await core.tasks.get(runId)).status).toBe('awaiting_review');
  }, 45_000);
});
