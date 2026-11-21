import {
  type ArticleMediaAsset,
  type EventRecord,
  type Settings,
  type SummaryDraft,
  SummaryDraftSchema,
} from '@aidaily/contracts';
import { TZDate } from '@date-fns/tz';
import { format } from 'date-fns';
import { readStoredArticleContent } from '../collector/extractor.js';
import type { CoreContext } from '../context.js';
import { invokeStageLlm } from './llm.js';
import { type ArticlePromptInput, buildArticlesXml, renderPromptTemplate } from './prompts.js';

/** 为核查预检准备的单篇原文正文字典条目 */
export interface LoadedEventArticle {
  id: string;
  title: string;
  sourceName: string;
  sourceUrl: string;
  publishedAt: string | null;
  text: string;
  imagePath: string | null;
  mediaAssets: ArticleMediaAsset[];
  promptInput: ArticlePromptInput;
}

/** 读取某新闻事件关联的所有原始文章信息、磁盘缓存正文与候选视觉素材 */
export async function loadEventArticles(
  ctx: CoreContext,
  event: EventRecord,
): Promise<Map<string, LoadedEventArticle>> {
  const articles = ctx.repos.articles.getByIds(event.articleIds);
  const sourceById = new Map(ctx.sources.map((s) => [s.id, s]));
  const result = new Map<string, LoadedEventArticle>();

  for (const article of articles) {
    const stored = await readStoredArticleContent(ctx.paths.rootDir, article.contentPath);
    const text = (stored?.text ?? article.excerpt ?? '').trim();
    if (!text) {
      continue;
    }
    const src = sourceById.get(article.sourceId);
    const sourceName = src?.name ?? article.sourceId;
    const tier = src?.tier ?? 3;
    const mediaAssets: ArticleMediaAsset[] =
      stored?.mediaAssets && stored.mediaAssets.length > 0
        ? stored.mediaAssets
        : article.imagePath
          ? [
              {
                id: `${article.id}-legacy`,
                articleId: article.id,
                kind: 'screenshot',
                imagePath: article.imagePath,
                sourceUrl: article.canonicalUrl,
                captionHint: article.title,
                contextSnippet: article.excerpt ?? '',
                score: 50,
              },
            ]
          : [];

    result.set(article.id, {
      id: article.id,
      title: article.title,
      sourceName,
      sourceUrl: article.canonicalUrl,
      publishedAt: article.publishedAt,
      text,
      imagePath: article.imagePath,
      mediaAssets,
      promptInput: {
        id: article.id,
        lang: article.lang,
        sourceName,
        tier,
        publishedAt: article.publishedAt,
        text,
      },
    });
  }

  return result;
}

/** 汇总同事件下所有关联文章提取出的候选视觉素材，去重并按价值分降序排列 */
export function collectEventMediaPool(
  articlesMap: ReadonlyMap<string, LoadedEventArticle>,
  limit = 8,
): ArticleMediaAsset[] {
  const byImagePath = new Map<string, ArticleMediaAsset>();
  for (const article of articlesMap.values()) {
    for (const asset of article.mediaAssets) {
      const existing = byImagePath.get(asset.imagePath);
      if (!existing || asset.score > existing.score) {
        byImagePath.set(asset.imagePath, asset);
      }
    }
  }
  return Array.from(byImagePath.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/** 将已加载的文章集合按字符上限组装为标准 `<article>` XML 片段 */
export function serializeLoadedArticlesXml(
  articlesMap: ReadonlyMap<string, LoadedEventArticle>,
  sourceMaxChars: number,
): string {
  const inputs = Array.from(articlesMap.values()).map((entry) => entry.promptInput);
  return buildArticlesXml(inputs, sourceMaxChars);
}

/**
 * 执行单条新闻的事实总结步骤：
 * 读取关联文章全文拼装原文上下文，调用大模型产出带逐字引文依据的客观摘要草稿，并写入版本历史表。
 */
export async function summarizeEventItem(opts: {
  ctx: CoreContext;
  settings: Settings;
  runId: string;
  itemId: string;
  event: EventRecord;
  articlesMap: ReadonlyMap<string, LoadedEventArticle>;
  signal?: AbortSignal;
}): Promise<SummaryDraft> {
  const { ctx, settings, runId, itemId, event, articlesMap, signal } = opts;
  if (articlesMap.size === 0) {
    throw new Error(`事件 ${event.id} 缺少可用的原始文章正文，无法总结`);
  }

  const nowDate = ctx.now();
  const tzNow = new TZDate(nowDate.getTime(), settings.timezone);
  const currentTime = `${format(tzNow, 'yyyy-MM-dd HH:mm')}（${settings.timezone}，UTC: ${nowDate.toISOString()}）`;
  const articlesXml = serializeLoadedArticlesXml(articlesMap, settings.editorial.sourceMaxChars);
  const prompt = await renderPromptTemplate('s3-summarize.md', {
    currentTime,
    eventTitle: event.title,
    articlesXml,
  });

  const res = await invokeStageLlm({
    ctx,
    settings,
    stage: 'summarize',
    runId,
    itemId,
    prompt,
    schema: SummaryDraftSchema,
    signal,
  });

  ctx.repos.runItems.appendVersion({
    itemId,
    kind: 'summary',
    round: 0,
    payload: res.data,
    createdAt: ctx.now().toISOString(),
  });

  return res.data;
}
