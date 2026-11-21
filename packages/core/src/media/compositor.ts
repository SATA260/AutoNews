import crypto from 'node:crypto';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  HostMascotId,
  ImpactLevel,
  IssuePackage,
  Live2dPack,
  MascotMood,
  PagePlan,
  RenderableIssue,
  RenderableNewsItem,
  RenderTheme,
  RunItemRecord,
  SectionRenderPlan,
  Settings,
  TemplateAdapter,
  Timeline,
} from '@aidaily/contracts';
import { HostMascotIdSchema } from '@aidaily/contracts';
import { isLocalVoiceCloneProvider } from '@aidaily/tts';
import { TZDate } from '@date-fns/tz';
import { format } from 'date-fns';
import { execa } from 'execa';
import { chromium } from 'playwright';
import { z } from 'zod';
import type { CoreContext } from '../context.js';
import { deriveMascotMood, loadPersonas } from '../editorial/personas.js';
import { collectEventMediaPool, loadEventArticles } from '../editorial/s3-summarize.js';
import { PipelineError } from '../errors.js';
import { readJsonOrNullWithSchema, writeFileAtomic, writeJsonAtomic } from '../storage/files.js';
import {
  createDefaultTemplateRegistry,
  resolveActiveTemplate,
  type TemplateRegistry,
} from '../templates/registry.js';
import { resolveEffectiveRunBgm } from './bgm.js';
import { closeBrowserSafely, resolveChromiumExecutablePath } from './browser.js';
import { loadLogoCatalog, resolveCompanyIdentity, resolveLogoAssetsRoot } from './company-logos.js';
import { renderRunCover } from './cover.js';
import {
  buildMasterAudioWav,
  composeSectionVideosMp4,
  composeSlidesVideoMp4,
  computePageTurnSfxTimesMs,
} from './ffmpeg.js';
import { extractWavLipSyncFrames } from './lipsync.js';
import { quantizeTimelineToFps } from './timeline.js';

export { resolveChromiumExecutablePath } from './browser.js';

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

/** 静态整页截图模板的进度与摘要缓存契约 */
const FramesProgressRecordSchema = z.object({
  digest: z.string(),
  width: z.number(),
  height: z.number(),
  template: z.string(),
});

/** 动态视频单个章节分片的摘要与编码规格缓存记录 */
interface SectionCacheRecord {
  sectionDigest: string;
  width: number;
  height: number;
  fps: number;
  frameCount: number;
}

/** 动态视频整期各章节分片缓存索引文件契约 */
const SectionsProgressFileSchema = z.object({
  template: z.string(),
  sections: z.record(
    z.string(),
    z.object({
      sectionDigest: z.string(),
      width: z.number(),
      height: z.number(),
      fps: z.number(),
      frameCount: z.number(),
    }),
  ),
});
type SectionsProgressFile = z.infer<typeof SectionsProgressFileSchema>;

/** 检测章节视频分片时校验 ffprobe JSON 输出的契约结构 */
const FfprobeSegmentSchema = z.object({
  streams: z
    .array(
      z.object({
        codec_name: z.string().optional(),
        width: z.number().optional(),
        height: z.number().optional(),
      }),
    )
    .optional(),
  format: z
    .object({
      duration: z.union([z.string(), z.number()]).optional(),
    })
    .optional(),
});

/** 解析视频合成使用的模板主题外观，未配置时默认使用深色模式 */
export function resolveRenderTheme(renderSettings: Pick<Settings['render'], 'theme'>): RenderTheme {
  return renderSettings.theme === 'light' ? 'light' : 'dark';
}

