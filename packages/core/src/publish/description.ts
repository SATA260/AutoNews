import path from 'node:path';
import {
  type Article,
  type IssuePackage,
  type PublishDraft,
  PublishDraftSchema,
  type RunItemRecord,
  type Settings,
  type Timeline,
  TimelineSchema,
} from '@aidaily/contracts';
import type { CoreContext } from '../context.js';
import type { PackageCheckpoint } from '../editorial/s6-package.js';
import { readJsonOrNull } from '../storage/files.js';
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

/** 把毫秒时间点格式化为视频平台章节时间轴标签（`mm:ss`） */
export function formatChapterTimestamp(ms: number): string {
  const totalSec = Math.max(0, Math.round(ms / 1000));
  const mins = String(Math.floor(totalSec / 60)).padStart(2, '0');
  const secs = String(totalSec % 60).padStart(2, '0');
  return `${mins}:${secs}`;
}

/** 根据时间轴、编排顺序、文章出处和平台字数上限生成 B 站视频简介文本 */
export function buildBilibiliDescription(opts: {
  packageData: IssuePackage;
  timeline: Timeline;
  items: RunItemRecord[];
  articlesById: ReadonlyMap<string, Article>;
  eventsArticleIdsByEventId: ReadonlyMap<string, string[]>;
  sourceNameById: ReadonlyMap<string, string>;
  publishConfig: Settings['publish']['bilibili'];
}): string {
  const {
    packageData,
    timeline,
    items,
    articlesById,
    eventsArticleIdsByEventId,
    sourceNameById,
    publishConfig,
  } = opts;

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

  const sourceLines: string[] = [];
  const seenUrls = new Set<string>();
  let sourceIdx = 0;
  for (const itemId of packageData.order) {
    const item = itemById.get(itemId);
    if (!item) {
      continue;
    }
    const evArtIds = eventsArticleIdsByEventId.get(item.eventId) ?? [];
    const draftArtIds = (item.finalJson?.evidence ?? []).map((e) => e.articleId);
    const orderedIds = [...new Set([...draftArtIds, ...evArtIds])];
    for (const artId of orderedIds) {
      const art = articlesById.get(artId);
      if (!art || seenUrls.has(art.canonicalUrl)) {
        continue;
      }
      seenUrls.add(art.canonicalUrl);
      sourceIdx += 1;
      const sourceName = sourceNameById.get(art.sourceId) ?? art.sourceId;
      sourceLines.push(`${String(sourceIdx).padStart(2, '0')} ${sourceName} - ${art.canonicalUrl}`);
    }
  }

  const introBlock = packageData.publish.descriptionIntro.trim();
  const chaptersBlock = `【内容时间轴】\n${chapterLines.join('\n')}`;
  const disclaimerBlock = publishConfig.aiDisclaimerText.trim();
  const maxChars = publishConfig.descMax;

  const assemble = (
    activeSources: string[],
    activeIntro: string,
    activeChapters: string,
  ): string => {
    const parts: string[] = [];
    if (activeIntro) {
      parts.push(activeIntro);
    }
    if (activeChapters) {
      parts.push(activeChapters);
    }
    if (activeSources.length > 0) {
      parts.push(`【参考来源】\n${activeSources.join('\n')}`);
    }
    if (disclaimerBlock) {
      parts.push(disclaimerBlock);
    }
    return parts.join('\n\n');
  };

  let candidate = assemble(sourceLines, introBlock, chaptersBlock);
  if (codepointLen(candidate) <= maxChars) {
    return candidate;
  }

  // 超出长度上限时优先从参考来源列表末尾逐步裁减，确保完整保留时间轴与 AI 声明文案
  const trimmedSources = [...sourceLines];
  while (trimmedSources.length > 0 && codepointLen(candidate) > maxChars) {
    trimmedSources.pop();
    candidate = assemble(trimmedSources, introBlock, chaptersBlock);
  }
  if (codepointLen(candidate) <= maxChars) {
    return candidate;
  }

  // 若仍超长则逐步压缩导言与章节块，并始终兜底保留 AI 生成内容声明
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
 * 为处于可审阅状态的任务自动生成并落盘 B 站投稿草稿（标题、时间轴及来源简介、标签）；
 * 若已有处于投稿中、已发布或状态不明的正式记录，则保护现有记录不覆盖。
 */
export async function ensurePublishDraftForRun(
  ctx: CoreContext,
  runId: string,
  settings: Settings,
): Promise<PublishDraft | null> {
  const existing = ctx.repos.publish.getByRun(runId);
  const runDir = ctx.paths.runDir(runId);
  const videoFile = path.join(runDir, 'output', 'video.mp4');
  const coverFile = path.join(runDir, 'output', 'cover.jpg');
  const videoPath = path.relative(ctx.paths.rootDir, videoFile);
  const coverPath = path.relative(ctx.paths.rootDir, coverFile);

  if (
    existing?.title &&
    existing.description &&
    (existing.status === 'publishing' ||
      existing.status === 'published' ||
      existing.status === 'uncertain' ||
      existing.status === 'consumed_only')
  ) {
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

  const pkgCheckpoint = await readJsonOrNull<PackageCheckpoint>(
    path.join(runDir, STAGE_CHECKPOINT_REL_PATH.package),
  );
  const rawTimeline = await readJsonOrNull<unknown>(path.join(runDir, 'timeline.json'));
  const parsedTimeline = TimelineSchema.safeParse(rawTimeline);
  if (!pkgCheckpoint?.packageData || !parsedTimeline.success) {
    return null;
  }

  const pkg = pkgCheckpoint.packageData;
  const items = ctx.repos.runItems.listByRun(runId);
  const events = ctx.repos.events.listByRun(runId);
  const eventsArticleIdsByEventId = new Map(events.map((e) => [e.id, e.articleIds]));
  const allArticleIds = Array.from(
    new Set(
      events
        .flatMap((e) => e.articleIds)
        .concat(items.flatMap((i) => (i.finalJson?.evidence ?? []).map((ev) => ev.articleId))),
    ),
  );
  const articles = ctx.repos.articles.getByIds(allArticleIds);
  const articlesById = new Map(articles.map((a) => [a.id, a]));
  const sourceNameById = new Map(ctx.sources.map((s) => [s.id, s.name]));

  const title = truncateByCodepoints(pkg.publish.title.trim(), settings.publish.bilibili.titleMax);
  const description = buildBilibiliDescription({
    packageData: pkg,
    timeline: parsedTimeline.data,
    items,
    articlesById,
    eventsArticleIdsByEventId,
    sourceNameById,
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
