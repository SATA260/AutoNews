import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  type BrowserPageLike,
  type ContentLimits,
  HostMascotIdSchema,
  type InfoCard,
  type MascotMood,
  type PagePlan,
  type RenderableIssue,
  type RenderableNewsItem,
  type RenderSectionsOptions,
  type TemplateAdapter,
  type Timeline,
  type TimelineSection,
} from '@aidaily/contracts';
import { execa } from 'execa';
import { resolveLogoAssetsRoot } from '../../media/company-logos.js';
import { encodeJpegStreamToMp4 } from '../../media/ffmpeg.js';
import { quantizeTimelineToFps } from '../../media/timeline.js';
import { startTemplateHttpServer } from '../server.js';

/** 视觉展示模板支持的右下角内置角色形象标识 */
export type DailyDeckMascotId = 'deepseek' | 'gpt' | 'claude' | 'gemini' | 'grok' | 'none';

/** 该展示模板推荐的内容字数限制上限（用于在采编阶段提前控制篇幅避免画面截断） */
export const DAILY_DECK_CONTENT_LIMITS: Partial<ContentLimits> = {
  headline: 48,
  title: 48,
  shortTitle: 30,
  progressLabel: 10,
  category: 10,
  summary: 100,
  keyPointsMax: 3,
  keyPoint: 32,
  narrationSentence: 48,
};

/** 根据新闻主体公司或产品名称匹配对应角色标识 */
export function mapEntityToMascotId(entity: string): DailyDeckMascotId {
  const lower = entity.toLowerCase();
  if (lower.includes('deepseek') || lower.includes('深度求索')) {
    return 'deepseek';
  }
  if (
    lower.includes('openai') ||
    lower.includes('gpt') ||
    lower.includes('chatgpt') ||
    lower.includes('sora')
  ) {
    return 'gpt';
  }
  if (lower.includes('anthropic') || lower.includes('claude')) {
    return 'claude';
  }
  if (lower.includes('google') || lower.includes('deepmind') || lower.includes('gemini')) {
    return 'gemini';
  }
  if (lower.includes('xai') || lower.includes('grok')) {
    return 'grok';
  }
  return 'none';
}

/** 从完整文章链接提取简洁的主机域名展示 */
function extractDisplayHost(rawUrl: string): string {
  try {
    return new URL(rawUrl).hostname.replace(/^www\./i, '');
  } catch {
    return rawUrl;
  }
}

/** 将标准时间字符串转换为简短日期格式（YYYY.MM.DD） */
function formatShortDate(rawDate: string): string {
  const parsed = Date.parse(rawDate);
  if (!Number.isNaN(parsed)) {
    return new Date(parsed).toISOString().slice(0, 10).replace(/-/g, '.');
  }
  return rawDate.replace(/-/g, '.').slice(0, 16);
}

/** 递归统计目录内所有文件的最新修改时间戳，用于判断构建产物是否落后于源码 */
async function scanLatestMtimeMs(dirPath: string): Promise<number> {
  let latestMtimeMs = 0;

  async function walk(curr: string): Promise<void> {
    const list = await fs.readdir(curr, { withFileTypes: true }).catch(() => null);
    if (!list) {
      return;
    }
    for (const ent of list) {
      const full = path.join(curr, ent.name);
      if (ent.isDirectory()) {
        await walk(full);
      } else if (ent.isFile()) {
        const st = await fs.stat(full);
        if (st.mtimeMs > latestMtimeMs) {
          latestMtimeMs = st.mtimeMs;
        }
      }
    }
  }

  await walk(dirPath);
  return latestMtimeMs;
}

/** 递归读取目录内全部文件内容并按排序相对路径生成确定性 SHA-1 内容指纹，防止保留原时间戳的文件替换漏失效 */
async function computeDirectoryContentHash(dirPath: string): Promise<string> {
  const hasher = crypto.createHash('sha1');
  let fileCount = 0;

  async function walk(curr: string, prefix: string): Promise<void> {
    const list = await fs.readdir(curr, { withFileTypes: true }).catch(() => null);
    if (!list) {
      return;
    }
    list.sort((a, b) => a.name.localeCompare(b.name));
    for (const ent of list) {
      const full = path.join(curr, ent.name);
      const rel = prefix ? `${prefix}/${ent.name}` : ent.name;
      if (ent.isDirectory()) {
        await walk(full, rel);
      } else if (ent.isFile()) {
        const buf = await fs.readFile(full);
        const fileSha = crypto.createHash('sha1').update(buf).digest('hex');
        hasher.update(`${rel}:${buf.byteLength}:${fileSha}\n`, 'utf8');
        fileCount += 1;
      }
    }
  }

  await walk(dirPath, '');
  if (fileCount === 0) {
    return 'empty';
  }
  return hasher.digest('hex');
}

