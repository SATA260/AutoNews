import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { QaReport } from '@aidaily/contracts';
import { createSilentTtsProvider, type SynthesizeRequest, type TtsProvider } from '@aidaily/tts';
import { execa } from 'execa';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createCore,
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
const envSnapshot = { ...process.env };

afterEach(async () => {
  process.env = { ...envSnapshot };
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

/** 构造带有足够正文长度的测试文章 HTML */
function buildArticleHtml(title: string, bodySentence: string): string {
  const body = `${bodySentence} `.repeat(16);
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body><article><h1>${title}</h1><p>${body}</p></article></body></html>`;
}

/** 构造故障演练使用的 RSS 与正文模拟请求函数 */
function createDrillFetch(opts: { nowFn: () => Date; shouldFail: () => boolean }): typeof fetch {
  return (async (input) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (opts.shouldFail()) {
      return new Response('Upstream Service Unavailable', { status: 500 });
    }
    const pubDate = opts.nowFn().toUTCString();
    if (url === 'https://drill-feed.example.com/rss.xml') {
      return new Response(
        `<?xml version="1.0" encoding="utf-8"?><rss version="2.0"><channel><title>Drill Feed</title><item><title>OpenAI 发布企业模型提速更新</title><link>https://drill-feed.example.com/story-1</link><pubDate>${pubDate}</pubDate><description>OpenAI announced faster enterprise inference.</description></item></channel></rss>`,
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
    return new Response('Not Found', { status: 404 });
  }) as typeof fetch;
}

