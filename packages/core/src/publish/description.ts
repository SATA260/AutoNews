import path from 'node:path';
import {
  type IssuePackage,
  type PublishDraft,
  PublishDraftSchema,
  type RunItemRecord,
  type Settings,
  type Timeline,
  TimelineSchema,
} from '@aidaily/contracts';
import type { CoreContext } from '../context.js';
import { PackageCheckpointSchema } from '../editorial/s6-package.js';
import { readJsonOrNullWithSchema } from '../storage/files.js';
import { STAGE_CHECKPOINT_REL_PATH } from '../workflow/stages.js';

/** 按完整 Unicode 码点安全截断文本，防止把表情符号从中间截断 */
function truncateByCodepoints(text: string, maxChars: number): string {
  const chars = Array.from(text);
  if (chars.length <= maxChars) {
    return text;
  }
  if (maxChars <= 1) {
    return chars.slice(0, Math.max(0, maxChars)).join('');
  }
  return `${chars
    .slice(0, maxChars - 1)
    .join('')
    .trimEnd()}…`;
}

/** 统计字符串的 Unicode 字符个数 */
function codepointLen(text: string): number {
  return Array.from(text).length;
}

const EXTERNAL_URL_PATTERN =
  /(?:https?:\/\/|www\.)\S+|\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|cn|org|net|io|ai|dev|gg|co|me|app|tv)(?:\/\S*)?/gi;

