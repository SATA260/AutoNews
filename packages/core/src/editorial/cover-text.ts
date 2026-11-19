import { COVER_TEXT_LIMITS, type CoverText, type IssuePackage } from '@aidaily/contracts';

/** 统计封面文字字数：按完整字符计，不计用于高亮的星号与手动换行符 */
export function coverTextLength(text: string): number {
  return Array.from(text.replace(/\\n/g, '').replace(/[*\r\n]/g, '')).length;
}

/** 去掉首尾空白并把连续空白合并成一个空格 */
function normalizeLine(text: string): string {
  return text.replace(/[\s\u3000]+/g, ' ').trim();
}

/** 整理封面主标题：保留手动换行符（同步把转义的 `\n` 统一为真实换行），按行清理首尾和多余空格并去掉空行 */
function normalizeCoverTitle(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/\\n/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t\f\v\u00A0\u3000]+/g, ' ').trim())
    .filter((line) => line.length > 0)
    .join('\n');
}

/** 整理封面文字的空白字符（主标题保留手动换行），返回可直接保存的新对象 */
export function normalizeCoverText(text: CoverText): CoverText {
  return { title: normalizeCoverTitle(text.title), subtitle: normalizeLine(text.subtitle) };
}

/** 检查封面文字是否符合字数、行数与高亮星号规则，返回中文问题列表（为空表示通过） */
export function checkCoverText(text: CoverText): string[] {
  const errors: string[] = [];
  const title = normalizeCoverTitle(text.title);
  const subtitle = normalizeLine(text.subtitle);
  if (!title.replace(/[*\n]/g, '')) {
    errors.push('封面主标题不能为空');
  }
  const titleLines = title.split('\n').filter((line) => line.length > 0);
  if (titleLines.length > 3) {
    errors.push(`封面主标题最多分 3 行（当前为 ${titleLines.length} 行）`);
  }
  const titleLen = coverTextLength(title);
  if (titleLen > COVER_TEXT_LIMITS.titleMax) {
    errors.push(`封面主标题超出字数上限（${titleLen} > ${COVER_TEXT_LIMITS.titleMax} 字）`);
  }
  const subtitleLen = coverTextLength(subtitle);
  if (subtitleLen > COVER_TEXT_LIMITS.subtitleMax) {
    errors.push(`封面副标题超出字数上限（${subtitleLen} > ${COVER_TEXT_LIMITS.subtitleMax} 字）`);
  }
  if ((title.match(/\*/g)?.length ?? 0) % 2 !== 0) {
    errors.push('封面主标题里用于高亮的星号必须成对出现，如 *翻车了*');
  }
  if (subtitle.includes('*')) {
    errors.push('封面副标题不支持星号高亮，请去掉星号');
  }
  return errors;
}

/** 按字符数截断文字：优先在逗号、冒号等停顿处截断，且不把英文、数字组成的词（如 GPT-6.2）从中间切开 */
export function clipAtPause(text: string, maxChars: number): string {
  const clean = normalizeLine(text.replace(/\*/g, ''));
  const trimTail = (value: string) => value.replace(/[，,：:；;、。.\-\s]+$/u, '').trim();
  const chars = Array.from(clean);
  if (chars.length <= maxChars) {
    return trimTail(clean);
  }
  const head = chars.slice(0, maxChars).join('');
  const pauseIdx = Math.max(
    ...['，', ',', '：', ':', '；', ';', '、'].map((p) => head.lastIndexOf(p)),
  );
  if (pauseIdx >= Math.floor(maxChars / 2)) {
    return trimTail(head.slice(0, pauseIdx));
  }
  // 截断点落在英文词中间时，退回到这个词之前
  const nextChar = chars[maxChars] ?? '';
  if (/[A-Za-z0-9.-]/.test(nextChar)) {
    const wordStart = head.search(/[A-Za-z0-9][A-Za-z0-9.-]*$/);
    if (wordStart > 0) {
      return trimTail(head.slice(0, wordStart));
    }
  }
  return trimTail(head);
}

/**
 * 编排阶段没给出封面文字时自动生成一份：
 * 主标题优先用头条新闻的短标题，放不下再截取头条导语；副标题截取导语摘要。
 */
export function deriveFallbackCoverText(pkg: IssuePackage, headlineShortTitle?: string): CoverText {
  const shortTitle = headlineShortTitle ? normalizeLine(headlineShortTitle.replace(/\*/g, '')) : '';
  const title =
    shortTitle && coverTextLength(shortTitle) <= COVER_TEXT_LIMITS.titleMax
      ? shortTitle
      : clipAtPause(pkg.headline, COVER_TEXT_LIMITS.titleMax);
  return {
    title: title || 'AI 每日报',
    subtitle: clipAtPause(pkg.leadSummary, COVER_TEXT_LIMITS.subtitleMax),
  };
}
