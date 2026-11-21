import crypto from 'node:crypto';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  COVER_TEXT_LIMITS,
  type CoverTemplateData,
  type CoverText,
  CoverTextSchema,
  type HostMascotId,
  HostMascotIdSchema,
  type Settings,
} from '@aidaily/contracts';
import { TZDate } from '@date-fns/tz';
import { format } from 'date-fns';
import { chromium } from 'playwright';
import type { CoreContext } from '../context.js';
import { deriveFallbackCoverText, normalizeCoverText } from '../editorial/cover-text.js';
import { loadPersonas } from '../editorial/personas.js';
import { PackageCheckpointSchema } from '../editorial/s6-package.js';
import { readJsonOrNull, readJsonOrNullWithSchema, writeJsonAtomic } from '../storage/files.js';
import { startTemplateHttpServer } from '../templates/server.js';
import { emitRunEvent } from '../workflow/events.js';
import { STAGE_CHECKPOINT_REL_PATH } from '../workflow/stages.js';
import { closeBrowserSafely, resolveChromiumExecutablePath } from './browser.js';
import { loadLogoCatalog, resolveCompanyIdentity, resolveLogoAssetsRoot } from './company-logos.js';
import { renderCoverJpg } from './ffmpeg.js';

/** 人工改过的封面文字在任务目录下的保存位置 */
export const COVER_TEXT_FILE = 'cover.json';

/** 封面图片在任务目录下的输出位置 */
export const COVER_IMAGE_REL_PATH = path.join('output', 'cover.jpg');

/** 封面模板画布尺寸（与 B 站推荐的 16:9 封面一致） */
const COVER_WIDTH = 1920;
const COVER_HEIGHT = 1080;

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'] as const;

/** 封面文字的来源：人工修改、编排阶段生成，或由头条导语自动截取 */
export type CoverTextSource = 'manual' | 'package' | 'fallback';

/** 某一期当前生效的封面文字及封面图片状态 */
export interface CoverState {
  text: CoverText;
  source: CoverTextSource;
  limits: typeof COVER_TEXT_LIMITS;
  /** 封面图片相对项目根目录的路径 */
  coverPath: string;
  /** 封面图片最后生成时间（UTC ISO），尚未生成时为 null */
  coverUpdatedAt: string | null;
}

/** 人工修改封面文字后保存的文件内容 */
interface CoverTextFile {
  text: CoverText;
  updatedAt: string;
}

/** 读取某一期人工保存的封面文字，文件不存在或内容不合法时返回 null */
async function readManualCoverText(ctx: CoreContext, runId: string): Promise<CoverText | null> {
  const raw = await readJsonOrNull<Partial<CoverTextFile>>(
    path.join(ctx.paths.runDir(runId), COVER_TEXT_FILE),
  );
  const parsed = CoverTextSchema.safeParse(raw?.text);
  return parsed.success ? normalizeCoverText(parsed.data) : null;
}

/** 读取封面图片最后修改时间，图片不存在时返回 null */
async function readCoverImageTime(ctx: CoreContext, runId: string): Promise<string | null> {
  try {
    const st = await fs.stat(path.join(ctx.paths.runDir(runId), COVER_IMAGE_REL_PATH));
    return st.mtime.toISOString();
  } catch {
    return null;
  }
}

/**
 * 读取某一期当前生效的封面文字：人工修改过的优先，其次是编排阶段生成的，最后用头条导语截取。
 * 尚未完成整期编排时返回 null。
 */
export async function readCoverState(ctx: CoreContext, runId: string): Promise<CoverState | null> {
  const runDir = ctx.paths.runDir(runId);
  const coverPath = path.relative(ctx.paths.rootDir, path.join(runDir, COVER_IMAGE_REL_PATH));
  const coverUpdatedAt = await readCoverImageTime(ctx, runId);
  const base = { limits: COVER_TEXT_LIMITS, coverPath, coverUpdatedAt };

  const manual = await readManualCoverText(ctx, runId);
  if (manual) {
    return { ...base, text: manual, source: 'manual' };
  }

  const pkgCheckpoint = await readJsonOrNullWithSchema(
    path.join(runDir, STAGE_CHECKPOINT_REL_PATH.package),
    PackageCheckpointSchema,
    { fallbackNullOnInvalid: true },
  );
  const pkg = pkgCheckpoint?.packageData;
  if (!pkg) {
    return null;
  }
  const fromPackage = CoverTextSchema.safeParse(pkg.cover);
  if (fromPackage.success) {
    return { ...base, text: normalizeCoverText(fromPackage.data), source: 'package' };
  }
  const headlineShortTitle =
    ctx.repos.runItems.getById(pkg.headlineItemId)?.finalJson?.shortTitle ?? undefined;
  return {
    ...base,
    text: deriveFallbackCoverText(pkg, headlineShortTitle),
    source: 'fallback',
  };
}

