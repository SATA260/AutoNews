import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { IssuePackage, QaReport, Timeline } from '@aidaily/contracts';
import { type TtsProvider, TtsService } from '@aidaily/tts';
import { execa } from 'execa';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildMasterAudioWav,
  buildNarrationSections,
  buildTimeline,
  createCore,
  createRun,
  editSettingsFile,
  executeRun,
  mapEntityToMascotId,
  mediaTimeoutMs,
  type PipelineError,
  type RenderCheckpoint,
  readJsonOrNull,
  resumeRun,
  runMediaCommand,
  runQaStage,
  runRenderStage,
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
  }, 60_000);

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
  }, 60_000);

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
    expect(tplData?.hostLive2dUrl).toBe('/__mascot_assets__/gemini/gemini.model3.json');
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
  }, 60_000);
});
