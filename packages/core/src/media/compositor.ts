import crypto from 'node:crypto';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type {
  ImpactLevel,
  IssuePackage,
  PagePlan,
  RenderableIssue,
  RenderableNewsItem,
  RunItemRecord,
  Settings,
  TemplateAdapter,
  Timeline,
} from '@aidaily/contracts';
import { TZDate } from '@date-fns/tz';
import { format } from 'date-fns';
import { chromium } from 'playwright';
import type { CoreContext } from '../context.js';
import { PipelineError } from '../errors.js';
import { readJsonOrNull, writeFileAtomic, writeJsonAtomic } from '../storage/files.js';
import {
  createDefaultTemplateRegistry,
  resolveActiveTemplate,
  type TemplateRegistry,
} from '../templates/registry.js';
import { buildMasterAudioWav, composeSlidesVideoMp4, renderCoverJpg } from './ffmpeg.js';

/** 成片渲染阶段完成后写入检查点的产物摘要 */
export interface RenderCheckpoint {
  videoPath: string;
  coverPath: string;
  masterAudioPath: string;
  template: string;
  frameCount: number;
  capturedFrameCount: number;
  reusedFrameCount: number;
  totalMs: number;
}

interface FramesProgressRecord {
  digest: string;
  width: number;
  height: number;
  template: string;
}

const PNG_HEADER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_IEND_TRAILER = Buffer.from([0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);

/** 检查截图文件是否为完整非截断的有效 PNG 图片（校验文件体积及首尾标志字节） */
async function isValidPngFile(filePath: string, minBytes = 1024): Promise<boolean> {
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile() || stat.size < minBytes) {
      return false;
    }
    const fh = await fs.open(filePath, 'r');
    try {
      const head = Buffer.alloc(8);
      await fh.read(head, 0, 8, 0);
      if (!head.equals(PNG_HEADER)) {
        return false;
      }
      const tailLen = Math.min(32, stat.size);
      const tail = Buffer.alloc(tailLen);
      await fh.read(tail, 0, tailLen, stat.size - tailLen);
      return tail.includes(PNG_IEND_TRAILER);
    } finally {
      await fh.close();
    }
  } catch {
    return false;
  }
}

/** 根据事件评分映射重要程度等级标签 */
function mapScoreToImpact(score: number): ImpactLevel {
  if (score >= 8.5) {
    return 'breaking';
  }
  if (score >= 7) {
    return 'high';
  }
  return 'normal';
}

/**
 * 探测可用的 Chromium 可执行程序路径：
 * 优先使用与当前 Playwright 版本完全匹配的浏览器；
 * 若当前目录缺少完整版，依次回退查找本地已缓存的 Playwright Chromium 与系统 Google Chrome。
 */
export async function resolveChromiumExecutablePath(): Promise<string | undefined> {
  const defaultExe = chromium.executablePath();
  if (defaultExe && fsSync.existsSync(defaultExe)) {
    return defaultExe;
  }

  const cacheDir = path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright');
  try {
    const entries = await fs.readdir(cacheDir, { withFileTypes: true });
    const sorted = entries
      .filter((e) => e.isDirectory() && e.name.startsWith('chromium-'))
      .sort((a, b) => b.name.localeCompare(a.name, undefined, { numeric: true }));

    for (const dir of sorted) {
      const armExe = path.join(
        cacheDir,
        dir.name,
        'chrome-mac-arm64',
        'Google Chrome for Testing.app',
        'Contents',
        'MacOS',
        'Google Chrome for Testing',
      );
      if (fsSync.existsSync(armExe)) {
        return armExe;
      }
      const x64Exe = path.join(
        cacheDir,
        dir.name,
        'chrome-mac',
        'Google Chrome for Testing.app',
        'Contents',
        'MacOS',
        'Google Chrome for Testing',
      );
      if (fsSync.existsSync(x64Exe)) {
        return x64Exe;
      }
    }
  } catch {
    // 缓存目录不存在时继续尝试系统安装的浏览器
  }

  const systemChrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  if (fsSync.existsSync(systemChrome)) {
    return systemChrome;
  }

  return undefined;
}

