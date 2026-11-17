import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Timeline } from '@aidaily/contracts';
import { probeAudioDurationMs, type TtsProvider, TtsService } from '@aidaily/tts';
import { execa } from 'execa';
import { afterEach, describe, expect, it } from 'vitest';
import {
  abandonRun,
  cancelRun,
  computeArticleId,
  createCore,
  createRun,
  executeRun,
  getRunRetryOptions,
  type PackageCheckpoint,
  type PipelineError,
  readJsonOrNull,
  recoverStaleRuns,
  resumeRun,
  retryRunItem,
  updateSettingsFile,
  updateSourcesFile,
} from '../src/index.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const FAKE_AGY_BIN = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'fake-agy.mjs',
);

const tempDirs: string[] = [];
const envSnapshot = { ...process.env };

afterEach(async () => {
  process.env = { ...envSnapshot };
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

function buildArticleHtml(title: string, bodySentence: string): string {
  const repeated = `${bodySentence} `.repeat(18);
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body><article><h1>${title}</h1><p>${repeated}</p></article></body></html>`;
}

async function setupWorkflowWorkspace(
  opts: {
    maxRevisions?: number;
    maxRounds?: number;
    reservationHoldHours?: number;
    itemConcurrency?: number;
    packageModel?: string;
  } = {},
): Promise<{ rootDir: string; scriptFile: string }> {
  await fs.chmod(FAKE_AGY_BIN, 0o755);
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aidaily-wf-'));
  tempDirs.push(rootDir);

  await fs.mkdir(path.join(rootDir, 'config'), { recursive: true });
  await fs.copyFile(
    path.join(REPO_ROOT, 'config', 'settings.yaml'),
    path.join(rootDir, 'config', 'settings.yaml'),
  );

  const settingsFile = path.join(rootDir, 'config', 'settings.yaml');
  await updateSettingsFile(settingsFile, {
    clis: {
      agy: {
        adapter: 'agy',
        bin: FAKE_AGY_BIN,
        extraArgs: [],
      },
    },
    issue: {
      itemConcurrency: opts.itemConcurrency ?? 2,
      refill: {
        maxRounds: opts.maxRounds ?? 2,
        useBackupSources: true,
        lookbackStepHours: 24,
        maxLookbackHours: 96,
      },
    },
    retry: {
      reservationHoldHours: opts.reservationHoldHours ?? 48,
    },
    editorial: {
      maxRevisions: opts.maxRevisions ?? 2,
    },
    ai: {
      stages: {
        select: { retries: 0 },
        summarize: { retries: 0 },
        polish: { retries: 0 },
        factcheck: { retries: 0 },
        package: {
          retries: 0,
          ...(opts.packageModel ? { model: opts.packageModel } : {}),
        },
      },
    },
  });

  await updateSourcesFile(path.join(rootDir, 'config', 'sources.yaml'), [
    {
      id: 'primary-feed',
      name: '主力资讯',
      lang: 'zh',
      tier: 1,
      kind: 'rss',
      pool: 'primary',
      url: 'https://primary.example.com/rss.xml',
      enabled: true,
    },
    {
      id: 'backup-feed',
      name: '备用资讯',
      lang: 'zh',
      tier: 2,
      kind: 'rss',
      pool: 'backup',
      url: 'https://backup.example.com/rss.xml',
      enabled: true,
    },
  ]);

  const scriptFile = path.join(rootDir, 'fake-agy-script.json');
  await fs.writeFile(scriptFile, JSON.stringify({ rules: [] }), 'utf8');
  process.env.FAKE_AGY_SCRIPT_FILE = scriptFile;

  return { rootDir, scriptFile };
}

function makeFeedMockFetch(
  primaryArticles: Array<{ slug: string; title: string; pubDate: string; body: string }>,
  backupArticles: Array<{ slug: string; title: string; pubDate: string; body: string }> = [],
): typeof fetch {
  return async (input) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url === 'https://primary.example.com/rss.xml') {
      const items = primaryArticles
        .map(
          (a) =>
            `<item><title>${a.title}</title><link>https://primary.example.com/${a.slug}</link><pubDate>${a.pubDate}</pubDate><description>${a.body.slice(0, 60)}</description></item>`,
        )
        .join('\n');
      return new Response(
        `<?xml version="1.0" encoding="utf-8"?><rss version="2.0"><channel>${items}</channel></rss>`,
        { status: 200 },
      );
    }
    if (url === 'https://backup.example.com/rss.xml') {
      const items = backupArticles
        .map(
          (a) =>
            `<item><title>${a.title}</title><link>https://backup.example.com/${a.slug}</link><pubDate>${a.pubDate}</pubDate><description>${a.body.slice(0, 60)}</description></item>`,
        )
        .join('\n');
      return new Response(
        `<?xml version="1.0" encoding="utf-8"?><rss version="2.0"><channel>${items}</channel></rss>`,
        { status: 200 },
      );
    }

    for (const a of primaryArticles) {
      if (url === `https://primary.example.com/${a.slug}`) {
        return new Response(buildArticleHtml(a.title, a.body), {
          status: 200,
          headers: { 'content-type': 'text/html; charset=utf-8' },
        });
      }
    }
    for (const a of backupArticles) {
      if (url === `https://backup.example.com/${a.slug}`) {
        return new Response(buildArticleHtml(a.title, a.body), {
          status: 200,
          headers: { 'content-type': 'text/html; charset=utf-8' },
        });
      }
    }
    return new Response('Not found', { status: 404 });
  };
}

