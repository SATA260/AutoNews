import { normalizeTitle } from '../collector/canonical-url.js';

/** 历史标题去重判定结果 */
export interface HistoryDuplicateMatch {
  duplicate: boolean;
  matchedTitle?: string;
  similarity: number;
}

/** 提取归一化标题的连续双字字符集合（去掉空白符后按窗口滑动切分） */
export function extractCharBigrams(title: string): Set<string> {
  const compact = normalizeTitle(title).replace(/\s+/g, '');
  const result = new Set<string>();
  if (compact.length === 0) {
    return result;
  }
  if (compact.length === 1) {
    result.add(compact);
    return result;
  }
  for (let i = 0; i < compact.length - 1; i++) {
    result.add(compact.slice(i, i + 2));
  }
  return result;
}

/** 计算两个新闻标题之间的字符二元组 Jaccard 相似度（0 到 1 之间） */
export function titleJaccardSimilarity(a: string, b: string): number {
  const normA = normalizeTitle(a);
  const normB = normalizeTitle(b);
  if (!normA || !normB) {
    return 0;
  }
  if (normA === normB) {
    return 1;
  }

  const setA = extractCharBigrams(normA);
  const setB = extractCharBigrams(normB);
  if (setA.size === 0 || setB.size === 0) {
    return 0;
  }

  let intersection = 0;
  for (const token of setA) {
    if (setB.has(token)) {
      intersection += 1;
    }
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/** 检查候选标题是否与近期已播出的历史新闻构成高度相似重复 */
export function isDuplicateOfHistory(
  title: string,
  history: ReadonlyArray<{ title: string; titleNorm?: string }>,
  threshold: number,
): HistoryDuplicateMatch {
  let maxSim = 0;
  let matchedTitle: string | undefined;

  for (const entry of history) {
    const sim = titleJaccardSimilarity(title, entry.titleNorm || entry.title);
    if (sim > maxSim) {
      maxSim = sim;
      matchedTitle = entry.title;
    }
  }

  if (maxSim >= threshold && matchedTitle !== undefined) {
    return { duplicate: true, matchedTitle, similarity: maxSim };
  }
  return { duplicate: false, similarity: maxSim };
}
