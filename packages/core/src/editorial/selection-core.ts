import {
  type Article,
  type SelectedEventCandidate,
  SelectionResultSchema,
  type Settings,
  type SourceDef,
} from '@aidaily/contracts';
import { TZDate } from '@date-fns/tz';
import { format } from 'date-fns';
import type { CoreContext } from '../context.js';
import type { PublishedHistoryRecord } from '../storage/repos/articles-repo.js';
import { invokeStageLlm } from './llm.js';
import { renderPromptTemplate } from './prompts.js';
import {
  isDuplicateOfHistory,
  isExactTitleMatch,
  normalizeTitleForExactMatch,
  selectRelevantOriginReferences,
} from './similarity.js';

const MAX_SELECT_CANDIDATES = 80;
const MAX_PROMPT_HISTORY_TITLES = 80;
const MAX_PROMPT_ORIGIN_REFS = 40;

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
 * 判断前期参考文章的发布时间是否确凿早于最早新闻时间下限：
 * 对于仅记录到公历日期（UTC 零点）的条目按跨时区日界线预留宽限，防止同日更新被误标为旧闻。
 */
function isOriginProvablyBeforeCutoff(
  originPublishedAt: string | null,
  notBeforeAt: string,
): boolean {
  if (!originPublishedAt) {
    return false;
  }
  const pubMs = Date.parse(originPublishedAt);
  const cutoffMs = Date.parse(notBeforeAt);
  if (Number.isNaN(pubMs) || Number.isNaN(cutoffMs)) {
    return false;
  }
  if (/T00:00:00(?:\.000)?Z$/i.test(originPublishedAt.trim())) {
    const latestPossibleMs = pubMs + 24 * 3600_000 - 1 + 12 * 3600_000;
    return latestPossibleMs < cutoffMs;
  }
  return pubMs < cutoffMs;
}

/** 将时间字符串转换为配置时区的日期标签（yyyy-MM-dd），解析失败时返回空串 */
function formatLocalDate(iso: string | null | undefined, timezone: string): string {
  if (!iso) {
    return '';
  }
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) {
    return '';
  }
  return format(new TZDate(ms, timezone), 'yyyy-MM-dd');
}

/** 将时间字符串转换为配置时区的日期时间标签（yyyy-MM-dd HH:mm），解析失败时返回空串 */
function formatLocalDateTime(iso: string | null | undefined, timezone: string): string {
  if (!iso) {
    return '';
  }
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) {
    return '';
  }
  return format(new TZDate(ms, timezone), 'yyyy-MM-dd HH:mm');
}

/** 压缩正文字段摘要空白并裁剪长度，若与标题完全重复则省略以避免提示词冗余 */
function compactExcerpt(text: string | null | undefined, title: string, maxLen = 80): string {
  if (!text) {
    return '';
  }
  const collapsed = text.replace(/\s+/g, ' ').trim();
  if (!collapsed) {
    return '';
  }
  const titleNorm = normalizeTitleForExactMatch(title);
  if (titleNorm && normalizeTitleForExactMatch(collapsed) === titleNorm) {
    return '';
  }
  return collapsed.length > maxLen ? `${collapsed.slice(0, maxLen)}…` : collapsed;
}

/** 生成注入选题提示词的最早时间硬性下限约束文本，并可附带相关性召回的前期参考条目 */
function buildTimeCutoffRuleText(
  notBeforeAt: string | null | undefined,
  timezone: string,
  originReferences: ReadonlyArray<{
    publishedAt: string | null;
    firstSeenAt: string;
    sourceName: string;
    title: string;
    excerpt: string | null;
  }> = [],
): string {
  if (!notBeforeAt) {
    return '';
  }
  const ms = Date.parse(notBeforeAt);
  if (Number.isNaN(ms)) {
    return '';
  }
  const localLabel = format(new TZDate(ms, timezone), 'yyyy-MM-dd HH:mm');
  const lines = [
    '## 最早新闻时间硬性限制',
    `本期只允许入选实际发生与发布时间不早于 **${localLabel}（${timezone}，UTC: ${notBeforeAt}）** 的新闻。`,
    '1. 仅当候选文章是在回顾、盘点或二手转述早于上述时间已发布的**同一具体事件**且没有新的核心发布或进展时，才跳过或将 `duplicateOfHistory` 设为 `true`。',
    '2. **不同型号、代号、版本或代际的新发布**，以及**此前仅有传闻/预告、如今由官方在最早时间之后正式发布的新产品或新模型**，属于新事件，绝不要误判为旧闻。',
  ];

  if (originReferences.length > 0) {
    lines.push(
      '',
      '### 最早时间之前已入库的相关来源参考（仅用于判断是否为同一旧闻的滞后转述，不同型号/代号/版本的新发布不构成重复）',
    );
    for (const ref of originReferences) {
      const refTime =
        formatLocalDateTime(ref.publishedAt ?? ref.firstSeenAt, timezone) || '未知时间';
      const snippet = compactExcerpt(ref.excerpt, ref.title);
      lines.push(
        `- [${refTime}] [${ref.sourceName}] ${ref.title}${snippet ? ` — ${snippet}` : ''}`,
      );
    }
  }

  return lines.join('\n');
}