/** 把人工修改后的封面文字原子写入任务目录 */
export async function saveCoverText(
  ctx: CoreContext,
  runId: string,
  text: CoverText,
): Promise<void> {
  const payload: CoverTextFile = {
    text: normalizeCoverText(text),
    updatedAt: ctx.now().toISOString(),
  };
  await writeJsonAtomic(path.join(ctx.paths.runDir(runId), COVER_TEXT_FILE), payload);
}

/** 组装传给封面模板的数据：封面文字、刊名、日期期号、当期主播与立绘地址 */
export async function buildCoverTemplateData(
  ctx: CoreContext,
  runId: string,
  settings: Settings,
  text: CoverText,
): Promise<CoverTemplateData> {
  const run = ctx.repos.runs.getById(runId);
  if (!run) {
    throw new Error(`未找到任务记录: ${runId}`);
  }
  const createdMs = Date.parse(run.createdAt);
  const tzDate = new TZDate(
    Number.isNaN(createdMs) ? ctx.now().getTime() : createdMs,
    settings.timezone,
  );

  const hostRow = ctx.db.prepare('SELECT host_id FROM runs WHERE id = ?').get(runId) as
    | { host_id: string | null }
    | undefined;
  const personas = await loadPersonas(ctx).catch(() => []);
  const host = HostMascotIdSchema.safeParse(hostRow?.host_id);
  const hostId: HostMascotId = host.success
    ? host.data
    : (personas[0]?.id ?? HostMascotIdSchema.parse(HostMascotIdSchema.options[0]));
  const persona = personas.find((p) => p.id === hostId);

  const mascotFile = path.join(ctx.paths.rootDir, 'assets', 'mascots', `${hostId}.png`);
  const normalized = normalizeCoverText(text);

  const pkgCheckpoint = await readJsonOrNullWithSchema(
    path.join(ctx.paths.runDir(runId), STAGE_CHECKPOINT_REL_PATH.package),
    PackageCheckpointSchema,
    { fallbackNullOnInvalid: true },
  );
  const pkg = pkgCheckpoint?.packageData;
  const themeVariant: 'digest' | 'spotlight' =
    pkg?.issueMode === 'spotlight' ? 'spotlight' : 'digest';
  const editionBadge =
    themeVariant === 'spotlight' ? '重磅专场' : tzDate.getHours() < 14 ? '早报' : '晚报';

  const headlineItem = pkg?.headlineItemId
    ? ctx.repos.runItems.getById(pkg.headlineItemId)
    : undefined;
  const headlineEntity = headlineItem?.finalJson?.entity;
  const templateDir = settings.template.cover
    ? path.resolve(ctx.paths.rootDir, settings.template.cover.dir)
    : undefined;
  const logosDir = await resolveLogoAssetsRoot(ctx.paths.rootDir, templateDir);
  const logoCatalog = logosDir ? await loadLogoCatalog(logosDir) : null;
  const brandIdentity =
    headlineEntity || pkg?.headline
      ? resolveCompanyIdentity({
          entity: headlineEntity,
          fallbackText: pkg?.headline,
          catalog: logoCatalog,
        })
      : null;

  return {
    title: normalized.title,
    subtitle: normalized.subtitle,
    masthead: 'AI 每日报',
    date: `${tzDate.getMonth() + 1}月${tzDate.getDate()}日 ${WEEKDAYS[tzDate.getDay()] ?? ''}`.trim(),
    issueNumber: `VOL.${format(tzDate, 'yyyy.MM.dd')}`,
    hostId,
    hostName: persona?.displayName ?? '',
    mascotUrl: fsSync.existsSync(mascotFile) ? `/__mascot_assets__/${hostId}.png` : '',
    ...(brandIdentity?.logoUrl ? { brandLogoUrl: brandIdentity.logoUrl } : {}),
    ...(brandIdentity?.isKnown ? { brandName: brandIdentity.displayName } : {}),
    editionBadge,
    themeVariant,
  };
}

/** 封面模板在页面里暴露的控制接口 */
interface CoverPageApi {
  setData(data: CoverTemplateData): void;
  waitUntilReady(): Promise<{ ok: boolean; warnings: string[] }>;
}

/**
 * 用封面模板把指定文字渲染成 1920×1080 的 JPG 封面：
 * 启动本地静态服务和无头浏览器，写入数据、等待排版完成后截图，再转成 JPG 原子写入目标路径。
 * 返回模板给出的排版提醒（如文字过长被缩小）。
 */