const STUB_RENDER_QA = {
  render: async () => ({ rendered: true }),
  qa: async () => ({ passed: true }),
};

describe('editorial workflow, TTS timeline, interruption recovery, and retry engine', () => {
  it('routes old snapshots to their CLI and uses snapshotted HTTP and CLI routes together on retry', async () => {
    const { rootDir } = await setupWorkflowWorkspace();
    const now = new Date('2026-11-16T08:00:00.000Z');
    const articleId = computeArticleId('https://primary.example.com/item-route');
    const article = {
      slug: 'item-route',
      title: '国内团队发布支持本地部署的新模型',
      pubDate: 'Mon, 16 Nov 2026 07:30:00 GMT',
      body: '国内团队宣布推出新一代开源语言模型，用户可以在本地设备运行模型并生成文本。',
    };
    const feed = makeFeedMockFetch([article]);
    const requested: Array<{ url: string; model: string }> = [];
    const fixtureKey = 'mock-deepseek-key';
    const core = await createCore({
      rootDir,
      now: () => now,
      fetchImpl: async (input, init) => {
        const url = input.toString();
        if (!url.includes('gateway.test')) {
          return feed(input, init);
        }
        expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${fixtureKey}`);
        if (url.endsWith('/models')) {
          return Response.json({ data: [{ id: 'fixture-old' }, { id: 'fixture-new' }] });
        }
        const { model } = JSON.parse(init?.body as string) as { model: string };
        requested.push({ url, model });
        return Response.json({
          id: 'select-fixture',
          choices: [
            {
              finish_reason: 'stop',
              message: {
                content: JSON.stringify({
                  events: [
                    {
                      title: article.title,
                      articleIds: [articleId],
                      category: '开源模型',
                      entity: '国内团队',
                      score: 9,
                      publicAppeal: 8,
                      reason: '读者可在本地使用',
                      duplicateOfHistory: false,
                    },
                  ],
                }),
              },
            },
          ],
        });
      },
    });

    try {
      const legacyId = createRun(core.context, { itemCount: 1, trigger: 'manual-cli' });
      const legacy = structuredClone(core.context.settings);
      delete legacy.ai.providers;
      core.context.repos.runs.updateStatus(legacyId, 'queued', {
        configSnapshotJson: JSON.stringify(legacy),
      });
      await core.config.updateSettings({ clis: { agy: { bin: 'fixture-missing-agy' } } });
      await executeRun(core.context, legacyId, { stopAfterStage: 'select' });
      expect(await core.tasks.getLlmCalls(legacyId)).toEqual([
        expect.objectContaining({ cli: 'agy', status: 'ok' }),
      ]);
      abandonRun(core.context, legacyId);

      await fs.writeFile(path.join(core.context.paths.secretsDir, 'fixture-deepseek'), fixtureKey, {
        mode: 0o600,
      });
      await core.config.updateSettings({
        clis: { agy: { bin: FAKE_AGY_BIN } },
        ai: {
          providers: {
            fixture: {
              adapter: 'openai-compatible',
              protocol: 'chat-completions',
              baseUrl: 'https://old.gateway.test/v1',
              apiKeyFile: 'fixture-deepseek',
            },
          },
          stages: { select: { cli: 'fixture', model: 'fixture-old' } },
        },
      });
      expect(core.system.getModelRoutes()).toContain('fixture');
      expect(await core.system.listModels('fixture')).toEqual(['fixture-old', 'fixture-new']);
      const runId = createRun(core.context, { itemCount: 1, trigger: 'manual-web' });
      await executeRun(core.context, runId, { stopAfterStage: 'select' });

      await core.config.updateSettings({
        ai: {
          providers: { fixture: { baseUrl: 'https://new.gateway.test/v1' } },
          stages: { select: { model: 'fixture-new' } },
        },
      });
      await resumeRun(core.context, runId, { fromStage: 'select', stopAfterStage: 'edit' });
      await resumeRun(core.context, runId, {
        fromStage: 'select',
        stopAfterStage: 'select',
        useLatestConfig: true,
      });
      expect(requested).toEqual([
        { url: 'https://old.gateway.test/v1/chat/completions', model: 'fixture-old' },
        { url: 'https://old.gateway.test/v1/chat/completions', model: 'fixture-old' },
        { url: 'https://new.gateway.test/v1/chat/completions', model: 'fixture-new' },
      ]);
      const logs = await core.tasks.getLlmCalls(runId);
      expect(logs).toContainEqual(
        expect.objectContaining({ stage: 'summarize', cli: 'agy', status: 'ok' }),
      );
      const selectCall = logs.find(({ cli }) => cli === 'fixture');
      expect(selectCall?.logPath).toBeTruthy();
      if (selectCall) {
        expect(JSON.stringify(await core.tasks.getLlmCallLog(runId, selectCall.id))).not.toContain(
          fixtureKey,
        );
      }
      const snapshot = core.context.repos.runs.getById(runId)?.configSnapshotJson;
      expect(snapshot).toContain('fixture-deepseek');
      expect(snapshot).not.toContain(fixtureKey);
    } finally {
      await core.close();
    }
  });

  it('runs end-to-end collect through narrate with accurate ffprobe timeline and LLM logs', async () => {
    const { rootDir, scriptFile } = await setupWorkflowWorkspace();
    const now = new Date('2026-11-16T08:00:00.000Z');

    const mockFetch = makeFeedMockFetch([
      {
        slug: 'openai-fast',
        title: 'OpenAI 发布轻量推理版本',
        pubDate: 'Mon, 16 Nov 2026 07:00:00 GMT',
        body: 'OpenAI 宣布推出全新轻量推理版本，响应速度比上代提升两倍，今日起向付费与常规用户陆续开放使用。',
      },
      {
        slug: 'google-coding',
        title: '谷歌升级代码生成助手',
        pubDate: 'Mon, 16 Nov 2026 06:30:00 GMT',
        body: '谷歌今日为开发者推出升级版代码生成助手，支持多文件上下文补全，目前已在公开网页版免费提供体验。',
      },
    ]);

    const core = await createCore({
      rootDir,
      fetchImpl: mockFetch,
      now: () => now,
    });

    const runId = createRun(core.context, { itemCount: 2, trigger: 'manual-cli' });
    await executeRun(core.context, runId, {
      stageOverrides: STUB_RENDER_QA,
    });

    const run = core.context.repos.runs.getById(runId);
    expect(run?.status).toBe('awaiting_review');

    const stages = core.context.repos.runStages.listByRun(runId);
    expect(stages.every((s) => s.status === 'done')).toBe(true);

    const runDir = core.context.paths.runDir(runId);
    const pkgCkpt = await readJsonOrNull<PackageCheckpoint>(
      path.join(runDir, 'stages', 'package.json'),
    );
    expect(pkgCkpt?.packageData.order).toHaveLength(2);

    const timeline = await readJsonOrNull<Timeline>(path.join(runDir, 'timeline.json'));
    expect(timeline).not.toBeNull();
    expect(timeline?.sections).toHaveLength(4); // intro + 2 items + outro

    for (const sec of timeline?.sections ?? []) {
      const wavPath = path.join(runDir, sec.audioFile);
      const actualMs = await probeAudioDurationMs(wavPath);
      expect(Math.abs(sec.speechMs - actualMs)).toBeLessThan(50);
    }

    const llmCalls = core.context.repos.llmCalls.listByRun(runId);
    expect(llmCalls.length).toBeGreaterThanOrEqual(8);
    expect(llmCalls.every((c) => c.status === 'ok' && Boolean(c.logPath))).toBe(true);

    // 验证切换自定义 TTS Provider 无需修改上游流程即可跑通
    let customSynthCount = 0;
    const customProvider: TtsProvider = {
      id: 'custom-mock',
      async healthcheck() {
        return { ok: true, detail: 'ok' };
      },
      async synthesize(req) {
        customSynthCount += 1;
        await execa('ffmpeg', [
          '-y',
          '-f',
          'lavfi',
          '-i',
          'sine=frequency=440:duration=0.3',
          '-ar',
          '48000',
          '-ac',
          '1',
          req.outFile,
        ]);
      },
    };
    const customTts = new TtsService({
      settings: {
        ...core.context.settings.tts,
        provider: 'custom-mock',
      },
      cacheDir: core.context.paths.ttsCacheDir,
      bridge: core.context.bridge,
    });
    customTts.register(customProvider);
    await updateSettingsFile(path.join(rootDir, 'config', 'settings.yaml'), {
      tts: { provider: 'custom-mock' },
    });

    const coreCustom = await createCore({
      rootDir,
      fetchImpl: mockFetch,
      tts: customTts,
      now: () => now,
    });
    await resumeRun(coreCustom.context, runId, {
      fromStage: 'narrate',
      useLatestConfig: true,
      stageOverrides: STUB_RENDER_QA,
    });
    expect(customSynthCount).toBeGreaterThan(0);

    // 确认 fake-agy 调用日志正常落地
    const callsRaw = await fs.readFile(`${scriptFile}.calls.jsonl`, 'utf8');
    expect(callsRaw).toContain('"stage":"select"');
    expect(callsRaw).toContain('"stage":"package"');

    await core.close();
    await coreCustom.close();
  });

  it('handles factcheck pass-override to revise, drop+reserve promotion, and backup refill', async () => {
    const { rootDir, scriptFile } = await setupWorkflowWorkspace({
      maxRevisions: 1,
      itemConcurrency: 1,
      maxRounds: 2,
    });
    const now = new Date('2026-11-16T10:00:00.000Z');

    // 主力仅有 2 篇：第 1 篇触发「pass 但 claims 含 unsupported -> 强制打回微调 -> 二轮通过」；
    // 第 2 篇被核查直接 drop 剔除，迫使协调器启用备用信源补抓第 3 篇完成补位。
    const mockFetch = makeFeedMockFetch(
      [
        {
          slug: 'ev-revise',
          title: '事件甲：支持局部测试的新工具',
          pubDate: 'Mon, 16 Nov 2026 09:00:00 GMT',
          body: '厂商公布新工具计划在部分内测白名单账号试运行，尚待后续公布全量开放计划。',
        },
        {
          slug: 'ev-drop',
          title: '事件乙：未经证实的硬件传闻',
          pubDate: 'Mon, 16 Nov 2026 08:30:00 GMT',
          body: '某论坛出现一段简短传闻消息，原文并未给出任何正式发布时间与可靠规格证明。',
        },
      ],
      [
        {
          slug: 'ev-backup',
          title: '备用补位：开源框架发布更新',
          pubDate: 'Mon, 16 Nov 2026 08:00:00 GMT',
          body: '社区开发者发布了新版开源推理框架，当前已可在公开代码仓库直接下载使用并查看文档。',
        },
      ],
    );

    await fs.writeFile(
      scriptFile,
      JSON.stringify({
        rules: [
          {
            stage: 'factcheck',
            contains: ['事件甲'],
            actions: [
              // 第一次返回自相矛盾的 pass + unsupported，验证 core 强制改为 revise
              {
                output: {
                  verdict: 'pass',
                  claims: [
                    {
                      text: '当前用户已可使用',
                      status: 'unsupported',
                      note: '原文写的是仅限局部内测，不能写成普遍可用',
                    },
                  ],
                  revisionNotes: [],
                },
              },
              {
                output: {
                  verdict: 'pass',
                  claims: [{ text: '经核对与原文一致', status: 'supported', note: '一致' }],
                  revisionNotes: [],
                },
              },
            ],
          },
          {
            stage: 'factcheck',
            contains: ['事件乙'],
            actions: [
              {
                output: {
                  verdict: 'drop',
                  claims: [
                    { text: '核心内容无事实支撑', status: 'unsupported', note: '无可靠出处' },
                  ],
                  revisionNotes: [],
                  dropReason: 'no_reliable_evidence',
                },
              },
            ],
          },
        ],
      }),
      'utf8',
    );

    const core = await createCore({
      rootDir,
      fetchImpl: mockFetch,
      now: () => now,
    });

    const runId = createRun(core.context, { itemCount: 2, trigger: 'manual-cli' });
    await executeRun(core.context, runId, {
      stageOverrides: STUB_RENDER_QA,
    });

    const items = core.context.repos.runItems.listByRun(runId);
    const passed = items.filter((i) => i.status === 'passed');
    const dropped = items.filter((i) => i.status === 'dropped');
    expect(passed).toHaveLength(2);
    expect(dropped).toHaveLength(1);
    expect(dropped[0]?.dropReason).toBe('no_reliable_evidence');

    const revisedItem = passed.find((i) => i.revision === 1);
    expect(revisedItem).toBeDefined();

    // 验证独立核查提示词未泄露 SummaryDraft 专属字段
    const fcCalls = core.context.repos.llmCalls
      .listByRun(runId)
      .filter((c) => c.stage === 'factcheck');
    expect(fcCalls.length).toBeGreaterThanOrEqual(3);
    for (const fc of fcCalls) {
      if (fc.logPath) {
        const logJson = await fs.readFile(path.join(rootDir, fc.logPath), 'utf8');
        expect(logJson).not.toContain('availabilityNote');
      }
    }

    const events = core.context.repos.runEvents.listAfter(runId, 0, 200);
    expect(events.some((e) => e.type === 'refill')).toBe(true);

    // 验证备选与补抓均耗尽时抛出 insufficient_items
    const badRunId = createRun(core.context, { itemCount: 5, trigger: 'manual-cli' });
    await expect(
      executeRun(core.context, badRunId, { stageOverrides: STUB_RENDER_QA }),
    ).rejects.toMatchObject({
      name: 'PipelineError',
      code: 'insufficient_items',
    } satisfies Partial<PipelineError>);

    expect(core.context.repos.runs.getById(badRunId)?.errorCode).toBe('insufficient_items');
    await core.close();
  });

  it('supports resume from interruption, fromStage archiving, retryItem, useLatestConfig, and stale lock recovery', async () => {
    const { rootDir, scriptFile } = await setupWorkflowWorkspace({
      itemConcurrency: 1,
      reservationHoldHours: 12,
      packageModel: 'broken-package-model',
    });
    let currentTime = new Date('2026-11-16T08:00:00.000Z');

    const mockFetch = makeFeedMockFetch([
      {
        slug: 'item-a',
        title: '第一条：国产推理芯片公布进展',
        pubDate: 'Mon, 16 Nov 2026 07:30:00 GMT',
        body: '国产芯片团队宣布新一代推理卡进入量产测试，功耗较上一代下降三成并兼容主流开源框架。',
      },
      {
        slug: 'item-b',
        title: '第二条：语音交互助手开放下载',
        pubDate: 'Mon, 16 Nov 2026 07:00:00 GMT',
        body: '科技公司宣布桌面语音交互客户端已正式面向大众开放免费下载安装，支持跨设备同步记录。',
      },
    ]);

    // 让 package 阶段使用 broken-package-model 时报错，验证失败保留检查点并通过 useLatestConfig 修复继续
    await fs.writeFile(
      scriptFile,
      JSON.stringify({
        rules: [
          {
            stage: 'package',
            modelEquals: 'broken-package-model',
            actions: [{ mode: 'exit_error', error: 'Model broken-package-model unavailable' }],
          },
        ],
      }),
      'utf8',
    );

    const core = await createCore({
      rootDir,
      fetchImpl: mockFetch,
      now: () => currentTime,
    });

    const runId = createRun(core.context, { itemCount: 2, trigger: 'manual-web' });
    await expect(
      executeRun(core.context, runId, { stageOverrides: STUB_RENDER_QA }),
    ).rejects.toThrow();

    const failedRun = core.context.repos.runs.getById(runId);
    expect(failedRun?.status).toBe('failed');
    expect(failedRun?.retryDeadlineAt).not.toBeNull();

    // 验证预留文章仍然保持 reserved 且不允许跳过 package 直接从 narrate 开始
    const reservedCount = core.context.repos.articles
      .getByIds(core.context.repos.events.listByRun(runId).flatMap((e) => e.articleIds))
      .filter((a) => a.status === 'reserved').length;
    expect(reservedCount).toBe(2);

    const optsWhileFailed = getRunRetryOptions(core.context, runId);
    expect(optsWhileFailed.resumable).toBe(true);
    expect(optsWhileFailed.resumeFrom).toBe('package');
    expect(optsWhileFailed.allowedFromStages).toEqual(['collect', 'select', 'edit', 'package']);

    await expect(
      resumeRun(core.context, runId, { fromStage: 'narrate', stageOverrides: STUB_RENDER_QA }),
    ).rejects.toThrow(/仅允许从/);

    // 统计 resume 前的 edit 模型调用次数，确认续跑不会重复跑已完成阶段
    const callsBeforeResume = core.context.repos.llmCalls.listByRun(runId).length;

    await updateSettingsFile(path.join(rootDir, 'config', 'settings.yaml'), {
      ai: { stages: { package: { model: 'gemini-3.8-flash-high' } } },
    });

    await resumeRun(core.context, runId, {
      useLatestConfig: true,
      stageOverrides: STUB_RENDER_QA,
    });
    expect(core.context.repos.runs.getById(runId)?.status).toBe('awaiting_review');

    const callsAfterResume = core.context.repos.llmCalls.listByRun(runId);
    const addedCalls = callsAfterResume.slice(callsBeforeResume);
    expect(addedCalls.every((c) => c.stage === 'package')).toBe(true);
    expect(addedCalls[0]?.model).toBe('gemini-3.8-flash-high');

    // 验证单条重试 retryRunItem：重做第一条从 polish 开始，并自动重跑 package 及之后阶段且归档旧产物
    const firstItemId = core.context.repos.runItems.listByRun(runId)[0]?.id;
    expect(firstItemId).toBeDefined();
    if (!firstItemId) {
      return;
    }

    const callsBeforeRetryItem = callsAfterResume.length;
    await retryRunItem(core.context, runId, firstItemId, {
      fromStep: 'polish',
      stageOverrides: STUB_RENDER_QA,
    });
    expect(core.context.repos.runs.getById(runId)?.status).toBe('awaiting_review');

    const addedAfterItemRetry = core.context.repos.llmCalls
      .listByRun(runId)
      .slice(callsBeforeRetryItem);
    expect(addedAfterItemRetry.some((c) => c.stage === 'summarize')).toBe(false);
    expect(addedAfterItemRetry.some((c) => c.stage === 'polish')).toBe(true);
    expect(addedAfterItemRetry.some((c) => c.stage === 'factcheck')).toBe(true);
    expect(addedAfterItemRetry.some((c) => c.stage === 'package')).toBe(true);

    // 验证 archive 目录保留了被作废的旧检查点
    const archiveEntries = await fs.readdir(path.join(core.context.paths.runDir(runId), 'archive'));
    expect(archiveEntries.some((d) => d.endsWith('-package'))).toBe(true);

    // 验证从编辑阶段重跑会归档旧产物并从总结步骤重写所有条目，同时保留数据库历史版本供对比
    const versionsBeforeEditRerun = core.context.repos.runItems.listVersions(firstItemId).length;
    await resumeRun(core.context, runId, {
      fromStage: 'edit',
      stageOverrides: STUB_RENDER_QA,
    });
    expect(core.context.repos.runItems.listVersions(firstItemId).length).toBeGreaterThan(
      versionsBeforeEditRerun,
    );

    // 验证进程崩溃失联恢复与超时自动 abandoned 释放预留文章（同时不误杀 awaiting_review）
    const crashedRunId = createRun(core.context, { itemCount: 1, trigger: 'manual-cli' });
    core.context.repos.runs.updateStatus(crashedRunId, 'running', {
      currentStage: 'edit',
      pid: 999998,
      startedAt: currentTime.toISOString(),
      heartbeatAt: new Date(currentTime.getTime() - 120_000).toISOString(),
    });
    core.context.repos.runStages.markStage(crashedRunId, 'edit', 'running');
    core.context.repos.locks.upsertLock({
      name: 'pipeline',
      ownerRun: crashedRunId,
      pid: 999998,
      acquiredAt: currentTime.toISOString(),
      heartbeatAt: new Date(currentTime.getTime() - 120_000).toISOString(),
    });

    const recovery1 = recoverStaleRuns(core.context);
    expect(recovery1.interruptedRunIds).toContain(crashedRunId);
    expect(core.context.repos.runs.getById(crashedRunId)?.status).toBe('interrupted');
    expect(core.context.repos.locks.get('pipeline')).toBeNull();

    // 推进时钟超出 12 小时重试保留期限
    currentTime = new Date(currentTime.getTime() + 13 * 3600_000);
    const recovery2 = recoverStaleRuns(core.context);
    expect(recovery2.abandonedRunIds).toContain(crashedRunId);
    expect(core.context.repos.runs.getById(crashedRunId)?.status).toBe('abandoned');
    // 已出片待审核的 runId 不会被自动放弃
    expect(core.context.repos.runs.getById(runId)?.status).toBe('awaiting_review');

    // 验证主动 cancel + abandon 正常释放排队任务与预留文章
    const queuedRun = createRun(core.context, { itemCount: 1, trigger: 'manual-cli' });
    cancelRun(core.context, queuedRun);
    expect(core.context.repos.runs.getById(queuedRun)?.status).toBe('cancelled');
    abandonRun(core.context, queuedRun);
    expect(core.context.repos.runs.getById(queuedRun)?.status).toBe('abandoned');

    // 验证相同任务 ID 在不同存活进程间仍互斥，且误调释放不会删掉其他进程的锁
    const lockCheck1 = core.context.repos.locks.tryAcquire({
      name: 'pipeline',
      ownerRun: 'same-run',
      pid: process.pid,
      now: currentTime.toISOString(),
      staleMs: 60_000,
      isProcessAlive: () => true,
    });
    expect(lockCheck1.acquired).toBe(true);

    const lockCheck2 = core.context.repos.locks.tryAcquire({
      name: 'pipeline',
      ownerRun: 'same-run',
      pid: process.pid + 12345,
      now: currentTime.toISOString(),
      staleMs: 60_000,
      isProcessAlive: () => true,
    });
    expect(lockCheck2.acquired).toBe(false);

    // 传入其他进程号尝试释放不应删除当前存活进程持有的锁
    core.context.repos.locks.releaseLock('pipeline', 'same-run', process.pid + 12345);
    expect(core.context.repos.locks.get('pipeline')?.pid).toBe(process.pid);
    core.context.repos.locks.releaseLock('pipeline', 'same-run', process.pid);
    expect(core.context.repos.locks.get('pipeline')).toBeNull();

    // 验证缺失本地检查点文件时，可重试查询会自动将其识别为需从该步骤继续
    const qaCkpt = path.join(core.context.paths.runDir(runId), 'qa.json');
    await fs.rm(qaCkpt, { force: true });
    const optsMissingCkpt = getRunRetryOptions(core.context, runId);
    expect(optsMissingCkpt.resumeFrom).toBe('qa');

    await core.close();
  }, 30_000);
});