/**
 * 执行一轮候选文章确定性预过滤与大模型聚类选题：
 * 1) 仅按规范化链接、时间下限与归一化标题完全一致规则排除原题重复，不再按标题字符相似度误删不同代号/版本的新发布；
 * 2) 合并标题完全一致的多源文章后按信源等级与时效保留前 80 条；
 * 3) 将历史已播/已消费记录与相关性召回的前期来源参考一并交给选题模型，由模型按「是否同一具体事件且无新事实」判断去重并完成选题。
 */
export async function selectCandidateEvents(opts: {
  ctx: CoreContext;
  runId: string;
  settings: Settings;
  sinceIso: string;
  notBeforeAt?: string | null;
  includeExpired: boolean;
  targetCount: number;
  itemCount: number;
  excludeArticleIds?: ReadonlySet<string>;
  signal?: AbortSignal;
}): Promise<CandidateSelectionOutput> {
  const {
    ctx,
    runId,
    settings,
    sinceIso,
    notBeforeAt,
    includeExpired,
    targetCount,
    itemCount,
    signal,
  } = opts;

  const cutoffMs = notBeforeAt ? Date.parse(notBeforeAt) : Number.NaN;
  const hasCutoff = !Number.isNaN(cutoffMs);
  const effectiveSinceIso =
    hasCutoff && Date.parse(sinceIso) < cutoffMs ? new Date(cutoffMs).toISOString() : sinceIso;

  const rawCandidates = ctx.repos.articles.listCandidates(effectiveSinceIso, includeExpired, {
    strictNotBefore: hasCutoff,
  });
  const historySinceIso = new Date(
    ctx.now().getTime() - settings.editorial.historyDedupDays * 24 * 3600_000,
  ).toISOString();
  const history: PublishedHistoryRecord[] = ctx.repos.history.listRecent(historySinceIso, 500);
  const recentConsumed = ctx.repos.articles.listRecentConsumed(historySinceIso, 300);

  const historyUrls = new Set<string>();
  for (const rec of history) {
    for (const url of rec.articleUrls) {
      historyUrls.add(url);
    }
  }
  for (const art of recentConsumed) {
    historyUrls.add(art.canonicalUrl);
  }

  const combinedHistoryEntries: Array<{ title: string; titleNorm?: string }> = [
    ...history.map((h) => ({ title: h.title, titleNorm: h.titleNorm })),
    ...recentConsumed.map((art) => ({ title: art.title, titleNorm: art.titleNorm })),
  ];

  const sourceById = new Map<string, SourceDef>(ctx.sources.map((s) => [s.id, s]));

  // 若开启了硬性最早时间限制，读取截止时间前 14 天内已入库且正文有效的较权威文章作为滞后转述参考（仅用于链接/原题精确去重与提示词参考）
  const earlierPrimaryArticles =
    hasCutoff && notBeforeAt
      ? ctx.repos.articles
          .listRecentForOriginCheck(
            new Date(cutoffMs - 14 * 24 * 3600_000).toISOString(),
            new Date(cutoffMs).toISOString(),
            400,
          )
          .filter(
            (art) =>
              (sourceById.get(art.sourceId)?.tier ?? 3) <= 2 &&
              art.extractStatus !== 'failed' &&
              isOriginProvablyBeforeCutoff(art.publishedAt, notBeforeAt),
          )
      : [];

  // 1. 排除已占用/已播链接、早于时间下限及与历史/前期原题完全一致的文章
  const freshFiltered: Article[] = [];
  for (const article of rawCandidates) {
    if (opts.excludeArticleIds?.has(article.id)) {
      continue;
    }
    if (hasCutoff && article.publishedAt) {
      const pubMs = Date.parse(article.publishedAt);
      if (!Number.isNaN(pubMs) && pubMs < cutoffMs) {
        continue;
      }
    }
    if (historyUrls.has(article.canonicalUrl)) {
      continue;
    }
    const dup = isDuplicateOfHistory(article.title, combinedHistoryEntries);
    if (dup.duplicate) {
      continue;
    }
    if (hasCutoff && earlierPrimaryArticles.length > 0) {
      const matchesEarlierOrigin = earlierPrimaryArticles.some(
        (origin) =>
          origin.canonicalUrl === article.canonicalUrl ||
          isExactTitleMatch(article.title, origin.title),
      );
      if (matchesEarlierOrigin) {
        continue;
      }
    }
    freshFiltered.push(article);
  }

  if (freshFiltered.length === 0) {
    return { selected: [], consideredArticleIds: [] };
  }

  // 2. 合并归一化标题完全一致的条目（优先保留信源等级更高、时间更新的那篇作为代表）
  const groupedByTitle = new Map<string, { rep: Article; aliases: string[]; score: number }>();
  for (const article of freshFiltered) {
    const key = normalizeTitleForExactMatch(article.titleNorm || article.title) || article.id;
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
  const articleById = new Map<string, Article>(freshFiltered.map((a) => [a.id, a]));
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

  const promptHistoryEntries: Array<{ title: string; titleNorm?: string }> = [];
  const promptHistoryLines: string[] = [];

  for (const h of history) {
    if (promptHistoryLines.length >= MAX_PROMPT_HISTORY_TITLES) {
      break;
    }
    if (isDuplicateOfHistory(h.title, promptHistoryEntries).duplicate) {
      continue;
    }
    const dateLabel = formatLocalDate(h.publishedAt, settings.timezone);
    const datePart = dateLabel ? `[${dateLabel}]` : '';
    const entityPart = h.entity?.trim() ? `（${h.entity.trim()}）` : '';
    const metaPrefix = `${datePart}${entityPart}`;
    promptHistoryLines.push(metaPrefix ? `- ${metaPrefix} ${h.title}` : `- ${h.title}`);
    promptHistoryEntries.push({ title: h.title, titleNorm: h.titleNorm });
  }

  for (const art of recentConsumed) {
    if (promptHistoryLines.length >= MAX_PROMPT_HISTORY_TITLES) {
      break;
    }
    if (isDuplicateOfHistory(art.title, promptHistoryEntries).duplicate) {
      continue;
    }
    const dateLabel = formatLocalDate(art.publishedAt ?? art.firstSeenAt, settings.timezone);
    const datePrefix = dateLabel ? `[${dateLabel}] ` : '';
    const snippet = compactExcerpt(art.excerpt, art.title);
    promptHistoryLines.push(`- ${datePrefix}${art.title}${snippet ? ` — ${snippet}` : ''}`);
    promptHistoryEntries.push({ title: art.title, titleNorm: art.titleNorm });
  }

  const historyText =
    promptHistoryLines.length > 0 ? promptHistoryLines.join('\n') : '（近期暂无已播事件）';

  const remainingEarlierOrigins =
    hasCutoff && earlierPrimaryArticles.length > 0
      ? earlierPrimaryArticles.filter(
          (art) => !isDuplicateOfHistory(art.title, promptHistoryEntries).duplicate,
        )
      : [];
  const originReferences =
    remainingEarlierOrigins.length > 0
      ? selectRelevantOriginReferences(
          dedupedGroups.map((g) => g.rep),
          remainingEarlierOrigins,
          MAX_PROMPT_ORIGIN_REFS,
        ).map((art) => ({
          publishedAt: art.publishedAt,
          firstSeenAt: art.firstSeenAt,
          sourceName: sourceById.get(art.sourceId)?.name ?? art.sourceId,
          title: art.title,
          excerpt: art.excerpt,
        }))
      : [];

  const prompt = await renderPromptTemplate('s2-select.md', {
    targetCount: String(Math.max(1, targetCount)),
    itemCount: String(Math.max(1, itemCount)),
    historyDedupDays: String(settings.editorial.historyDedupDays),
    timeCutoffRule: buildTimeCutoffRuleText(notBeforeAt, settings.timezone, originReferences),
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
    if (
      ev.duplicateOfHistory ||
      (settings.issue.minScore !== undefined && ev.score < settings.issue.minScore)
    ) {
      continue;
    }
    const evDup = isDuplicateOfHistory(ev.title, combinedHistoryEntries);
    if (evDup.duplicate) {
      continue;
    }
    if (hasCutoff && earlierPrimaryArticles.length > 0) {
      const eventMatchesEarlier = earlierPrimaryArticles.some((origin) =>
        isExactTitleMatch(ev.title, origin.title),
      );
      if (eventMatchesEarlier) {
        continue;
      }
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
    if (hasCutoff) {
      const containsPreCutoffArticle = expandedArticleIds.some((artId) => {
        const art = articleById.get(artId);
        if (!art?.publishedAt) {
          return false;
        }
        const pubMs = Date.parse(art.publishedAt);
        return !Number.isNaN(pubMs) && pubMs < cutoffMs;
      });
      if (containsPreCutoffArticle) {
        continue;
      }
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
    selected: !settings.issue.allowPartial
      ? selected
      : selected.sort((a, b) => b.candidate.score - a.candidate.score).slice(0, itemCount + 2),
    consideredArticleIds: dedupedGroups.flatMap((g) => g.aliases),
  };
}