export async function renderCoverImage(opts: {
  ctx: CoreContext;
  runId: string;
  settings: Settings;
  text: CoverText;
  outJpg: string;
  ffmpegBin?: string;
  signal?: AbortSignal;
}): Promise<{ warnings: string[] }> {
  const { ctx, runId, settings, text, outJpg, ffmpegBin, signal } = opts;
  const coverCfg = settings.template.cover;
  if (!coverCfg) {
    throw new Error('尚未配置封面模板目录（template.cover.dir）');
  }
  const templateDir = path.resolve(ctx.paths.rootDir, coverCfg.dir);
  await fs.access(path.join(templateDir, 'index.html')).catch(() => {
    throw new Error(`封面模板目录缺少 index.html: ${templateDir}`);
  });
  if (signal?.aborted) {
    throw new DOMException('已取消', 'AbortError');
  }

  const data = await buildCoverTemplateData(ctx, runId, settings, text);
  await fs.mkdir(path.dirname(outJpg), { recursive: true });
  const tmpPng = path.join(path.dirname(outJpg), `.cover-${crypto.randomUUID()}.png`);
  const logosDir = await resolveLogoAssetsRoot(ctx.paths.rootDir, templateDir);
  const server = await startTemplateHttpServer({
    distDir: templateDir,
    mascotDir: path.join(ctx.paths.rootDir, 'assets', 'mascots'),
    logosDir,
  });
  const browserToken = crypto.randomUUID();
  let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;
  const onAbort = () => {
    void closeBrowserSafely(browser, browserToken);
  };
  signal?.addEventListener('abort', onAbort, { once: true });

  try {
    const exePath = await resolveChromiumExecutablePath();
    browser = await chromium.launch({
      headless: true,
      handleSIGINT: false,
      handleSIGTERM: false,
      handleSIGHUP: false,
      args: [`--aidaily-browser-token=${browserToken}`],
      ...(exePath ? { executablePath: exePath } : {}),
    });
    const page = await browser.newPage({
      viewport: { width: COVER_WIDTH, height: COVER_HEIGHT },
      deviceScaleFactor: settings.render.deviceScaleFactor ?? 1,
    });
    await page.goto(`${server.baseUrl}/index.html?external=1`, {
      waitUntil: 'load',
      timeout: 30_000,
    });
    const report = await page.evaluate(async (payload: CoverTemplateData) => {
      const api = (globalThis as unknown as { __COVER__?: CoverPageApi }).__COVER__;
      if (!api) {
        throw new Error('封面模板未提供 window.__COVER__ 控制接口');
      }
      api.setData(payload);
      return api.waitUntilReady();
    }, data);
    if (!report.ok) {
      throw new Error(`封面模板缺少必要内容：${report.warnings.join('；')}`);
    }
    if (signal?.aborted) {
      throw new DOMException('已取消', 'AbortError');
    }
    await page.screenshot({ path: tmpPng, type: 'png' });
    await renderCoverJpg({ inPng: tmpPng, outJpg, ffmpegBin, signal });
    return { warnings: report.warnings };
  } catch (err) {
    if (signal?.aborted) {
      throw new DOMException('已取消', 'AbortError');
    }
    throw err;
  } finally {
    signal?.removeEventListener('abort', onAbort);
    try {
      await closeBrowserSafely(browser, browserToken);
    } finally {
      await server.close().catch(() => undefined);
      await fs.rm(tmpPng, { force: true }).catch(() => undefined);
    }
  }
}

/**
 * 成片渲染时生成本期封面：配置了封面模板就用当前生效的封面文字出图；
 * 未配置模板、尚无封面文字或模板出图失败时，退回用视频第一帧截图作为封面，不影响成片。
 */
export async function renderRunCover(opts: {
  ctx: CoreContext;
  runId: string;
  settings: Settings;
  outJpg: string;
  fallbackPng: string;
  ffmpegBin?: string;
  signal?: AbortSignal;
}): Promise<void> {
  const { ctx, runId, settings, outJpg, fallbackPng, ffmpegBin, signal } = opts;
  if (settings.template.cover) {
    try {
      const state = await readCoverState(ctx, runId);
      if (state) {
        const { warnings } = await renderCoverImage({
          ctx,
          runId,
          settings,
          text: state.text,
          outJpg,
          ffmpegBin,
          signal,
        });
        if (warnings.length > 0) {
          emitRunEvent(ctx, {
            runId,
            level: 'warn',
            stage: 'render',
            type: 'cover_layout_warning',
            message: `封面排版提醒：${warnings.join('；')}`,
          });
        }
        return;
      }
    } catch (err) {
      if (signal?.aborted || (err instanceof Error && err.name === 'AbortError')) {
        throw new DOMException('已取消', 'AbortError');
      }
      emitRunEvent(ctx, {
        runId,
        level: 'warn',
        stage: 'render',
        type: 'cover_template_fallback',
        message: `封面模板出图失败，改用视频第一帧作为封面：${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }
  await renderCoverJpg({ inPng: fallbackPng, outJpg, ffmpegBin, signal });
}
