/** 单行字幕默认最大视觉字宽（按全角中文字符宽度折算） */
export const DEFAULT_SUBTITLE_MAX_LINE_UNITS = 28.5;

type SubtitleBreakKind = 'clause' | 'pause' | 'space' | 'char';

interface SubtitleToken {
  text: string;
  hasTrailingSpace: boolean;
  units: number;
  breakKind: SubtitleBreakKind;
}

const CLAUSE_PUNCTUATION = new Set([...'，；：。！？…—,;:.!?']);
const PAUSE_PUNCTUATION = new Set([...'、']);
const CLOSING_PUNCTUATION = new Set([...'，；：。！？…—、,;:.!?）)]】」』”’》']);
const OPENING_PUNCTUATION = new Set([...'（([【「『“‘《']);

const BREAK_PENALTIES: Record<SubtitleBreakKind, number> = {
  clause: 0,
  pause: 45,
  char: 300,
  space: 335,
};

/** 估算单个字符占用的视觉宽度权重（全角汉字与中文标点计为 1，数字与字母按比例折算） */
function getCharVisualUnits(ch: string): number {
  if (/\s/u.test(ch)) {
    return 0.32;
  }
  if (/[\u0020-\u007e]/u.test(ch)) {
    return /[A-Z0-9]/u.test(ch) ? 0.62 : 0.54;
  }
  return 1;
}

/** 计算整段文本占用的视觉字符宽度总和 */
export function measureSubtitleUnits(text: string): number {
  let total = 0;
  for (const ch of text) {
    total += getCharVisualUnits(ch);
  }
  return total;
}

