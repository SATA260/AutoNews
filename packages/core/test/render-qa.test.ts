import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { IssuePackage, QaReport, Timeline } from '@aidaily/contracts';
import { saveToCache, type TtsProvider, TtsService, tryRestoreFromCache } from '@aidaily/tts';
import { execa } from 'execa';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  buildMasterAudioWav,
  buildNarrationSections,
  buildRenderableIssue,
  buildTimeline,
  createCore,
  createDailyDeckAdapter,
  createRun,
  editSettingsFile,
  executeRun,
  mapEntityToMascotId,
  mediaTimeoutMs,
  type PipelineError,
  type RenderCheckpoint,
  readJsonOrNull,
  readJsonOrNullWithSchema,
  resolveRenderTheme,
  resumeRun,
  runMediaCommand,
  runQaStage,
  runRenderStage,
  toErrorCode,
  updateSettingsFile,
  updateSourcesFile,
  validateMp4Segment,
  writeJsonAtomic,
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

async function setupRenderWorkspace(templateName: 'solid-color' | 'daily-deck') {
  await fs.chmod(FAKE_AGY_BIN, 0o755);
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aidaily-render-'));
  tempDirs.push(rootDir);

  await fs.mkdir(path.join(rootDir, 'config'), { recursive: true });
  await fs.copyFile(
    path.join(REPO_ROOT, 'config', 'settings.yaml'),
    path.join(rootDir, 'config', 'settings.yaml'),
  );

  const settingsFile = path.join(rootDir, 'config', 'settings.yaml');
  await editSettingsFile(settingsFile, (doc) => {
    doc.setIn(['ai', 'providers'], {});
    doc.setIn(['tts', 'provider'], 'silent');
    doc.deleteIn(['issue', 'minScore']);
    doc.setIn(['issue', 'allowPartial'], false);
    doc.setIn(['editorial', 'compactStyle'], false);
    doc.setIn(['editorial', 'requireImageOptIn'], false);
  });
  await updateSettingsFile(settingsFile, {
    clis: {
      agy: { adapter: 'agy', bin: FAKE_AGY_BIN, extraArgs: [] },
    },
    template: {
      active: templateName,
      registry: {
        'daily-deck': {
          dir: path.join(REPO_ROOT, 'templates', 'daily-deck'),
          adapter: 'daily-deck',
        },
        'solid-color': {
          dir: '',
          adapter: 'solid-color',
        },
      },
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

  const scriptFile = path.join(rootDir, 'fake-script.json');
  await fs.writeFile(scriptFile, JSON.stringify({ rules: [] }), 'utf8');
  process.env.FAKE_AGY_SCRIPT_FILE = scriptFile;

  return { rootDir, settingsFile };
}

function makeSimpleFetch(
  articles: Array<{ slug: string; title: string; body: string }>,
): typeof fetch {
  const pubDate = new Date('2026-11-16T08:00:00.000Z').toUTCString();
  return async (input) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url === 'https://primary.example.com/rss.xml') {
      const items = articles
        .map(
          (a) =>
            `<item><title>${a.title}</title><link>https://primary.example.com/${a.slug}</link><pubDate>${pubDate}</pubDate><description>${a.body.slice(0, 60)}</description></item>`,
        )
        .join('\n');
      return new Response(
        `<?xml version="1.0"?><rss version="2.0"><channel><title>Feed</title>${items}</channel></rss>`,
        { status: 200, headers: { 'Content-Type': 'application/rss+xml' } },
      );
    }
    const found = articles.find((a) => `https://primary.example.com/${a.slug}` === url);
    if (found) {
      return new Response(buildArticleHtml(found.title, found.body), {
        status: 200,
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
    }
    return new Response('Not Found', { status: 404 });
  };
}

describe('template rendering, Playwright capture, ffmpeg composition, and QA', () => {
  it('runs end-to-end collect through qa with solid-color template, supports frame resume and qa recovery', async () => {
    const { rootDir } = await setupRenderWorkspace('solid-color');
    const fixedNow = new Date('2026-11-16T10:00:00.000Z');
    const core = await createCore({
      rootDir,
      fetchImpl: makeSimpleFetch([
        {
          slug: 'n1',
          title: 'OpenAI 发布全新推理引擎',
          body: 'OpenAI officially rolled out its faster inference stack today at $15 per 1000000 tokens.',
        },
        {
          slug: 'n2',
          title: 'DeepSeek 开源代码评测工具',
          body: 'DeepSeek open-sourced a benchmark harness supporting 128000 context tokens for developers.',
        },
      ]),
      now: () => fixedNow,
    });

    const runId = createRun(core.context, { itemCount: 2, trigger: 'manual-cli' });
    await executeRun(core.context, runId);

    const runDir = core.context.paths.runDir(runId);
    expect(core.context.repos.runs.getById(runId)?.status).toBe('awaiting_review');

    const videoFile = path.join(runDir, 'output', 'video.mp4');
    const coverFile = path.join(runDir, 'output', 'cover.jpg');
    const qaFile = path.join(runDir, 'qa.json');
    const renderCkpt = await readJsonOrNull<RenderCheckpoint>(
      path.join(runDir, 'stages', 'render.json'),
    );
    const qaReport = await readJsonOrNull<QaReport>(qaFile);
    const timeline = await readJsonOrNull<Timeline>(path.join(runDir, 'timeline.json'));

    await expect(fs.stat(videoFile)).resolves.toMatchObject({ size: expect.any(Number) });
    await expect(fs.stat(coverFile)).resolves.toMatchObject({ size: expect.any(Number) });
    expect(renderCkpt?.frameCount).toBe(4); // cover + 2 items + outro
    expect(qaReport?.passed).toBe(true);
    expect(qaReport?.width).toBe(1920);
    expect(qaReport?.height).toBe(1080);
    expect(qaReport?.fps).toBeCloseTo(30, 0);
    expect(qaReport?.blackRatio).toBeLessThan(0.05);
    expect(
      Math.abs((qaReport?.videoDurationSec ?? 0) - (qaReport?.audioDurationSec ?? 0)),
    ).toBeLessThan(0.3);
    expect(
      Math.abs((qaReport?.videoDurationSec ?? 0) * 1000 - (timeline?.totalMs ?? 0)),
    ).toBeLessThan(500);

    // 验证渲染阶段页面级续跑：删除第 2 张截图与 render 检查点，续跑时应仅补截缺失的那 1 页
    await fs.rm(path.join(runDir, 'frames', 'page-01.png'), { force: true });
    await fs.rm(path.join(runDir, 'stages', 'render.json'), { force: true });
    await fs.rm(qaFile, { force: true });
    core.context.repos.runs.updateStatus(runId, 'interrupted');
    await resumeRun(core.context, runId);

    const resumedRender = await readJsonOrNull<RenderCheckpoint>(
      path.join(runDir, 'stages', 'render.json'),
    );
    expect(resumedRender?.reusedFrameCount).toBe(3);
    expect(resumedRender?.capturedFrameCount).toBe(1);
    expect(core.context.repos.runs.getById(runId)?.status).toBe('awaiting_review');

    // 验证质检不通过时写入失败版 qa.json，并允许通过 resume --from render 自动修复
    await runMediaCommand('ffmpeg', [
      '-y',
      '-f',
      'lavfi',
      '-i',
      'color=c=black:s=640x360:d=1',
      '-f',
      'lavfi',
      '-i',
      'anullsrc=r=48000:cl=mono',
      '-t',
      '1',
      '-c:v',
      'libx264',
      '-c:a',
      'aac',
      videoFile,
    ]);
    await fs.rm(qaFile, { force: true });
    core.context.repos.runs.updateStatus(runId, 'interrupted');

    let caughtQaErr: PipelineError | null = null;
    try {
      await resumeRun(core.context, runId);
    } catch (err) {
      caughtQaErr = err as PipelineError;
    }
    expect(caughtQaErr?.code).toBe('qa_failed');
    const failedQa = await readJsonOrNull<QaReport>(qaFile);
    expect(failedQa?.passed).toBe(false);

    await resumeRun(core.context, runId, { fromStage: 'render' });
    const recoveredQa = await readJsonOrNull<QaReport>(qaFile);
    expect(recoveredQa?.passed).toBe(true);
    expect(core.context.repos.runs.getById(runId)?.status).toBe('awaiting_review');

    await core.close();
  }, 90_000);

  it('保留句子音量并根据视频时长增加处理等待时间', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aidaily-master-volume-'));
    tempDirs.push(tmpDir);
    const source = path.join(tmpDir, 'source.wav');
    const output = path.join(tmpDir, 'master.wav');
    await execa('ffmpeg', [
      '-y',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:duration=4',
      '-ac',
      '2',
      source,
    ]);
    await buildMasterAudioWav({
      runDir: tmpDir,
      rootDir: tmpDir,
      outWav: output,
      sampleRate: 48000,
      loudnessLUFS: -16,
      isSilentProvider: false,
      bgm: { file: '', volumeDb: -18, duckDb: -8 },
      timeline: {
        totalMs: 20000,
        sections: [
          {
            key: 'intro',
            kind: 'intro',
            audioFile: 'source.wav',
            startMs: 0,
            speechMs: 4000,
            pageMs: 20000,
            sentences: [],
          },
        ],
      },
    });
    const readVolume = async (file: string) => {
      const result = await execa('ffmpeg', [
        '-hide_banner',
        '-i',
        file,
        '-t',
        '3',
        '-af',
        'volumedetect',
        '-f',
        'null',
        '-',
      ]);
      const match = /mean_volume: ([\d.-]+) dB/.exec(result.stderr);
      if (!match) throw new Error('未能测量音量');
      return Number(match[1]);
    };
    expect(Math.abs((await readVolume(source)) - (await readVolume(output)))).toBeLessThan(0.5);
    expect(mediaTimeoutMs(600_000)).toBeGreaterThan(600_000);
    expect(mediaTimeoutMs(600_000, true)).toBeGreaterThan(mediaTimeoutMs(600_000));
  });

  it('开启口播均衡后将同段内过响与过轻的句子拉平至相近音量', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aidaily-level-voice-'));
    tempDirs.push(tmpDir);
    const uneven = path.join(tmpDir, 'uneven.wav');
    const leveled = path.join(tmpDir, 'leveled.wav');

    // FFmpeg sine 默认基准约 -23 dB，此处构造 -9 dB（过响）与 -25 dB（偏轻）的两段真实口播电平（中间保留 0.4s 停顿）
    await execa('ffmpeg', [
      '-y',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:sample_rate=48000:duration=4.4',
      '-af',
      'volume=5.0:enable=between(t\\,0\\,1.8),volume=0.0:enable=between(t\\,1.8\\,2.2),volume=0.8:enable=between(t\\,2.2\\,4.4)',
      uneven,
    ]);

    await buildMasterAudioWav({
      runDir: tmpDir,
      rootDir: tmpDir,
      outWav: leveled,
      sampleRate: 48000,
      loudnessLUFS: -16,
      isSilentProvider: false,
      levelVoice: true,
      bgm: { file: '', volumeDb: -9, duckDb: -5 },
      timeline: {
        totalMs: 4400,
        sections: [
          {
            key: 'intro',
            kind: 'intro',
            audioFile: 'uneven.wav',
            startMs: 0,
            speechMs: 4400,
            pageMs: 4400,
            sentences: [],
          },
        ],
      },
    });

    const readSliceMean = async (startSec: number, durSec: number) => {
      const res = await execa('ffmpeg', [
        '-hide_banner',
        '-ss',
        String(startSec),
        '-t',
        String(durSec),
        '-i',
        leveled,
        '-af',
        'volumedetect',
        '-f',
        'null',
        '-',
      ]);
      const match = /mean_volume: ([\d.-]+) dB/.exec(res.stderr);
      if (!match) throw new Error('未能测量分段音量');
      return Number(match[1]);
    };

    const loudHalf = await readSliceMean(0.3, 1.2);
    const pauseGap = await readSliceMean(1.85, 0.3);
    const quietHalf = await readSliceMean(2.5, 1.4);
    expect(Math.abs(loudHalf - quietHalf)).toBeLessThan(3.5);
    expect(pauseGap).toBeLessThan(-60);
  });

  it('limits speech peaks and mixes sidechain-ducked BGM cleanly', async () => {
    const { rootDir, settingsFile } = await setupRenderWorkspace('solid-color');
    const bgmFile = path.join(rootDir, 'bgm.wav');
    await execa('ffmpeg', [
      '-y',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=220:sample_rate=48000:duration=3',
      '-c:a',
      'pcm_s16le',
      bgmFile,
    ]);

    await updateSettingsFile(settingsFile, {
      tts: { provider: 'audible-tone' },
      render: {
        bgm: { file: bgmFile, volumeDb: -20, duckDb: -10 },
      },
    });

    const core = await createCore({
      rootDir,
      fetchImpl: makeSimpleFetch([
        {
          slug: 'n1',
          title: 'Gemini 更新开发者工具套件',
          body: 'Google announced Gemini coding tools with 2x throughput for studio engineers.',
        },
      ]),
    });

    const toneProvider: TtsProvider = {
      id: 'audible-tone',
      async synthesize(req) {
        await execa('ffmpeg', [
          '-y',
          '-f',
          'lavfi',
          '-i',
          'sine=frequency=440:sample_rate=48000:duration=1.2',
          '-c:a',
          'pcm_s16le',
          req.outFile,
        ]);
      },
      async healthcheck() {
        return { ok: true, detail: '440Hz tone generator' };
      },
    };
    core.context.tts.register(toneProvider);

    const runId = createRun(core.context, { itemCount: 1, trigger: 'manual-cli' });
    await executeRun(core.context, runId);

    const qaReport = await readJsonOrNull<QaReport>(
      path.join(core.context.paths.runDir(runId), 'qa.json'),
    );
    expect(qaReport?.passed).toBe(true);
    expect(qaReport?.meanVolumeDb).not.toBeNull();
    expect(qaReport?.meanVolumeDb as number).toBeGreaterThan(-35);

    await core.close();
  }, 90_000);

  it('renders daily-deck template with staged article image asset and passes QA', async () => {
    expect(mapEntityToMascotId('OpenAI')).toBe('gpt');
    expect(mapEntityToMascotId('DeepSeek')).toBe('deepseek');
    expect(mapEntityToMascotId('Anthropic Claude')).toBe('claude');
    expect(mapEntityToMascotId('Google Gemini')).toBe('gemini');
    expect(mapEntityToMascotId('xAI Grok')).toBe('grok');
    expect(mapEntityToMascotId('Meta Llama')).toBe('none');

    const { rootDir } = await setupRenderWorkspace('daily-deck');
    const core = await createCore({ rootDir });

    const samplePng = path.join(core.context.paths.imagesDir, 'art-sample.png');
    await fs.mkdir(path.dirname(samplePng), { recursive: true });
    await execa('ffmpeg', [
      '-y',
      '-f',
      'lavfi',
      '-i',
      'color=c=0x2563eb:s=800x450:d=1',
      '-frames:v',
      '1',
      samplePng,
    ]);

    const runId = createRun(core.context, { itemCount: 1, trigger: 'manual-cli' });
    const nowIso = '2026-11-16T09:00:00.000Z';
    core.context.repos.articles.insertIfAbsent({
      id: 'art-1',
      sourceId: 'primary-feed',
      canonicalUrl: 'https://openai.com/news/test-release',
      title: 'OpenAI 开放新一代代码推理模型预览',
      titleNorm: 'openai 开放新一代代码推理模型预览',
      lang: 'zh',
      publishedAt: nowIso,
      firstSeenAt: nowIso,
      excerpt: 'OpenAI announced today.',
      contentPath: 'storage/articles/art-1.txt',
      contentChars: 120,
      imagePath: path.relative(rootDir, samplePng),
      extractStatus: 'ok',
    });
    core.context.repos.events.insertMany([
      {
        id: 'ev-1',
        runId,
        rank: 1,
        role: 'primary',
        refillRound: 0,
        title: 'OpenAI 开放代码推理模型预览',
        category: '大模型',
        entity: 'OpenAI',
        score: 9.1,
        publicAppeal: 9.0,
        reason: '重大实用更新',
        articleIds: ['art-1'],
      },
    ]);
    core.context.repos.runItems.createMany([
      {
        id: 'item-1',
        runId,
        eventId: 'ev-1',
        position: 1,
        status: 'passed',
        revision: 0,
        dropReason: null,
        finalJson: {
          title: 'OpenAI 开放新一代代码推理模型预览，支持长程规划',
          shortTitle: 'OpenAI 开放新推理预览',
          progressLabel: 'OpenAI推理预览',
          category: '大模型',
          entity: 'OpenAI',
          summary: '今天起，开发者可以直接接入全新推理接口，显著缩短复杂代码调试耗时。',
          keyPoints: ['响应速度提升明显', '支持长文本上下文输入', '已向付费用户全面开放'],
          detail: '开发者可在控制台直接调用并查看推理步骤轨迹。',
          hostComment: '工具越来越顺手了。',
          narration: ['第一条来自 OpenAI。', '开发者现在可以直接调用新接口，加快代码调试效率。'],
          evidence: [
            {
              claim: '支持新接口',
              articleId: 'art-1',
              quote: 'OpenAI announced today.',
            },
          ],
        },
        updatedAt: nowIso,
      },
    ]);

    const pkgData: IssuePackage = {
      order: ['item-1'],
      headlineItemId: 'item-1',
      headline: 'OpenAI 开放代码推理预览，工程调试迎来提速',
      leadSummary: '今天聚焦前沿大模型的实战工程能力升级与开发套件更新。',
      intro: {
        narration: ['大家好，欢迎收看 AI 每日报。'],
        hostComment: '今日热点非常务实。',
      },
      outro: {
        narration: ['以上是本期全部内容，感谢收看。'],
        hostComment: '我们下期再见。',
        cta: '你最关心哪个 AI 工具的实用更新？欢迎留言。',
      },
      publish: {
        title: 'AI每日报｜OpenAI 开放代码推理预览',
        descriptionIntro: '本期聚焦工程推理工具新动态。',
        tags: ['OpenAI'],
      },
    };

    const ttsService = new TtsService({
      settings: core.context.settings.tts,
      cacheDir: core.context.paths.ttsCacheDir,
    });
    const storedItem = core.context.repos.runItems.getById('item-1');
    if (!storedItem) {
      throw new Error('预期测试条目 item-1 存在');
    }
    const sections = buildNarrationSections(pkgData, new Map([['item-1', storedItem]]));
    const runDir = core.context.paths.runDir(runId);
    const audioSections = await ttsService.synthesizeSections(sections, path.join(runDir, 'audio'));
    const timeline = buildTimeline({
      sections,
      audioSections,
      runDir,
      pagePaddingSec: 0.6,
      sectionGapMs: 600,
    });

    const renderCkpt = await runRenderStage({
      ctx: core.context,
      runId,
      settings: core.context.settings,
      packageData: pkgData,
      timeline,
    });
    expect(renderCkpt.frameCount).toBe(3);
    expect(renderCkpt.capturedFrameCount).toBe(3);
    expect(renderCkpt.reusedFrameCount).toBe(0);

    const page0Stat = await fs.stat(path.join(runDir, 'frames', 'page-00.png'));
    const page1Stat = await fs.stat(path.join(runDir, 'frames', 'page-01.png'));
    const page2Stat = await fs.stat(path.join(runDir, 'frames', 'page-02.png'));
    const sec0Stat = await fs.stat(path.join(runDir, 'frames', 'section-00.mp4'));
    const sec1Stat = await fs.stat(path.join(runDir, 'frames', 'section-01.mp4'));
    const sec2Stat = await fs.stat(path.join(runDir, 'frames', 'section-02.mp4'));
    expect(page0Stat.size).toBeGreaterThan(5000);
    expect(page1Stat.size).toBeGreaterThan(5000);
    expect(page2Stat.size).toBeGreaterThan(5000);
    expect(sec0Stat.size).toBeGreaterThan(2000);
    expect(sec1Stat.size).toBeGreaterThan(2000);
    expect(sec2Stat.size).toBeGreaterThan(2000);

    const sectionsProg = await readJsonOrNull<{
      template: string;
      sections: Record<string, unknown>;
    }>(path.join(runDir, 'frames', 'sections-progress.json'));
    expect(sectionsProg?.template).toBe('daily-deck');
    expect(Object.keys(sectionsProg?.sections ?? {})).toHaveLength(3);

    const tplData = await readJsonOrNull<Record<string, unknown>>(
      path.join(runDir, 'template-data.json'),
    );
    expect(tplData?.hostLive2dUrl).toBe(
      '/__mascot_assets__/fullbody/deepseek/deepseek.model3.json',
    );
    expect(Array.isArray(tplData?.coverLipSync)).toBe(true);

    const stagedAssetStat = await fs.stat(path.join(runDir, 'assets', 'item-01.png'));
    expect(stagedAssetStat.size).toBeGreaterThan(0);

    // 验证章节未发生变更时再次执行渲染可直接复用全部已编码章节分片，无需重新启动浏览器截帧
    const cachedRenderCkpt = await runRenderStage({
      ctx: core.context,
      runId,
      settings: core.context.settings,
      packageData: pkgData,
      timeline,
    });
    expect(cachedRenderCkpt.reusedFrameCount).toBe(3);
    expect(cachedRenderCkpt.capturedFrameCount).toBe(0);

    // 验证即使损坏分片体积超过 1024 字节，ffprobe 校验也会拒绝复用并仅重渲该损坏章节
    await fs.writeFile(
      path.join(runDir, 'frames', 'section-01.mp4'),
      'corrupted-mp4-'.repeat(200),
      'utf8',
    );
    const repairedRenderCkpt = await runRenderStage({
      ctx: core.context,
      runId,
      settings: core.context.settings,
      packageData: pkgData,
      timeline,
    });
    expect(repairedRenderCkpt.reusedFrameCount).toBe(2);
    expect(repairedRenderCkpt.capturedFrameCount).toBe(1);

    const qa = await runQaStage({
      ctx: core.context,
      runId,
      settings: core.context.settings,
      timeline,
    });
    expect(qa.passed).toBe(true);
    expect(qa.width).toBe(1920);
    expect(qa.height).toBe(1080);

    // 验证实际截出的视频帧画布边缘像素处于深色模式（RGB 亮度低），而非浅色纸张底色
    expect(resolveRenderTheme(core.context.settings.render)).toBe('dark');
    const samplePixelRgb = async (pngPath: string): Promise<[number, number, number]> => {
      const { stdout } = await execa(
        'ffmpeg',
        [
          '-v',
          'error',
          '-i',
          pngPath,
          '-vf',
          'crop=1:1:10:10',
          '-f',
          'rawvideo',
          '-pix_fmt',
          'rgb24',
          'pipe:1',
        ],
        { encoding: 'buffer' },
      );
      return [stdout[0] ?? 0, stdout[1] ?? 0, stdout[2] ?? 0];
    };

    const [darkR, darkG, darkB] = await samplePixelRgb(path.join(runDir, 'frames', 'page-01.png'));
    expect(darkR).toBeLessThan(45);
    expect(darkG).toBeLessThan(45);
    expect(darkB).toBeLessThan(45);

    // 验证切换 render.theme 会使章节缓存摘要失效并按浅色主题重渲
    const lightRenderCkpt = await runRenderStage({
      ctx: core.context,
      runId,
      settings: {
        ...core.context.settings,
        render: { ...core.context.settings.render, theme: 'light' },
      },
      packageData: pkgData,
      timeline,
    });
    expect(lightRenderCkpt.capturedFrameCount).toBe(3);
    expect(lightRenderCkpt.reusedFrameCount).toBe(0);
    const [lightR, lightG, lightB] = await samplePixelRgb(
      path.join(runDir, 'frames', 'page-01.png'),
    );
    expect(lightR).toBeGreaterThan(180);
    expect(lightG).toBeGreaterThan(180);
    expect(lightB).toBeGreaterThan(180);

    // 验证缺失音轨及损坏 PNG 文件头时，质检阶段仍会把失败明细写入 qa.json 再抛出异常
    const qaFile = path.join(runDir, 'qa.json');
    await fs.rm(qaFile, { force: true });
    await fs.writeFile(path.join(runDir, 'frames', 'page-00.png'), 'x'.repeat(2048), 'utf8');
    await runMediaCommand('ffmpeg', [
      '-y',
      '-f',
      'lavfi',
      '-i',
      'color=c=blue:s=1920x1080:d=1',
      '-an',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      path.join(runDir, 'output', 'video.mp4'),
    ]);
    await expect(
      runQaStage({
        ctx: core.context,
        runId,
        settings: core.context.settings,
        timeline,
      }),
    ).rejects.toThrow(/成片质检未通过/);

    const damagedReport = await readJsonOrNull<QaReport>(qaFile);
    expect(damagedReport?.passed).toBe(false);
    expect(damagedReport?.checks.find((c) => c.name === 'streams_present')?.passed).toBe(false);
    expect(damagedReport?.checks.find((c) => c.name === 'audio_volume')?.passed).toBe(false);
    expect(damagedReport?.checks.find((c) => c.name === 'frame_screenshots')?.detail).toContain(
      '文件头非PNG',
    );

    await core.close();
  }, 90_000);

  it('stages a single primary media asset, suppresses secondaryImageUrl in daily-deck, and supports candidate selection', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aidaily-dual-img-'));
    tempDirs.push(tmpDir);
    await fs.mkdir(path.join(tmpDir, 'config'), { recursive: true });
    await fs.mkdir(path.join(tmpDir, 'storage', 'articles'), { recursive: true });
    await fs.mkdir(path.join(tmpDir, 'storage', 'images'), { recursive: true });
    await fs.copyFile(
      path.join(REPO_ROOT, 'config', 'settings.yaml'),
      path.join(tmpDir, 'config', 'settings.yaml'),
    );
    await fs.copyFile(
      path.join(REPO_ROOT, 'config', 'sources.yaml'),
      path.join(tmpDir, 'config', 'sources.yaml'),
    );

    const core = await createCore({ rootDir: tmpDir });
    const png1x1 = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+X2ZkAAAAASUVORK5CYII=',
      'base64',
    );
    try {
      const nowIso = '2026-11-16T09:00:00.000Z';
      await fs.writeFile(path.join(tmpDir, 'storage', 'images', 'art-tw.png'), png1x1);
      await fs.writeFile(path.join(tmpDir, 'storage', 'images', 'art-tbl.png'), png1x1);
      await fs.writeFile(path.join(tmpDir, 'storage', 'images', 'art-chart.png'), png1x1);
      await writeJsonAtomic(path.join(tmpDir, 'storage', 'articles', 'art-dual.json'), {
        title: 'Model Release with Tweet and Benchmark',
        text: 'OpenAI released GPT-5.2 with verified SWE-bench benchmark score.',
        mediaAssets: [
          {
            id: 'cand-tw',
            articleId: 'art-dual',
            kind: 'tweet_shot',
            imagePath: 'storage/images/art-tw.png',
            sourceUrl: 'https://x.com/thsottiaux/status/1',
            captionHint: '@thsottiaux 官宣推文',
            contextSnippet: 'Official launch post',
            score: 94,
          },
          {
            id: 'cand-tbl',
            articleId: 'art-dual',
            kind: 'table_shot',
            imagePath: 'storage/images/art-tbl.png',
            sourceUrl: null,
            captionHint: 'SWE-bench 跑分对比表',
            contextSnippet: '84.5% vs 71.2%',
            score: 90,
          },
          {
            id: 'cand-chart',
            articleId: 'art-dual',
            kind: 'chart',
            imagePath: 'storage/images/art-chart.png',
            sourceUrl: 'https://openai.com/chart.png',
            captionHint: '推理延迟成本对比图',
            contextSnippet: 'Cost down 50%',
            score: 86,
          },
        ],
      });

      core.context.repos.articles.insertIfAbsent({
        id: 'art-dual',
        sourceId: 'openai-news',
        canonicalUrl: 'https://openai.com/news/dual',
        title: 'Model Release with Tweet and Benchmark',
        titleNorm: 'model release with tweet and benchmark',
        lang: 'en',
        publishedAt: nowIso,
        firstSeenAt: nowIso,
        excerpt: 'Model launch with benchmark comparison.',
        contentPath: 'storage/articles/art-dual.json',
        contentChars: 200,
        imagePath: 'storage/images/art-tw.png',
        extractStatus: 'ok',
      });

      const runId = createRun(core.context, { itemCount: 1, trigger: 'manual-web' });
      const runDir = core.context.paths.runDir(runId);
      core.context.repos.events.insertMany([
        {
          id: 'ev-dual-1',
          runId,
          rank: 1,
          role: 'primary',
          refillRound: 0,
          title: 'OpenAI 发布新模型',
          category: '大模型',
          entity: 'OpenAI',
          score: 9.2,
          publicAppeal: 8.8,
          reason: '重磅更新',
          articleIds: ['art-dual'],
        },
      ]);
      core.context.repos.runItems.createMany([
        {
          id: 'item-dual-1',
          runId,
          eventId: 'ev-dual-1',
          position: 1,
          status: 'passed',
          revision: 0,
          dropReason: null,
          finalJson: {
            title: 'OpenAI 发布推理新模型',
            shortTitle: 'OpenAI发新模型',
            progressLabel: 'OpenAI新模型',
            category: '大模型',
            entity: 'OpenAI',
            summary: '新版本给出推文公告与跑分对比表。',
            preferArticleImage: true,
            primaryMediaId: 'cand-tw',
            secondaryMediaId: 'cand-tbl',
            imageCaption: '官宣推文与跑分对比表',
            keyPoints: ['支持推理升级', '延迟减半'],
            detail: '工程博客公布了完整测试结果。',
            hostComment: '数据扎实。',
            narration: ['OpenAI 今天发布推理模型更新，并附上了跑分对比表。'],
            evidence: [
              {
                claim: '发布新模型',
                articleId: 'art-dual',
                quote: 'OpenAI released GPT-5.2 with verified SWE-bench benchmark score.',
              },
            ],
          },
          updatedAt: nowIso,
        },
      ]);

      const pkg: IssuePackage = {
        order: ['item-dual-1'],
        headlineItemId: 'item-dual-1',
        headline: 'OpenAI 发布推理新模型',
        leadSummary: '双图实测展示推文与跑分。',
        intro: { narration: ['欢迎收看每日报。'], hostComment: '来看细节。' },
        outro: { narration: ['以上是今天全部内容。'], hostComment: '下期见。', cta: '欢迎讨论。' },
        publish: {
          title: 'OpenAI 推理新模型重磅上线，实测跑分全面领先！',
          descriptionIntro: '快讯',
          tags: ['AI'],
        },
      };
      const timeline: Timeline = {
        totalMs: 12_000,
        sections: [
          {
            key: 'intro',
            kind: 'intro',
            audioFile: 'audio/intro.wav',
            startMs: 0,
            speechMs: 2000,
            pageMs: 3000,
            sentences: [{ text: '欢迎收看每日报。', startMs: 0, durationMs: 2000 }],
          },
          {
            key: 'item-dual-1',
            kind: 'item',
            itemId: 'item-dual-1',
            audioFile: 'audio/item-1.wav',
            startMs: 3000,
            speechMs: 4000,
            pageMs: 5000,
            sentences: [{ text: 'OpenAI 今天发布推理模型更新。', startMs: 3000, durationMs: 4000 }],
          },
          {
            key: 'outro',
            kind: 'outro',
            audioFile: 'audio/outro.wav',
            startMs: 8000,
            speechMs: 2000,
            pageMs: 4000,
            sentences: [{ text: '以上是今天全部内容。', startMs: 8000, durationMs: 2000 }],
          },
        ],
      };

      const renderIssue = await buildRenderableIssue({
        ctx: core.context,
        runId,
        settings: core.context.settings,
        packageData: pkg,
      });
      expect(renderIssue.items[0]?.imagePath).toBe('assets/item-01.png');
      expect(renderIssue.items[0]?.secondaryImagePath).toBeUndefined();

      const adapter = createDailyDeckAdapter();
      const deckData = adapter.buildData(renderIssue, timeline) as {
        items: Array<{ imageUrl: string | null; secondaryImageUrl: string | null }>;
      };
      expect(deckData.items[0]?.imageUrl).toBe('/__run_assets__/assets/item-01.png');
      expect(deckData.items[0]?.secondaryImageUrl).toBeNull();

      // 将任务切为可调图状态，测试 getRunMediaCandidates 暂存与 setItemImage 单图候选切换
      core.context.repos.runs.updateStatus(runId, 'awaiting_review');
      const candMap = await core.tasks.getRunMediaCandidates(runId);
      expect(candMap['item-dual-1']).toHaveLength(3);
      const firstCandPath = candMap['item-dual-1']?.[0]?.artifactRelPath ?? '';
      await expect(fs.stat(path.join(runDir, firstCandPath))).resolves.toBeDefined();

      await core.tasks.setItemImage(runId, 'item-dual-1', {
        mode: 'custom',
        selectedPrimaryMediaId: 'cand-chart',
      });
      const updatedItem = core.context.repos.runItems.getById('item-dual-1');
      expect(updatedItem?.selectedMediaIds).toEqual({
        primary: 'cand-chart',
      });

      await core.tasks.setItemImage(runId, 'item-dual-1', {
        mode: 'custom',
        selectedPrimaryMediaId: 'cand-tw',
      });
      expect(core.context.repos.runItems.getById('item-dual-1')?.selectedMediaIds).toEqual({
        primary: 'cand-tw',
      });
    } finally {
      await core.close();
    }
  });

  it('区分探测工具缺失与分片损坏，支持结构化校验、阶段错误归类、原子缓存恢复与 render 清脏标志', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aidaily-m5-m14-'));
    tempDirs.push(tmpDir);

    // 验证探测工具缺失时返回 probe_error 且不会把真实分片误删
    const fakeMp4 = path.join(tmpDir, 'seg.mp4');
    await fs.writeFile(fakeMp4, Buffer.alloc(2048, 0xaa));
    const probeRes = await validateMp4Segment({
      filePath: fakeMp4,
      expectedDurationMs: 2000,
      width: 1920,
      height: 1080,
      fps: 30,
      ffprobeBin: path.join(tmpDir, 'nonexistent-ffprobe'),
    });
    expect(probeRes.status).toBe('probe_error');
    await expect(fs.stat(fakeMp4)).resolves.toBeDefined();

    // 验证非大模型阶段异常按所在步骤映射到对应错误码，而非一律归为 llm_unavailable
    expect(toErrorCode(new Error('校验失败'), 'package')).toBe('package_failed');
    expect(toErrorCode(new Error('核查失败'), 'edit')).toBe('editorial_failed');

    // 验证 readJsonOrNullWithSchema 对损坏 JSON 结构给出明确校验异常
    const badJsonFile = path.join(tmpDir, 'bad-ckpt.json');
    await fs.writeFile(badJsonFile, JSON.stringify({ unexpected: true }), 'utf8');
    await expect(
      readJsonOrNullWithSchema(badJsonFile, z.object({ packageData: z.object({}) }), {
        label: '测试检查点',
      }),
    ).rejects.toThrow(/JSON 文件格式校验失败/);

    // 验证 TTS 缓存原子写恢复不残留临时文件
    const cacheDir = path.join(tmpDir, 'tts-cache');
    const srcWav = path.join(tmpDir, 'src.wav');
    const destWav = path.join(tmpDir, 'out', 'restored.wav');
    await fs.writeFile(srcWav, Buffer.from('RIFFtestwavdata'));
    await saveToCache(cacheDir, 'k1', srcWav);
    expect(await tryRestoreFromCache(cacheDir, 'k1', destWav)).toBe(true);
    expect(await fs.readFile(destWav)).toEqual(Buffer.from('RIFFtestwavdata'));
    const outFiles = await fs.readdir(path.dirname(destWav));
    expect(outFiles).toEqual(['restored.wav']);

    // 验证 render 阶段成功后（即使止步于 render 或后续 qa 失败）立即清除 media_dirty 标记
    const { rootDir } = await setupRenderWorkspace('solid-color');
    const core = await createCore({ rootDir });
    try {
      const runId = createRun(core.context, { itemCount: 1, trigger: 'manual-cli' });
      core.context.db.prepare('UPDATE runs SET media_dirty = 1 WHERE id = ?').run(runId);
      await expect(
        executeRun(core.context, runId, {
          stageOverrides: {
            collect: async () => ({
              sourcesOk: [],
              sourcesFailed: [],
              sourcesSkipped: [],
              newArticleIds: [],
              expiredCount: 0,
            }),
            select: async () => ({ selectedCount: 1 }),
            edit: async () => ({ passedItemIds: ['item-1'], droppedItemIds: [] }),
            package: async () => ({ packaged: true }),
            narrate: async () => ({ narrated: true }),
            render: async () => ({ rendered: true }),
            qa: async () => {
              throw new Error('qa check rejected');
            },
          },
        }),
      ).rejects.toThrow('qa check rejected');

      const dirtyRow = core.context.db
        .prepare('SELECT media_dirty FROM runs WHERE id = ?')
        .get(runId) as { media_dirty: number } | undefined;
      expect(dirtyRow?.media_dirty).toBe(0);
    } finally {
      await core.close();
    }
  });
});
