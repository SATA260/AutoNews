import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Timeline } from '@aidaily/contracts';
import { probeAudioDurationMs, type TtsProvider, TtsService } from '@aidaily/tts';
import { execa } from 'execa';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  abandonRun,
  cancelRun,
  computeArticleId,
  createCore,
  createRun,
  editSettingsFile,
  executeRun,
  getRunRetryOptions,
  isEventOlderThanCutoff,
  normalizeTitle,
  type PackageCheckpoint,
  type PipelineError,
  readJsonOrNull,
  recoverStaleRuns,
  resumeRun,
  retryRunItem,
  retryRunItems,
  selectCandidateEvents,
  updateSettingsFile,
  updateSourcesFile,
} from '../src/index.js';
import { runNarrateStage } from '../src/media/narration.js';

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
  await editSettingsFile(settingsFile, (doc) => {
    doc.setIn(['ai', 'providers'], {});
    doc.setIn(['ai', 'channels'], []);
    doc.setIn(['publish', 'mode'], 'manual-review');
    doc.setIn(['publish', 'bilibili', 'cookieFile'], path.join(rootDir, 'test-bili-cookies.json'));
    doc.setIn(['tts', 'provider'], 'silent');
    doc.deleteIn(['issue', 'minScore']);
    doc.setIn(['issue', 'allowPartial'], false);
    doc.setIn(['editorial', 'compactStyle'], false);
    doc.setIn(['editorial', 'requireImageOptIn'], false);
  });
  await updateSettingsFile(settingsFile, {
    clis: {
      agy: {
        adapter: 'agy',
        bin: FAKE_AGY_BIN,
        extraArgs: [],
      },
      biliup: {
        adapter: 'generic',
        bin: 'fixture-disabled-biliup',
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
      channels: [],
      stages: {
        select: { mode: 'custom', cli: 'agy', model: 'gemini-3.8-flash-high', retries: 0 },
        summarize: { mode: 'custom', cli: 'agy', model: 'gemini-3.8-flash-high', retries: 0 },
        polish: { mode: 'custom', cli: 'agy', model: 'gemini-3.8-flash-high', retries: 0 },
        factcheck: { mode: 'custom', cli: 'agy', model: 'gemini-4-carbon-high', retries: 0 },
        package: {
          mode: 'custom',
          cli: 'agy',
          model: opts.packageModel ?? 'gemini-3.8-flash-high',
          retries: 0,
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
      await executeRun(core.context, legacyId, {
        stopAfterStage: 'select',
        useLatestConfig: false,
      });
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
          stages: { select: { mode: 'custom', cli: 'fixture', model: 'fixture-old' } },
        },
      });
      expect(core.system.getModelRoutes()).toContain('fixture');
      expect(await core.system.listModels('fixture')).toEqual(['fixture-old', 'fixture-new']);
      const runId = createRun(core.context, { itemCount: 1, trigger: 'manual-web' });
      await executeRun(core.context, runId, { stopAfterStage: 'select' });

      await core.config.updateSettings({
        ai: {
          providers: { fixture: { baseUrl: 'https://new.gateway.test/v1' } },
          stages: { select: { mode: 'custom', model: 'fixture-new' } },
        },
      });
      await resumeRun(core.context, runId, {
        fromStage: 'select',
        stopAfterStage: 'edit',
        useLatestConfig: false,
      });
      await resumeRun(core.context, runId, {
        fromStage: 'select',
        stopAfterStage: 'select',
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
  }, 30_000);

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
  }, 30_000);

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
    // 同一进程在同一任务已正式持锁后，二次调用 tryAcquire 也必须被拒绝，防止并发互相踩锁
    const sameProcessReentrant = core.context.repos.locks.tryAcquire({
      name: 'pipeline',
      ownerRun: 'same-run',
      pid: process.pid,
      now: currentTime.toISOString(),
      staleMs: 60_000,
      isProcessAlive: () => true,
    });
    expect(sameProcessReentrant.acquired).toBe(false);
    // 验证 releaseIfStale 不会误删存活进程的新锁
    expect(
      core.context.repos.locks.releaseIfStale({
        name: 'pipeline',
        expectedOwnerRun: 'same-run',
        expectedPid: 999999,
        now: currentTime.toISOString(),
        staleMs: 60_000,
        isProcessAlive: (pid) => pid === process.pid,
      }),
    ).toBe(false);
    core.context.repos.locks.releaseLock('pipeline', 'same-run', process.pid);
    expect(core.context.repos.locks.get('pipeline')).toBeNull();

    // 验证父进程 reserved 占位锁仅允许目标子进程认领一次，认领后再次并发仍拒接
    const reservedChildLock = core.context.repos.locks.tryAcquire({
      name: 'pipeline',
      ownerRun: 'child-run',
      pid: process.pid,
      now: currentTime.toISOString(),
      staleMs: 60_000,
      isProcessAlive: () => true,
      reserved: true,
    });
    expect(reservedChildLock.acquired).toBe(true);
    const childClaimOnce = core.context.repos.locks.tryAcquire({
      name: 'pipeline',
      ownerRun: 'child-run',
      pid: process.pid,
      now: currentTime.toISOString(),
      staleMs: 60_000,
      isProcessAlive: () => true,
    });
    expect(childClaimOnce.acquired).toBe(true);
    const childClaimTwice = core.context.repos.locks.tryAcquire({
      name: 'pipeline',
      ownerRun: 'child-run',
      pid: process.pid,
      now: currentTime.toISOString(),
      staleMs: 60_000,
      isProcessAlive: () => true,
    });
    expect(childClaimTwice.acquired).toBe(false);
    core.context.repos.locks.releaseLock('pipeline', 'child-run', process.pid);

    // 验证缺失本地检查点文件时，可重试查询会自动将其识别为需从该步骤继续
    const qaCkpt = path.join(core.context.paths.runDir(runId), 'qa.json');
    await fs.rm(qaCkpt, { force: true });
    const optsMissingCkpt = getRunRetryOptions(core.context, runId);
    expect(optsMissingCkpt.resumeFrom).toBe('qa');

    await core.close();
  }, 30_000);

  it('重跑选题时重新选择自动主播并保留手动主播', async () => {
    const { rootDir, scriptFile } = await setupWorkflowWorkspace();
    await updateSettingsFile(path.join(rootDir, 'config', 'settings.yaml'), {
      issue: { minScore: 7.5, allowPartial: true },
      editorial: { compactStyle: true, requireImageOptIn: true },
    });
    await fs.copyFile(
      path.join(REPO_ROOT, 'config', 'personas.yaml'),
      path.join(rootDir, 'config', 'personas.yaml'),
    );
    const article = {
      slug: 'choice',
      title: '人工智能产品更新',
      pubDate: 'Mon, 16 Nov 2026 09:00:00 GMT',
      body: '团队公布了新的人工智能进展，并介绍了适用范围。',
    };
    const core = await createCore({
      rootDir,
      now: () => new Date('2026-11-16T10:00:00.000Z'),
      fetchImpl: makeFeedMockFetch([article]),
    });
    const articleId = computeArticleId('https://primary.example.com/choice');
    const setSelection = async (entity: string) =>
      fs.writeFile(
        scriptFile,
        JSON.stringify({
          rules: [
            {
              stage: 'select',
              actions: [
                {
                  output: {
                    events: [
                      {
                        title: `${entity} 发布更新`,
                        articleIds: [articleId],
                        category: '人工智能',
                        entity,
                        score: 9,
                        publicAppeal: 9,
                        reason: '重要',
                        duplicateOfHistory: false,
                      },
                    ],
                  },
                },
              ],
            },
          ],
        }),
      );
    try {
      await setSelection('OpenAI');
      const automatic = createRun(core.context, { itemCount: 1 });
      await executeRun(core.context, automatic, { stopAfterStage: 'select' });
      expect(core.context.repos.runs.getById(automatic)?.hostId).toBe('gpt');
      await setSelection('Google');
      await resumeRun(core.context, automatic, { fromStage: 'select', stopAfterStage: 'select' });
      expect(core.context.repos.runs.getById(automatic)?.hostId).toBe('gemini');
      abandonRun(core.context, automatic);
      const manual = createRun(core.context, { itemCount: 1, hostId: 'claude' });
      await executeRun(core.context, manual, { stopAfterStage: 'select' });
      await resumeRun(core.context, manual, { fromStage: 'select', stopAfterStage: 'select' });
      expect(core.context.repos.runs.getById(manual)?.hostId).toBe('claude');
    } finally {
      await core.close();
    }
  }, 15_000);

  it('允许少于上限的新闻继续制作，并在没有重点新闻时跳过', async () => {
    const { rootDir } = await setupWorkflowWorkspace();
    await updateSettingsFile(path.join(rootDir, 'config', 'settings.yaml'), {
      issue: { minScore: 7.5, allowPartial: true },
      editorial: { compactStyle: true, requireImageOptIn: true },
    });
    await fs.copyFile(
      path.join(REPO_ROOT, 'config', 'personas.yaml'),
      path.join(rootDir, 'config', 'personas.yaml'),
    );
    const core = await createCore({
      rootDir,
      now: () => new Date('2026-11-16T10:00:00.000Z'),
      fetchImpl: makeFeedMockFetch([
        {
          slug: 'important',
          title: '重要人工智能进展',
          pubDate: 'Mon, 16 Nov 2026 09:00:00 GMT',
          body: '有关团队公布一项人工智能进展，并说明目前的使用范围。',
        },
      ]),
    });
    try {
      const runId = createRun(core.context, { itemCount: 5, trigger: 'manual-cli' });
      await executeRun(core.context, runId, { stopAfterStage: 'package' });
      const events = core.context.repos.events.listByRun(runId);
      expect(events.filter((event) => event.role === 'primary')).toHaveLength(1);
      expect(
        core.context.repos.runItems.listByRun(runId).filter((item) => item.status === 'passed'),
      ).toHaveLength(1);
      expect(core.context.repos.runs.getById(runId)?.hostId).toBe('gpt');
      expect(
        await fs.readFile(path.join(core.context.paths.runDir(runId), 'narration.txt'), 'utf8'),
      ).toContain('\n');
      const packageCheckpoint = await readJsonOrNull<PackageCheckpoint>(
        path.join(core.context.paths.runDir(runId), 'stages', 'package.json'),
      );
      expect(packageCheckpoint).not.toBeNull();
      if (!packageCheckpoint) throw new Error('缺少整期编排结果');
      const synthesize = vi
        .spyOn(core.context.tts, 'synthesizeSections')
        .mockImplementation(async (sections, outDir) =>
          sections.map((section) => ({
            key: section.key,
            file: path.join(outDir, `${section.key}.wav`),
            speechMs: section.kind === 'item' ? 60_001 : 120_001,
            sentences: section.sentences.map((text) => ({ text, offsetMs: 0, durationMs: 1 })),
          })),
        );
      try {
        const { timeline } = await runNarrateStage({
          ctx: core.context,
          runId,
          settings: core.context.settings,
          packageData: packageCheckpoint.packageData,
        });
        expect(timeline.totalMs).toBeGreaterThan(300_000);
        expect(
          timeline.sections.find((section) => section.kind === 'item')?.pageMs,
        ).toBeGreaterThan(60_000);
      } finally {
        synthesize.mockRestore();
      }
      const item = core.context.repos.runItems
        .listByRun(runId)
        .find((entry) => entry.status === 'passed');
      expect(item).toBeDefined();
      if (!item) throw new Error('缺少已过审条目');
      core.context.repos.runs.updateStatus(runId, 'awaiting_review');
      await core.tasks.setItemImage(runId, item.id, { mode: 'none' });
      expect(core.context.repos.runItems.getById(item.id)?.imageMode).toBe('none');
      await expect(
        core.tasks.setItemImage(runId, item.id, {
          mode: 'custom',
          data: Buffer.from('not an image'),
        }),
      ).rejects.toThrow();
      const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
      await core.tasks.setItemImage(runId, item.id, {
        mode: 'custom',
        data: png,
        caption: '官方图示',
      });
      const changed = core.context.repos.runItems.getById(item.id);
      expect(changed?.imageMode).toBe('custom');
      expect(changed?.customImageCaption).toBe('官方图示');
      expect(changed?.customImagePath).toMatch(/^custom-assets/);
      await expect(core.tasks.setBgm(runId, '../bad.mp3')).rejects.toThrow();
      const next = createRun(core.context, { itemCount: 5, trigger: 'manual-cli' });
      await executeRun(core.context, next);
      expect(core.context.repos.runs.getById(next)?.status).toBe('skipped');
      expect(
        core.context.repos.runStages.listByRun(next).find((stage) => stage.stage === 'narrate')
          ?.status,
      ).toBe('skipped');
    } finally {
      await core.close();
    }
  });

  it.skipIf(process.env.AIDAILY_QWEN_LIVE !== '1')(
    '以本地语音和视频模板生成隔离测试成片',
    async () => {
      const { rootDir } = await setupWorkflowWorkspace();
      await fs.cp(path.join(REPO_ROOT, 'assets'), path.join(rootDir, 'assets'), {
        recursive: true,
        filter: (src) => !src.startsWith(path.join(REPO_ROOT, 'assets', 'tts')),
      });
      await fs
        .symlink(path.join(REPO_ROOT, 'assets', 'tts'), path.join(rootDir, 'assets', 'tts'))
        .catch(() => undefined);
      await fs.copyFile(
        path.join(REPO_ROOT, 'config', 'personas.yaml'),
        path.join(rootDir, 'config', 'personas.yaml'),
      );
      await updateSettingsFile(path.join(rootDir, 'config', 'settings.yaml'), {
        issue: { minScore: 7.5, allowPartial: true },
        editorial: { compactStyle: true, requireImageOptIn: true },
        tts: { provider: 'qwen-local' },
        template: {
          active: 'daily-deck',
          registry: {
            'daily-deck': {
              dir: path.join(REPO_ROOT, 'templates', 'daily-deck'),
              adapter: 'daily-deck',
            },
          },
        },
      });
      const core = await createCore({
        rootDir,
        now: () => new Date('2026-11-16T10:00:00.000Z'),
        fetchImpl: makeFeedMockFetch([
          {
            slug: 'live-sample',
            title: '人工智能技术发布更新',
            pubDate: 'Mon, 16 Nov 2026 09:00:00 GMT',
            body: '有关团队公布一项人工智能进展，并说明目前的使用范围。',
          },
        ]),
      });
      try {
        const runId = createRun(core.context, { itemCount: 1, trigger: 'manual-cli' });
        await executeRun(core.context, runId);
        expect(core.context.repos.runs.getById(runId)?.status).toBe('awaiting_review');
        const qa = await core.tasks.readArtifactJson<{ passed: boolean }>(runId, 'qa.json');
        expect(qa?.passed).toBe(true);
        await fs.mkdir(path.join(REPO_ROOT, 'tmp'), { recursive: true });
        await fs.copyFile(
          path.join(core.context.paths.runDir(runId), 'output', 'video.mp4'),
          path.join(REPO_ROOT, 'tmp', '本地语音联调示例.mp4'),
        );
      } finally {
        await core.close();
      }
    },
    240_000,
  );

  it('supports concurrent multi-item revision, decoupled precheck repairs, evidence recovery, and batch retryItems', async () => {
    const { rootDir } = await setupWorkflowWorkspace({
      maxRevisions: 1,
      itemConcurrency: 3,
    });
    const now = new Date('2026-11-18T08:00:00.000Z');

    const articles = [
      {
        slug: 'item-1',
        title: '第一条：GPT\u20116 推出 440 亿美元规模计划',
        pubDate: 'Wed, 18 Nov 2026 07:00:00 GMT',
        body: 'OpenAI introduced GPT\u20116 across six countries with a $44 billion enterprise plan.',
      },
      {
        slug: 'item-2',
        title: '第二条：测试集覆盖 18.5 万真实样本',
        pubDate: 'Wed, 18 Nov 2026 06:30:00 GMT',
        body: 'Anthropic evaluated 185,000 developer tasks with 12 million context tokens.',
      },
      {
        slug: 'item-3',
        title: '第三条：团队公布 8.2B 参数轻量模型',
        pubDate: 'Wed, 18 Nov 2026 06:00:00 GMT',
        body: 'Google published an $8.2B cloud partnership spanning twenty-four regions.',
      },
    ];
    const feedFetch = makeFeedMockFetch(articles);
    const idBySlug = new Map(
      articles.map((a) => [a.slug, computeArticleId(`https://primary.example.com/${a.slug}`)]),
    );

    const metrics = {
      activeRevise: 0,
      peakRevise: 0,
      activeRetryPolish: 0,
      peakRetryPolish: 0,
      summarizeCount: 0,
      packageCount: 0,
      factcheckSawPriorContext: false,
      factcheckLeakedAvailabilityNote: false,
    };
    const itemRoundState = new Map<string, { precheckFix: number; fcRound: number }>();
    let phase: 'initial' | 'batchRetry' = 'initial';

    const core = await createCore({
      rootDir,
      now: () => now,
      fetchImpl: async (input, init) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (!url.includes('mock-ai.test')) {
          return feedFetch(input, init);
        }
        if (url.endsWith('/models')) {
          return Response.json({ data: [{ id: 'mock-model' }] });
        }
        const body = JSON.parse(String(init?.body ?? '{}')) as {
          messages?: Array<{ role: string; content: string }>;
        };
        const prompt = (body.messages ?? []).map((m) => m.content).join('\n');
        const stageMatch = /<!--stage:([a-zA-Z0-9_-]+)-->/.exec(prompt);
        const stage = stageMatch?.[1] ?? 'unknown';

        const emitJson = (obj: unknown) =>
          Response.json({
            id: `resp-${Date.now()}`,
            choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(obj) } }],
          });

        if (stage === 'select') {
          return emitJson({
            events: articles.map((a, idx) => ({
              title: a.title,
              articleIds: [idBySlug.get(a.slug) ?? ''],
              category: '大模型',
              entity: 'OpenAI',
              score: 9.5 - idx * 0.2,
              publicAppeal: 9,
              reason: '测试并发微调与预检解耦',
              duplicateOfHistory: false,
            })),
          });
        }

        if (stage === 'summarize') {
          metrics.summarizeCount += 1;
          const matchedArt =
            articles.find((a) => prompt.includes(idBySlug.get(a.slug) ?? '__missing__')) ??
            articles[0];
          if (!matchedArt) {
            throw new Error('测试文章列表为空');
          }
          const artId = idBySlug.get(matchedArt.slug) ?? '';
          const isFirst = matchedArt.slug === 'item-1';
          return emitJson({
            facts: [`原文说明：${matchedArt.title}`],
            relevance: '与产业应用密切相关。',
            availability: 'available_now',
            availabilityNote: '仅限特定区域接入，尚未面向全部用户免费开放。',
            evidence: [
              {
                claim: '核心事实出处',
                articleId: artId,
                // 第 1 条在总结故意产出一个损坏引文，验证本地预检与微调可顺利替换为原文合法引文而不陷入死循环
                quote: isFirst ? 'broken-nonexistent-quote-from-summary' : matchedArt.body,
              },
            ],
          });
        }

        const matchedArt =
          articles.find((a) => prompt.includes(idBySlug.get(a.slug) ?? '__missing__')) ??
          articles[0];
        if (!matchedArt) {
          throw new Error('测试文章列表为空');
        }
        const artId = idBySlug.get(matchedArt.slug) ?? '';

        if (stage === 'polish') {
          if (phase === 'batchRetry') {
            metrics.activeRetryPolish += 1;
            metrics.peakRetryPolish = Math.max(metrics.peakRetryPolish, metrics.activeRetryPolish);
            await new Promise((r) => setTimeout(r, 60));
            metrics.activeRetryPolish -= 1;
          }
          const shortTitle =
            matchedArt.slug === 'item-1'
              ? 'GPT-6规模计划'
              : matchedArt.slug === 'item-2'
                ? '18.5万样本评估'
                : '8.2B合作项目';
          return emitJson({
            title: matchedArt.title,
            shortTitle,
            progressLabel: '并发微调测试',
            category: '大模型',
            entity: 'OpenAI',
            summary:
              matchedArt.slug === 'item-1'
                ? 'GPT-6 推出 440 亿美元规模计划并覆盖 6 个国家。'
                : matchedArt.slug === 'item-2'
                  ? '评估测试集覆盖 18.5 万任务与 1200 万上下文词元。'
                  : '新合作项目资金规模达到 82 亿美元，覆盖 24 个地区。',
            keyPoints: ['信息已与原文对照', '数字换算符合规范'],
            detail: '本文主要报道相关团队发布的最新进度与覆盖规模说明。',
            hostComment: '这项进展的数据尺度值得关注。',
            narration: ['今天来看这条重要人工智能消息。', '具体细节请以官方原文披露为准。'],
            evidence: [
              {
                claim: '原文依据',
                articleId: artId,
                quote:
                  phase === 'initial' && matchedArt.slug === 'item-1'
                    ? 'still-broken-quote-from-polish'
                    : matchedArt.body,
              },
            ],
          });
        }

        if (stage === 'revise') {
          metrics.activeRevise += 1;
          metrics.peakRevise = Math.max(metrics.peakRevise, metrics.activeRevise);
          await new Promise((r) => setTimeout(r, 60));
          metrics.activeRevise -= 1;

          const state = itemRoundState.get(matchedArt.slug) ?? { precheckFix: 0, fcRound: 0 };
          state.precheckFix += 1;
          itemRoundState.set(matchedArt.slug, state);
          const shortTitle =
            matchedArt.slug === 'item-1'
              ? 'GPT-6规模计划'
              : matchedArt.slug === 'item-2'
                ? '18.5万样本评估'
                : '8.2B合作项目';
          return emitJson({
            title: matchedArt.title,
            shortTitle,
            progressLabel: '修订完成进展',
            category: '大模型',
            entity: 'OpenAI',
            summary:
              matchedArt.slug === 'item-1'
                ? 'GPT-6 推出 440 亿美元企业计划并覆盖 6 个国家。'
                : matchedArt.slug === 'item-2'
                  ? '评估测试集覆盖 18.5 万任务与 1200 万上下文词元。'
                  : '新合作项目资金规模达到 82 亿美元，覆盖 24 个地区。',
            keyPoints: ['修正后完全吻合原文', '数字换算无误'],
            detail: '已根据修改建议核准描述并修正了引文依据。',
            hostComment: '修正后的表述清晰准确。',
            narration: ['经过对照原文核对调整。', '相关数字与开放范围均与原文一致。'],
            evidence: [{ claim: '修正后真实引文', articleId: artId, quote: matchedArt.body }],
          });
        }

        if (stage === 'factcheck') {
          if (prompt.includes('availabilityNote')) {
            metrics.factcheckLeakedAvailabilityNote = true;
          }
          if (prompt.includes('上一轮复核关注清单')) {
            metrics.factcheckSawPriorContext = true;
          }
          const state = itemRoundState.get(matchedArt.slug) ?? { precheckFix: 0, fcRound: 0 };
          state.fcRound += 1;
          itemRoundState.set(matchedArt.slug, state);

          if (phase === 'initial' && state.fcRound === 1) {
            return emitJson({
              verdict: 'revise',
              claims: [
                {
                  text: '首轮核查需要确认限定范围',
                  status: 'unsupported',
                  severity: 'major',
                  note: '请核准限定条件',
                },
              ],
              revisionNotes: ['请确认限定范围并与原文一致'],
            });
          }
          // 二轮验证：哪怕核查员输出了 minor 问题且 verdict 写了 revise，也能收敛放行且不触发 exceeded_revisions
          return emitJson({
            verdict: 'revise',
            claims: [
              {
                text: '核心数字与范围准确',
                status: 'supported',
                severity: 'major',
                note: '准确',
              },
              {
                text: '卡片短句措辞略简洁',
                status: 'unsupported',
                severity: 'minor',
                note: '仅属细微措辞风格差异',
              },
            ],
            revisionNotes: ['建议小幅润色语气'],
          });
        }

        if (stage === 'package') {
          metrics.packageCount += 1;
          const idxMarker = prompt.indexOf('## 本期已过审新闻列表（JSON）\n');
          const rest =
            idxMarker >= 0
              ? prompt.slice(idxMarker + '## 本期已过审新闻列表（JSON）\n'.length)
              : '[]';
          const endIdx = rest.search(/\n## /);
          const list = JSON.parse((endIdx >= 0 ? rest.slice(0, endIdx) : rest).trim()) as Array<{
            itemId: string;
          }>;
          const order = list.map((x) => x.itemId);
          return emitJson({
            order,
            headlineItemId: order[0] ?? 'item-1',
            headline: '本期聚焦：大模型企业级规模扩展',
            leadSummary: '今天为你并发核查并整理三条大模型工程新动态。',
            intro: { narration: ['欢迎收看今天的节目。'], hostComment: '三条资讯都很实在。' },
            outro: {
              narration: ['本期内容就到这里。'],
              hostComment: '感谢大家关注。',
              cta: '欢迎点赞评论交流。',
            },
            publish: {
              title: 'AI每日报｜企业大模型规模与评测新进展',
              descriptionIntro: '盘点近期三大重点行业更新。',
              tags: ['人工智能', '大模型'],
            },
          });
        }

        return emitJson({ ok: true });
      },
    });

    try {
      await fs.writeFile(path.join(core.context.paths.secretsDir, 'mock-key'), 'secret-mock-key', {
        mode: 0o600,
      });
      await core.config.updateSettings({
        ai: {
          maxConcurrentCalls: 6,
          providers: {
            mockapi: {
              adapter: 'openai-compatible',
              protocol: 'chat-completions',
              baseUrl: 'https://mock-ai.test/v1',
              apiKeyFile: 'mock-key',
            },
          },
          stages: {
            select: { cli: 'mockapi', model: 'mock-model', timeoutSec: 30, retries: 0 },
            summarize: { cli: 'mockapi', model: 'mock-model', timeoutSec: 30, retries: 0 },
            polish: { cli: 'mockapi', model: 'mock-model', timeoutSec: 30, retries: 0 },
            factcheck: { cli: 'mockapi', model: 'mock-model', timeoutSec: 30, retries: 0 },
            package: { cli: 'mockapi', model: 'mock-model', timeoutSec: 30, retries: 0 },
          },
        },
      });

      const runId = createRun(core.context, { itemCount: 3, trigger: 'manual-cli' });
      await executeRun(core.context, runId, { stageOverrides: STUB_RENDER_QA });

      expect(core.context.repos.runs.getById(runId)?.status).toBe('awaiting_review');
      const itemsAfterRun = core.context.repos.runItems.listByRun(runId);
      expect(itemsAfterRun.filter((i) => i.status === 'passed')).toHaveLength(3);
      // 验证 3 条新闻确系并发进入 revise 微调，且第 1 条本地预检修引文未挤占 maxRevisions=1 名额
      expect(metrics.peakRevise).toBeGreaterThanOrEqual(2);
      expect(metrics.factcheckSawPriorContext).toBe(true);
      expect(metrics.factcheckLeakedAvailabilityNote).toBe(false);
      expect(metrics.packageCount).toBe(1);
      const recordedCalls = await core.tasks.getLlmCalls(runId);
      expect(recordedCalls.filter((c) => c.stage === 'revise').length).toBeGreaterThanOrEqual(3);
      const recordedEvents = await core.tasks.events(runId, 0, 500);
      expect(recordedEvents.some((e) => e.type === 'item_revising')).toBe(true);

      // 批量并发重做 2 条新闻（从 polish 起步）：两条同时并发 polish，summarize 不重复执行，package 仅重跑一次
      phase = 'batchRetry';
      const summarizeBeforeRetry = metrics.summarizeCount;
      const packageBeforeRetry = metrics.packageCount;
      const targetIds = itemsAfterRun.slice(0, 2).map((i) => i.id);
      await retryRunItems(core.context, runId, targetIds, {
        fromStep: 'polish',
        stageOverrides: STUB_RENDER_QA,
      });

      expect(metrics.peakRetryPolish).toBeGreaterThanOrEqual(2);
      expect(metrics.summarizeCount).toBe(summarizeBeforeRetry);
      expect(metrics.packageCount).toBe(packageBeforeRetry + 1);
      expect(core.context.repos.runs.getById(runId)?.status).toBe('awaiting_review');

      // 验证外部修改 settings.yaml 后，未重启且未手动 reloadConfig 的既有 Core 启动新任务会自动加载最新并发配置
      await updateSettingsFile(path.join(rootDir, 'config', 'settings.yaml'), {
        issue: { itemConcurrency: 9 },
      });
      let reloadedRunId = '';
      await expect(
        core.tasks.start({
          itemCount: 1,
          trigger: 'manual-web',
          onCreated: (createdId) => {
            reloadedRunId = createdId;
            cancelRun(core.context, createdId);
          },
        }),
      ).rejects.toThrow();
      const reloadedSnapshot = JSON.parse(
        core.context.repos.runs.getById(reloadedRunId)?.configSnapshotJson ?? '{}',
      ) as { issue?: { itemConcurrency?: number } };
      expect(reloadedSnapshot.issue?.itemConcurrency).toBe(9);
      abandonRun(core.context, reloadedRunId);
    } finally {
      await core.close();
    }
  }, 30_000);

  it('pauses after narration when requested, then continues through video review', async () => {
    const { rootDir } = await setupWorkflowWorkspace();
    const now = new Date('2026-11-16T08:00:00.000Z');
    const mockFetch = makeFeedMockFetch([
      {
        slug: 'pause-item',
        title: '开源语音模型发布可离线试听版本',
        pubDate: 'Mon, 16 Nov 2026 07:20:00 GMT',
        body: '研究团队发布可在本地离线运行的语音模型，用户可以先试听再决定是否生成完整视频。',
      },
    ]);
    const core = await createCore({ rootDir, fetchImpl: mockFetch, now: () => now });
    try {
      await core.config.updateSettings({ tts: { pauseAfterNarrate: true } });
      const runId = createRun(core.context, { itemCount: 1, trigger: 'manual-web' });
      await executeRun(core.context, runId, { stageOverrides: STUB_RENDER_QA });
      expect(core.context.repos.runs.getById(runId)?.status).toBe('awaiting_audio_review');
      expect(
        core.context.repos.runStages.listByRun(runId).find((stage) => stage.stage === 'narrate')
          ?.status,
      ).toBe('done');
      expect(
        core.context.repos.runStages.listByRun(runId).find((stage) => stage.stage === 'render')
          ?.status,
      ).toBe('pending');

      core.context.repos.articles.releaseByRun(runId);
      const stoppedId = createRun(core.context, { itemCount: 1, trigger: 'manual-web' });
      await executeRun(core.context, stoppedId, {
        stopAfterStage: 'narrate',
        stageOverrides: STUB_RENDER_QA,
      });
      expect(core.context.repos.runs.getById(stoppedId)?.status).toBe('awaiting_audio_review');

      await resumeRun(core.context, runId, { stageOverrides: STUB_RENDER_QA });
      expect(core.context.repos.runs.getById(runId)?.status).toBe('awaiting_review');
      expect(
        core.context.repos.runStages.listByRun(runId).find((stage) => stage.stage === 'qa')?.status,
      ).toBe('done');
    } finally {
      await core.close();
    }
  }, 90_000);

  it('reopens a consumed run from selection and from one news item without running out of candidates', async () => {
    const { rootDir } = await setupWorkflowWorkspace();
    const now = new Date('2026-11-16T08:00:00.000Z');
    const articleUrl = 'https://primary.example.com/revive-select';
    const articleId = computeArticleId(articleUrl);
    const mockFetch = makeFeedMockFetch([
      {
        slug: 'revive-select',
        title: '本地绘图模型开始支持中文海报排版',
        pubDate: 'Mon, 16 Nov 2026 07:10:00 GMT',
        body: '新版本让本地绘图模型可以直接排出中文海报，创作者无需再把文字交给外部服务处理。',
      },
    ]);
    const core = await createCore({ rootDir, fetchImpl: mockFetch, now: () => now });
    try {
      const runId = createRun(core.context, { itemCount: 1, trigger: 'manual-web' });
      await executeRun(core.context, runId, { stageOverrides: STUB_RENDER_QA });
      expect(core.context.repos.runs.getById(runId)?.status).toBe('awaiting_review');
      await core.publish.markConsumed(runId);
      expect(core.context.repos.articles.getById(articleId)?.status).toBe('consumed');
      expect(
        core.context.repos.history
          .listRecent('2020-01-01T00:00:00.000Z')
          .filter((record) => record.runId === runId),
      ).toHaveLength(1);

      await resumeRun(core.context, runId, {
        fromStage: 'select',
        stageOverrides: STUB_RENDER_QA,
      });
      expect(core.context.repos.runs.getById(runId)?.status).toBe('awaiting_review');
      expect(core.context.repos.articles.getById(articleId)).toMatchObject({
        status: 'reserved',
        reservedByRun: runId,
      });
      expect(
        core.context.repos.history
          .listRecent('2020-01-01T00:00:00.000Z')
          .filter((record) => record.runId === runId),
      ).toHaveLength(0);
      await core.publish.markConsumed(runId);
      expect(core.context.repos.articles.getById(articleId)?.status).toBe('consumed');

      const item = core.context.repos.runItems
        .listByRun(runId)
        .find((entry) => entry.status === 'passed');
      expect(item?.id).toBeTruthy();
      await retryRunItems(core.context, runId, [item?.id ?? ''], {
        stageOverrides: STUB_RENDER_QA,
      });
      expect(core.context.repos.runs.getById(runId)?.status).toBe('awaiting_review');
      expect(
        core.context.repos.runEvents
          .listAfter(runId, 0, 500)
          .some((event) => event.type === 'run_revived'),
      ).toBe(true);
    } finally {
      await core.close();
    }
  }, 180_000);

  it('enforces notBeforeAt across selection, refill, origin checks, and partial convergence without falling back to older news', async () => {
    const { rootDir, scriptFile } = await setupWorkflowWorkspace();
    const now = new Date('2026-11-16T12:00:00.000Z');
    const cutoffIso = '2026-11-16T06:00:00.000Z';

    // 校验跨时区纯日期宽限规则：北京时间 2026-11-16 00:00 (= 2026-11-15T16:00Z)，2026-11-15 日期事件允许保留，2026-11-14 事件必定判旧
    expect(isEventOlderThanCutoff('2026-11-15', '2026-11-15T16:00:00.000Z')).toBe(false);
    expect(isEventOlderThanCutoff('2026-11-14', '2026-11-15T16:00:00.000Z')).toBe(true);
    expect(isEventOlderThanCutoff('2026-11-16T05:59:59Z', cutoffIso)).toBe(true);
    expect(isEventOlderThanCutoff('2026-11-16T06:00:00Z', cutoffIso)).toBe(false);

    const freshArticle = {
      slug: 'fresh-only',
      title: 'Anthropic 发布代码生成模型微调版本',
      pubDate: 'Mon, 16 Nov 2026 09:00:00 GMT',
      body: 'Anthropic 今天上线全新代码推理模型升级，大幅降低函数重构延迟并全面开放接口访问。',
    };
    const delayedRewrite = {
      slug: 'delayed-rewrite',
      title: 'DeepSeek 正式发布开源新一代推理优化框架实测',
      pubDate: 'Mon, 16 Nov 2026 08:30:00 GMT',
      body: '多家媒体回顾并整理报道 DeepSeek 此前已发布的开源新一代推理优化框架性能表现。',
    };
    const exactRepost = {
      slug: 'exact-repost',
      title: 'DeepSeek 正式发布开源新一代推理优化框架！',
      pubDate: 'Mon, 16 Nov 2026 08:45:00 GMT',
      body: '转载汇总 DeepSeek 正式发布开源新一代推理优化框架的旧稿全文。',
    };
    const oldBackupCandidate = {
      slug: 'old-backup',
      title: '早期行业峰会筹备消息',
      pubDate: 'Sat, 14 Nov 2026 12:00:00 GMT',
      body: '上周预热的一则普通算力峰会日程公告，发布于设定时间门槛之前。',
    };

    const freshId = computeArticleId('https://primary.example.com/fresh-only');
    const delayedId = computeArticleId('https://primary.example.com/delayed-rewrite');
    const exactRepostId = computeArticleId('https://primary.example.com/exact-repost');

    await fs.writeFile(
      scriptFile,
      JSON.stringify({
        rules: [
          {
            stage: 'select',
            contains: [
              '最早时间之前已入库的相关来源参考',
              'DeepSeek 正式发布开源新一代推理优化框架',
              'DeepSeek 正式发布开源新一代推理优化框架实测',
              freshId,
            ],
            actions: [
              {
                output: {
                  events: [
                    {
                      title: freshArticle.title,
                      articleIds: [freshId],
                      category: '大模型',
                      entity: 'Anthropic',
                      score: 9,
                      publicAppeal: 8.5,
                      reason: '全新代码生成模型微调版本',
                      duplicateOfHistory: false,
                    },
                    {
                      title: delayedRewrite.title,
                      articleIds: [delayedId],
                      category: '大模型',
                      entity: 'DeepSeek',
                      score: 8,
                      publicAppeal: 7.5,
                      reason: '对昨日旧发布的滞后二手实测回顾',
                      duplicateOfHistory: true,
                    },
                  ],
                },
              },
            ],
          },
          {
            stage: 'select',
            contains: [
              '最早时间之前已入库的相关来源参考',
              'DeepSeek 正式发布开源新一代推理优化框架',
              'DeepSeek 正式发布开源新一代推理优化框架实测',
            ],
            actions: [
              {
                output: {
                  events: [
                    {
                      title: delayedRewrite.title,
                      articleIds: [delayedId],
                      category: '大模型',
                      entity: 'DeepSeek',
                      score: 8,
                      publicAppeal: 7.5,
                      reason: '对昨日旧发布的滞后二手实测回顾',
                      duplicateOfHistory: true,
                    },
                  ],
                },
              },
            ],
          },
        ],
      }),
      'utf8',
    );

    const mockFetch = makeFeedMockFetch(
      [freshArticle, delayedRewrite, exactRepost],
      [oldBackupCandidate],
    );
    const core = await createCore({ rootDir, fetchImpl: mockFetch, now: () => now });
    try {
      // 预先入库早于截止时间的一手源报道，验证：
      // 1) 同标题复发稿（exactRepost）在进模型前被精确去重跳过；
      // 2) 滞后二手实测（delayedRewrite）不会被相似度硬删除，而是携带前期参考进入模型并由模型识别为同一旧闻后剔除
      core.context.repos.articles.insertIfAbsent({
        id: 'art-origin-old',
        sourceId: 'primary-feed',
        canonicalUrl: 'https://primary.example.com/origin-v3',
        title: 'DeepSeek 正式发布开源新一代推理优化框架',
        titleNorm: 'deepseek 正式发布开源新一代推理优化框架',
        lang: 'zh',
        publishedAt: '2026-11-15T10:00:00.000Z',
        firstSeenAt: '2026-11-15T10:05:00.000Z',
        excerpt: 'DeepSeek 于昨日正式推出开源新一代推理优化框架。',
        contentPath: null,
        contentChars: 300,
        imagePath: null,
        extractStatus: 'feed_only',
      });

      // 1. 当设定最早时间为 11-16 06:00，请求最多 3 条但仅 1 条真正达标时，应宁少勿滥以 1 条顺利完结
      const runId = createRun(core.context, {
        itemCount: 3,
        notBeforeAt: cutoffIso,
        trigger: 'manual-cli',
      });
      await executeRun(core.context, runId, { stageOverrides: STUB_RENDER_QA });

      expect(core.context.repos.runs.getById(runId)?.status).toBe('awaiting_review');
      const items = core.context.repos.runItems.listByRun(runId);
      const passed = items.filter((item) => item.status === 'passed');
      expect(passed).toHaveLength(1);
      expect(passed[0]?.finalJson?.evidence[0]?.articleId).toBe(freshId);

      const llmCalls = await core.tasks.getLlmCalls(runId);
      const selectCallLogs = await Promise.all(
        llmCalls
          .filter((c) => c.stage === 'select')
          .map((c) => core.tasks.getLlmCallLog(runId, c.id)),
      );
      const selectPrompts = selectCallLogs
        .map((entry) => (entry as { prompt?: string } | null)?.prompt ?? '')
        .filter((text) => text.length > 0);
      expect(selectPrompts.length).toBeGreaterThanOrEqual(1);
      expect(selectPrompts[0]).toContain('最早时间之前已入库的相关来源参考');
      expect(selectPrompts[0]).toContain('DeepSeek 正式发布开源新一代推理优化框架');
      expect(selectPrompts[0]).toContain('DeepSeek 正式发布开源新一代推理优化框架实测');
      expect(selectPrompts[0]).not.toContain(exactRepostId);
      expect(selectPrompts[0]).not.toContain(exactRepost.title);

      // 2. 当设定更晚的严格截止时间导致 0 条满足条件时，拒绝越界并将状态收敛为 failed (insufficient_items)
      core.context.repos.articles.releaseByRun(runId);
      const strictRunId = createRun(core.context, {
        itemCount: 2,
        notBeforeAt: '2026-11-16T11:30:00.000Z',
        trigger: 'manual-cli',
      });
      await expect(
        executeRun(core.context, strictRunId, { stageOverrides: STUB_RENDER_QA }),
      ).rejects.toMatchObject({ code: 'insufficient_items' });
      expect(core.context.repos.runs.getById(strictRunId)?.status).toBe('failed');
    } finally {
      await core.close();
    }
  }, 60_000);

  it('normalizes Unicode hyphens and includes recently consumed articles in selection dedup and prompt history even when published_history is absent', async () => {
    expect(normalizeTitle('GPT\u20116.2 Astra and GPT\u20116.2 Sol')).toBe(
      'gpt-6.2 astra and gpt-6.2 sol',
    );

    const { rootDir } = await setupWorkflowWorkspace();
    const now = new Date('2026-11-19T02:00:00.000Z');
    const capturedPrompts: string[] = [];
    const fixtureKey = 'consumed-dedup-key';

    const core = await createCore({
      rootDir,
      now: () => now,
      fetchImpl: async (input, init) => {
        const url = input.toString();
        if (url.includes('gateway.test')) {
          const payload = JSON.parse(init?.body as string) as {
            messages?: Array<{ content?: string }>;
          };
          const userPrompt = payload.messages?.map((m) => m.content ?? '').join('\n') ?? '';
          capturedPrompts.push(userPrompt);
          return Response.json({
            id: 'select-consumed-test',
            choices: [
              {
                finish_reason: 'stop',
                message: {
                  content: JSON.stringify({
                    events: [
                      {
                        title: 'Google Releases Gemini 4 Neon',
                        articleIds: ['art-fresh-neon'],
                        category: '模型发布',
                        entity: 'Google',
                        score: 9,
                        publicAppeal: 9,
                        reason: '主流大模型更新',
                        duplicateOfHistory: false,
                      },
                    ],
                  }),
                },
              },
            ],
          });
        }
        return new Response('Not found', { status: 404 });
      },
    });

    try {
      await fs.writeFile(path.join(core.context.paths.secretsDir, 'fixture-key'), fixtureKey, {
        mode: 0o600,
      });
      await core.config.updateSettings({
        ai: {
          providers: {
            fixture: {
              adapter: 'openai-compatible',
              protocol: 'chat-completions',
              baseUrl: 'https://mock.gateway.test/v1',
              apiKeyFile: 'fixture-key',
            },
          },
          stages: { select: { cli: 'fixture', model: 'fixture-model' } },
        },
      });

      const oldRunId = createRun(core.context, { itemCount: 1, trigger: 'manual-cli' });
      const consumedUrl = 'https://primary.example.com/introducing-gpt-6-2';
      core.context.repos.articles.insertIfAbsent({
        id: 'art-consumed-gpt',
        sourceId: 'primary-feed',
        canonicalUrl: consumedUrl,
        title: 'Introducing GPT-6.2 Astra and Sol',
        titleNorm: normalizeTitle('Introducing GPT-6.2 Astra and Sol'),
        lang: 'en',
        publishedAt: '2026-11-17T18:00:00.000Z',
        firstSeenAt: '2026-11-18T01:00:00.000Z',
        excerpt: 'OpenAI releases GPT-6.2 Astra and Sol.',
        contentPath: null,
        contentChars: 500,
        imagePath: null,
        extractStatus: 'ok',
      });
      core.context.repos.articles.markReserved(['art-consumed-gpt'], oldRunId);
      core.context.repos.articles.markConsumed(['art-consumed-gpt'], oldRunId);

      // 新入库一条标题使用 U+2011 不换行连字符且高度重合的待选文章（应当在送入大模型前即被确定性去重拦截）
      core.context.repos.articles.insertIfAbsent({
        id: 'art-dup-hyphen',
        sourceId: 'backup-feed',
        canonicalUrl: 'https://backup.example.com/introducing-gpt-6-2-unicode',
        title: 'Introducing GPT\u20116.2 Astra and Sol!',
        titleNorm: normalizeTitle('Introducing GPT\u20116.2 Astra and Sol!'),
        lang: 'en',
        publishedAt: '2026-11-18T12:00:00.000Z',
        firstSeenAt: '2026-11-18T12:10:00.000Z',
        excerpt: 'Reprint using non-breaking hyphen.',
        contentPath: null,
        contentChars: 500,
        imagePath: null,
        extractStatus: 'ok',
      });

      // 新入库一条全新重大事件文章（应当保留送入大模型并被选中）
      core.context.repos.articles.insertIfAbsent({
        id: 'art-fresh-neon',
        sourceId: 'primary-feed',
        canonicalUrl: 'https://primary.example.com/introducing-gemini-4-neon',
        title: 'Introducing Gemini 4 Neon',
        titleNorm: normalizeTitle('Introducing Gemini 4 Neon'),
        lang: 'en',
        publishedAt: '2026-11-18T21:35:00.000Z',
        firstSeenAt: '2026-11-19T00:10:00.000Z',
        excerpt: 'Google releases Gemini 4 Neon with high intelligence per dollar.',
        contentPath: null,
        contentChars: 600,
        imagePath: null,
        extractStatus: 'ok',
      });

      const runId = createRun(core.context, { itemCount: 2, trigger: 'manual-cli' });
      const result = await selectCandidateEvents({
        ctx: core.context,
        runId,
        settings: core.context.settings,
        sinceIso: '2026-11-18T00:00:00.000Z',
        includeExpired: false,
        targetCount: 4,
        itemCount: 2,
      });

      expect(result.consideredArticleIds).toEqual(['art-fresh-neon']);
      expect(result.selected).toHaveLength(1);
      expect(result.selected[0]?.allArticleIds).toEqual(['art-fresh-neon']);
      expect(capturedPrompts).toHaveLength(1);
      expect(capturedPrompts).toHaveLength(1);
      expect(capturedPrompts[0]).toContain('Introducing GPT-6.2 Astra and Sol');
      expect(capturedPrompts[0]).not.toContain('art-dup-hyphen');
    } finally {
      await core.close();
    }
  });

  it('does not drop codename/version model releases (Neon vs Hydrogen, X 5 BBB vs AAA) and delegates reworded duplicates to LLM event judgment', async () => {
    const { rootDir } = await setupWorkflowWorkspace();
    const now = new Date('2026-11-19T07:07:00.000Z');
    const notBeforeAt = '2026-11-18T15:00:00.000Z';
    const capturedPrompts: string[] = [];
    const fixtureKey = 'neon-hydrogen-regression-key';

    await updateSourcesFile(path.join(rootDir, 'config', 'sources.yaml'), [
      {
        id: 'deepmind-blog',
        name: 'Google DeepMind',
        lang: 'en',
        tier: 1,
        kind: 'rss',
        pool: 'primary',
        url: 'https://deepmind.google/blog/rss.xml',
        enabled: true,
      },
      {
        id: 'google-gemini',
        name: 'Google Gemini Blog',
        lang: 'en',
        tier: 1,
        kind: 'rss',
        pool: 'primary',
        url: 'https://blog.google/gemini/rss.xml',
        enabled: true,
      },
      {
        id: 'artificial-analysis',
        name: 'Artificial Analysis',
        lang: 'en',
        tier: 2,
        kind: 'html-list',
        pool: 'primary',
        url: 'https://artificialanalysis.ai/',
        enabled: true,
      },
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
    ]);

    const neonDeepmindId = 'b898a1b2127c5756e1c018cc6a81581a6294cda6';
    const neonGeminiBlogId = 'b2c084a41275137173e812609f66e708e4fc8ea8';
    const hydrogenId = 'a8d5fa7d24b3647f4501b383397b571abdcb6905';

    const core = await createCore({
      rootDir,
      now: () => now,
      fetchImpl: async (input, init) => {
        const url = input.toString();
        if (url.includes('gateway.test')) {
          const payload = JSON.parse(init?.body as string) as {
            messages?: Array<{ content?: string }>;
          };
          const userPrompt = payload.messages?.map((m) => m.content ?? '').join('\n') ?? '';
          capturedPrompts.push(userPrompt);
          return Response.json({
            id: 'select-neon-regression',
            choices: [
              {
                finish_reason: 'stop',
                message: {
                  content: JSON.stringify({
                    events: [
                      {
                        title: 'Introducing Gemini 4 Neon',
                        articleIds: [neonDeepmindId],
                        category: '模型发布',
                        entity: 'Google DeepMind',
                        score: 9.4,
                        publicAppeal: 9.2,
                        reason: '全新代号模型正式发布，与此前 Gemini 4 Hydrogen 为不同代号产品',
                        duplicateOfHistory: false,
                      },
                      {
                        title: 'Introducing X 5 BBB',
                        articleIds: ['art-x5-bbb'],
                        category: '模型发布',
                        entity: 'X Lab',
                        score: 8.6,
                        publicAppeal: 8.4,
                        reason: '同系列新型号发布',
                        duplicateOfHistory: false,
                      },
                      {
                        title: 'OpenAI 正式推出全新推理模型',
                        articleIds: ['art-openai-reword'],
                        category: '模型发布',
                        entity: 'OpenAI',
                        score: 8.0,
                        publicAppeal: 7.8,
                        reason: '与近期已播出的 OpenAI 正式发布全新推理模型 为同一事件换词重复',
                        duplicateOfHistory: true,
                      },
                    ],
                  }),
                },
              },
            ],
          });
        }
        return new Response('Not found', { status: 404 });
      },
    });

    try {
      await fs.writeFile(path.join(core.context.paths.secretsDir, 'fixture-key'), fixtureKey, {
        mode: 0o600,
      });
      await core.config.updateSettings({
        ai: {
          providers: {
            fixture: {
              adapter: 'openai-compatible',
              protocol: 'chat-completions',
              baseUrl: 'https://mock.gateway.test/v1',
              apiKeyFile: 'fixture-key',
            },
          },
          stages: { select: { cli: 'fixture', model: 'fixture-model' } },
        },
      });

      // 历史已播库：Introducing X 5 AAA 与 OpenAI 正式发布全新推理模型
      core.context.repos.history.insert({
        eventId: 'ev-hist-x5-aaa',
        runId: '20261115-1000-aaaa',
        title: 'Introducing X 5 AAA',
        titleNorm: normalizeTitle('Introducing X 5 AAA'),
        entity: 'X Lab',
        articleUrls: ['https://primary.example.com/x5-aaa'],
        publishedAt: '2026-11-15T10:00:00.000Z',
      });
      core.context.repos.history.insert({
        eventId: 'ev-hist-openai-reason',
        runId: '20261117-1000-bbbb',
        title: 'OpenAI 正式发布全新推理模型',
        titleNorm: normalizeTitle('OpenAI 正式发布全新推理模型'),
        entity: 'OpenAI',
        articleUrls: ['https://primary.example.com/openai-reasoning-launch'],
        publishedAt: '2026-11-17T10:00:00.000Z',
      });

      // 11 月 12 日的 Gemini 4 Hydrogen：原故障态为 expired + failed，从未进入 published_history
      core.context.repos.articles.insertIfAbsent({
        id: hydrogenId,
        sourceId: 'deepmind-blog',
        canonicalUrl: 'https://deepmind.google/blog/introducing-gemini-4-hydrogen',
        title: 'Introducing Gemini 4 Hydrogen',
        titleNorm: normalizeTitle('Introducing Gemini 4 Hydrogen'),
        lang: 'en',
        publishedAt: '2026-11-12T18:00:50.000Z',
        firstSeenAt: '2026-11-12T18:05:00.000Z',
        excerpt: 'Introducing Gemini 4 Hydrogen.',
        contentPath: null,
        contentChars: 0,
        imagePath: null,
        extractStatus: 'failed',
      });
      core.context.repos.articles.expireOlderThan('2026-11-15T00:00:00.000Z');

      // 同日仅精确到日期（UTC 00:00:00Z）的文章：跨时区宽限下不应被当成确凿早于 15:00Z 的前期参考
      core.context.repos.articles.insertIfAbsent({
        id: 'art-aa-same-day-date-only',
        sourceId: 'artificial-analysis',
        canonicalUrl: 'https://artificialanalysis.ai/articles/gemini-4-neon',
        title: 'Google continues to accelerate its release cadence with Gemini 4 Neon',
        titleNorm: normalizeTitle(
          'Google continues to accelerate its release cadence with Gemini 4 Neon',
        ),
        lang: 'en',
        publishedAt: '2026-11-18T00:00:00.000Z',
        firstSeenAt: '2026-11-18T12:00:00.000Z',
        excerpt: 'Same-day benchmark note.',
        contentPath: null,
        contentChars: 500,
        imagePath: null,
        extractStatus: 'ok',
      });

      // 两篇 Neon 官方正式稿（DeepMind + Google Gemini Blog）
      core.context.repos.articles.insertIfAbsent({
        id: neonDeepmindId,
        sourceId: 'deepmind-blog',
        canonicalUrl: 'https://deepmind.google/blog/introducing-gemini-4-neon',
        title: 'Introducing Gemini 4 Neon',
        titleNorm: normalizeTitle('Introducing Gemini 4 Neon'),
        lang: 'en',
        publishedAt: '2026-11-18T21:35:43.000Z',
        firstSeenAt: '2026-11-19T00:05:00.000Z',
        excerpt: 'DeepMind introduces Gemini 4 Neon with major speed and cost improvements.',
        contentPath: null,
        contentChars: 800,
        imagePath: null,
        extractStatus: 'ok',
      });
      core.context.repos.articles.insertIfAbsent({
        id: neonGeminiBlogId,
        sourceId: 'google-gemini',
        canonicalUrl:
          'https://blog.google/innovation-and-ai/models-and-research/gemini-models/introducing-gemini-4-neon',
        title: 'Introducing Gemini 4 Neon',
        titleNorm: normalizeTitle('Introducing Gemini 4 Neon'),
        lang: 'en',
        publishedAt: '2026-11-18T21:00:00.000Z',
        firstSeenAt: '2026-11-19T00:05:00.000Z',
        excerpt: 'Google Gemini Blog introduces Gemini 4 Neon.',
        contentPath: null,
        contentChars: 800,
        imagePath: null,
        extractStatus: 'ok',
      });

      // 同模板不同代号候选：Introducing X 5 BBB
      core.context.repos.articles.insertIfAbsent({
        id: 'art-x5-bbb',
        sourceId: 'primary-feed',
        canonicalUrl: 'https://primary.example.com/x5-bbb',
        title: 'Introducing X 5 BBB',
        titleNorm: normalizeTitle('Introducing X 5 BBB'),
        lang: 'en',
        publishedAt: '2026-11-18T20:00:00.000Z',
        firstSeenAt: '2026-11-19T00:05:00.000Z',
        excerpt: 'X Lab introduces X 5 BBB model.',
        contentPath: null,
        contentChars: 500,
        imagePath: null,
        extractStatus: 'ok',
      });

      // 精确重复候选（应被进模型前确定性跳过）与同题换词候选（应进模型由大模型按事件语义标 duplicateOfHistory=true）
      core.context.repos.articles.insertIfAbsent({
        id: 'art-openai-exact',
        sourceId: 'primary-feed',
        canonicalUrl: 'https://primary.example.com/openai-exact-mirror',
        title: 'OpenAI 正式发布全新推理模型！',
        titleNorm: normalizeTitle('OpenAI 正式发布全新推理模型！'),
        lang: 'zh',
        publishedAt: '2026-11-18T20:30:00.000Z',
        firstSeenAt: '2026-11-19T00:05:00.000Z',
        excerpt: '同题完全一致的转载稿。',
        contentPath: null,
        contentChars: 500,
        imagePath: null,
        extractStatus: 'ok',
      });
      core.context.repos.articles.insertIfAbsent({
        id: 'art-openai-reword',
        sourceId: 'primary-feed',
        canonicalUrl: 'https://primary.example.com/openai-reworded',
        title: 'OpenAI 正式推出全新推理模型',
        titleNorm: normalizeTitle('OpenAI 正式推出全新推理模型'),
        lang: 'zh',
        publishedAt: '2026-11-18T20:40:00.000Z',
        firstSeenAt: '2026-11-19T00:05:00.000Z',
        excerpt: '对昨日已播的 OpenAI 全新推理模型发布换词复述，无新进展。',
        contentPath: null,
        contentChars: 500,
        imagePath: null,
        extractStatus: 'ok',
      });

      const runId1 = createRun(core.context, {
        itemCount: 5,
        notBeforeAt,
        trigger: 'manual-cli',
      });
      const res1 = await selectCandidateEvents({
        ctx: core.context,
        runId: runId1,
        settings: core.context.settings,
        sinceIso: notBeforeAt,
        notBeforeAt,
        includeExpired: true,
        targetCount: 10,
        itemCount: 5,
      });

      expect(capturedPrompts).toHaveLength(1);
      const prompt1 = capturedPrompts[0] ?? '';
      expect(prompt1).toContain(neonDeepmindId);
      expect(prompt1).toContain('Introducing Gemini 4 Neon');
      expect(prompt1).toContain('art-x5-bbb');
      expect(prompt1).toContain('art-openai-reword');
      expect(prompt1).not.toContain('art-openai-exact');
      expect(prompt1).not.toContain(
        'Google continues to accelerate its release cadence with Gemini 4 Neon',
      );
      expect(prompt1).not.toContain('Introducing Gemini 4 Hydrogen');

      expect(res1.consideredArticleIds).toContain(neonDeepmindId);
      expect(res1.consideredArticleIds).toContain(neonGeminiBlogId);
      expect(res1.selected.map((item) => item.candidate.title)).toEqual([
        'Introducing Gemini 4 Neon',
        'Introducing X 5 BBB',
      ]);
      expect(res1.selected[0]?.allArticleIds).toEqual(
        expect.arrayContaining([neonDeepmindId, neonGeminiBlogId]),
      );

      // 更严苛场景：即使 Hydrogen 正文抽取成功、已消费并写入 published_history，Neon 仍必须正常进入候选并入选
      core.context.db
        .prepare("UPDATE articles SET extract_status = 'ok', status = 'consumed' WHERE id = ?")
        .run(hydrogenId);
      core.context.repos.history.insert({
        eventId: 'ev-hist-hydrogen',
        runId: '20261113-1000-hhhh',
        title: 'Introducing Gemini 4 Hydrogen',
        titleNorm: normalizeTitle('Introducing Gemini 4 Hydrogen'),
        entity: 'Google DeepMind',
        articleUrls: ['https://deepmind.google/blog/introducing-gemini-4-hydrogen'],
        publishedAt: '2026-11-13T10:00:00.000Z',
      });

      const runId2 = createRun(core.context, {
        itemCount: 5,
        notBeforeAt,
        trigger: 'manual-cli',
      });
      const res2 = await selectCandidateEvents({
        ctx: core.context,
        runId: runId2,
        settings: core.context.settings,
        sinceIso: notBeforeAt,
        notBeforeAt,
        includeExpired: true,
        targetCount: 10,
        itemCount: 5,
      });

      expect(capturedPrompts).toHaveLength(2);
      expect(capturedPrompts[1]).toContain(neonDeepmindId);
      expect(capturedPrompts[1]).toContain('Introducing Gemini 4 Hydrogen');
      expect(res2.selected.map((item) => item.candidate.title)).toEqual([
        'Introducing Gemini 4 Neon',
        'Introducing X 5 BBB',
      ]);
      expect(res2.selected[0]?.allArticleIds).toEqual(
        expect.arrayContaining([neonDeepmindId, neonGeminiBlogId]),
      );
    } finally {
      await core.close();
    }
  });

  it('修改或移除 minScore 只影响分数门槛，不会改变允许少条数出片与紧凑文风设置', async () => {
    const { rootDir, scriptFile } = await setupWorkflowWorkspace();
    // 删除 minScore 但显式开启 allowPartial / compactStyle / requireImageOptIn：仍然允许少条出片并在 0 条时跳过
    await updateSettingsFile(path.join(rootDir, 'config', 'settings.yaml'), {
      issue: { allowPartial: true },
      editorial: { compactStyle: true, requireImageOptIn: true },
    });
    const core = await createCore({
      rootDir,
      now: () => new Date('2026-11-16T10:00:00.000Z'),
      fetchImpl: makeFeedMockFetch([
        {
          slug: 'only-one',
          title: '单条行业进展',
          pubDate: 'Mon, 16 Nov 2026 09:00:00 GMT',
          body: '今天有关团队公布了一条独立的人工智能工程新进展，详细说明了功能细节与适用范围。',
        },
      ]),
    });
    try {
      const runPartialId = createRun(core.context, { itemCount: 5, trigger: 'manual-cli' });
      await executeRun(core.context, runPartialId, { stopAfterStage: 'package' });
      expect(core.context.repos.runs.getById(runPartialId)).toMatchObject({
        status: 'interrupted',
        currentStage: 'package',
      });
      expect(
        core.context.repos.runItems.listByRun(runPartialId).filter((i) => i.status === 'passed'),
      ).toHaveLength(1);

      // 反向验证：即使保留 minScore=7.5，若关闭 allowPartial，0 条入选时仍严格报错而非静默跳过
      await editSettingsFile(path.join(rootDir, 'config', 'settings.yaml'), (doc) => {
        doc.setIn(['issue', 'minScore'], 7.5);
        doc.setIn(['issue', 'allowPartial'], false);
      });
      await fs.writeFile(
        scriptFile,
        JSON.stringify({
          rules: [{ stage: 'select', actions: [{ output: { events: [] } }] }],
        }),
        'utf8',
      );
      const coreStrict = await createCore({
        rootDir,
        now: () => new Date('2026-11-16T10:00:00.000Z'),
        fetchImpl: makeFeedMockFetch([
          {
            slug: 'low-score',
            title: '次要动态',
            pubDate: 'Mon, 16 Nov 2026 09:00:00 GMT',
            body: '一条用于验证分数门槛与数量策略各自独立生效的次要人工智能动态正文描述内容。',
          },
        ]),
      });
      try {
        const strictRunId = createRun(coreStrict.context, { itemCount: 3, trigger: 'manual-cli' });
        await expect(
          executeRun(coreStrict.context, strictRunId, { stopAfterStage: 'select' }),
        ).rejects.toThrow(/不足/);
        expect(coreStrict.context.repos.runs.getById(strictRunId)?.status).toBe('failed');
      } finally {
        await coreStrict.close();
      }
    } finally {
      await core.close();
    }
  });

  it('supports ordered AI channel fallback, mid-run live config reloads, and 1:1 non-repeating mascot/BGM binding', async () => {
    const { rootDir, scriptFile } = await setupWorkflowWorkspace();
    await fs.copyFile(
      path.join(REPO_ROOT, 'config', 'personas.yaml'),
      path.join(rootDir, 'config', 'personas.yaml'),
    );
    const bgmDir = path.join(rootDir, 'assets', 'bgm');
    await fs.mkdir(bgmDir, { recursive: true });
    for (const id of ['deepseek', 'gpt', 'gemini', 'claude']) {
      await fs.writeFile(path.join(bgmDir, `${id}-bgm.mp3`), `${id}-audio`);
    }

    const fixtureKey = 'fallback-key-secret';
    await fs
      .writeFile(path.join(rootDir, 'storage', 'secrets', 'fb-key'), fixtureKey, {
        mode: 0o600,
      })
      .catch(async () => {
        await fs.mkdir(path.join(rootDir, 'storage', 'secrets'), { recursive: true });
        await fs.writeFile(path.join(rootDir, 'storage', 'secrets', 'fb-key'), fixtureKey, {
          mode: 0o600,
        });
      });

    const settingsFile = path.join(rootDir, 'config', 'settings.yaml');
    await fs.writeFile(
      scriptFile,
      JSON.stringify({
        rules: [
          {
            stage: 'select',
            modelEquals: 'primary-broken',
            actions: [{ mode: 'exit_error', error: '主渠道暂时不可用' }],
          },
        ],
      }),
      'utf8',
    );

    const apiCalls: Array<{ model: string }> = [];
    let feedBatch = 1;
    const feed1 = makeFeedMockFetch([
      {
        slug: 'openai-1',
        title: 'OpenAI 公布开发者工具定价调整',
        pubDate: 'Mon, 16 Nov 2026 07:30:00 GMT',
        body: 'OpenAI 宣布面向开发者的实时工具调用方案升级定价与响应速度。',
      },
      {
        slug: 'claude-2',
        title: 'Anthropic 发布 Claude Code 终端沙盒',
        pubDate: 'Mon, 16 Nov 2026 07:10:00 GMT',
        body: 'Anthropic 公布 Claude Code 全新安全沙盒工具链，大幅降低编程智能体误操作风险。',
      },
    ]);
    const feed2 = makeFeedMockFetch([
      {
        slug: 'openai-3',
        title: 'OpenAI 扩充团队推理算力配额',
        pubDate: 'Mon, 16 Nov 2026 08:50:00 GMT',
        body: 'OpenAI 宣布企业开发者默认配额翻倍并降低批处理接口延时。',
      },
      {
        slug: 'deepseek-4',
        title: 'DeepSeek 开源推理加速算子库',
        pubDate: 'Mon, 16 Nov 2026 08:30:00 GMT',
        body: 'DeepSeek 公布开源低显存推理优化库，支持单卡高效部署。',
      },
    ]);

    const core = await createCore({
      rootDir,
      now: () => new Date('2026-11-16T10:00:00.000Z'),
      fetchImpl: async (input, init) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.includes('gw.test')) {
          const body = JSON.parse(String(init?.body ?? '{}')) as { model?: string };
          apiCalls.push({ model: body.model ?? '' });
          if (body.model === 'http-broken') {
            return Response.json({ error: { message: 'HTTP 网关故障' } }, { status: 500 });
          }
          // 第三候选（agy/gemini-3.8-flash-high）已在 CLI 上可用，或者这里让第二个成功
          return Response.json({ error: { message: '意外到达' } }, { status: 500 });
        }
        return feedBatch === 1 ? feed1(input, init) : feed2(input, init);
      },
    });

    try {
      await updateSettingsFile(settingsFile, {
        ai: {
          providers: {
            backupGw: {
              adapter: 'openai-compatible',
              protocol: 'chat-completions',
              baseUrl: 'https://gw.test/v1',
              apiKeyFile: 'fb-key',
            },
          },
          channels: [
            { cli: 'agy', model: 'primary-broken', retries: 1, enabled: true },
            { cli: 'backupGw', model: 'http-broken', retries: 0, enabled: true },
            { cli: 'agy', model: 'gemini-3.8-flash-high', retries: 0, enabled: true },
          ],
          stages: {
            select: { mode: 'pool', cli: 'agy', model: 'primary-broken', retries: 1 },
            summarize: { mode: 'pool', cli: 'agy', model: 'primary-broken', retries: 1 },
            polish: { mode: 'pool', cli: 'agy', model: 'primary-broken', retries: 1 },
            factcheck: { mode: 'pool', cli: 'agy', model: 'primary-broken', retries: 1 },
            package: { mode: 'pool', cli: 'agy', model: 'primary-broken', retries: 1 },
          },
        },
      });
      await core.context.reloadConfig();

      // 1. 禁止脱离主播或跨主播混用 BGM
      await expect(
        core.tasks.start({ itemCount: 1, bgmFile: 'gpt-bgm.mp3', trigger: 'manual-cli' }),
      ).rejects.toThrow(/背景音乐|主播/);
      await expect(
        core.tasks.start({
          itemCount: 1,
          hostId: 'claude',
          bgmFile: 'gpt-bgm.mp3',
          trigger: 'manual-cli',
        }),
      ).rejects.toThrow(/不匹配/);

      // 2. 第一期：channel #1 (agy/primary-broken) 重试1次共2次失败 -> channel #2 (backupGw/http-broken) 失败 -> channel #3 (agy/gemini-3.8-flash-high) 兜底成功
      const run1 = createRun(core.context, { itemCount: 1, trigger: 'manual-cli' });
      let midRunUpdated = false;
      await executeRun(core.context, run1, {
        stopAfterStage: 'edit',
        stageOverrides: {
          edit: async () => {
            // 模拟阶段进行到 edit 时，磁盘配置已改成直连可用模型
            midRunUpdated = true;
            await updateSettingsFile(settingsFile, {
              ai: {
                channels: [
                  { cli: 'agy', model: 'gemini-3.8-flash-high', retries: 0, enabled: true },
                ],
              },
            });
            return { passedItemIds: [], droppedItemIds: [] };
          },
        },
      });
      expect(midRunUpdated).toBe(true);
      const events1 = await core.tasks.events(run1);
      expect(events1.some((e) => e.type === 'llm_fallback')).toBe(true);
      expect(events1.some((e) => e.type === 'llm_fallback_succeeded')).toBe(true);
      expect(apiCalls.filter((c) => c.model === 'http-broken')).toHaveLength(1);
      // 此时磁盘配置已经在 edit 时切到了 gemini-3.8-flash-high，snapshot 应立即同步生效
      const syncedSnapshot = JSON.parse(
        core.context.repos.runs.getById(run1)?.configSnapshotJson ?? '{}',
      ) as { ai?: { channels?: Array<{ model?: string }> } };
      expect(syncedSnapshot.ai?.channels?.[0]?.model).toBe('gemini-3.8-flash-high');

      // 验证第一期选定了 gpt 并严格绑定了 gpt-bgm.mp3，且 setBgm 禁止跨形象改配乐
      const detail1 = await core.tasks.get(run1);
      expect(detail1.hostId).toBe('gpt');
      expect(detail1.bgmFile).toBe('gpt-bgm.mp3');
      core.context.repos.runs.updateStatus(run1, 'awaiting_review');
      await expect(core.tasks.setBgm(run1, 'claude-bgm.mp3')).rejects.toThrow(/不匹配/);

      // 3. 第二期依然以 OpenAI 新闻为主，但因上一期是 gpt，本期自动选择必须避开 gpt 并绑定对应专属 BGM
      feedBatch = 2;
      const run2 = createRun(core.context, { itemCount: 2, trigger: 'manual-web' });
      await executeRun(core.context, run2, { stopAfterStage: 'select' });
      const detail2 = await core.tasks.get(run2);
      expect(detail2.hostId).toBeTruthy();
      expect(detail2.hostId).not.toBe('gpt');
      expect(detail2.bgmFile).toBe(`${detail2.hostId}-bgm.mp3`);

      // 4. 人工破例选择仍允许，但依然严格锁定该形象对应的 BGM
      const runManual = createRun(core.context, {
        itemCount: 1,
        hostId: 'gpt',
        trigger: 'manual-web',
      });
      expect((await core.tasks.get(runManual)).hostId).toBe('gpt');
      expect((await core.tasks.get(runManual)).bgmFile).toBe('gpt-bgm.mp3');
    } finally {
      await core.close();
    }
  }, 30_000);
});