/** 判断半角字符是否属于应整体保留的英文单词、缩写、数字或小数/百分比组合 */
function isAsciiWordUnit(chars: readonly string[], index: number): boolean {
  const ch = chars[index];
  if (!ch) {
    return false;
  }
  if (/[A-Za-z0-9%$#@+_&]/u.test(ch)) {
    return true;
  }
  if (
    (ch === '.' || ch === '-' || ch === '/' || ch === ',' || ch === ':') &&
    index > 0 &&
    index + 1 < chars.length
  ) {
    const prev = chars[index - 1] ?? '';
    const next = chars[index + 1] ?? '';
    return /[A-Za-z0-9]/u.test(prev) && /[A-Za-z0-9]/u.test(next);
  }
  return false;
}

/** 将原始片段切分为不可拆分的英文词组与单个中文字符，并维护空格标记 */
function extractRawPieces(text: string): Array<{ text: string; hasTrailingSpace: boolean }> {
  const chars = Array.from(text);
  const rawPieces: Array<{ text: string; hasTrailingSpace: boolean }> = [];
  let i = 0;

  while (i < chars.length) {
    const ch = chars[i];
    if (!ch) {
      break;
    }
    if (ch === ' ') {
      const last = rawPieces[rawPieces.length - 1];
      if (last) {
        last.hasTrailingSpace = true;
      }
      i += 1;
      continue;
    }
    if (isAsciiWordUnit(chars, i)) {
      let word = ch;
      let j = i + 1;
      while (j < chars.length && isAsciiWordUnit(chars, j)) {
        word += chars[j] ?? '';
        j += 1;
      }
      rawPieces.push({ text: word, hasTrailingSpace: false });
      i = j;
      continue;
    }
    rawPieces.push({ text: ch, hasTrailingSpace: false });
    i += 1;
  }
  return rawPieces;
}

/** 识别片段末尾的断行优先级类型（句内分句标点 > 顿号 > 普通字间 > 英文词间空格） */
function detectBreakKind(tokenText: string, hasTrailingSpace: boolean): SubtitleBreakKind {
  const tailChars = Array.from(tokenText);
  for (let k = tailChars.length - 1; k >= 0; k -= 1) {
    const ch = tailChars[k] ?? '';
    if (CLAUSE_PUNCTUATION.has(ch)) {
      return 'clause';
    }
    if (PAUSE_PUNCTUATION.has(ch)) {
      return 'pause';
    }
    if (!CLOSING_PUNCTUATION.has(ch)) {
      break;
    }
  }
  return hasTrailingSpace ? 'space' : 'char';
}

/** 将字幕按排版规则分词，确保开闭引号与标点不出现在违禁行首或行尾 */
function tokenizeSubtitle(text: string): SubtitleToken[] {
  const rawPieces = extractRawPieces(text);
  const merged: Array<{ text: string; hasTrailingSpace: boolean }> = [];
  let pendingOpening = '';

  for (const piece of rawPieces) {
    if (piece.text.length === 1 && OPENING_PUNCTUATION.has(piece.text) && !piece.hasTrailingSpace) {
      pendingOpening += piece.text;
      continue;
    }
    if (piece.text.length === 1 && CLOSING_PUNCTUATION.has(piece.text) && merged.length > 0) {
      const prev = merged[merged.length - 1];
      if (prev) {
        prev.text += piece.text;
        if (piece.hasTrailingSpace) {
          prev.hasTrailingSpace = true;
        }
        continue;
      }
    }
    merged.push({
      text: `${pendingOpening}${piece.text}`,
      hasTrailingSpace: piece.hasTrailingSpace,
    });
    pendingOpening = '';
  }

  if (pendingOpening) {
    const prev = merged[merged.length - 1];
    if (prev) {
      prev.text += pendingOpening;
    } else {
      merged.push({ text: pendingOpening, hasTrailingSpace: false });
    }
  }

  return merged.map((item) => ({
    text: item.text,
    hasTrailingSpace: item.hasTrailingSpace,
    units: measureSubtitleUnits(item.text),
    breakKind: detectBreakKind(item.text, item.hasTrailingSpace),
  }));
}

/** 通过动态规划求解在指定行数内的最优断行切片区间（优先按标点换行，无合适标点则尽量均分每行宽度） */
function solveLineCuts(
  tokens: readonly SubtitleToken[],
  prefixUnits: readonly number[],
  targetLines: number,
  maxLineUnits: number,
): Array<[number, number]> | null {
  const totalTokUnits = prefixUnits[tokens.length] ?? 0;
  const avgUnits = Math.max(1, totalTokUnits / targetLines);
  const inf = Number.POSITIVE_INFINITY;

  const dpCost = Array.from({ length: targetLines + 1 }, () =>
    new Float64Array(tokens.length + 1).fill(inf),
  );
  const dpPrev = Array.from({ length: targetLines + 1 }, () =>
    new Int32Array(tokens.length + 1).fill(-1),
  );
  const row0 = dpCost[0];
  if (row0) {
    row0[0] = 0;
  }

  for (let lineIdx = 1; lineIdx <= targetLines; lineIdx += 1) {
    const prevCostRow = dpCost[lineIdx - 1];
    const currCostRow = dpCost[lineIdx];
    const currPrevRow = dpPrev[lineIdx];
    if (!prevCostRow || !currCostRow || !currPrevRow) {
      continue;
    }

    for (let end = lineIdx; end <= tokens.length; end += 1) {
      for (let start = lineIdx - 1; start < end; start += 1) {
        const prevCost = prevCostRow[start] ?? inf;
        if (!Number.isFinite(prevCost)) {
          continue;
        }
        const leadingSpace = start > 0 && tokens[start - 1]?.hasTrailingSpace ? 0.32 : 0;
        const lineWidth = (prefixUnits[end] ?? 0) - (prefixUnits[start] ?? 0) - leadingSpace;
        if (lineWidth > maxLineUnits && end - start > 1) {
          continue;
        }

        const normDiff = (lineWidth - avgUnits) / avgUnits;
        let stepCost = normDiff * normDiff * 120;
        if (end < tokens.length) {
          const breakKind = tokens[end - 1]?.breakKind ?? 'char';
          stepCost += BREAK_PENALTIES[breakKind];
        }

        const totalCost = prevCost + stepCost;
        if (totalCost < (currCostRow[end] ?? inf)) {
          currCostRow[end] = totalCost;
          currPrevRow[end] = start;
        }
      }
    }
  }

  const finalCost = dpCost[targetLines]?.[tokens.length] ?? inf;
  if (!Number.isFinite(finalCost)) {
    return null;
  }

  const cuts: Array<[number, number]> = [];
  let cursor = tokens.length;
  for (let lineIdx = targetLines; lineIdx >= 1; lineIdx -= 1) {
    const prev = dpPrev[lineIdx]?.[cursor] ?? -1;
    if (prev < 0) {
      return null;
    }
    cuts.push([prev, cursor]);
    cursor = prev;
  }
  cuts.reverse();
  return cuts;
}

/** 当单个超大不可拆词组导致固定行数不可解时，按贪心最大宽度保底折行 */
function greedyFallbackWrap(
  tokens: readonly SubtitleToken[],
  maxLineUnits: number,
): Array<[number, number]> {
  const cuts: Array<[number, number]> = [];
  let start = 0;
  let width = 0;

  for (let i = 0; i < tokens.length; i += 1) {
    const tok = tokens[i];
    if (!tok) {
      continue;
    }
    const spaceCost = i > start && tokens[i - 1]?.hasTrailingSpace ? 0.32 : 0;
    if (i > start && width + spaceCost + tok.units > maxLineUnits) {
      cuts.push([start, i]);
      start = i;
      width = tok.units;
    } else {
      width += spaceCost + tok.units;
    }
  }
  if (start < tokens.length) {
    cuts.push([start, tokens.length]);
  }
  return cuts;
}

/** 将字幕切片索引范围还原成带正确单词空格的文本行列表 */
function renderLineCuts(
  tokens: readonly SubtitleToken[],
  cuts: readonly [number, number][],
): string[] {
  return cuts.map(([start, end]) => {
    let line = '';
    for (let i = start; i < end; i += 1) {
      if (i > start && tokens[i - 1]?.hasTrailingSpace) {
        line += ' ';
      }
      line += tokens[i]?.text ?? '';
    }
    return line;
  });
}

/**
 * 智能字幕断行函数：
 * 1. 未超出单行宽度阈值时保持单行不折行；
 * 2. 需要换行时优先按分句标点（逗号、分号、冒号、顿号等）断行，并尽量保持行宽均衡；
 * 3. 若句内没有可用标点，则在保留英文单词与数字完整性的前提下均匀断行。
 */
export function formatSubtitleLines(
  rawText: string,
  maxLineUnits = DEFAULT_SUBTITLE_MAX_LINE_UNITS,
): string[] {
  const clean = rawText.trim().replace(/\s+/gu, ' ');
  if (!clean) {
    return [];
  }
  if (measureSubtitleUnits(clean) <= maxLineUnits) {
    return [clean];
  }

  const tokens = tokenizeSubtitle(clean);
  if (tokens.length <= 1) {
    return [clean];
  }

  const prefixUnits = [0];
  for (let i = 0; i < tokens.length; i += 1) {
    const tok = tokens[i];
    const spaceCost = i > 0 && tokens[i - 1]?.hasTrailingSpace ? 0.32 : 0;
    prefixUnits.push((prefixUnits[i] ?? 0) + spaceCost + (tok?.units ?? 0));
  }

  // 多行模式下字幕字号略缩小以保持更紧凑观感，每行安全可容纳宽度随之放宽约 2 个汉字位
  const wrappedLineBudget = maxLineUnits + 2;
  const totalUnits = prefixUnits[tokens.length] ?? 0;
  const minLines = Math.max(2, Math.ceil(totalUnits / Math.max(8, wrappedLineBudget)));

  for (
    let targetLines = minLines;
    targetLines <= Math.min(tokens.length, minLines + 2);
    targetLines += 1
  ) {
    const cuts = solveLineCuts(tokens, prefixUnits, targetLines, wrappedLineBudget);
    if (cuts) {
      return renderLineCuts(tokens, cuts);
    }
  }

  return renderLineCuts(tokens, greedyFallbackWrap(tokens, wrappedLineBudget));
}