/** 解析看板娘使用的 Live2D 模型套组，未配置时默认使用全身动作版 */
export function resolveRenderLive2dPack(
  renderSettings: Pick<Settings['render'], 'live2dPack'>,
): Live2dPack {
  return renderSettings.live2dPack === 'expression' ? 'expression' : 'fullbody';
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

/** 根据给定的 ffmpeg 可执行文件路径推断同目录下的 ffprobe 路径，不存在时回退全局命令名 */
function resolveFfprobeFromFfmpeg(ffmpegBin?: string): string {
  if (!ffmpegBin || !path.isAbsolute(ffmpegBin)) {
    return 'ffprobe';
  }
  const candidate = path.join(path.dirname(ffmpegBin), 'ffprobe');
  return fsSync.existsSync(candidate) ? candidate : 'ffprobe';
}

/** 校验章节视频 MP4 分片的返回状态（区分明确损坏与检测工具执行故障） */
export type Mp4SegmentValidationResult =
  | { status: 'ok' }
  | { status: 'invalid'; detail: string }
  | { status: 'probe_error'; detail: string };

/**
 * 校验章节视频 MP4 分片是否完整可读，并通过 ffprobe 核对编码格式、分辨率及实际时长误差不超过一帧。
 * 区分分片本身损坏与 ffprobe 缺失/超时等外部执行异常，防止误删有效成片分片。
 */
export async function validateMp4Segment(opts: {
  filePath: string;
  expectedDurationMs: number;
  width: number;
  height: number;
  fps: number;
  ffprobeBin: string;
}): Promise<Mp4SegmentValidationResult> {
  try {
    const st = await fs.stat(opts.filePath);
    if (!st.isFile() || st.size < 1024) {
      return { status: 'invalid', detail: '分片文件不存在或字节数过小' };
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return { status: 'invalid', detail: '分片文件不存在' };
    }
    return {
      status: 'probe_error',
      detail: err instanceof Error ? err.message : String(err),
    };
  }

  try {
    const res = await execa(
      opts.ffprobeBin,
      [
        '-v',
        'error',
        '-select_streams',
        'v:0',
        '-show_entries',
        'stream=codec_name,width,height:format=duration',
        '-of',
        'json',
        opts.filePath,
      ],
      { timeout: 15_000, reject: false },
    );
    const spawnCode = (res as { code?: string }).code;
    if (res.timedOut) {
      return { status: 'probe_error', detail: 'ffprobe 探测分片超时' };
    }
    if (spawnCode || res.exitCode === undefined) {
      return {
        status: 'probe_error',
        detail: `无法启动 ffprobe (${spawnCode ?? res.stderr ?? '未知错误'})`,
      };
    }
    if (res.exitCode !== 0 || !res.stdout) {
      return {
        status: 'invalid',
        detail: res.stderr?.trim() || `ffprobe 返回异常退出码 ${res.exitCode}`,
      };
    }
    let rawJson: unknown;
    try {
      rawJson = JSON.parse(res.stdout);
    } catch {
      return { status: 'probe_error', detail: 'ffprobe 输出无法解析为合法 JSON' };
    }
    const parsedRes = FfprobeSegmentSchema.safeParse(rawJson);
    if (!parsedRes.success) {
      return { status: 'invalid', detail: '分片媒体流结构不符合预期' };
    }
    const parsed = parsedRes.data;
    const vStream = parsed.streams?.[0];
    if (
      vStream?.codec_name !== 'h264' ||
      Number(vStream.width) !== opts.width ||
      Number(vStream.height) !== opts.height
    ) {
      return {
        status: 'invalid',
        detail: `视频流编码或分辨率不匹配 (${String(vStream?.codec_name)} ${String(vStream?.width)}x${String(vStream?.height)})`,
      };
    }
    const actualDurationMs = Number(parsed.format?.duration) * 1000;
    if (!Number.isFinite(actualDurationMs) || actualDurationMs <= 0) {
      return { status: 'invalid', detail: '分片有效时长缺失或非正数' };
    }
    const toleranceMs = Math.ceil(1000 / Math.max(1, opts.fps)) + 25;
    if (Math.abs(actualDurationMs - opts.expectedDurationMs) > toleranceMs) {
      return {
        status: 'invalid',
        detail: `分片时长超出误差 (${actualDurationMs.toFixed(0)}ms vs ${opts.expectedDurationMs}ms)`,
      };
    }
    return { status: 'ok' };
  } catch (err) {
    return {
      status: 'probe_error',
      detail: err instanceof Error ? err.message : String(err),
    };
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

const ALLOWED_IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.avif']);

/** 安全地把已下载的新闻配图复制到本期任务独立素材目录下，保障模板预览服务只暴露任务目录 */
async function stageArticleAssetIntoRunDir(opts: {
  ctx: CoreContext;
  runDir: string;
  relImagePath: string | null | undefined;
  itemIndex: number;
  slotSuffix?: string;
}): Promise<string | undefined> {
  const { ctx, runDir, relImagePath, itemIndex, slotSuffix } = opts;
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
    const fileName = `item-${String(itemIndex + 1).padStart(2, '0')}${slotSuffix ?? ''}${ext}`;
    const relDest = path.posix.join('assets', fileName);
    const absDest = path.join(runDir, relDest);
    const buf = await fs.readFile(realSrc);
    await writeFileAtomic(absDest, buf);
    return relDest;
  } catch {
    return undefined;
  }
}

const ALLOWED_AUDIO_EXTENSIONS = new Set(['.mp3', '.wav', '.flac', '.m4a', '.ogg']);

/** 安全地将已配置的背景音乐复制到本期任务素材目录中，供前端实时有声预览播放 */
async function stageBgmAssetIntoRunDir(opts: {
  rootDir: string;
  runDir: string;
  bgmSpecFile: string;
}): Promise<string | undefined> {
  const raw = opts.bgmSpecFile.trim();
  if (!raw || raw.includes('\0')) {
    return undefined;
  }
  const resolvedRoot = path.resolve(opts.rootDir);
  const candidate = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(resolvedRoot, raw);
  const ext = path.extname(candidate).toLowerCase();
  if (!ALLOWED_AUDIO_EXTENSIONS.has(ext)) {
    return undefined;
  }
  try {
    const st = await fs.stat(candidate);
    if (!st.isFile() || st.size === 0) {
      return undefined;
    }
    const relDest = path.posix.join('assets', `bgm${ext}`);
    const absDest = path.join(opts.runDir, relDest);
    const buf = await fs.readFile(candidate);
    await writeFileAtomic(absDest, buf);
    return `/__run_assets__/${relDest}`;
  } catch {
    return undefined;
  }
}

/** 按指定模型套组自动扫描角色 Live2D 目录，返回首个 `.model3.json` 的只读服务路径，缺失时自动回退可用套组 */
export async function resolveHostLive2dModelUrl(
  rootDir: string,
  hostId: HostMascotId,
  templateDir?: string,
  live2dPack: Live2dPack = 'fullbody',
): Promise<string | undefined> {
  const candidateRoots = [path.join(rootDir, 'assets', 'mascots')];
  const primaryRoot = candidateRoots[0];
  if (templateDir && primaryRoot) {
    const fallbackRoot = path.resolve(templateDir, '..', '..', 'assets', 'mascots');
    if (path.resolve(fallbackRoot) !== path.resolve(primaryRoot)) {
      candidateRoots.push(fallbackRoot);
    }
  }
  const fallbackPack: Live2dPack = live2dPack === 'fullbody' ? 'expression' : 'fullbody';
  const packSearchOrder: Array<Live2dPack | ''> = [live2dPack, fallbackPack, ''];

  for (const packSubdir of packSearchOrder) {
    for (const mascotBase of candidateRoots) {
      const hostDir = packSubdir
        ? path.join(mascotBase, packSubdir, hostId)
        : path.join(mascotBase, hostId);
      try {
        const entries = await fs.readdir(hostDir, { withFileTypes: true });
        const modelEntry = entries
          .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.model3.json'))
          .sort((a, b) => a.name.localeCompare(b.name))[0];
        if (modelEntry) {
          return packSubdir
            ? `/__mascot_assets__/${packSubdir}/${hostId}/${modelEntry.name}`
            : `/__mascot_assets__/${hostId}/${modelEntry.name}`;
        }
      } catch {
        // 当前候选目录不存在对应模型时继续尝试回退目录
      }
    }
  }
  return undefined;
}

/** 将整期编排结果、新闻条目定稿、角色模型与口型序列组装为供模板消费的标准 RenderableIssue */
export async function buildRenderableIssue(opts: {
  ctx: CoreContext;
  runId: string;
  settings: Settings;
  packageData: IssuePackage;
  timeline?: Timeline;
  templateDir?: string;
}): Promise<RenderableIssue> {
  const { ctx, runId, settings, packageData, timeline, templateDir } = opts;
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

  const hostRow = ctx.db.prepare('SELECT host_id FROM runs WHERE id = ?').get(runId) as
    | { host_id: string | null }
    | undefined;
  const personas = await loadPersonas(ctx).catch(() => []);
  const host = HostMascotIdSchema.safeParse(hostRow?.host_id);
  const activeHostId: HostMascotId = host.success
    ? host.data
    : (personas[0]?.id ?? HostMascotIdSchema.parse(HostMascotIdSchema.options[0]));
  const activePersona = personas.find((p) => p.id === activeHostId);
  const logosRoot = await resolveLogoAssetsRoot(ctx.paths.rootDir, templateDir);
  const logoCatalog = logosRoot ? await loadLogoCatalog(logosRoot) : null;

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
    const loadedEventArticles = ev
      ? await loadEventArticles(ctx, ev).catch(() => new Map())
      : new Map();
    const mediaPool = collectEventMediaPool(loadedEventArticles);
    const mediaById = new Map(mediaPool.map((asset) => [asset.id, asset]));

    let primaryRelSource: string | null = null;
    let fallbackRelSource: string | null = null;

    if (item.imageMode === 'none') {
      primaryRelSource = null;
    } else if (item.imageMode === 'custom') {
      if (item.customImagePath) {
        primaryRelSource = path.relative(
          ctx.paths.rootDir,
          path.join(runDir, item.customImagePath),
        );
      } else if (item.selectedMediaIds?.primary) {
        primaryRelSource = mediaById.get(item.selectedMediaIds.primary)?.imagePath ?? null;
      }

      if (!primaryRelSource) {
        if (item.secondaryCustomImagePath) {
          primaryRelSource = path.relative(
            ctx.paths.rootDir,
            path.join(runDir, item.secondaryCustomImagePath),
          );
        } else if (item.selectedMediaIds?.secondary) {
          primaryRelSource = mediaById.get(item.selectedMediaIds.secondary)?.imagePath ?? null;
        }
      }
    } else {
      const blockedByPolicy =
        item.finalJson.preferArticleImage === false ||
        (settings.editorial.requireImageOptIn &&
          item.finalJson.preferArticleImage !== true &&
          !item.finalJson.primaryMediaId);
      if (!blockedByPolicy) {
        primaryRelSource =
          (item.finalJson.primaryMediaId
            ? mediaById.get(item.finalJson.primaryMediaId)?.imagePath
            : undefined) ??
          primaryArticle?.imagePath ??
          null;
        if (!primaryRelSource && item.finalJson.secondaryMediaId) {
          primaryRelSource = mediaById.get(item.finalJson.secondaryMediaId)?.imagePath ?? null;
        }
        if (item.finalJson.primaryMediaId && primaryArticle?.imagePath) {
          fallbackRelSource = primaryArticle.imagePath;
        }
      }
    }

    // 每条新闻最多只暂存并展示一张配图；仅当主图读取失败时尝试备选主图兜底
    let effectivePrimaryRel = await stageArticleAssetIntoRunDir({
      ctx,
      runDir,
      relImagePath: primaryRelSource,
      itemIndex: i,
    });
    if (!effectivePrimaryRel && fallbackRelSource && fallbackRelSource !== primaryRelSource) {
      effectivePrimaryRel = await stageArticleAssetIntoRunDir({
        ctx,
        runDir,
        relImagePath: fallbackRelSource,
        itemIndex: i,
      });
    }

    const sourceDisplay = primaryArticle
      ? (sourceNameById.get(primaryArticle.sourceId) ?? primaryArticle.sourceId)
      : 'AI 每日报整理';

    const mascotMood = deriveMascotMood(
      activeHostId,
      `${item.finalJson.entity} ${item.finalJson.title} ${item.finalJson.category}`,
      personas,
    );
    const companyIdentity = resolveCompanyIdentity({
      entity: item.finalJson.entity,
      fallbackText: `${item.finalJson.title} ${item.finalJson.shortTitle} ${sourceDisplay}`,
      catalog: logoCatalog,
    });

    const guestWindow = timeline?.sections.find((sec) => sec.itemId === item.id)?.guestWindow;
    const guestReaction = guestWindow
      ? {
          hostId: guestWindow.hostId,
          ...(guestWindow.hostName ? { hostName: guestWindow.hostName } : {}),
          line: guestWindow.line,
          ...(guestWindow.mood ? { mood: guestWindow.mood } : {}),
          startSec: Number((guestWindow.offsetInSectionMs / 1000).toFixed(3)),
          endSec: Number(((guestWindow.offsetInSectionMs + guestWindow.durationMs) / 1000).toFixed(3)),
          audioUrl: `/__run_assets__/${guestWindow.audioFile.replace(/^\/+/, '')}`,
        }
      : undefined;

    renderItems.push({
      ...item.finalJson,
      ...(item.imageMode === 'custom' && item.customImageCaption
        ? { imageCaption: item.customImageCaption }
        : {}),
      id: item.id,
      position: i + 1,
      source: sourceDisplay,
      sourceUrl: primaryArticle?.canonicalUrl ?? '',
      publishedAt: primaryArticle?.publishedAt ?? run.createdAt,
      imagePath: effectivePrimaryRel,
      ...(companyIdentity.logoUrl ? { companyLogoUrl: companyIdentity.logoUrl } : {}),
      impact: mapScoreToImpact(ev?.score ?? 5),
      mascotMood,
      ...(guestReaction ? { guestReaction } : {}),
    });
  }

  const hostMascotPath = await stageArticleAssetIntoRunDir({
    ctx,
    runDir,
    relImagePath: path.join('assets', 'mascots', `${activeHostId}.png`),
    itemIndex: 999,
  });

  const hostLive2dModelUrl = await resolveHostLive2dModelUrl(
    ctx.paths.rootDir,
    activeHostId,
    templateDir,
    resolveRenderLive2dPack(settings.render),
  );

  const customBgmName = await resolveEffectiveRunBgm(ctx, runId, activeHostId, personas);
  const resolvedBgmSpec =
    customBgmName &&
    path.basename(customBgmName) === customBgmName &&
    /\.(mp3|wav|flac|m4a)$/i.test(customBgmName)
      ? path.join('assets', 'bgm', customBgmName)
      : settings.render.bgm.file;
  const bgmAudioUrl = resolvedBgmSpec
    ? await stageBgmAssetIntoRunDir({
        rootDir: ctx.paths.rootDir,
        runDir,
        bgmSpecFile: resolvedBgmSpec,
      })
    : undefined;

  let lipSyncBySectionKey: Record<string, number[]> | undefined;
  if (timeline) {
    lipSyncBySectionKey = {};
    for (const sec of timeline.sections) {
      const absWav = path.join(runDir, sec.audioFile);
      lipSyncBySectionKey[sec.key] = await extractWavLipSyncFrames(absWav, {
        fps: settings.render.fps,
        totalDurationMs: sec.speechMs,
      });
    }
  }

  return {
    ...(hostMascotPath ? { hostMascotPath } : {}),
    hostId: activeHostId,
    ...(activePersona?.displayName ? { hostDisplayName: activePersona.displayName } : {}),
    ...(hostLive2dModelUrl ? { hostLive2dModelUrl } : {}),
    ...(bgmAudioUrl ? { bgmAudioUrl } : {}),
    bgmVolumeDb: settings.render.bgm.volumeDb,
    pagePaddingSec: settings.render.pagePaddingSec,
    fps: settings.render.fps,
    ...(lipSyncBySectionKey ? { lipSyncBySectionKey } : {}),
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
 * 1) 组装画面数据并校验帧摘要，断点重跑时自动跳过已完整落盘的页面截图或章节视频分片；
 * 2) 启动模板本地服务与 Playwright 无头浏览器渲染缺失页面或分片（退出前确保安全关闭浏览器与服务）；
 * 3) 生成封面图、按统一量化时间轴校准全片主音轨（含响度限制与背景音乐侧链闪避）并封装标准 MP4。
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
  const ffprobeBin = resolveFfprobeFromFfmpeg(ffmpegBin);

  const resolvedTemplate = resolveActiveTemplate(
    ctx,
    settings,
    registry ?? createDefaultTemplateRegistry(),
  );
  const adapter: TemplateAdapter = resolvedTemplate.adapter;

  const issue = await buildRenderableIssue({
    ctx,
    runId,
    settings,
    packageData,
    timeline,
    templateDir: resolvedTemplate.dir,
  });
  const templateData = adapter.buildData(issue, timeline);
  const plan: PagePlan[] = adapter.planPages(issue, timeline);
  if (plan.length === 0) {
    throw new PipelineError('render_failed', '模板页面计划为空，无法合成视频');
  }

  await writeJsonAtomic(templateDataFile, templateData);

  const orderedFrames: string[] = [];
  const orderedDurations: number[] = [];
  const orderedSectionMp4s: string[] = [];
  let capturedCount = 0;
  const renderSectionsFn = adapter.renderSections?.bind(adapter);
  const useDynamicSections = typeof renderSectionsFn === 'function';
  const quantized = useDynamicSections
    ? quantizeTimelineToFps(timeline, settings.render.fps)
    : null;

  if (renderSectionsFn && quantized) {
    await fs.mkdir(framesDir, { recursive: true });
    const sectionsProgressFile = path.join(framesDir, 'sections-progress.json');
    const prevSectionsProgress = (await readJsonOrNullWithSchema(
      sectionsProgressFile,
      SectionsProgressFileSchema,
      { fallbackNullOnInvalid: true },
    )) ?? {
      template: resolvedTemplate.name,
      sections: {},
    };

    // 收集重跑归档目录中的历史章节缓存，使从渲染阶段重跑（如替换单张配图或背景音乐）也能复用未改动的章节分片
    const archivedFramesSources: Array<{
      framesDir: string;
      progress: SectionsProgressFile;
    }> = [];
    const archiveRoot = path.join(runDir, 'archive');
    try {
      const archiveDirs = await fs.readdir(archiveRoot, { withFileTypes: true });
      const renderArchives = archiveDirs
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
        .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
      for (const dirName of renderArchives) {
        const archFrames = path.join(archiveRoot, dirName, 'frames');
        const archProg = await readJsonOrNullWithSchema(
          path.join(archFrames, 'sections-progress.json'),
          SectionsProgressFileSchema,
          { fallbackNullOnInvalid: true },
        );
        if (archProg && archProg.template === resolvedTemplate.name) {
          archivedFramesSources.push({ framesDir: archFrames, progress: archProg });
        }
      }
    } catch {
      // 尚未产生归档目录时忽略
    }

    const hashRunRelFile = async (relPath: string | undefined): Promise<string | null> => {
      if (!relPath) {
        return null;
      }
      try {
        const buf = await fs.readFile(path.join(runDir, relPath));
        return crypto.createHash('sha1').update(buf).digest('hex');
      } catch {
        return null;
      }
    };

    const hostMascotFileHash = await hashRunRelFile(issue.hostMascotPath);
    const itemImageFileHashes = await Promise.all(
      issue.items.map((it) => hashRunRelFile(it.imagePath)),
    );

    const assetFingerprint = adapter.getAssetFingerprint
      ? await adapter.getAssetFingerprint({
          templateDir: resolvedTemplate.dir,
          rootDir: ctx.paths.rootDir,
          issue,
          signal,
        })
      : resolvedTemplate.name;

    const dataObj =
      templateData && typeof templateData === 'object'
        ? (templateData as Record<string, unknown>)
        : {};
    const dataItems = Array.isArray(dataObj.items) ? dataObj.items : [];
    const chapterLabelsSummary = dataItems.map((it) =>
      it && typeof it === 'object'
        ? ((it as Record<string, unknown>).progressLabel ??
          (it as Record<string, unknown>).shortTitle)
        : '',
    );
    const chapterFrameCounts = quantized.sections.map((s) => s.frameCount);

    const getSlideVisualPayload = (secIdx: number): unknown => {
      if (secIdx === 0) {
        return {
          headline: dataObj.headline,
          items: dataItems.map((it) =>
            it && typeof it === 'object'
              ? {
                  shortTitle: (it as Record<string, unknown>).shortTitle,
                  category: (it as Record<string, unknown>).category,
                  source: (it as Record<string, unknown>).source,
                  entity: (it as Record<string, unknown>).entity,
                  impact: (it as Record<string, unknown>).impact,
                  companyLogoUrl: (it as Record<string, unknown>).companyLogoUrl,
                }
              : null,
          ),
          coverLipSync: dataObj.coverLipSync,
          coverSubtitles: dataObj.coverSubtitles,
        };
      }
      if (secIdx >= timeline.sections.length - 1) {
        return {
          footerCta: dataObj.footerCta,
          items: dataItems.map((it) =>
            it && typeof it === 'object'
              ? {
                  shortTitle: (it as Record<string, unknown>).shortTitle,
                  summary: (it as Record<string, unknown>).summary,
                  source: (it as Record<string, unknown>).source,
                }
              : null,
          ),
          outroLipSync: dataObj.outroLipSync,
          outroSubtitles: dataObj.outroSubtitles,
        };
      }
      return {
        item: dataItems[secIdx - 1] ?? null,
        imageHash: itemImageFileHashes[secIdx - 1] ?? null,
      };
    };

    const getSectionMood = (secIdx: number): MascotMood => {
      if (secIdx === 0) {
        return 'neutral';
      }
      if (secIdx >= timeline.sections.length - 1) {
        return 'proud';
      }
      return issue.items[secIdx - 1]?.mascotMood ?? 'neutral';
    };

    const nextSectionsMap: Record<string, SectionCacheRecord> = {};
    const allSectionPlans: SectionRenderPlan[] = [];
    const pendingSections: SectionRenderPlan[] = [];

    for (let i = 0; i < quantized.sections.length; i++) {
      const qSec = quantized.sections[i];
      if (!qSec) {
        continue;
      }
      const mp4FileName = `section-${String(i).padStart(2, '0')}.mp4`;
      const pngFileName = `page-${String(i).padStart(2, '0')}.png`;
      const outMp4Path = path.join(framesDir, mp4FileName);
      const outPngPath = path.join(framesDir, pngFileName);
      const sectionMood = getSectionMood(i);

      const secPlan: SectionRenderPlan = {
        index: i,
        sectionKey: qSec.sectionKey,
        startFrame: qSec.startFrame,
        frameCount: qSec.frameCount,
        startMs: qSec.quantizedStartMs,
        durationMs: qSec.quantizedDurationMs,
        speechOffsetMs: qSec.speechOffsetMs,
        speechMs: qSec.speechMs,
        mood: sectionMood,
        outMp4Path,
        outPngPath,
      };
      allSectionPlans.push(secPlan);

      const sectionDigest = crypto
        .createHash('sha1')
        .update(
          JSON.stringify({
            template: resolvedTemplate.name,
            adapter: adapter.id,
            theme: resolveRenderTheme(settings.render),
            assetFingerprint,
            deviceScaleFactor: settings.render.deviceScaleFactor ?? 1,
            width: settings.render.width,
            height: settings.render.height,
            fps: settings.render.fps,
            crf: 18,
            preset: 'veryfast',
            jpegQuality: 90,
            totalFrames: quantized.totalFrames,
            // 每帧顶部刊头常驻可见的所有全局标识与章节摘要
            issueTitle: dataObj.issueTitle,
            date: dataObj.date,
            issueNumber: dataObj.issueNumber,
            hostMascotId: dataObj.hostMascotId,
            hostDisplayName: dataObj.hostDisplayName,
            hostMascotUrl: dataObj.hostMascotUrl,
            hostMascotFileHash,
            hostLive2dUrl: dataObj.hostLive2dUrl,
            mascotMode: dataObj.mascotMode,
            chapterLabelsSummary,
            chapterFrameCounts,
            index: i,
            startFrame: qSec.startFrame,
            frameCount: qSec.frameCount,
            speechOffsetMs: qSec.speechOffsetMs,
            speechMs: qSec.speechMs,
            mood: sectionMood,
            currSlide: getSlideVisualPayload(i),
            prevSlide: i > 0 ? getSlideVisualPayload(i - 1) : null,
          }),
          'utf8',
        )
        .digest('hex');

      const cacheKey = `${String(i).padStart(2, '0')}:${qSec.sectionKey}`;
      nextSectionsMap[cacheKey] = {
        sectionDigest,
        width: settings.render.width,
        height: settings.render.height,
        fps: settings.render.fps,
        frameCount: qSec.frameCount,
      };

      const prevEntry =
        prevSectionsProgress.template === resolvedTemplate.name
          ? prevSectionsProgress.sections[cacheKey]
          : undefined;
      const prevSegCheck =
        prevEntry?.sectionDigest === sectionDigest &&
        prevEntry.width === settings.render.width &&
        prevEntry.height === settings.render.height &&
        prevEntry.fps === settings.render.fps &&
        prevEntry.frameCount === qSec.frameCount
          ? await validateMp4Segment({
              filePath: outMp4Path,
              expectedDurationMs: qSec.quantizedDurationMs,
              width: settings.render.width,
              height: settings.render.height,
              fps: settings.render.fps,
              ffprobeBin,
            })
          : null;
      if (prevSegCheck?.status === 'probe_error') {
        throw new PipelineError('render_failed', `校验缓存分片失败: ${prevSegCheck.detail}`);
      }
      let canReuse = prevSegCheck?.status === 'ok' && (await isValidPngFile(outPngPath));

      if (!canReuse) {
        for (const arch of archivedFramesSources) {
          const archEntry = arch.progress.sections[cacheKey];
          if (
            archEntry?.sectionDigest === sectionDigest &&
            archEntry.width === settings.render.width &&
            archEntry.height === settings.render.height &&
            archEntry.fps === settings.render.fps &&
            archEntry.frameCount === qSec.frameCount
          ) {
            const archMp4 = path.join(arch.framesDir, mp4FileName);
            const archPng = path.join(arch.framesDir, pngFileName);
            const archSegCheck = await validateMp4Segment({
              filePath: archMp4,
              expectedDurationMs: qSec.quantizedDurationMs,
              width: settings.render.width,
              height: settings.render.height,
              fps: settings.render.fps,
              ffprobeBin,
            });
            if (archSegCheck.status === 'probe_error') {
              throw new PipelineError('render_failed', `校验归档分片失败: ${archSegCheck.detail}`);
            }
            if (archSegCheck.status === 'ok' && (await isValidPngFile(archPng))) {
              const [mp4Buf, pngBuf] = await Promise.all([
                fs.readFile(archMp4),
                fs.readFile(archPng),
              ]);
              await Promise.all([
                writeFileAtomic(outMp4Path, mp4Buf),
                writeFileAtomic(outPngPath, pngBuf),
              ]);
              canReuse = true;
              break;
            }
          }
        }
      }

      if (!canReuse) {
        await fs.rm(outMp4Path, { force: true }).catch(() => undefined);
        await fs.rm(outPngPath, { force: true }).catch(() => undefined);
        pendingSections.push(secPlan);
      }
    }

    capturedCount = pendingSections.length;

    if (pendingSections.length > 0) {
      if (signal?.aborted) {
        throw new DOMException('已取消', 'AbortError');
      }

      const exePath = await resolveChromiumExecutablePath();
      const server = await adapter.prepare({
        dir: resolvedTemplate.dir,
        runDir,
        rootDir: ctx.paths.rootDir,
        signal,
      });
      const browserToken = crypto.randomUUID();
      let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;
      const onAbort = () => {
        void closeBrowserSafely(browser, browserToken);
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
          args: [
            '--use-gl=angle',
            '--enable-webgl',
            '--ignore-gpu-blocklist',
            `--aidaily-browser-token=${browserToken}`,
          ],
          ...(exePath ? { executablePath: exePath } : {}),
        });
        const browserCtx = await browser.newContext({
          viewport: { width: settings.render.width, height: settings.render.height },
          deviceScaleFactor: settings.render.deviceScaleFactor ?? 1,
        });
        const page = await browserCtx.newPage();
        await page.setViewportSize({
          width: settings.render.width,
          height: settings.render.height,
        });
        await page.goto(
          `${server.baseUrl}/?clean=1&clock=manual&theme=${resolveRenderTheme(settings.render)}`,
          {
            waitUntil: 'load',
            timeout: 30_000,
          },
        );
        await renderSectionsFn({
          page,
          data: templateData,
          sections: pendingSections,
          width: settings.render.width,
          height: settings.render.height,
          fps: settings.render.fps,
          ffmpegBin,
          signal,
        });
        if (signal?.aborted) {
          throw new DOMException('已取消', 'AbortError');
        }
      } catch (err) {
        if (signal?.aborted || (err instanceof Error && err.name === 'AbortError')) {
          throw new DOMException('已取消', 'AbortError');
        }
        throw new PipelineError(
          'render_failed',
          `动态章节流式渲染失败: ${err instanceof Error ? err.message : String(err)}`,
          { cause: err },
        );
      } finally {
        signal?.removeEventListener('abort', onAbort);
        try {
          await closeBrowserSafely(browser, browserToken);
        } finally {
          await server.close().catch(() => undefined);
        }
      }
    }

    for (const secPlan of allSectionPlans) {
      const segCheck = await validateMp4Segment({
        filePath: secPlan.outMp4Path,
        expectedDurationMs: secPlan.durationMs,
        width: settings.render.width,
        height: settings.render.height,
        fps: settings.render.fps,
        ffprobeBin,
      });
      if (segCheck.status === 'probe_error') {
        throw new PipelineError(
          'render_failed',
          `探测章节视频分片失败（已保留原分片文件）: ${secPlan.outMp4Path} (${segCheck.detail})`,
        );
      }
      if (segCheck.status === 'invalid') {
        await fs.rm(secPlan.outMp4Path, { force: true }).catch(() => undefined);
        throw new PipelineError(
          'render_failed',
          `缺少或损坏的章节视频分片: ${secPlan.outMp4Path} (${segCheck.detail})`,
        );
      }
      if (!(await isValidPngFile(secPlan.outPngPath))) {
        await fs.rm(secPlan.outPngPath, { force: true }).catch(() => undefined);
        throw new PipelineError(
          'render_failed',
          `缺少或损坏的章节代表帧截图: ${secPlan.outPngPath}`,
        );
      }
      orderedSectionMp4s.push(secPlan.outMp4Path);
      orderedFrames.push(secPlan.outPngPath);
      orderedDurations.push(secPlan.durationMs);
    }

    await writeJsonAtomic(sectionsProgressFile, {
      template: resolvedTemplate.name,
      sections: nextSectionsMap,
    } satisfies SectionsProgressFile);
  } else {
    const digest = crypto
      .createHash('sha1')
      .update(
        JSON.stringify({
          template: resolvedTemplate.name,
          adapter: adapter.id,
          theme: resolveRenderTheme(settings.render),
          deviceScaleFactor: settings.render.deviceScaleFactor ?? 1,
          width: settings.render.width,
          height: settings.render.height,
          templateData,
          plan,
        }),
        'utf8',
      )
      .digest('hex');

    const prevProgress = await readJsonOrNullWithSchema(progressFile, FramesProgressRecordSchema, {
      fallbackNullOnInvalid: true,
    });
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

    capturedCount = pendingPlan.length;

    if (pendingPlan.length > 0) {
      if (signal?.aborted) {
        throw new DOMException('已取消', 'AbortError');
      }

      const exePath = await resolveChromiumExecutablePath();
      const server = await adapter.prepare({
        dir: resolvedTemplate.dir,
        runDir,
        rootDir: ctx.paths.rootDir,
        signal,
      });
      const browserToken = crypto.randomUUID();
      let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;
      const onAbort = () => {
        void closeBrowserSafely(browser, browserToken);
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
          args: [`--aidaily-browser-token=${browserToken}`],
          ...(exePath ? { executablePath: exePath } : {}),
        });
        const browserCtx = await browser.newContext({
          viewport: { width: settings.render.width, height: settings.render.height },
          deviceScaleFactor: settings.render.deviceScaleFactor ?? 1,
        });
        const page = await browserCtx.newPage();
        await page.setViewportSize({
          width: settings.render.width,
          height: settings.render.height,
        });
        await page.goto(
          `${server.baseUrl}/?clean=1&transition=none&motion=static&theme=${resolveRenderTheme(settings.render)}`,
          {
            waitUntil: 'load',
            timeout: 30_000,
          },
        );
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
          await closeBrowserSafely(browser, browserToken);
        } finally {
          await server.close().catch(() => undefined);
        }
      }
    }

    for (const p of plan) {
      const file = frameFilesByIdx.get(p.index);
      if (!file || !(await isValidPngFile(file))) {
        throw new PipelineError('render_failed', `缺少或损坏的渲染帧截图: ${file ?? p.sectionKey}`);
      }
      orderedFrames.push(file);
      orderedDurations.push(p.durationMs);
    }
  }

  const firstFrame = orderedFrames[0];
  if (!firstFrame) {
    throw new PipelineError('render_failed', '无法生成视频封面图：缺少首帧截图');
  }

  try {
    await renderRunCover({
      ctx,
      runId,
      settings,
      outJpg: coverFile,
      fallbackPng: firstFrame,
      ffmpegBin,
      signal,
    });

    const bgmName = await resolveEffectiveRunBgm(ctx, runId, issue.hostId);
    if (bgmName && (path.basename(bgmName) !== bgmName || !/\.(mp3|wav|flac|m4a)$/i.test(bgmName)))
      throw new Error('背景音乐文件名不合法');
    const masterTimeline = quantized ? quantized.audioTimeline : timeline;
    // 配置了翻页音效且文件存在时，在每次翻页的时间点叠加咔嗒声；文件缺失只记警告、不加音效，不影响成片
    const pageTurnSfxSetting = settings.render.pageTurnSfx;
    const sfxRel = pageTurnSfxSetting?.file.trim() ?? '';
    let pageTurnSfx: { file: string; volumeDb: number; atMs: number[] } | undefined;
    if (pageTurnSfxSetting && sfxRel) {
      const sfxAbs = path.isAbsolute(sfxRel) ? sfxRel : path.resolve(ctx.paths.rootDir, sfxRel);
      const sfxExists = await fs
        .access(sfxAbs)
        .then(() => true)
        .catch(() => false);
      if (sfxExists) {
        pageTurnSfx = {
          file: sfxAbs,
          volumeDb: pageTurnSfxSetting.volumeDb,
          atMs: computePageTurnSfxTimesMs(masterTimeline, pageTurnSfxSetting.leadMs),
        };
      } else {
        ctx.logger.warn(
          { runId, file: sfxRel, code: 'page_turn_sfx_missing' },
          `找不到翻页音效文件 ${sfxRel}，本次成片不加翻页音效`,
        );
      }
    }
    await buildMasterAudioWav({
      timeline: masterTimeline,
      runDir,
      outWav: masterWavFile,
      sampleRate: settings.tts.postprocess.sampleRate,
      loudnessLUFS: settings.tts.postprocess.loudnessLUFS,
      isSilentProvider: settings.tts.provider === 'silent',
      // 本地克隆引擎已在段落合成阶段完成两遍响度、降噪与分句均衡处理，主轨不再重复执行动态处理
      levelVoice:
        settings.tts.provider !== 'silent' && !isLocalVoiceCloneProvider(settings.tts.provider),
      denoiseVoice: settings.tts.postprocess.denoise ?? true,
      bgm: bgmName
        ? { ...settings.render.bgm, file: path.join('assets', 'bgm', bgmName) }
        : settings.render.bgm,
      pageTurnSfx,
      rootDir: ctx.paths.rootDir,
      ffmpegBin,
      signal,
    });

    if (useDynamicSections && quantized) {
      await composeSectionVideosMp4({
        sectionMp4Files: orderedSectionMp4s,
        totalMs: quantized.audioTimeline.totalMs,
        totalFrames: quantized.totalFrames,
        fps: settings.render.fps,
        masterWav: masterWavFile,
        outMp4: videoFile,
        sampleRate: settings.tts.postprocess.sampleRate,
        ffmpegBin,
        signal,
      });
    } else {
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
    }
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
    capturedFrameCount: capturedCount,
    reusedFrameCount: orderedFrames.length - capturedCount,
    totalMs: timeline.totalMs,
  };
}
