import {
  type Article,
  type SelectedEventCandidate,
  SelectionResultSchema,
  type Settings,
  type SourceDef,
} from '@aidaily/contracts';
import type { CoreContext } from '../context.js';
import type { PublishedHistoryRecord } from '../storage/repos/articles-repo.js';
import { invokeStageLlm } from './llm.js';
import { renderPromptTemplate } from './prompts.js';
import { isDuplicateOfHistory } from './similarity.js';

const MAX_SELECT_CANDIDATES = 80;

/** 经过确定性初筛与去重后的候选事件输出结果 */
export interface CandidateSelectionOutput {
  selected: Array<{
    candidate: SelectedEventCandidate;
    allArticleIds: string[];
  }>;
  consideredArticleIds: string[];
}

/** 计算候选文章发布时间的毫秒时间戳 */
function articlePublishedMs(article: Article): number {
  const ts = article.publishedAt ?? article.firstSeenAt;
  const ms = Date.parse(ts);
  return Number.isNaN(ms) ? 0 : ms;
}

/** 计算单篇文章进入候选池的排序权重（高权威信源等级优先，其次发布时间越新越靠前） */
function candidateRankScore(article: Article, sourceTier: number): number {
  const tierWeight = Math.max(1, 4 - sourceTier) * 1e13;
  return tierWeight + articlePublishedMs(article);
}

/**
 * 执行一轮候选文章确定性预过滤与大模型聚类选题：
 * 先按历史播报链接与标题相似度去重、合并完全相同的标题、按信源等级与时效保留前 80 条，
 * 再调用选题阶段大模型合并同事件多源报道并滤除与历史重复的新闻。
 */
export async function selectCandidateEvents(opts: {
  ctx: CoreContext;
  runId: string;
  settings: Settings;
  sinceIso: string;
  includeExpired: boolean;
  targetCount: number;
  itemCount: number;
  excludeArticleIds?: ReadonlySet<string>;
  signal?: AbortSignal;
}): Promise<CandidateSelectionOutput> {
  const { ctx, runId, settings, sinceIso, includeExpired, targetCount, itemCount, signal } = opts;

  const rawCandidates = ctx.repos.articles.listCandidates(sinceIso, includeExpired);
  const historySinceIso = new Date(
    ctx.now().getTime() - settings.editorial.historyDedupDays * 24 * 3600_000,
  ).toISOString();
  const history: PublishedHistoryRecord[] = ctx.repos.history.listRecent(historySinceIso, 500);

  const historyUrls = new Set<string>();
  for (const rec of history) {
    for (const url of rec.articleUrls) {
      historyUrls.add(url);
    }
  }

  const sourceById = new Map<string, SourceDef>(ctx.sources.map((s) => [s.id, s]));

  // 1. 排除已使用/已播链接与与历史标题高度相似的文章
  const freshFiltered: Article[] = [];
  for (const article of rawCandidates) {
    if (opts.excludeArticleIds?.has(article.id)) {
      continue;
    }
    if (historyUrls.has(article.canonicalUrl)) {
      continue;
    }
    const dup = isDuplicateOfHistory(
      article.title,
      history,
      settings.editorial.titleSimilarityThreshold,
    );
    if (dup.duplicate) {
      continue;
    }
    freshFiltered.push(article);
  }

  if (freshFiltered.length === 0) {
    return { selected: [], consideredArticleIds: [] };
  }

  // 2. 合并标题完全一致的条目（优先保留信源等级更高、时间更新的那篇作为代表）
  const groupedByTitle = new Map<string, { rep: Article; aliases: string[]; score: number }>();
  for (const article of freshFiltered) {
    const key = article.titleNorm || article.title;
    const tier = sourceById.get(article.sourceId)?.tier ?? 3;
    const score = candidateRankScore(article, tier);
    const existing = groupedByTitle.get(key);
    if (!existing) {
      groupedByTitle.set(key, { rep: article, aliases: [article.id], score });
    } else {
      existing.aliases.push(article.id);
      if (score > existing.score) {
        existing.rep = article;
        existing.score = score;
      }
    }
  }

  // 3. 候选超过 80 条时按综合评分截断保留前 80 条
  const dedupedGroups = Array.from(groupedByTitle.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_SELECT_CANDIDATES);

  const aliasesByRepId = new Map<string, string[]>();
  const validRepIds = new Set<string>();
  for (const group of dedupedGroups) {
    aliasesByRepId.set(group.rep.id, group.aliases);
    validRepIds.add(group.rep.id);
  }

  const promptCandidates = dedupedGroups.map(({ rep }) => {
    const src = sourceById.get(rep.sourceId);
    return {
      id: rep.id,
      source: src?.name ?? rep.sourceId,
      tier: src?.tier ?? 3,
      lang: rep.lang,
      publishedAt: rep.publishedAt ?? rep.firstSeenAt,
      title: rep.title,
      excerpt: (rep.excerpt ?? '').slice(0, 300),
    };
  });

  const historyText =
    history.length > 0 ? history.map((h) => `- ${h.title}`).join('\n') : '（近期暂无已播事件）';

  const prompt = await renderPromptTemplate('s2-select.md', {
    targetCount: String(Math.max(1, targetCount)),
    itemCount: String(Math.max(1, itemCount)),
    historyDedupDays: String(settings.editorial.historyDedupDays),
    historyTitles: historyText,
    candidates: JSON.stringify(promptCandidates, null, 2),
  });

  const llmRes = await invokeStageLlm({
    ctx,
    settings,
    stage: 'select',
    runId,
    prompt,
    schema: SelectionResultSchema,
    signal,
  });

  const claimedRepIds = new Set<string>();
  const selected: CandidateSelectionOutput['selected'] = [];

  for (const ev of llmRes.data.events) {
    if (ev.duplicateOfHistory) {
      continue;
    }
    const evDup = isDuplicateOfHistory(
      ev.title,
      history,
      settings.editorial.titleSimilarityThreshold,
    );
    if (evDup.duplicate) {
      continue;
    }

    const validRepForEvent: string[] = [];
    const expandedArticleIds: string[] = [];
    const seenExpanded = new Set<string>();

    for (const rawId of ev.articleIds) {
      if (!validRepIds.has(rawId) || claimedRepIds.has(rawId)) {
        continue;
      }
      validRepForEvent.push(rawId);
      const groupIds = aliasesByRepId.get(rawId) ?? [rawId];
      for (const gid of groupIds) {
        if (!seenExpanded.has(gid)) {
          seenExpanded.add(gid);
          expandedArticleIds.push(gid);
        }
      }
    }

    if (validRepForEvent.length === 0 || expandedArticleIds.length === 0) {
      continue;
    }
    for (const repId of validRepForEvent) {
      claimedRepIds.add(repId);
    }

    selected.push({
      candidate: {
        ...ev,
        articleIds: validRepForEvent,
      },
      allArticleIds: expandedArticleIds,
    });
  }

  return {
    selected,
    consideredArticleIds: dedupedGroups.flatMap((g) => g.aliases),
  };
}