const ALLOWED_IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.avif']);

/** 安全地把已下载的新闻配图复制到本期任务独立素材目录下，保障模板预览服务只暴露任务目录 */
async function stageArticleAssetIntoRunDir(opts: {
  ctx: CoreContext;
  runDir: string;
  relImagePath: string | null | undefined;
  itemIndex: number;
}): Promise<string | undefined> {
  const { ctx, runDir, relImagePath, itemIndex } = opts;
  if (!relImagePath || relImagePath.includes('\0')) {
    return undefined;
  }
  const resolvedRoot = path.resolve(ctx.paths.rootDir);
  const candidate = path.resolve(resolvedRoot, relImagePath);
  if (!candidate.startsWith(`${resolvedRoot}${path.sep}`)) {
    return undefined;
  }

  try {
    const stat = await fs.stat(candidate);
    if (!stat.isFile() || stat.size === 0) {
      return undefined;
    }
    const rootReal = await fs.realpath(resolvedRoot).catch(() => resolvedRoot);
    const realSrc = await fs.realpath(candidate);
    if (!realSrc.startsWith(`${rootReal}${path.sep}`)) {
      return undefined;
    }
    const ext = path.extname(realSrc).toLowerCase();
    if (!ALLOWED_IMAGE_EXTENSIONS.has(ext)) {
      return undefined;
    }
    const fileName = `item-${String(itemIndex + 1).padStart(2, '0')}${ext}`;
    const relDest = path.posix.join('assets', fileName);
    const absDest = path.join(runDir, relDest);
    const buf = await fs.readFile(realSrc);
    await writeFileAtomic(absDest, buf);
    return relDest;
  } catch {
    return undefined;
  }
}

/** 将整期编排结果、新闻条目定稿和原始文章信息组装为供模板消费的标准 RenderableIssue */
export async function buildRenderableIssue(opts: {
  ctx: CoreContext;
  runId: string;
  settings: Settings;
  packageData: IssuePackage;
}): Promise<RenderableIssue> {
  const { ctx, runId, settings, packageData } = opts;
  const run = ctx.repos.runs.getById(runId);
  if (!run) {
    throw new Error(`未找到任务记录: ${runId}`);
  }
  const runDir = ctx.paths.runDir(runId);

  const createdMs = Date.parse(run.createdAt);
  const tzDate = new TZDate(
    Number.isNaN(createdMs) ? ctx.now().getTime() : createdMs,
    settings.timezone,
  );
  const dateStr = format(tzDate, 'yyyy-MM-dd');
  const issueNumber = `VOL.${format(tzDate, 'yyyy.MM.dd')}`;

  const items = ctx.repos.runItems.listByRun(runId);
  const itemById = new Map<string, RunItemRecord>(items.map((i) => [i.id, i]));
  const events = ctx.repos.events.listByRun(runId);
  const eventById = new Map(events.map((e) => [e.id, e]));
  const sourceNameById = new Map(ctx.sources.map((s) => [s.id, s.name]));

  const renderItems: RenderableNewsItem[] = [];
  for (let i = 0; i < packageData.order.length; i++) {
    const itemId = packageData.order[i];
    if (!itemId) {
      continue;
    }
    const item = itemById.get(itemId);
    if (!item?.finalJson) {
      throw new Error(`新闻条目 ${itemId} 缺少定稿数据，无法组装画面`);
    }
    const ev = eventById.get(item.eventId);
    const primaryArticleId = item.finalJson.evidence[0]?.articleId ?? ev?.articleIds[0] ?? null;
    const primaryArticle = primaryArticleId ? ctx.repos.articles.getById(primaryArticleId) : null;

    const stagedImageRel = await stageArticleAssetIntoRunDir({
      ctx,
      runDir,
      relImagePath: primaryArticle?.imagePath,
      itemIndex: i,
    });

    const sourceDisplay = primaryArticle
      ? (sourceNameById.get(primaryArticle.sourceId) ?? primaryArticle.sourceId)
      : 'AI 每日报整理';

    renderItems.push({
      ...item.finalJson,
      id: item.id,
      position: i + 1,
      source: sourceDisplay,
      sourceUrl: primaryArticle?.canonicalUrl ?? '',
      publishedAt: primaryArticle?.publishedAt ?? run.createdAt,
      imagePath: stagedImageRel,
      impact: mapScoreToImpact(ev?.score ?? 5),
    });
  }

  return {
    date: dateStr,
    issueNumber,
    headline: packageData.headline,
    leadSummary: packageData.leadSummary,
    intro: packageData.intro,
    outro: packageData.outro,
    items: renderItems,
  };
}