/** 根据模型访问路径安全解析实际命中的 Live2D 模型文件夹，缺失时按全身版、仅表情版、旧根目录顺序探测 */
export async function resolveMascotModelDirectory(
  mascotRoot: string,
  hostLive2dModelUrl: string | undefined,
  hostKey: string,
): Promise<string> {
  const rootResolved = path.resolve(mascotRoot);
  const mascotPrefix = '/__mascot_assets__/';
  if (hostLive2dModelUrl?.startsWith(mascotPrefix)) {
    const rawRel = hostLive2dModelUrl.slice(mascotPrefix.length);
    let decodedRel = rawRel;
    try {
      decodedRel = decodeURIComponent(rawRel);
    } catch {
      decodedRel = rawRel;
    }
    const posixDir = path.posix.dirname(decodedRel.replace(/\\/g, '/'));
    const segments = posixDir.split('/').filter((seg) => seg.length > 0 && seg !== '.');
    if (segments.length > 0 && !segments.includes('..')) {
      const candidate = path.resolve(rootResolved, ...segments);
      if (candidate === rootResolved || candidate.startsWith(`${rootResolved}${path.sep}`)) {
        return candidate;
      }
    }
  }
  const defaultDir = path.join(rootResolved, 'fullbody', hostKey);
  const fallbackCandidates = [
    defaultDir,
    path.join(rootResolved, 'expression', hostKey),
    path.join(rootResolved, hostKey),
  ];
  for (const dir of fallbackCandidates) {
    try {
      const st = await fs.stat(dir);
      if (st.isDirectory()) {
        return dir;
      }
    } catch {
      // 继续尝试下一个候选模型目录
    }
  }
  return defaultDir;
}

/** 定位可用的看板娘模型根目录：优先读取工作区根目录，缺失时回退模板所在仓库的共享模型目录 */
async function resolveMascotAssetsRoot(
  templateDir: string,
  rootDir?: string,
): Promise<string | undefined> {
  const candidates: string[] = [];
  if (rootDir) {
    candidates.push(path.join(rootDir, 'assets', 'mascots'));
  }
  candidates.push(path.resolve(templateDir, '..', '..', 'assets', 'mascots'));
  for (const dir of candidates) {
    try {
      const st = await fs.stat(dir);
      if (st.isDirectory()) {
        return dir;
      }
    } catch {
      // 继续尝试候选目录
    }
  }
  return undefined;
}

/** 执行支持外部取消信号的模板构建命令 */
async function runCancelableTemplateCmd(
  cmd: string,
  args: string[],
  cwd: string,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) {
    throw new DOMException('已取消', 'AbortError');
  }
  const res = await execa(cmd, args, {
    cwd,
    timeout: 300_000,
    cancelSignal: signal,
    reject: false,
  });
  if (res.isCanceled || signal?.aborted) {
    throw new DOMException('已取消', 'AbortError');
  }
  if (res.timedOut) {
    throw new Error(`前端模板命令 ${cmd} ${args.join(' ')} 执行超时`);
  }
  if (res.exitCode !== 0) {
    const errCode = (res as { code?: string }).code;
    const err = new Error(
      `前端模板命令 ${cmd} ${args.join(' ')} 失败: ${res.stderr || res.stdout || res.shortMessage}`,
    );
    if (errCode === 'ENOENT') {
      Object.assign(err, { code: 'ENOENT' });
    }
    throw err;
  }
}