/** 剥离简介中意外混入的外部链接与域名，防止触发 B 站外链违规下架 */
export function stripExternalUrlsFromDescription(text: string): string {
  return text
    .replace(EXTERNAL_URL_PATTERN, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** 把毫秒时间点格式化为视频平台章节时间轴标签（`mm:ss`） */
export function formatChapterTimestamp(ms: number): string {
  const totalSec = Math.max(0, Math.round(ms / 1000));
  const mins = String(Math.floor(totalSec / 60)).padStart(2, '0');
  const secs = String(totalSec % 60).padStart(2, '0');
  return `${mins}:${secs}`;
}

/** 根据时间轴、编排顺序和平台字数上限生成 B 站视频简介文本（严禁外链，保留清晰免责声明） */
export function buildBilibiliDescription(opts: {
  packageData: IssuePackage;
  timeline: Timeline;
  items: RunItemRecord[];
  publishConfig: Settings['publish']['bilibili'];
}): string {
  const { packageData, timeline, items, publishConfig } = opts;

  const itemById = new Map(items.map((item) => [item.id, item]));
  const chapterLines: string[] = [];
  let itemCounter = 0;

  for (const sec of timeline.sections) {
    const ts = formatChapterTimestamp(sec.startMs);
    if (sec.kind === 'intro') {
      chapterLines.push(`${ts} 开场导览`);
    } else if (sec.kind === 'outro') {
      chapterLines.push(`${ts} 本期总结与互动`);
    } else {
      itemCounter += 1;
      const item = sec.itemId ? itemById.get(sec.itemId) : undefined;
      const label = item?.finalJson?.shortTitle ?? `第 ${itemCounter} 条资讯`;
      chapterLines.push(`${ts} ${String(itemCounter).padStart(2, '0')} ${label}`);
    }
  }

  const introBlock = stripExternalUrlsFromDescription(packageData.publish.descriptionIntro);
  const chaptersBlock = `【内容时间轴】\n${chapterLines.join('\n')}`;
  const disclaimerBlock = stripExternalUrlsFromDescription(publishConfig.aiDisclaimerText);
  const maxChars = publishConfig.descMax;

  const candidate = [introBlock, chaptersBlock, disclaimerBlock].filter(Boolean).join('\n\n');
  if (codepointLen(candidate) <= maxChars) {
    return candidate;
  }

  // 超长时优先裁剪导览与章节块，并始终兜底保留 AI 生成内容声明
  const fixedTail = disclaimerBlock;
  const fixedTailLen = codepointLen(fixedTail);
  if (fixedTailLen >= maxChars) {
    return truncateByCodepoints(fixedTail, maxChars);
  }

  const remainingBudget = Math.max(0, maxChars - fixedTailLen - 2);
  const headText = [introBlock, chaptersBlock].filter(Boolean).join('\n\n');
  const trimmedHead = truncateByCodepoints(headText, remainingBudget);
  return trimmedHead ? `${trimmedHead}\n\n${fixedTail}` : fixedTail;
}

/** 合并默认标签和编排生成的新闻关键词标签，去重并裁剪至平台允许上限 */
export function buildBilibiliTags(
  packageTags: readonly string[],
  publishConfig: Settings['publish']['bilibili'],
): string[] {
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const raw of [...publishConfig.defaultTags, ...packageTags]) {
    const clean = raw.trim();
    if (!clean || seen.has(clean)) {
      continue;
    }
    seen.add(clean);
    merged.push(clean);
    if (merged.length >= publishConfig.tagsMax) {
      break;
    }
  }
  return merged;
}

/**
 * 为处于可审阅状态的任务自动生成并落盘 B 站投稿草稿（标题、章节时间轴简介与标签）；
 * 除非显式指定重新生成（`regenerate: true`），否则一旦已存在完整草稿或正式投稿记录即原样保留，避免覆盖人工编辑或尝试次数。
 */
export async function ensurePublishDraftForRun(
  ctx: CoreContext,
  runId: string,
  settings: Settings,
  opts?: { regenerate?: boolean },
): Promise<PublishDraft | null> {
  const existing = ctx.repos.publish.getByRun(runId);
  const runDir = ctx.paths.runDir(runId);
  const videoFile = path.join(runDir, 'output', 'video.mp4');
  const coverFile = path.join(runDir, 'output', 'cover.jpg');
  const videoPath = path.relative(ctx.paths.rootDir, videoFile);
  const coverPath = path.relative(ctx.paths.rootDir, coverFile);

  const isProtectedStatus =
    existing?.status === 'publishing' ||
    existing?.status === 'published' ||
    existing?.status === 'uncertain' ||
    existing?.status === 'consumed_only';

  if (existing?.title && existing.description && (isProtectedStatus || !opts?.regenerate)) {
    return PublishDraftSchema.parse({
      runId,
      title: existing.title,
      description: existing.description,
      tags: existing.tags.length > 0 ? existing.tags : settings.publish.bilibili.defaultTags,
      videoPath,
      coverPath,
      aiDeclaration: true,
      status: existing.status,
    });
  }

  const pkgCheckpoint = await readJsonOrNullWithSchema(
    path.join(runDir, STAGE_CHECKPOINT_REL_PATH.package),
    PackageCheckpointSchema,
    { fallbackNullOnInvalid: true },
  );
  const parsedTimeline = await readJsonOrNullWithSchema(
    path.join(runDir, 'timeline.json'),
    TimelineSchema,
    { fallbackNullOnInvalid: true },
  );
  if (!pkgCheckpoint?.packageData || !parsedTimeline) {
    return null;
  }

  const pkg = pkgCheckpoint.packageData;
  const items = ctx.repos.runItems.listByRun(runId);

  const title = truncateByCodepoints(pkg.publish.title.trim(), settings.publish.bilibili.titleMax);
  const description = buildBilibiliDescription({
    packageData: pkg,
    timeline: parsedTimeline,
    items,
    publishConfig: settings.publish.bilibili,
  });
  const tags = buildBilibiliTags(pkg.publish.tags, settings.publish.bilibili);

  const saved = ctx.repos.publish.upsertDraft({
    runId,
    title,
    description,
    tags,
    updatedAt: ctx.now().toISOString(),
  });

  return PublishDraftSchema.parse({
    runId,
    title: saved.title ?? title,
    description: saved.description ?? description,
    tags: saved.tags.length > 0 ? saved.tags : tags,
    videoPath,
    coverPath,
    aiDeclaration: true,
    status: saved.status,
  });
}