/** 初始化隔离的故障演练工作区（包含 fake-agy、fake-biliup 与 solid-color 快速测试模板） */
async function setupDrillWorkspace() {
  await Promise.all([fs.chmod(FAKE_AGY_BIN, 0o755), fs.chmod(FAKE_BILIUP_BIN, 0o755)]);
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aidaily-m11-drill-'));
  tempDirs.push(rootDir);

  await fs.mkdir(path.join(rootDir, 'config'), { recursive: true });
  await fs.copyFile(
    path.join(REPO_ROOT, 'config', 'settings.yaml'),
    path.join(rootDir, 'config', 'settings.yaml'),
  );

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
        select: { retries: 0 },
        summarize: { retries: 0 },
        polish: { retries: 0 },
        factcheck: { retries: 0 },
        package: { retries: 0 },
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

describe('M11 fault recovery and resilience drills', () => {
  it('Drill 1: recovers from collect_all_failed after all feeds fail HTTP 500 and resume completes', async () => {
    const { rootDir } = await setupDrillWorkspace();
    let currentNow = new Date('2026-11-16T10:00:00.000Z');
    let feedsDown = true;

    const core = await createCore({
      rootDir,
      now: () => currentNow,
      fetchImpl: createDrillFetch({
        nowFn: () => currentNow,
        shouldFail: () => feedsDown,
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

    feedsDown = false;
    currentNow = new Date('2026-11-16T10:01:00.000Z');
    await core.tasks.resume(failedRunId);

    const recovered = await core.tasks.get(failedRunId);
    expect(recovered.status).toBe('awaiting_review');
    expect(recovered.items.some((it) => it.status === 'passed')).toBe(true);

    await core.close();
  }, 45_000);

  it('Drill 2: preserves collect/select checkpoints and reserved articles on agy auth_error, then resumes from edit cleanly', async () => {
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
    const core = await createCore({
      rootDir,
      now: () => nowDate,
      fetchImpl: createDrillFetch({ nowFn: () => nowDate, shouldFail: () => false }),
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

    await core.tasks.resume(runId);
    const detailAfterResume = await core.tasks.get(runId);
    expect(detailAfterResume.status).toBe('awaiting_review');
    expect(detailAfterResume.attempt).toBe(2);

    await core.close();
  }, 45_000);

  it('Drill 3: recovers from TtsProvider failure and reuses disk cache for previously synthesized sentences on resume', async () => {
    const { rootDir } = await setupDrillWorkspace();
    const nowDate = new Date('2026-11-16T10:00:00.000Z');

    const core = await createCore({
      rootDir,
      now: () => nowDate,
      fetchImpl: createDrillFetch({ nowFn: () => nowDate, shouldFail: () => false }),
    });

    const baseSilent = createSilentTtsProvider(core.config.getSettings().tts);
    let shouldFailSecondCall = true;
    let firstCachedText: string | null = null;
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

    const failedDetail = await core.tasks.get(runId);
    expect(failedDetail.status).toBe('failed');
    expect(failedDetail.stages.find((s) => s.stage === 'narrate')?.status).toBe('failed');

    shouldFailSecondCall = false;
    isSecondAttempt = true;
    await core.tasks.resume(runId);

    const resumedDetail = await core.tasks.get(runId);
    expect(resumedDetail.status).toBe('awaiting_review');
    expect(synthesizedCallsRun2).not.toContain(firstCachedText);
    expect(synthesizedCallsRun2.length).toBeGreaterThan(0);

    await core.close();
  }, 45_000);

  it('Drill 4: detects qa_failed on corrupted video and recovers cleanly via fromStage=render archiving prior outputs', async () => {
    const { rootDir } = await setupDrillWorkspace();
    const nowDate = new Date('2026-11-16T10:00:00.000Z');
    const core = await createCore({
      rootDir,
      now: () => nowDate,
      fetchImpl: createDrillFetch({ nowFn: () => nowDate, shouldFail: () => false }),
    });

    const { runId } = await core.tasks.start({ itemCount: 1, trigger: 'manual-cli' });
    expect((await core.tasks.get(runId)).status).toBe('awaiting_review');

    const videoPath = path.join(core.context.paths.runDir(runId), 'output', 'video.mp4');
    await execa('ffmpeg', [
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
    ]);

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

    await core.tasks.resume(runId, { fromStage: 'render' });
    const recovered = await core.tasks.get(runId);
    expect(recovered.status).toBe('awaiting_review');
    expect(recovered.artifacts.some((rel) => rel.startsWith('archive/'))).toBe(true);

    const qaReport = await readJsonOrNull<QaReport>(
      path.join(core.context.paths.runDir(runId), 'qa.json'),
    );
    expect(qaReport?.passed).toBe(true);

    await core.close();
  }, 60_000);

  it('Drill 5: keeps articles reserved on publish_failed and completes publish + consumption via retry', async () => {
    const { rootDir, biliStateFile } = await setupDrillWorkspace();
    const nowDate = new Date('2026-11-16T10:00:00.000Z');
    const core = await createCore({
      rootDir,
      now: () => nowDate,
      fetchImpl: createDrillFetch({ nowFn: () => nowDate, shouldFail: () => false }),
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
    expect((await core.tasks.get(runId)).status).toBe('publish_failed');

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

    await core.close();
  }, 45_000);

  it('Drill 6: blocks automatic retry on publish_uncertain and handles both manual confirmUncertain branches', async () => {
    const { rootDir, biliStateFile } = await setupDrillWorkspace();
    const nowDate = new Date('2026-11-16T10:00:00.000Z');
    const core = await createCore({
      rootDir,
      now: () => nowDate,
      fetchImpl: createDrillFetch({ nowFn: () => nowDate, shouldFail: () => false }),
    });

    const { runId } = await core.tasks.start({ itemCount: 1, trigger: 'manual-cli' });
    await core.publish.getDraft(runId);

    core.context.repos.runs.updateStatus(runId, 'publishing', {
      currentStage: 'publish',
      pid: 999998,
      heartbeatAt: '2026-11-16T08:00:00.000Z',
    });

    const recovery = recoverStaleRuns(core.context);
    expect(recovery.uncertainPublishRunIds).toContain(runId);
    expect((await core.tasks.get(runId)).status).toBe('publish_uncertain');

    await expect(core.publish.retry(runId)).rejects.toThrow(/禁止自动重传/);

    // 分支 A：人工确认平台未收稿 -> 退回 publish_failed 并允许重试成功
    await core.publish.confirmUncertain(runId, { published: false });
    expect((await core.tasks.get(runId)).status).toBe('publish_failed');

    // 再测试分支 B：biliup 返回 0 但未输出 BV 号进入 publish_uncertain -> 补填 BV 号完成定案
    await fs.writeFile(biliStateFile, JSON.stringify({ mode: 'missing_bvid', calls: [] }), 'utf8');
    await expect(core.publish.retry(runId, { retryDelaysMs: [0, 0, 0] })).rejects.toMatchObject({
      code: 'publish_uncertain',
    });
    expect((await core.tasks.get(runId)).status).toBe('publish_uncertain');

    await core.publish.confirmUncertain(runId, { published: true, bvid: 'BV1UC411c7mE' });
    const confirmedDetail = await core.tasks.get(runId);
    expect(confirmedDetail.status).toBe('published');
    expect(confirmedDetail.publishRecord?.bvid).toBe('BV1UC411c7mE');

    const history = await core.publish.listHistory(20);
    expect(history.some((h) => h.runId === runId)).toBe(true);
    const articlesFinal = await core.tasks.getRunArticles(runId);
    expect(articlesFinal.some((a) => a.status === 'consumed')).toBe(true);

    await core.close();
  }, 45_000);

  it('Drill 7: transitions expired stopped runs past reservationHoldHours to abandoned and releases reserved articles to new', async () => {
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
    const core = await createCore({
      rootDir,
      now: () => new Date(clockMs),
      fetchImpl: createDrillFetch({ nowFn: () => new Date(clockMs), shouldFail: () => false }),
    });

    let runId = '';
    try {
      await core.tasks.start({
        itemCount: 1,
        trigger: 'manual-cli',
        onCreated: (id) => {
          runId = id;
        },
      });
    } catch {
      // 预期在总结步骤中断并保留文章占用
    }

    const beforeExpiry = await core.tasks.getRunArticles(runId);
    expect(beforeExpiry.length).toBeGreaterThan(0);
    expect(beforeExpiry.every((a) => a.status === 'reserved')).toBe(true);

    // 推进时钟超过默认 48 小时保留期
    clockMs += 49 * 3600_000;
    const expiryRecovery = recoverStaleRuns(core.context);
    expect(expiryRecovery.abandonedRunIds).toContain(runId);
    expect(expiryRecovery.releasedExpiredArticlesCount).toBeGreaterThan(0);

    expect((await core.tasks.get(runId)).status).toBe('abandoned');
    const afterExpiry = await core.tasks.getRunArticles(runId);
    expect(afterExpiry.every((a) => a.status === 'new' && a.reservedByRun === null)).toBe(true);

    await core.close();
  }, 45_000);
});