/**
 * 执行视频渲染与音画合成阶段：
 * 1) 组装画面数据并校验帧摘要，断点重跑时自动跳过已完整落盘的页面截图；
 * 2) 启动模板本地服务与 Playwright 无头浏览器截取缺失页面（退出前确保关闭浏览器和服务）；
 * 3) 生成封面图、校准全片主音轨（含响度平衡及可选背景音乐侧链压缩）并封装标准 MP4。
 */
export async function runRenderStage(opts: {
  ctx: CoreContext;
  runId: string;
  settings: Settings;
  packageData: IssuePackage;
  timeline: Timeline;
  registry?: TemplateRegistry;
  ffmpegBin?: string;
  signal?: AbortSignal;
}): Promise<RenderCheckpoint> {
  const { ctx, runId, settings, packageData, timeline, registry, ffmpegBin, signal } = opts;

  if (signal?.aborted) {
    throw new DOMException('已取消', 'AbortError');
  }

  const runDir = ctx.paths.runDir(runId);
  const framesDir = path.join(runDir, 'frames');
  const progressFile = path.join(framesDir, 'frames-progress.json');
  const templateDataFile = path.join(runDir, 'template-data.json');
  const masterWavFile = path.join(runDir, 'audio', 'master.wav');
  const outputDir = path.join(runDir, 'output');
  const videoFile = path.join(outputDir, 'video.mp4');
  const coverFile = path.join(outputDir, 'cover.jpg');

  const resolvedTemplate = resolveActiveTemplate(
    ctx,
    settings,
    registry ?? createDefaultTemplateRegistry(),
  );
  const adapter: TemplateAdapter = resolvedTemplate.adapter;

  const issue = await buildRenderableIssue({ ctx, runId, settings, packageData });
  const templateData = adapter.buildData(issue, timeline);
  const plan: PagePlan[] = adapter.planPages(issue, timeline);
  if (plan.length === 0) {
    throw new PipelineError('render_failed', '模板页面计划为空，无法合成视频');
  }

  await writeJsonAtomic(templateDataFile, templateData);

  const digest = crypto
    .createHash('sha1')
    .update(
      JSON.stringify({
        template: resolvedTemplate.name,
        adapter: adapter.id,
        width: settings.render.width,
        height: settings.render.height,
        templateData,
        plan,
      }),
      'utf8',
    )
    .digest('hex');

  const prevProgress = await readJsonOrNull<FramesProgressRecord>(progressFile);
  const digestMatched =
    prevProgress?.digest === digest &&
    prevProgress.width === settings.render.width &&
    prevProgress.height === settings.render.height;

  if (!digestMatched) {
    // 模板数据或尺寸变更时彻底清理旧帧目录，禁止吞掉权限错误导致新旧截屏混用
    await fs.rm(framesDir, { recursive: true, force: true });
  }
  await fs.mkdir(framesDir, { recursive: true });
  await writeJsonAtomic(progressFile, {
    digest,
    width: settings.render.width,
    height: settings.render.height,
    template: resolvedTemplate.name,
  });

  const frameFilesByIdx = new Map<number, string>();
  const pendingPlan: PagePlan[] = [];
  for (const p of plan) {
    const file = path.join(framesDir, `page-${String(p.index).padStart(2, '0')}.png`);
    frameFilesByIdx.set(p.index, file);
    if (digestMatched && (await isValidPngFile(file))) {
      continue;
    }
    await fs.rm(file, { force: true }).catch(() => undefined);
    pendingPlan.push(p);
  }

  if (pendingPlan.length > 0) {
    if (signal?.aborted) {
      throw new DOMException('已取消', 'AbortError');
    }

    const exePath = await resolveChromiumExecutablePath();
    const server = await adapter.prepare({ dir: resolvedTemplate.dir, runDir });
    let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;
    const onAbort = () => {
      void browser?.close().catch(() => undefined);
      void server.close().catch(() => undefined);
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    try {
      if (signal?.aborted) {
        throw new DOMException('已取消', 'AbortError');
      }
      browser = await chromium.launch({
        headless: true,
        handleSIGINT: false,
        handleSIGTERM: false,
        handleSIGHUP: false,
        ...(exePath ? { executablePath: exePath } : {}),
      });
      const browserCtx = await browser.newContext({
        viewport: { width: settings.render.width, height: settings.render.height },
        deviceScaleFactor: 1,
      });
      const page = await browserCtx.newPage();
      await page.setViewportSize({
        width: settings.render.width,
        height: settings.render.height,
      });
      await page.goto(`${server.baseUrl}/?clean=1&transition=none&motion=static`, {
        waitUntil: 'load',
        timeout: 30_000,
      });
      await adapter.capture(page, templateData, pendingPlan, framesDir);
      if (signal?.aborted) {
        throw new DOMException('已取消', 'AbortError');
      }
    } catch (err) {
      if (signal?.aborted || (err instanceof Error && err.name === 'AbortError')) {
        throw new DOMException('已取消', 'AbortError');
      }
      throw new PipelineError(
        'render_failed',
        `浏览器截图渲染失败: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    } finally {
      signal?.removeEventListener('abort', onAbort);
      try {
        if (browser) {
          await Promise.race([
            browser.close().catch(() => undefined),
            new Promise<void>((r) => setTimeout(r, 5000)),
          ]);
        }
      } finally {
        await server.close().catch(() => undefined);
      }
    }
  }

  const orderedFrames: string[] = [];
  const orderedDurations: number[] = [];
  for (const p of plan) {
    const file = frameFilesByIdx.get(p.index);
    if (!file || !(await isValidPngFile(file))) {
      throw new PipelineError('render_failed', `缺少或损坏的渲染帧截图: ${file ?? p.sectionKey}`);
    }
    orderedFrames.push(file);
    orderedDurations.push(p.durationMs);
  }

  const firstFrame = orderedFrames[0];
  if (!firstFrame) {
    throw new PipelineError('render_failed', '无法生成视频封面图：缺少首帧截图');
  }

  try {
    await renderCoverJpg({
      inPng: firstFrame,
      outJpg: coverFile,
      ffmpegBin,
      signal,
    });

    await buildMasterAudioWav({
      timeline,
      runDir,
      outWav: masterWavFile,
      sampleRate: settings.tts.postprocess.sampleRate,
      loudnessLUFS: settings.tts.postprocess.loudnessLUFS,
      isSilentProvider: settings.tts.provider === 'silent',
      bgm: settings.render.bgm,
      rootDir: ctx.paths.rootDir,
      ffmpegBin,
      signal,
    });

    await composeSlidesVideoMp4({
      frameFiles: orderedFrames,
      pageDurationsMs: orderedDurations,
      totalMs: timeline.totalMs,
      masterWav: masterWavFile,
      outMp4: videoFile,
      width: settings.render.width,
      height: settings.render.height,
      fps: settings.render.fps,
      sampleRate: settings.tts.postprocess.sampleRate,
      ffmpegBin,
      signal,
    });
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw err;
    }
    if (err instanceof PipelineError) {
      throw err;
    }
    throw new PipelineError(
      'render_failed',
      `音视频封装合成失败: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }

  return {
    videoPath: path.relative(ctx.paths.rootDir, videoFile),
    coverPath: path.relative(ctx.paths.rootDir, coverFile),
    masterAudioPath: path.relative(ctx.paths.rootDir, masterWavFile),
    template: resolvedTemplate.name,
    frameCount: orderedFrames.length,
    capturedFrameCount: pendingPlan.length,
    reusedFrameCount: orderedFrames.length - pendingPlan.length,
    totalMs: timeline.totalMs,
  };
}
