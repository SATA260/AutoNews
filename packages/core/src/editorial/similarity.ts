import { normalizeTitle } from '../collector/canonical-url.js';

/** 历史标题完全一致去重的判定结果 */
export interface HistoryDuplicateMatch {
  duplicate: boolean;
  matchedTitle?: string;
}

const RECALL_ENGLISH_STOPWORDS = new Set([
  'the',
  'and',
  'for',
  'with',
  'from',
  'that',
  'this',
  'into',
  'your',
  'our',
  'new',
  'how',
  'why',
  'what',
  'are',
  'was',
  'has',
  'have',
  'now',
  'out',
  'all',
  'can',
  'will',
  'more',
  'introducing',
  'announcing',
  'launches',
  'launch',
  'releases',
  'release',
  'update',
  'blog',
  'news',
]);

const ASCII_IDENTIFIER_TOKEN_RE = /^[a-z0-9][a-z0-9._+-]{2,}$/;

/**
 * 将标题归一化为用于完全一致比对的标准文本：
 * 在通用标题归一化基础上统一中英文弯引号，并清除紧邻汉字两侧的空格，
 * 避免“OpenAI 发布新模型”与“OpenAI发布新模型”被当成不同标题，同时保留英文词边界、版本号与产品代号差异。
 */
export function normalizeTitleForExactMatch(title: string): string {
  return normalizeTitle(title)
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/(?<=[\p{Script=Han}])\s+|\s+(?=[\p{Script=Han}])/gu, '')
    .trim();
}

/** 判断两个标题在归一化后是否完全一致 */
export function isExactTitleMatch(a: string, b: string): boolean {
  const normA = normalizeTitleForExactMatch(a);
  const normB = normalizeTitleForExactMatch(b);
  return normA.length > 0 && normA === normB;
}

/**
 * 检查候选标题是否与历史已播或已消费文章标题在归一化后完全一致；
 * 仅用于拦截原题复发，不再按字符相似度删除不同型号、代号或改写换词的报道。
 */
export function isDuplicateOfHistory(
  title: string,
  history: ReadonlyArray<{ title: string; titleNorm?: string }>,
): HistoryDuplicateMatch {
  const target = normalizeTitleForExactMatch(title);
  if (!target) {
    return { duplicate: false };
  }

  for (const entry of history) {
    const matchesRaw = normalizeTitleForExactMatch(entry.title) === target;
    const matchesNorm =
      Boolean(entry.titleNorm) && normalizeTitleForExactMatch(entry.titleNorm ?? '') === target;
    if (matchesRaw || matchesNorm) {
      return { duplicate: true, matchedTitle: entry.title };
    }
  }

  return { duplicate: false };
}

/** 从标题中提取用于相关性召回的英文数字词元与中文双字片段集合 */
function extractRecallTokens(title: string): Set<string> {
  const norm = normalizeTitle(title);
  const tokens = new Set<string>();
  if (!norm) {
    return tokens;
  }

  for (const match of norm.matchAll(/[a-z0-9][a-z0-9._+-]*/g)) {
    const word = match[0];
    if (word.length >= 2 && !RECALL_ENGLISH_STOPWORDS.has(word)) {
      tokens.add(word);
    }
  }

  for (const match of norm.matchAll(/\p{Script=Han}+/gu)) {
    const hanSeq = match[0];
    if (hanSeq.length < 2) {
      continue;
    }
    for (let i = 0; i < hanSeq.length - 1; i++) {
      tokens.add(hanSeq.slice(i, i + 2));
    }
  }

  return tokens;
}

/**
 * 仅用于从早于截止时间的历史入库文章中挑出与本期候选最可能相关的参考条目送入选题模型，
 * 帮助模型按事件内容识别滞后转述；绝不用于直接删除候选文章。
 */
export function selectRelevantOriginReferences<
  T extends { title: string; titleNorm?: string; publishedAt?: string | null },
>(
  candidates: ReadonlyArray<{ title: string; titleNorm?: string }>,
  origins: readonly T[],
  maxCount: number,
): T[] {
  if (maxCount <= 0 || origins.length === 0) {
    return [];
  }

  const uniqueOrigins: T[] = [];
  const seenKeys = new Set<string>();
  for (const origin of origins) {
    const key = normalizeTitleForExactMatch(origin.title) || origin.title.trim();
    if (!key || seenKeys.has(key)) {
      continue;
    }
    seenKeys.add(key);
    uniqueOrigins.push(origin);
  }

  const candidateTokenSets = candidates
    .map((candidate) => extractRecallTokens(candidate.titleNorm || candidate.title))
    .filter((set) => set.size > 0);

  /** 标题召回关联的历史或前序事件匹配项 */
  interface RelatedOriginEntry {
    item: T;
    index: number;
    ratio: number;
    shared: number;
  }

  const related: RelatedOriginEntry[] = [];
  if (candidateTokenSets.length > 0) {
    uniqueOrigins.forEach((origin, index) => {
      const originTokens = extractRecallTokens(origin.titleNorm || origin.title);
      if (originTokens.size === 0) {
        return;
      }

      let bestRatio = 0;
      let bestShared = 0;
      let isRelated = false;

      for (const candTokens of candidateTokenSets) {
        let shared = 0;
        let hasIdentifier = false;
        for (const token of originTokens) {
          if (candTokens.has(token)) {
            shared += 1;
            if (!hasIdentifier && ASCII_IDENTIFIER_TOKEN_RE.test(token)) {
              hasIdentifier = true;
            }
          }
        }
        if (shared >= 2 || (shared >= 1 && hasIdentifier)) {
          isRelated = true;
          const union = originTokens.size + candTokens.size - shared;
          const ratio = union > 0 ? shared / union : 0;
          if (ratio > bestRatio || (ratio === bestRatio && shared > bestShared)) {
            bestRatio = ratio;
            bestShared = shared;
          }
        }
      }

      if (isRelated) {
        related.push({ item: origin, index, ratio: bestRatio, shared: bestShared });
      }
    });
  }

  related.sort((a, b) => b.ratio - a.ratio || b.shared - a.shared || a.index - b.index);

  const relatedQuota = Math.min(related.length, Math.ceil(maxCount * 0.6));
  const picked = new Set<T>();
  const result: T[] = [];

  for (let i = 0; i < relatedQuota; i++) {
    const entry = related[i];
    if (entry && !picked.has(entry.item)) {
      picked.add(entry.item);
      result.push(entry.item);
    }
  }

  for (const origin of uniqueOrigins) {
    if (result.length >= maxCount) {
      break;
    }
    if (!picked.has(origin)) {
      picked.add(origin);
      result.push(origin);
    }
  }

  return result;
}