/** 确保独立前端模板已经完成最新构建，若产物缺失或源码有更新则自动触发重新构建并响应取消信号 */
async function ensureDailyDeckBuilt(templateDir: string, signal?: AbortSignal): Promise<string> {
  if (signal?.aborted) {
    throw new DOMException('已取消', 'AbortError');
  }
  const distDir = path.join(templateDir, 'dist');
  const distIndex = path.join(distDir, 'index.html');
  let distMtime = 0;
  try {
    const st = await fs.stat(distIndex);
    distMtime = st.mtimeMs;
  } catch {
    distMtime = 0;
  }

  if (distMtime > 0) {
    const [srcMtime, pubMtime, indexMtime] = await Promise.all([
      scanLatestMtimeMs(path.join(templateDir, 'src')),
      scanLatestMtimeMs(path.join(templateDir, 'public')),
      fs
        .stat(path.join(templateDir, 'index.html'))
        .then((st) => st.mtimeMs)
        .catch(() => 0),
    ]);
    const newestSrc = Math.max(srcMtime, pubMtime, indexMtime);
    if (distMtime >= newestSrc - 50) {
      return distDir;
    }
    try {
      await runCancelableTemplateCmd('npm', ['run', 'build'], templateDir, signal);
      await fs.access(distIndex);
      return distDir;
    } catch (err) {
      if (signal?.aborted || (err instanceof Error && err.name === 'AbortError')) {
        throw new DOMException('已取消', 'AbortError');
      }
      if ((err as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') {
        // 若当前子进程环境未挂载包管理器但已有现成产物，保留现有产物继续运行
        return distDir;
      }
      throw err;
    }
  }

  const nodeModulesDir = path.join(templateDir, 'node_modules');
  let hasNodeModules = false;
  try {
    await fs.access(nodeModulesDir);
    hasNodeModules = true;
  } catch {
    hasNodeModules = false;
  }

  if (!hasNodeModules) {
    await runCancelableTemplateCmd('npm', ['install'], templateDir, signal);
  }

  await runCancelableTemplateCmd('npm', ['run', 'build'], templateDir, signal);

  await fs.access(distIndex);
  return distDir;
}

/** 模板单页最多展示的信息卡片张数 */
const DAILY_DECK_MAX_VISIBLE_CARDS = 4;

/**
 * 按模板网格结构整理或从历史摘要字段自动组装单条新闻的信息卡片列表（最多 4 张）。
 * 卡片没有指定图标时不在这里随意补，交给模板按标题和正文关键词自动匹配。
 */
function buildAdapterCards(item: RenderableNewsItem): InfoCard[] {
  if (Array.isArray(item.cards) && item.cards.length > 0) {
    return item.cards.slice(0, DAILY_DECK_MAX_VISIBLE_CARDS).map((card) => ({
      ...(card.icon ? { icon: card.icon } : {}),
      title: card.title,
      body: card.body,
    }));
  }

  const cards: InfoCard[] = [];
  if (item.summary.trim().length > 0) {
    cards.push({
      icon: 'rocket',
      title: '核心发布',
      body: item.summary.trim().slice(0, 78),
    });
  }
  for (
    let i = 0;
    i < item.keyPoints.length && cards.length < DAILY_DECK_MAX_VISIBLE_CARDS - 1;
    i++
  ) {
    const point = item.keyPoints[i]?.trim();
    if (!point) {
      continue;
    }
    cards.push({
      title: `关键看点 ${i + 1}`,
      body: point.slice(0, 78),
    });
  }
  if (
    item.detail.trim().length > 0 &&
    item.detail.trim() !== item.summary.trim() &&
    cards.length < DAILY_DECK_MAX_VISIBLE_CARDS
  ) {
    cards.push({
      title: '背景与详情',
      body: item.detail.trim().slice(0, 78),
    });
  }
  if (
    Array.isArray(item.metrics) &&
    item.metrics.length > 0 &&
    cards.length < DAILY_DECK_MAX_VISIBLE_CARDS
  ) {
    const metricsSummary = item.metrics
      .map((m) => `${m.label}：${m.value}`)
      .join('；')
      .slice(0, 78);
    if (metricsSummary) {
      cards.push({
        icon: 'gauge',
        title: '核心参数',
        body: metricsSummary,
      });
    }
  }
  return cards.slice(0, DAILY_DECK_MAX_VISIBLE_CARDS);
}

/** 将任务目录内音频或配图相对路径转换为模板本地服务可访问的链接 */
function toRunAssetUrl(relPath: string | undefined | null): string | null {
  if (!relPath) {
    return null;
  }
  return `/__run_assets__/${relPath.replace(/^\/+/, '')}`;
}

/** 将单个章节的时间轴口播分句转换为相对章节起点的字幕显示列表 */
function buildSectionSubtitles(
  sec: TimelineSection | undefined,
  maxDurationSec: number,
): Array<{ text: string; startSec: number; endSec: number }> {
  if (!sec?.sentences?.length || maxDurationSec <= 0) {
    return [];
  }
  const subtitles: Array<{ text: string; startSec: number; endSec: number }> = [];
  for (const sentence of sec.sentences) {
    const cleanText = sentence.text.trim().replace(/。+$/, '').trim();
    if (!cleanText) {
      continue;
    }
    const relStartSec = Math.max(0, (sentence.startMs - sec.startMs) / 1000);
    if (relStartSec >= maxDurationSec - 0.02) {
      continue;
    }
    const rawEndSec = relStartSec + Math.max(0.05, sentence.durationMs / 1000);
    const endSec = Math.min(maxDurationSec, rawEndSec);
    if (endSec > relStartSec + 0.02) {
      subtitles.push({
        text: cleanText,
        startSec: Number(relStartSec.toFixed(3)),
        endSec: Number(endSec.toFixed(3)),
      });
    }
  }
  return subtitles;
}

/** 创建独立新闻画报前端模板的适配实现 */
export function createDailyDeckAdapter(): TemplateAdapter {
  return {
    id: 'daily-deck',
    contentLimits: DAILY_DECK_CONTENT_LIMITS,

    /** 把核心引擎组装好的整期新闻对象转换为前端模板可识别的输入数据结构（含统一帧网格、音频与口型序列） */
    buildData(issue: RenderableIssue, timeline: Timeline): Record<string, unknown> {
      if (issue.items.length > 12) {
        throw new Error('视频模板最多支持 12 条新闻，无法安全渲染更多页面');
      }
      const targetFps = Math.max(1, Math.round(issue.fps ?? 30));
      const quantized = quantizeTimelineToFps(timeline, targetFps);
      const qByKey = new Map(quantized.sections.map((s) => [s.sectionKey, s]));

      const introSec = timeline.sections.find((s) => s.kind === 'intro');
      const outroSec = timeline.sections.find((s) => s.kind === 'outro');
      const itemSecById = new Map(
        timeline.sections.filter((s) => s.itemId).map((s) => [s.itemId as string, s]),
      );
      const lipMap = issue.lipSyncBySectionKey ?? {};

      const qIntro = introSec ? qByKey.get(introSec.key) : undefined;
      const qOutro = outroSec ? qByKey.get(outroSec.key) : undefined;

      const coverFrameCount = qIntro?.frameCount;
      const coverDurationSec =
        coverFrameCount !== undefined
          ? Math.max(1, Number((coverFrameCount / targetFps).toFixed(6)))
          : Math.max(1, Number((((introSec?.pageMs ?? 5000) as number) / 1000).toFixed(3)));
      const coverSpeechStartSec = Math.max(
        0,
        Math.min(
          coverDurationSec,
          Number(((qIntro?.speechOffsetMs ?? introSec?.speechOffsetMs ?? 0) / 1000).toFixed(3)),
        ),
      );
      const coverSpeechSec = Math.max(
        0,
        Math.min(
          Math.max(0, coverDurationSec - coverSpeechStartSec),
          Number((((introSec?.speechMs ?? introSec?.pageMs ?? 5000) as number) / 1000).toFixed(3)),
        ),
      );

      const outroFrameCount = qOutro?.frameCount;
      const outroDurationSec =
        outroFrameCount !== undefined
          ? Math.max(1, Number((outroFrameCount / targetFps).toFixed(6)))
          : Math.max(1, Number((((outroSec?.pageMs ?? 6000) as number) / 1000).toFixed(3)));
      const outroSpeechStartSec = Math.max(
        0,
        Math.min(
          outroDurationSec,
          Number(((qOutro?.speechOffsetMs ?? outroSec?.speechOffsetMs ?? 0) / 1000).toFixed(3)),
        ),
      );
      const outroSpeechSec = Math.max(
        0,
        Math.min(
          Math.max(0, outroDurationSec - outroSpeechStartSec),
          Number((((outroSec?.speechMs ?? outroSec?.pageMs ?? 6000) as number) / 1000).toFixed(3)),
        ),
      );

      return {
        issueTitle: 'AI 每日报',
        issueNumber: issue.issueNumber,
        date: issue.date.replace(/-/g, '.'),
        headline: issue.headline,
        footerCta: issue.outro.cta,
        fps: targetFps,
        hostMascotId: issue.hostId ?? HostMascotIdSchema.parse(HostMascotIdSchema.options[0]),
        hostDisplayName: issue.hostDisplayName ?? undefined,
        hostMascotUrl: toRunAssetUrl(issue.hostMascotPath),
        hostLive2dUrl: issue.hostLive2dModelUrl ?? null,
        mascotMode: issue.hostId || issue.hostLive2dModelUrl ? 'fixed-host' : 'per-item',
        bgmAudioUrl: issue.bgmAudioUrl ?? null,
        bgmVolumeDb: issue.bgmVolumeDb ?? -18,
        pagePaddingSec: issue.pagePaddingSec ?? 1.0,
        coverFrameCount,
        coverDurationSec,
        coverSpeechStartSec,
        coverSpeechSec,
        coverAudioUrl: toRunAssetUrl(introSec?.audioFile),
        coverLipSync: introSec ? (lipMap[introSec.key] ?? []) : [],
        coverSubtitles: buildSectionSubtitles(introSec, coverDurationSec),
        outroFrameCount,
        outroDurationSec,
        outroSpeechStartSec,
        outroSpeechSec,
        outroAudioUrl: toRunAssetUrl(outroSec?.audioFile),
        outroLipSync: outroSec ? (lipMap[outroSec.key] ?? []) : [],
        outroSubtitles: buildSectionSubtitles(outroSec, outroDurationSec),
        items: issue.items.map((item) => {
          const sec = itemSecById.get(item.id);
          const qItem = sec ? qByKey.get(sec.key) : undefined;
          const itemFrameCount = qItem?.frameCount;
          const durationSec =
            itemFrameCount !== undefined
              ? Math.max(1, Number((itemFrameCount / targetFps).toFixed(6)))
              : Math.max(1, Number(((sec?.pageMs ?? 8000) / 1000).toFixed(3)));
          const speechStartSec = Math.max(
            0,
            Math.min(
              durationSec,
              Number(((qItem?.speechOffsetMs ?? sec?.speechOffsetMs ?? 0) / 1000).toFixed(3)),
            ),
          );
          const speechDurationSec = Math.max(
            0,
            Math.min(
              Math.max(0, durationSec - speechStartSec),
              Number(((sec?.speechMs ?? sec?.pageMs ?? 8000) / 1000).toFixed(3)),
            ),
          );
          const assetPath = toRunAssetUrl(item.imagePath);
          return {
            id: item.id,
            category: item.category,
            entity: item.entity,
            impact: item.impact,
            companyLogoUrl: item.companyLogoUrl ?? null,
            shortTitle: item.shortTitle,
            progressLabel: item.progressLabel,
            title: item.title,
            summary: item.highlight ?? item.summary,
            actionHint: item.actionHint ?? null,
            cards: buildAdapterCards(item),
            keyPoints: item.keyPoints.slice(0, 3),
            imageUrl: assetPath,
            secondaryImageUrl: null,
            imageCaption: assetPath ? (item.imageCaption ?? `${item.source} 配图`) : null,
            officialQuote: item.officialQuote ?? item.evidence[0]?.quote ?? item.detail,
            metrics: item.metrics ?? [],
            source: item.source,
            sourceUrl: extractDisplayHost(item.sourceUrl),
            publishedAt: formatShortDate(item.publishedAt),
            mascotId: mapEntityToMascotId(item.entity),
            mascotMood: item.mascotMood ?? 'neutral',
            guestReaction: item.guestReaction ?? null,
            frameCount: itemFrameCount,
            durationSec,
            speechStartSec,
            speechDurationSec,
            audioUrl: toRunAssetUrl(sec?.audioFile),
            lipSyncFrames: sec ? (lipMap[sec.key] ?? []) : [],
            subtitles: buildSectionSubtitles(sec, durationSec),
          };
        }),
      };
    },

    /** 按时间轴段落顺序输出每一页（封面、各新闻页、尾页）的编号与停留毫秒数 */
    planPages(_issue: RenderableIssue, timeline: Timeline): PagePlan[] {
      return timeline.sections.map((section, index) => ({
        index,
        sectionKey: section.key,
        durationMs: section.pageMs,
      }));
    },

    /** 计算模板构建产物、角色模型与公司 Logo 资产的内容 SHA-1 指纹，用于判定章节分片缓存是否需要失效重渲 */
    async getAssetFingerprint(opts) {
      const distDir = await ensureDailyDeckBuilt(opts.templateDir, opts.signal);
      const distHash = await computeDirectoryContentHash(distDir);
      const mascotRoot = await resolveMascotAssetsRoot(opts.templateDir, opts.rootDir);
      const hostKey = opts.issue.hostId ?? HostMascotIdSchema.parse(HostMascotIdSchema.options[0]);
      const mascotDir =
        mascotRoot && hostKey
          ? await resolveMascotModelDirectory(mascotRoot, opts.issue.hostLive2dModelUrl, hostKey)
          : undefined;
      const mascotHash = mascotDir ? await computeDirectoryContentHash(mascotDir) : 'none';
      const logosDir = await resolveLogoAssetsRoot(opts.rootDir, opts.templateDir);
      const logosHash = logosDir ? await computeDirectoryContentHash(logosDir) : 'none';
      return crypto
        .createHash('sha1')
        .update(JSON.stringify({ distHash, mascotHash, logosHash }), 'utf8')
        .digest('hex');
    },

    /** 确认前端模板已打包完成，并启动同时挂载当期素材、角色模型与公司 Logo 目录的本地服务 */
    async prepare(opts) {
      const distDir = await ensureDailyDeckBuilt(opts.dir, opts.signal);
      const mascotDir = await resolveMascotAssetsRoot(opts.dir, opts.rootDir);
      const logosDir = opts.rootDir
        ? await resolveLogoAssetsRoot(opts.rootDir, opts.dir)
        : await resolveLogoAssetsRoot(path.resolve(opts.dir, '..', '..'), opts.dir);
      return startTemplateHttpServer({
        distDir,
        runDir: opts.runDir,
        mascotDir,
        logosDir,
      });
    },

    /** 在无头浏览器中等待前端控制接口就绪、注入整期数据并逐页截取 PNG 画面 */
    async capture(
      page: BrowserPageLike,
      data: unknown,
      plan: PagePlan[],
      outDir: string,
    ): Promise<string[]> {
      await fs.mkdir(outDir, { recursive: true });

      const bridgeReady = await page.evaluate(async () => {
        const deadline = Date.now() + 15_000;
        while (Date.now() < deadline) {
          const win = window as unknown as { __NEWS_DECK__?: unknown };
          if (win.__NEWS_DECK__) {
            return true;
          }
          await new Promise((r) => setTimeout(r, 50));
        }
        return false;
      }, undefined);

      if (!bridgeReady) {
        throw new Error('前端视频模板加载超时，未能检测到 window.__NEWS_DECK__ 控制接口');
      }

      const injectRes = await page.evaluate(async (payload) => {
        const win = window as unknown as {
          __NEWS_DECK__?: {
            setNewsData: (raw: unknown) => {
              ok: boolean;
              warningCount: number;
              warnings?: Array<{ path: string; code: string }>;
            };
          };
        };
        if (!win.__NEWS_DECK__) {
          throw new Error('模板控制接口不可用');
        }
        const res = win.__NEWS_DECK__.setNewsData(payload);
        if (document.fonts?.ready) {
          await Promise.race([document.fonts.ready, new Promise((r) => setTimeout(r, 3000))]);
        }
        return res;
      }, data);

      if (!injectRes.ok) {
        throw new Error('向前端模板注入整期新闻数据失败');
      }
      if (
        injectRes.warnings?.some(
          (warning) => warning.path === 'items' && warning.code === 'clamped',
        )
      ) {
        throw new Error('模板截断了新闻列表，已停止渲染以防音画错位');
      }

      const capturedFiles: string[] = [];
      for (const item of plan) {
        await page.evaluate(async (pageIdx) => {
          const win = window as unknown as {
            __NEWS_DECK__?: {
              goToPage: (index: number) => Promise<number>;
            };
          };
          if (!win.__NEWS_DECK__) {
            throw new Error('模板翻页前控制接口丢失');
          }
          await win.__NEWS_DECK__.goToPage(pageIdx);
          if (document.fonts?.ready) {
            await Promise.race([document.fonts.ready, new Promise((r) => setTimeout(r, 3000))]);
          }
        }, item.index);

        await page.waitForTimeout(50);

        const health = await page.evaluate(() => {
          const win = window as unknown as {
            __NEWS_DECK__?: {
              getHealthReport: () => { ok: boolean; runtimeErrors: string[] };
            };
          };
          return win.__NEWS_DECK__?.getHealthReport() ?? { ok: true, runtimeErrors: [] };
        }, undefined);

        if (!health.ok || health.runtimeErrors.length > 0) {
          throw new Error(
            `前端模板渲染第 ${item.index} 页时报告异常: ${health.runtimeErrors.join('; ')}`,
          );
        }

        const outFile = path.join(outDir, `page-${String(item.index).padStart(2, '0')}.png`);
        const tmpFile = path.join(
          outDir,
          `.page-${String(item.index).padStart(2, '0')}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp.png`,
        );
        try {
          await page.screenshot({ path: tmpFile, type: 'png', fullPage: false });
          await fs.rename(tmpFile, outFile);
        } catch (err) {
          await fs.rm(tmpFile, { force: true }).catch(() => undefined);
          throw err;
        }
        capturedFiles.push(outFile);
      }

      return capturedFiles;
    },

    /**
     * 在确定性虚拟时钟模式下按统一帧网格步进渲染指定章节的动态视频分片（含顶部进度推进、翻页过渡与 Live2D 口型微动），
     * 并在每个章节的稳定展示时刻保存一张无损代表帧 PNG 供封面生成与成片质检使用。
     */
    async renderSections(opts: RenderSectionsOptions): Promise<void> {
      const { page, data, sections, width, height, fps, ffmpegBin, signal } = opts;
      if (sections.length === 0) {
        return;
      }

      const dataRecord = data && typeof data === 'object' ? (data as Record<string, unknown>) : {};
      const expectsLive2d = Boolean(
        typeof dataRecord.hostLive2dUrl === 'string' &&
          dataRecord.hostLive2dUrl.trim().length > 0 &&
          dataRecord.hostMascotId !== 'none',
      );

      const bridgeReady = await page.evaluate(async () => {
        const deadline = Date.now() + 15_000;
        while (Date.now() < deadline) {
          const win = window as unknown as { __NEWS_DECK__?: unknown };
          if (win.__NEWS_DECK__) {
            return true;
          }
          await new Promise((r) => setTimeout(r, 40));
        }
        return false;
      }, undefined);

      if (!bridgeReady) {
        throw new Error('前端视频模板加载超时，未能检测到 window.__NEWS_DECK__ 控制接口');
      }

      const injectRes = await page.evaluate(async (payload) => {
        const win = window as unknown as {
          __NEWS_DECK__?: {
            setNewsData: (raw: unknown) => {
              ok: boolean;
              warningCount: number;
              warnings?: Array<{ path: string; code: string }>;
            };
            waitUntilReady: (timeoutMs?: number) => Promise<{ ok: boolean; live2dReady: boolean }>;
            getHealthReport: () => { ok: boolean; runtimeErrors: string[] };
          };
        };
        if (!win.__NEWS_DECK__) {
          throw new Error('模板控制接口不可用');
        }
        const setOut = win.__NEWS_DECK__.setNewsData(payload);
        const readyOut = await win.__NEWS_DECK__.waitUntilReady(12_000);
        const health = win.__NEWS_DECK__.getHealthReport();
        return {
          ...setOut,
          live2dReady: readyOut.live2dReady,
          runtimeErrors: health.runtimeErrors,
        };
      }, data);

      if (!injectRes.ok) {
        throw new Error('向前端模板注入整期新闻数据失败');
      }
      if (
        injectRes.warnings?.some(
          (warning) => warning.path === 'items' && warning.code === 'clamped',
        )
      ) {
        throw new Error('模板截断了新闻列表，已停止渲染以防音画错位');
      }
      if (expectsLive2d && !injectRes.live2dReady) {
        throw new Error(
          `Live2D 角色模型未能在规定时间内就绪，拒绝写入残缺画面缓存: ${injectRes.runtimeErrors.join('; ') || 'live2dReady=false'}`,
        );
      }

      const fixedDtMs = 1000 / fps;
      const rawItems = Array.isArray(dataRecord.items) ? dataRecord.items : [];
      const totalPageCount = rawItems.length + 2;

      for (const sec of sections) {
        if (signal?.aborted) {
          throw new DOMException('已取消', 'AbortError');
        }
        await fs.mkdir(path.dirname(sec.outMp4Path), { recursive: true });
        await fs.mkdir(path.dirname(sec.outPngPath), { recursive: true });

        const startFrame = sec.startFrame;
        const frameCount = Math.max(1, sec.frameCount);
        const speechOffsetMs = sec.speechOffsetMs ?? 0;
        // 代表帧截图时刻：封面取开头不久；新闻页取口播真正开始后进行到 85% 时（卡片已全部出齐）
        const isNewsSection = sec.index > 0 && sec.index < totalPageCount - 1;
        const preferredRepOffset =
          sec.index === 0
            ? Math.round(0.8 * fps)
            : isNewsSection && sec.speechMs > 0
              ? Math.round(((speechOffsetMs + sec.speechMs * 0.85) / 1000) * fps)
              : Math.round(((speechOffsetMs + 650) / 1000) * fps);
        const repLocalFrame = Math.min(frameCount - 1, Math.max(0, preferredRepOffset));
        const sectionMood: MascotMood = sec.mood ?? 'neutral';

        await page.evaluate(
          async (warmupPayload: {
            atTimeMs: number;
            steps: number;
            mood: MascotMood;
            stepMs: number;
          }) => {
            const win = window as unknown as {
              __NEWS_DECK__?: {
                warmupPhysics: (
                  atTimeMs: number,
                  steps?: number,
                  mood?: MascotMood,
                  stepMs?: number,
                ) => Promise<void>;
              };
            };
            await win.__NEWS_DECK__?.warmupPhysics(
              warmupPayload.atTimeMs,
              warmupPayload.steps,
              warmupPayload.mood,
              warmupPayload.stepMs,
            );
          },
          {
            atTimeMs: (startFrame * 1000) / fps,
            steps: 18,
            mood: sectionMood,
            stepMs: fixedDtMs,
          },
        );

        await encodeJpegStreamToMp4({
          outMp4: sec.outMp4Path,
          width,
          height,
          fps,
          durationMs: sec.durationMs,
          ffmpegBin,
          signal,
          produceFrames: async (pushJpegFrame) => {
            for (let f = 0; f < frameCount; f++) {
              if (signal?.aborted) {
                throw new DOMException('已取消', 'AbortError');
              }
              const globalTimeMs = ((startFrame + f) * 1000) / fps;
              const seekSnap = await page.evaluate(
                async (arg: { targetMs: number; dtMs: number }) => {
                  const win = window as unknown as {
                    __NEWS_DECK__?: {
                      seekTo: (
                        ms: number,
                        dtMs?: number,
                      ) => Promise<{
                        currentPage: number;
                        live2dReady: boolean;
                      }>;
                    };
                  };
                  if (!win.__NEWS_DECK__) {
                    throw new Error('虚拟时钟步进期间前端控制接口丢失');
                  }
                  return win.__NEWS_DECK__.seekTo(arg.targetMs, arg.dtMs);
                },
                { targetMs: globalTimeMs, dtMs: fixedDtMs },
              );

              const itemRecord =
                sec.index > 0 && sec.index < totalPageCount - 1
                  ? (rawItems[sec.index - 1] as Record<string, unknown> | undefined)
                  : undefined;
              const sectionExpectsLive2d =
                expectsLive2d &&
                (dataRecord.mascotMode !== 'per-item' ||
                  sec.index === 0 ||
                  sec.index >= totalPageCount - 1 ||
                  itemRecord?.mascotId === dataRecord.hostMascotId);
              if (sectionExpectsLive2d && !seekSnap.live2dReady) {
                throw new Error(
                  `第 ${sec.index} 章第 ${f} 帧检测到 Live2D 模型丢失或未就绪，中止分片编码`,
                );
              }

              if (f === 0 || f === frameCount - 1) {
                const health = await page.evaluate(() => {
                  const win = window as unknown as {
                    __NEWS_DECK__?: {
                      getHealthReport: () => { ok: boolean; runtimeErrors: string[] };
                    };
                  };
                  return win.__NEWS_DECK__?.getHealthReport() ?? { ok: true, runtimeErrors: [] };
                }, undefined);
                if (!health.ok || health.runtimeErrors.length > 0) {
                  throw new Error(
                    `前端模板渲染第 ${sec.index} 章时报告运行异常: ${health.runtimeErrors.join('; ')}`,
                  );
                }
              }

              if (f === repLocalFrame) {
                const tmpPng = `${sec.outPngPath}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp.png`;
                try {
                  await page.screenshot({ path: tmpPng, type: 'png', fullPage: false });
                  await fs.rename(tmpPng, sec.outPngPath);
                } catch (err) {
                  await fs.rm(tmpPng, { force: true }).catch(() => undefined);
                  throw err;
                }
              }

              const jpegBuf = await page.screenshot({
                type: 'jpeg',
                quality: 90,
                fullPage: false,
              });
              await pushJpegFrame(jpegBuf);
            }
            return frameCount;
          },
        });
      }
    },
  };
}
