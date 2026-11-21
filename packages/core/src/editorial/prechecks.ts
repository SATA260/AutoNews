import type {
  ContentLimits,
  Evidence,
  IssueMode,
  IssuePackage,
  PolishedItem,
  Settings,
} from '@aidaily/contracts';
import { checkCoverText } from './cover-text.js';

/** 确定性规则预检结果（未通过时附带可供模型微调的具体批注） */
export interface PrecheckResult {
  passed: boolean;
  errors: string[];
  warnings: string[];
}

/** 单条引文依据的原文核验结果 */
export interface EvidenceQuoteMatchResult {
  valid: boolean;
  exact: boolean;
  ratio: number;
}

const URL_PATTERN = /https?:\/\/|www\./i;
const MARKDOWN_PATTERN = /[`*]|\b__|(^|\n)\s*#{1,6}\s|\[[^\]]+\]\([^)]+\)/;
const CHINESE_CHAR_PATTERN = /[\u4e00-\u9fff]/;
const CHINESE_NUMBER_PHRASE_PATTERN =
  /[零一二两三四五六七八九十百千万亿]{2,}|[一二两三四五六七八九十]+点[零一二三四五六七八九十]+|[一二两三四五六七八九十][万亿倍成个家款代次年月天小时分秒%％]/g;

const ENGLISH_NUMBER_WORDS: Record<string, number> = {
  zero: 0,
  one: 1,
  first: 1,
  single: 1,
  two: 2,
  second: 2,
  double: 2,
  twice: 2,
  pair: 2,
  three: 3,
  third: 3,
  triple: 3,
  four: 4,
  fourth: 4,
  five: 5,
  fifth: 5,
  six: 6,
  sixth: 6,
  seven: 7,
  seventh: 7,
  eight: 8,
  eighth: 8,
  nine: 9,
  ninth: 9,
  ten: 10,
  tenth: 10,
  eleven: 11,
  eleventh: 11,
  twelve: 12,
  twelfth: 12,
  dozen: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90,
  hundred: 100,
};

const ENGLISH_MONTH_VALUES: ReadonlyArray<readonly [RegExp, number]> = [
  [/\bJanuary\b|\bJan\.?\b/gi, 1],
  [/\bFebruary\b|\bFeb\.?\b/gi, 2],
  // 对可能作为常见英文动词或情态词的月份缩写，仅在月份上下文或首字母大写日期格式下识别
  [
    /\b(?:in|on|by|since|until|from|this|last|next)\s+March\b|\bMar(?:ch)?\.?\s+\d{1,2}\b|\b\d{1,2}(?:st|nd|rd|th)?\s+(?:of\s+)?Mar(?:ch)?\.?\b/g,
    3,
  ],
  [/\bApril\b|\bApr\.?\b/gi, 4],
  [
    /\b(?:in|on|by|since|until|from|this|last|next)\s+May\b|\bMay\s+\d{1,2}\b|\b\d{1,2}(?:st|nd|rd|th)?\s+(?:of\s+)?May\b/g,
    5,
  ],
  [
    /\b(?:in|on|by|since|until|from|this|last|next)\s+June?\b|\bJun(?:e)?\.?\s+\d{1,2}\b|\b\d{1,2}(?:st|nd|rd|th)?\s+(?:of\s+)?Jun(?:e)?\.?\b/gi,
    6,
  ],
  [
    /\b(?:in|on|by|since|until|from|this|last|next)\s+July?\b|\bJul(?:y)?\.?\s+\d{1,2}\b|\b\d{1,2}(?:st|nd|rd|th)?\s+(?:of\s+)?Jul(?:y)?\.?\b/gi,
    7,
  ],
  [
    /\b(?:in|on|by|since|until|from|this|last|next)\s+Aug(?:ust)?\.?\b|\bAug(?:ust)?\.?\s+\d{1,2}\b|\b\d{1,2}(?:st|nd|rd|th)?\s+(?:of\s+)?Aug(?:ust)?\.?\b/gi,
    8,
  ],
  [/\bSeptember\b|\bSept?\.?\b/gi, 9],
  [/\bOctober\b|\bOct\.?\b/gi, 10],
  [/\bNovember\b|\bNov\.?\b/gi, 11],
  [/\bDecember\b|\bDec\.?\b/gi, 12],
];

const CHINESE_DIGIT_VALUES: Record<string, number> = {
  零: 0,
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
  十: 10,
};

/** 统计字符串按 Unicode 字符个数计算的长度（准确计入双字节与表情符号） */
function charLength(text: string): number {
  return Array.from(text.trim()).length;
}

/** 归一化文本用于原文引语比对：NFKC 规范化、清理不可见断词符、统一弯引号与各类连字符、压缩连续空白 */
export function normalizeForQuoteCheck(text: string): string {
  return text
    .normalize('NFKC')
    .replace(/[\u00AD\u200B-\u200D\uFEFF]/g, '')
    .replace(/[\u2018\u2019\u201A]/g, "'")
    .replace(/[\u201C\u201D\u201E]/g, '"')
    .replace(/[\u2010-\u2015\u2212\uFE58\uFE63\uFF0D]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 计算引语与正文之间最长连续公共子串长度（滚动一维数组动态规划，节省内存） */
export function longestCommonSubstringLength(needle: string, haystack: string): number {
  if (needle.length === 0 || haystack.length === 0) {
    return 0;
  }
  if (haystack.includes(needle)) {
    return needle.length;
  }

  let prev = new Uint32Array(haystack.length + 1);
  let curr = new Uint32Array(haystack.length + 1);
  let maxLen = 0;

  for (let i = 1; i <= needle.length; i++) {
    const chN = needle.charCodeAt(i - 1);
    curr.fill(0);
    for (let j = 1; j <= haystack.length; j++) {
      if (chN === haystack.charCodeAt(j - 1)) {
        const nextLen = (prev[j - 1] ?? 0) + 1;
        curr[j] = nextLen;
        if (nextLen > maxLen) {
          maxLen = nextLen;
        }
      }
    }
    const tmp = prev;
    prev = curr;
    curr = tmp;
  }

  return maxLen;
}

/** 校验单条引文依据是否在对应原文正文中真实存在（支持完整子串、有序省略分段与高重合连续子串） */
export function verifyEvidenceQuote(
  ev: Evidence,
  articlesById: ReadonlyMap<string, { text: string }>,
): EvidenceQuoteMatchResult {
  const article = articlesById.get(ev.articleId);
  const normQuote = normalizeForQuoteCheck(ev.quote);
  if (!article || !normQuote) {
    return { valid: false, exact: false, ratio: 0 };
  }
  const normBody = normalizeForQuoteCheck(article.text);
  if (!normBody) {
    return { valid: false, exact: false, ratio: 0 };
  }
  if (normBody.includes(normQuote)) {
    return { valid: true, exact: true, ratio: 1 };
  }

  // 支持模型使用省略号连接同一篇原文中的前后连续摘录片段
  if (/\.{3,}|…+/.test(normQuote)) {
    const segments = normQuote
      .split(/\.{3,}|…+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    const totalSegLen = segments.reduce((sum, s) => sum + s.length, 0);
    if (segments.length >= 2 && totalSegLen >= 16 && segments.every((s) => s.length >= 6)) {
      let cursor = 0;
      let allOrderedMatch = true;
      for (const seg of segments) {
        const foundAt = normBody.indexOf(seg, cursor);
        if (foundAt < 0) {
          allOrderedMatch = false;
          break;
        }
        cursor = foundAt + seg.length;
      }
      if (allOrderedMatch) {
        return { valid: true, exact: false, ratio: 0.95 };
      }
    }
  }

  const lcsLen = longestCommonSubstringLength(normQuote, normBody);
  const ratio = lcsLen / normQuote.length;
  return {
    valid: ratio >= 0.9,
    exact: false,
    ratio,
  };
}

/** 从优先与备选引文依据中筛选通过原文核验的条目并去重；若暂无有效条目则返回可待修复的最新提交引文 */
export function selectGroundedEvidence(
  primary: readonly Evidence[],
  fallback: readonly Evidence[],
  articlesById: ReadonlyMap<string, { text: string }>,
): Evidence[] {
  const verified: Evidence[] = [];
  const seen = new Set<string>();
  for (const ev of [...primary, ...fallback]) {
    if (!verifyEvidenceQuote(ev, articlesById).valid) {
      continue;
    }
    const dedupKey = `${ev.articleId}::${normalizeForQuoteCheck(ev.quote)}`;
    if (!seen.has(dedupKey)) {
      seen.add(dedupKey);
      verified.push(ev);
    }
  }
  if (verified.length > 0) {
    return verified;
  }
  if (fallback.length > 0) {
    return [...fallback];
  }
  return [...primary];
}

/** 提取文本中的标准化阿拉伯数字（全角转半角并移除千位分隔符） */
export function extractArabicNumbers(text: string): string[] {
  const normalized = text.normalize('NFKC').replace(/(?<=\d),(?=\d)/g, '');
  const matches = normalized.match(/\d+(?:\.\d+)?/g);
  return matches ? Array.from(new Set(matches)) : [];
}

/** 将数值格式化为不含浮点尾差与科学计数法的干净字符串写入集合 */
function addCleanNumber(target: Set<string>, value: number): void {
  if (!Number.isFinite(value) || value < 0) {
    return;
  }
  const normalized = Number(value.toPrecision(12));
  const raw = String(normalized);
  if (!/[eE]/.test(raw)) {
    target.add(raw);
  }
}

/** 根据数值与紧随的中英文数量级单位推导等价表达（如 44 billion 对应 440 亿） */
function addMagnitudeEquivalents(target: Set<string>, baseValue: number, rawUnit: string): void {
  if (!Number.isFinite(baseValue) || baseValue <= 0) {
    return;
  }
  addCleanNumber(target, baseValue);
  switch (rawUnit.toLowerCase()) {
    case 'thousand':
    case 'k':
      addCleanNumber(target, baseValue * 1000);
      addCleanNumber(target, baseValue / 10);
      break;
    case 'million':
    case 'mn':
    case 'm':
      addCleanNumber(target, baseValue * 1_000_000);
      addCleanNumber(target, baseValue * 100);
      if (baseValue >= 10) {
        addCleanNumber(target, baseValue / 100);
      }
      break;
    case 'billion':
    case 'bn':
    case 'b':
      addCleanNumber(target, baseValue * 1_000_000_000);
      addCleanNumber(target, baseValue * 10);
      if (baseValue >= 100) {
        addCleanNumber(target, baseValue / 1000);
      }
      break;
    case 'trillion':
    case 't':
      addCleanNumber(target, baseValue * 1_000_000_000_000);
      addCleanNumber(target, baseValue * 10_000);
      break;
    case '万':
      addCleanNumber(target, baseValue * 10_000);
      if (baseValue >= 1000) {
        addCleanNumber(target, baseValue / 10_000);
      }
      break;
    case '亿':
      addCleanNumber(target, baseValue * 100_000_000);
      addCleanNumber(target, baseValue * 10_000);
      addCleanNumber(target, baseValue / 10);
      break;
    case '万亿':
      addCleanNumber(target, baseValue * 1_000_000_000_000);
      addCleanNumber(target, baseValue * 10_000);
      break;
    case '千':
      addCleanNumber(target, baseValue * 1000);
      addCleanNumber(target, baseValue / 10);
      break;
    case '百':
      addCleanNumber(target, baseValue * 100);
      break;
    default:
      break;
  }
}

/** 从原文或已精确匹配引文中提取全部合法数字及跨语言换算等价数值 */
export function extractGroundedSourceNumbers(text: string): string[] {
  const result = new Set<string>(extractArabicNumbers(text));
  const normalized = text
    .normalize('NFKC')
    .replace(/[\u2010-\u2015\u2212\uFE58\uFE63\uFF0D]/g, '-')
    .replace(/(?<=\d),(?=\d)/g, '');

  // 1. 大整数自动支持「万 / 亿」折算，百分比支持「成 / 折 / 小数」表达
  for (const numStr of result) {
    const val = Number(numStr);
    if (!Number.isFinite(val)) {
      continue;
    }
    if (val >= 10_000) {
      addCleanNumber(result, val / 10_000);
    }
    if (val >= 100_000_000) {
      addCleanNumber(result, val / 100_000_000);
    }
  }

  for (const match of normalized.matchAll(/(\d+(?:\.\d+)?)\s*(?:%|percent\b)/gi)) {
    const pct = Number(match[1]);
    if (Number.isFinite(pct) && pct >= 0) {
      addCleanNumber(result, pct / 10);
      addCleanNumber(result, pct / 100);
    }
  }

  // 2. 识别范围带数量级（如 $44-62 billion、10 to 20 million）
  for (const match of normalized.matchAll(
    /(\d+(?:\.\d+)?)\s*(?:[$€£¥]?\s*(?:-|~|to|and)\s*[$€£¥]?)\s*(\d+(?:\.\d+)?)\s*(trillion|billion|million|thousand|bn|mn|万亿|亿|万|千|百)\b/gi,
  )) {
    const unit = match[3] ?? '';
    addMagnitudeEquivalents(result, Number(match[1]), unit);
    addMagnitudeEquivalents(result, Number(match[2]), unit);
  }
  for (const match of normalized.matchAll(
    /(\d+(?:\.\d+)?)\s*(?:-|to)\s*(\d+(?:\.\d+)?)\s*([BMKTbmkt])(?![A-Za-z0-9_])/g,
  )) {
    const unit = match[3] ?? '';
    addMagnitudeEquivalents(result, Number(match[1]), unit);
    addMagnitudeEquivalents(result, Number(match[2]), unit);
  }

  // 3. 识别单值带数量级（如 44 billion、8.2B、12 million、150B）
  for (const match of normalized.matchAll(
    /(\d+(?:\.\d+)?)\s*(trillion|billion|million|thousand|bn|mn|万亿|亿|万|千|百)(?![A-Za-z0-9_])/gi,
  )) {
    addMagnitudeEquivalents(result, Number(match[1]), match[2] ?? '');
  }
  for (const match of normalized.matchAll(/(\d+(?:\.\d+)?)\s*([BMKTbmkt])(?![A-Za-z0-9_])/g)) {
    addMagnitudeEquivalents(result, Number(match[1]), match[2] ?? '');
  }

  // 4. 识别英文数词及其后随数量级（如 six、twenty-four、twenty-five million、two billion、half a billion）
  for (const match of normalized.matchAll(
    /\b(twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)[-\s]+(one|two|three|four|five|six|seven|eight|nine)(?:\s+(?:of\s+)?(trillion|billion|million|thousand))?\b/gi,
  )) {
    const tens = ENGLISH_NUMBER_WORDS[(match[1] ?? '').toLowerCase()] ?? 0;
    const ones = ENGLISH_NUMBER_WORDS[(match[2] ?? '').toLowerCase()] ?? 0;
    const scale = match[3];
    if (tens > 0 && ones > 0) {
      const combined = tens + ones;
      if (scale) {
        addMagnitudeEquivalents(result, combined, scale);
      } else {
        addCleanNumber(result, combined);
      }
    }
  }
  for (const match of normalized.matchAll(
    /\b([a-z]+)(?:\s+(?:of\s+)?(trillion|billion|million|thousand))?\b/gi,
  )) {
    const word = (match[1] ?? '').toLowerCase();
    const scale = match[2];
    if (word === 'half') {
      addCleanNumber(result, 50);
      addCleanNumber(result, 0.5);
      addCleanNumber(result, 2);
      if (scale) {
        addMagnitudeEquivalents(result, 0.5, scale);
      }
      continue;
    }
    if (word === 'quarter') {
      addCleanNumber(result, 25);
      addCleanNumber(result, 4);
      continue;
    }
    const wordVal = ENGLISH_NUMBER_WORDS[word];
    if (wordVal !== undefined) {
      if (scale) {
        addMagnitudeEquivalents(result, wordVal, scale);
      } else {
        addCleanNumber(result, wordVal);
      }
    }
  }
  for (const match of normalized.matchAll(
    /\bhalf\s+(?:a|an)\s+(trillion|billion|million|thousand)\b/gi,
  )) {
    addMagnitudeEquivalents(result, 0.5, match[1] ?? '');
  }

  // 5. 识别正文出现的英文月份名称（不涉及外部发布时间字段）
  for (const [pattern, monthNum] of ENGLISH_MONTH_VALUES) {
    if (pattern.test(normalized)) {
      addCleanNumber(result, monthNum);
    }
    pattern.lastIndex = 0;
  }

  // 6. 识别中文正文里的中文数词与倍/成/折/量词组合（如「两倍」「三成」「六国」）
  for (const match of normalized.matchAll(
    /([零一二两三四五六七八九十])(万亿|亿|万|千|百|倍|成|折|个|家|款|代|国|项|次|轮|天|年|月|周|小时|分钟|秒)/g,
  )) {
    const base = CHINESE_DIGIT_VALUES[match[1] ?? ''];
    const unit = match[2] ?? '';
    if (base === undefined) {
      continue;
    }
    addCleanNumber(result, base);
    if (unit === '成' || unit === '折') {
      addCleanNumber(result, base * 10);
    } else if (
      unit === '万' ||
      unit === '亿' ||
      unit === '万亿' ||
      unit === '千' ||
      unit === '百'
    ) {
      addMagnitudeEquivalents(result, base, unit);
    }
  }

  return Array.from(result);
}

/** 检查单句口播文本是否满足纯中文口语、不含链接与标记符号的基本格式规范 */
function checkNarrationSentence(
  sentence: string,
  index: number,
  maxChars: number,
  label: string,
  errors: string[],
): void {
  const trimmed = sentence.trim();
  if (!trimmed) {
    errors.push(`${label}第 ${index + 1} 句口播为空`);
    return;
  }
  if (charLength(trimmed) > maxChars) {
    errors.push(
      `${label}第 ${index + 1} 句口播超出长度上限（${charLength(trimmed)} > ${maxChars} 字）`,
    );
  }
  if (!CHINESE_CHAR_PATTERN.test(trimmed)) {
    errors.push(`${label}第 ${index + 1} 句口播缺少中文内容`);
  }
  if (URL_PATTERN.test(trimmed)) {
    errors.push(`${label}第 ${index + 1} 句口播不允许包含网址链接`);
  }
  if (MARKDOWN_PATTERN.test(trimmed)) {
    errors.push(`${label}第 ${index + 1} 句口播不允许包含 Markdown 格式符号`);
  }
  if (
    / {2,}/.test(trimmed) ||
    /\u3000/.test(trimmed) ||
    /(?<=[\u4e00-\u9fff])\s+(?=[\u4e00-\u9fff])/.test(trimmed)
  ) {
    errors.push(`${label}第 ${index + 1} 句口播包含多余空格或使用空格断句，请改用中文标点`);
  }
}

/** 检查字符串列表中是否命中自我描述套话黑名单 */
function checkMetaBlacklist(
  fields: Array<{ label: string; value: string }>,
  blacklist: readonly string[],
  errors: string[],
): void {
  const normalizedBlacklist = blacklist
    .map((term) => term.normalize('NFKC').toLowerCase().trim())
    .filter((term) => term.length > 0);
  if (normalizedBlacklist.length === 0) {
    return;
  }

  for (const field of fields) {
    const lowerVal = field.value.normalize('NFKC').toLowerCase();
    for (const badTerm of normalizedBlacklist) {
      if (lowerVal.includes(badTerm)) {
        errors.push(`字段「${field.label}」包含禁止出现的套话或格式标记 "${badTerm}"`);
      }
    }
  }
}

/** 检查主播相关展示或口播字段中是否出现人设禁用词或旧式称呼 */
function checkForbiddenPersonaTokens(
  fields: Array<{ label: string; value: string }>,
  forbiddenTokens: readonly string[] | undefined,
  hostSelfName: string | undefined,
  errors: string[],
): void {
  const tokens = (forbiddenTokens ?? [])
    .map((term) => term.normalize('NFKC').toLowerCase().trim())
    .filter((term) => term.length > 0);
  const oldSuffixPattern = /(deepseek|gemini|gpt|claude)\s*娘/i;
  const selfNameHint = hostSelfName ? `，若需自称请固定使用「${hostSelfName}」` : '';

  for (const field of fields) {
    const normalized = field.value.normalize('NFKC').toLowerCase();
    const matchedToken = tokens.find((token) => normalized.includes(token));
    const oldMatch = field.value.match(oldSuffixPattern)?.[0];
    const hit = matchedToken ?? oldMatch;
    if (hit) {
      errors.push(`字段「${field.label}」包含主播禁用词 "${hit}"${selfNameHint}`);
    }
  }
}

const COMPANY_TEAM_SELF_REF_PATTERN =
  /(?:我们公司|我们团队|我们研发|我们官方|我们内部|我们业务|我们旗下|咱们公司|咱们团队|咱们研发|咱们官方|我司|本司|我方|贵司|本团队|本公司)/i;
const FIRST_PERSON_COMPANY_ASSET_PATTERN =
  /(?:我们的|咱们的)(?:模型|产品|新模型|新产品|新功能|工具|插件|服务|平台|系统|API|接口|团队|公司|研发|业务|用户|会员|付费用户|免费额度|算力|开源|代码|权重|生态|安全防护|防护|分类器|科研计划)/i;
const CLAUSE_FIRST_PERSON_COMPANY_ACTION_PATTERN =
  /(?:^|[，。！？；：\s])(?:我们|咱们)(?:这次|这波|这回|这边|这里|最新|近日|今日|近期|目前|刚刚|正式|已经|已|也|还|直接|同步|正在|将会|计划|决定){0,3}(?:发布|推出|宣布|开源|开放|上线|更新|升级|下调|降价|涨价|调整|研发|打造|开发|训练|提供|新增|取消|解散|封禁|暂停|重置|限制|限流|宕机|回应|致歉|表态|整改|被起诉|被告|遭到|遭遇)/;
const FIELD_LEADING_OWN_COMPANY_PATTERN = /^自家/;
const EXPLICIT_OWN_COMPANY_PATTERN =
  /(?:^|[，。！？；：\s])自家(?:公司|团队|业务|科研|销售|这次|这波)/;

/** 检查口播与主播评论是否误用第一人称或内部口吻代表某家公司发言（忽略引号内的直接引语） */
function checkCompanySpokespersonPhrases(
  fields: Array<{ label: string; value: string }>,
  errors: string[],
): void {
  for (const field of fields) {
    const unquoted = field.value
      .normalize('NFKC')
      .replace(/“[^”]*”|"[^"]*"|「[^」]*」|『[^』]*』/g, '')
      .trim();
    if (!unquoted) {
      continue;
    }

    const hit =
      unquoted.match(COMPANY_TEAM_SELF_REF_PATTERN)?.[0] ??
      unquoted.match(FIRST_PERSON_COMPANY_ASSET_PATTERN)?.[0] ??
      unquoted.match(CLAUSE_FIRST_PERSON_COMPANY_ACTION_PATTERN)?.[0]?.trim() ??
      unquoted.match(FIELD_LEADING_OWN_COMPANY_PATTERN)?.[0] ??
      unquoted.match(EXPLICIT_OWN_COMPANY_PATTERN)?.[0]?.trim();
    if (hit) {
      errors.push(
        `字段「${field.label}」疑似以第一人称或公司内部口吻代指新闻主体（"${hit}"）；主播仅为玩家根据模型二创的形象，不能代表任何公司发言，请改用具体公司或产品名称`,
      );
    }
  }
}

/**
 * 对中文润色后的单条新闻定稿执行确定性规则检查：
 * 校验逐字引语是否在原文中真实存在、稿件里的阿拉伯数字是否有原文或依据支撑、
 * 各展示字段与口播分句是否超出字数上限、是否混入自我描述套话或非法符号。
 */
export function precheckPolishedItem(opts: {
  item: PolishedItem;
  articlesById: ReadonlyMap<string, { text: string; publishedAt?: string | null }>;
  limits: ContentLimits;
  metaTextBlacklist: readonly string[];
  compact?: boolean;
  isHeadline?: boolean;
  issueMode?: IssueMode;
  headlineNarrationMaxChars?: number;
  briefNarrationMaxChars?: number;
  forbiddenTokens?: readonly string[];
  hostSelfName?: string;
}): PrecheckResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const { item, articlesById, limits, metaTextBlacklist } = opts;

  // 1. 校验每条引文在对应原始文章正文中确实存在（精确子串、省略拼接分段或最长公共子串达到 90%）
  const exactMatchedQuotes: string[] = [];
  for (let i = 0; i < item.evidence.length; i++) {
    const ev = item.evidence[i];
    if (!ev) {
      continue;
    }
    const article = articlesById.get(ev.articleId);
    if (!article) {
      errors.push(`第 ${i + 1} 条引文依据引用了不存在的文章 ID: ${ev.articleId}`);
      continue;
    }
    if (!normalizeForQuoteCheck(ev.quote)) {
      errors.push(`第 ${i + 1} 条引文依据 quote 为空`);
      continue;
    }
    const match = verifyEvidenceQuote(ev, articlesById);
    if (match.exact) {
      exactMatchedQuotes.push(ev.quote);
    } else if (!match.valid) {
      errors.push(
        `第 ${i + 1} 条引文依据（articleId=${ev.articleId}）与原文匹配率仅为 ${Math.round(match.ratio * 100)}%，低于 90% 下限`,
      );
    }
  }

  // 2. 校验稿件各展示与口播字段中的阿拉伯数字必须全部在已精确匹配的引文或原文正文中出现过（含合法跨语言单位换算）
  const groundedSourceChunks: string[] = [...exactMatchedQuotes];
  for (const article of articlesById.values()) {
    groundedSourceChunks.push(article.text);
  }
  const groundedNumbers = new Set(extractGroundedSourceNumbers(groundedSourceChunks.join('\n')));

  const draftFields: Array<{ label: string; value: string }> = [
    { label: 'title', value: item.title },
    { label: 'shortTitle', value: item.shortTitle },
    { label: 'progressLabel', value: item.progressLabel ?? '' },
    { label: 'category', value: item.category },
    { label: 'entity', value: item.entity },
    { label: 'summary', value: item.summary },
    ...item.keyPoints.map((kp, idx) => ({ label: `keyPoints[${idx}]`, value: kp })),
    { label: 'detail', value: item.detail },
    { label: 'hostComment', value: item.hostComment },
    ...item.narration.map((line, idx) => ({ label: `narration[${idx}]`, value: line })),
  ];
  if (item.cards) {
    for (let i = 0; i < item.cards.length; i++) {
      const card = item.cards[i];
      if (card) {
        draftFields.push({ label: `cards[${i}].title`, value: card.title });
        draftFields.push({ label: `cards[${i}].body`, value: card.body });
      }
    }
  }
  if (item.officialQuote) {
    draftFields.push({ label: 'officialQuote', value: item.officialQuote });
  }
  if (item.imageCaption) {
    draftFields.push({ label: 'imageCaption', value: item.imageCaption });
  }
  if (item.metrics) {
    for (let i = 0; i < item.metrics.length; i++) {
      const m = item.metrics[i];
      if (m) {
        draftFields.push({ label: `metrics[${i}].label`, value: m.label });
        draftFields.push({ label: `metrics[${i}].value`, value: m.value });
      }
    }
  }

  const ungroundedNums = new Set<string>();
  for (const field of draftFields) {
    for (const num of extractArabicNumbers(field.value)) {
      if (!groundedNumbers.has(num)) {
        ungroundedNums.add(num);
      }
    }
    const zhNumMatches = field.value.match(CHINESE_NUMBER_PHRASE_PATTERN);
    if (zhNumMatches && zhNumMatches.length > 0) {
      warnings.push(
        `字段「${field.label}」包含中文数量表述（${zhNumMatches.join('、')}），请注意核对`,
      );
    }
  }
  if (ungroundedNums.size > 0) {
    errors.push(`稿件中出现原文与引文依据均未提及的数字: ${Array.from(ungroundedNums).join('、')}`);
  }

  const pLen = charLength(item.progressLabel ?? '');
  const maxProgressLen = limits.progressLabel ?? 10;
  if (pLen < 4 || pLen > maxProgressLen) {
    errors.push(
      `字段「progressLabel」必填且字数须在 4 到 ${maxProgressLen} 字之间（当前为 ${pLen} 字）`,
    );
  }

  // 3. 校验各字段字数上限及要点数量上限
  const lengthChecks: Array<[string, string, number]> = [
    ['title', item.title, limits.title],
    ['shortTitle', item.shortTitle, limits.shortTitle],
    ['category', item.category, limits.category],
    ['summary', item.summary, limits.summary],
    ['detail', item.detail, limits.detail],
    ['hostComment', item.hostComment, limits.hostComment],
  ];
  if (item.imageCaption) {
    lengthChecks.push(['imageCaption', item.imageCaption, 44]);
  }
  if (item.actionHint) {
    lengthChecks.push(['actionHint', item.actionHint, 28]);
    if (URL_PATTERN.test(item.actionHint)) {
      errors.push('字段「actionHint」仅填平台名或搜索关键词，严禁包含网址链接');
    }
  }
  for (const [label, value, maxChars] of lengthChecks) {
    const len = charLength(value);
    if (len > maxChars) {
      errors.push(`字段「${label}」超出字数上限（${len} > ${maxChars} 字）`);
    }
  }
  if (item.keyPoints.length > limits.keyPointsMax) {
    errors.push(`要点条数过多（${item.keyPoints.length} > ${limits.keyPointsMax} 条）`);
  }
  for (let i = 0; i < item.keyPoints.length; i++) {
    const kp = item.keyPoints[i] ?? '';
    const len = charLength(kp);
    if (len > limits.keyPoint) {
      errors.push(`第 ${i + 1} 条核心要点超出字数上限（${len} > ${limits.keyPoint} 字）`);
    }
  }

  if (item.cards) {
    if (item.cards.length > 4) {
      errors.push(`信息卡片数量过多（${item.cards.length} > 4 张），画面卡片太多观众来不及看`);
    }
    for (let i = 0; i < item.cards.length; i++) {
      const card = item.cards[i];
      if (!card) {
        continue;
      }
      const titleLen = charLength(card.title);
      const bodyLen = charLength(card.body);
      if (titleLen > 8) {
        errors.push(`第 ${i + 1} 张信息卡片小标题超出字数上限（${titleLen} > 8 字）`);
      }
      if (bodyLen > 28) {
        errors.push(`第 ${i + 1} 张信息卡片正文超出字数上限（${bodyLen} > 28 字）`);
      }
    }
  }

  const sentenceLimit = opts.compact
    ? Math.max(46, limits.narrationSentence)
    : limits.narrationSentence;

  if (opts.compact) {
    if (charLength(item.title) > 36 || charLength(item.shortTitle) > 16)
      errors.push('标题或短标题超过新版字数上限');
    if (!item.highlight || charLength(item.highlight) > 18)
      errors.push('核心高亮必须为不超过十八字的客观结论');
    if (
      item.keyPoints.length < 2 ||
      item.keyPoints.length > 3 ||
      item.keyPoints.some((point) => charLength(point) > 15)
    )
      errors.push('核心要点须为二到三条，每条不超过十五字');
    if (!item.cards || item.cards.length < 2 || item.cards.length > 4) {
      errors.push('信息卡片须为二到四张');
    } else if (
      item.cards.some(
        (card) =>
          charLength(card.title) < 2 ||
          charLength(card.title) > 8 ||
          charLength(card.body) < 10 ||
          charLength(card.body) > 28,
      )
    ) {
      errors.push('每张信息卡片小标题须为二到八字，正文须为十到二十八字');
    }
    const total = item.narration.reduce((sum, sentence) => sum + charLength(sentence), 0);
    const isHeadline = opts.isHeadline ?? item.isHeadlineTier === true;
    const maxSentences = isHeadline ? (opts.issueMode === 'spotlight' ? 8 : 6) : 5;
    const maxTotalChars = isHeadline
      ? opts.issueMode === 'spotlight'
        ? 265
        : Math.max(140, opts.headlineNarrationMaxChars ?? 180)
      : Math.max(95, opts.briefNarrationMaxChars ?? 140);
    if (
      item.narration.length < 2 ||
      item.narration.length > maxSentences ||
      total < 40 ||
      total > maxTotalChars
    )
      errors.push(`口播应为二到${maxSentences}句，总长四十到${maxTotalChars}字`);
    if (
      item.narration.some(
        (sentence) => charLength(sentence) < 4 || charLength(sentence) > sentenceLimit,
      )
    )
      errors.push(`每句口播须为四到${sentenceLimit}字`);
    if (item.narration.some((sentence) => /[~～♪♫]|……|呐呐|呢喵/.test(sentence)))
      errors.push('口播包含不适合语音合成的符号或语气词');
    const firstSentence = item.narration[0]?.trim() ?? '';
    if (
      /^(?:今天(?:我们)?(?:先|一起)?(?:来|一起)?(?:看|关注|聊聊|说说)(?:一条|一下|这?条)|接下来(?:我们)?(?:先|一起)?来?(?:看|关注)|下面(?:我们)?(?:先|一起)?来?(?:看|关注)(?:一条|一下))/.test(
        firstSentence,
      )
    ) {
      errors.push('口播首句严禁使用“今天先来看一条…”等铺垫套话，请直接切入新闻主体与事件');
    }
    const lastSentence = item.narration[item.narration.length - 1]?.trim() ?? '';
    if (
      /值得(?:我们|大家)?持续关注|标志着.{0,12}迈入新阶段|未来(?:发展|表现)?值得期待/.test(
        lastSentence,
      )
    ) {
      errors.push('口播结尾严禁使用“值得持续关注”等拔高套话，说完事实与限制即可收尾');
    }
    if (
      item.narration.some((sentence) =>
        /(?:原帖|原文|该帖|原推)(?:里|中)?(?:没写|未写|没提|未提|光放了|没给|没公布|未公布|没透露|未透露)/.test(
          sentence,
        ),
      )
    ) {
      errors.push(
        '口播不要提及“原帖没写/原文未透露”等打破播报感的话，未公开细节直接略过或说“暂未公布”',
      );
    }
    const vagueRefCount = item.narration.filter((sentence) => /该公司|后者/.test(sentence)).length;
    if (vagueRefCount >= 2)
      errors.push('口播多次使用“该公司”或“后者”等模糊指代，请改为具体主语并优化衔接');
    const stripPunctuation = (text: string): string =>
      text.replace(/[\s，。！？；：、“”"'‘’（）()【】[\]、,.!?;:-]/g, '');
    const cardTitleSet = new Set(
      (item.cards ?? []).map((card) => stripPunctuation(card.title)).filter(Boolean),
    );
    if (item.narration.some((sentence) => cardTitleSet.has(stripPunctuation(sentence)))) {
      errors.push('口播出现直接念卡片小标题的情况，请改为自然串联口播句子');
    }
  }

  // 4. 检查自我描述黑名单、主播禁用词及代表公司发言措辞
  const personaSpeechFields: Array<{ label: string; value: string }> = [
    { label: 'hostComment', value: item.hostComment },
    ...item.narration.map((line, idx) => ({ label: `narration[${idx}]`, value: line })),
  ];
  checkMetaBlacklist(draftFields, metaTextBlacklist, errors);
  checkForbiddenPersonaTokens(personaSpeechFields, opts.forbiddenTokens, opts.hostSelfName, errors);
  checkCompanySpokespersonPhrases(personaSpeechFields, errors);

  // 5. 校验口播分句规则
  for (let i = 0; i < item.narration.length; i++) {
    checkNarrationSentence(item.narration[i] ?? '', i, sentenceLimit, '', errors);
  }

  return {
    passed: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * 对整期编排与投稿包装产物执行确定性规则检查：
 * 验证条目顺序完整性、开闭口播合乎规范、各标题简介字段字数未超限且无自我描述套话。
 */
export function precheckIssuePackage(opts: {
  pkg: IssuePackage;
  expectedItemIds: readonly string[];
  limits: ContentLimits;
  publishConfig: Settings['publish']['bilibili'];
  metaTextBlacklist: readonly string[];
  compact?: boolean;
  forbiddenTokens?: readonly string[];
  hostSelfName?: string;
}): PrecheckResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const { pkg, expectedItemIds, limits, publishConfig, metaTextBlacklist } = opts;

  const expectedSet = new Set(expectedItemIds);
  const orderSet = new Set(pkg.order);
  if (pkg.order.length !== expectedItemIds.length || orderSet.size !== expectedItemIds.length) {
    errors.push(
      `播出顺序 order 长度（${pkg.order.length}）与已通过条目数（${expectedItemIds.length}）不匹配或存在重复`,
    );
  } else {
    for (const id of expectedItemIds) {
      if (!orderSet.has(id)) {
        errors.push(`播出顺序 order 遗漏了已通过的新闻条目: ${id}`);
      }
    }
    for (const id of pkg.order) {
      if (!expectedSet.has(id)) {
        errors.push(`播出顺序 order 包含未知的新闻条目: ${id}`);
      }
    }
  }

  if (pkg.order.length > 0 && pkg.headlineItemId !== pkg.order[0]) {
    errors.push(
      `头条标识 headlineItemId (${pkg.headlineItemId}) 必须与 order 首项 (${pkg.order[0]}) 一致`,
    );
  }

  const lengthChecks: Array<[string, string, number]> = [
    ['headline', pkg.headline, limits.headline],
    ['leadSummary', pkg.leadSummary, limits.leadSummary],
    ['intro.hostComment', pkg.intro.hostComment, limits.hostComment],
    ['outro.hostComment', pkg.outro.hostComment, limits.hostComment],
    ['publish.title', pkg.publish.title, publishConfig.titleMax],
  ];
  for (const [label, value, maxChars] of lengthChecks) {
    const len = charLength(value);
    if (len > maxChars) {
      errors.push(`字段「${label}」超出字数上限（${len} > ${maxChars} 字）`);
    }
  }

  const extraTagBudget = Math.max(0, publishConfig.tagsMax - publishConfig.defaultTags.length);
  if (pkg.publish.tags.length > extraTagBudget) {
    errors.push(
      `额外投稿标签数量超出上限（${pkg.publish.tags.length} > ${extraTagBudget} 个，含默认标签总上限为 ${publishConfig.tagsMax} 个）`,
    );
  }

  // 封面文字：漏填只提醒（会用头条导语自动生成），填了但不合规则要求重写
  if (pkg.cover) {
    errors.push(...checkCoverText(pkg.cover));
  } else {
    warnings.push('未生成封面文字 cover，将用头条导语自动截取封面文字');
  }

  for (let i = 0; i < pkg.intro.narration.length; i++) {
    checkNarrationSentence(
      pkg.intro.narration[i] ?? '',
      i,
      limits.narrationSentence,
      '开场',
      errors,
    );
  }
  for (let i = 0; i < pkg.outro.narration.length; i++) {
    checkNarrationSentence(
      pkg.outro.narration[i] ?? '',
      i,
      limits.narrationSentence,
      '结尾',
      errors,
    );
  }

  if (opts.compact) {
    const introText = pkg.intro.narration.join('');
    const introTotal = charLength(introText);
    if (pkg.intro.narration.length > 2 || introTotal > 65) {
      errors.push('开场口播应直给头条重点（一到两句、总长不超过六十五字），不要冗长寒暄');
    }
    const outroText = pkg.outro.narration.join('');
    const outroTotal = pkg.outro.narration.reduce((sum, line) => sum + charLength(line), 0);
    if (pkg.outro.narration.length > 2 || outroTotal > 55) {
      errors.push('结尾口播应干净利落（一到两句、总长不超过五十五字），不要做长篇总结');
    }
    if (opts.hostSelfName) {
      const normOutro = outroText.normalize('NFKC').toLowerCase();
      const normSelf = opts.hostSelfName.normalize('NFKC').toLowerCase();
      if (!normOutro.includes(normSelf)) {
        errors.push(`结尾口播必须自然自报家门并包含主播自称「${opts.hostSelfName}」`);
      }
    }
    if (
      /(?:我是|来自|代表)[^，。！？]{1,15}(?:公司|旗下|出品|团队)的|(?:我是|来自|代表)[^，。！？]{0,10}(?:谷歌|google|deepmind|openai|anthropic|深度求索|deepseek)[^，。！？]{0,8}(?:的|家的)/i.test(
        `${introText} ${outroText}`,
      )
    ) {
      errors.push('主播自报家门直接报名字即可，不用说自己是哪个公司的，也不能代表任何公司发言');
    }

    const validateTitle = (rawTitle: string, label: string) => {
      const publishTitle = rawTitle.trim();
      if (/^(?:【?\s*)?(?:AI\s*(?:每日报|早报|晚报|日报)|今日\s*AI\s*资讯)/i.test(publishTitle)) {
        errors.push(`${label}严禁以“AI每日报/AI早报”等死板栏目名开头，请直接切入本期最核心新闻看点`);
      }
      if (charLength(publishTitle) < 18) {
        errors.push(`${label}过于简短（须至少十八字并写入具体产品/模型名、关键数字或核心事件）`);
      }
      if (charLength(publishTitle) > publishConfig.titleMax) {
        errors.push(`${label}超出平台字数上限（${charLength(publishTitle)} > ${publishConfig.titleMax} 字）`);
      }
      if (/(?<=[\u4e00-\u9fff])_|_(?=[\u4e00-\u9fff])/.test(publishTitle)) {
        errors.push(`${label}请使用正常标点或空格，不要混入文件名下划线“_”`);
      }
    };
    validateTitle(pkg.publish.title, '视频标题');
    if (pkg.publish.titleCandidates) {
      pkg.publish.titleCandidates.forEach((cand, idx) => {
        validateTitle(cand, `候选标题[${idx + 1}]`);
      });
    }
  }

  const descIntro = pkg.publish.descriptionIntro.trim();
  if (
    /https?:\/\/\S+/i.test(descIntro) ||
    /(?:【\s*(?:参考|信息|消息)?来源\s*】|(?:参考来源|信息来源|消息来源|信源)\s*[:：])/.test(
      descIntro,
    )
  ) {
    errors.push('视频简介导览（publish.descriptionIntro）中不要包含信息来源、参考链接或 URL');
  }

  const fields: Array<{ label: string; value: string }> = [
    { label: 'headline', value: pkg.headline },
    { label: 'leadSummary', value: pkg.leadSummary },
    { label: 'intro.hostComment', value: pkg.intro.hostComment },
    { label: 'outro.hostComment', value: pkg.outro.hostComment },
    { label: 'outro.cta', value: pkg.outro.cta },
    { label: 'publish.title', value: pkg.publish.title },
    { label: 'publish.descriptionIntro', value: pkg.publish.descriptionIntro },
    ...(pkg.cover
      ? [
          { label: 'cover.title', value: pkg.cover.title },
          { label: 'cover.subtitle', value: pkg.cover.subtitle },
        ]
      : []),
    ...pkg.intro.narration.map((s, idx) => ({ label: `intro.narration[${idx}]`, value: s })),
    ...pkg.outro.narration.map((s, idx) => ({ label: `outro.narration[${idx}]`, value: s })),
  ];
  const personaSpeechFields: Array<{ label: string; value: string }> = [
    { label: 'headline', value: pkg.headline },
    { label: 'leadSummary', value: pkg.leadSummary },
    { label: 'intro.hostComment', value: pkg.intro.hostComment },
    { label: 'outro.hostComment', value: pkg.outro.hostComment },
    { label: 'outro.cta', value: pkg.outro.cta },
    ...pkg.intro.narration.map((s, idx) => ({ label: `intro.narration[${idx}]`, value: s })),
    ...pkg.outro.narration.map((s, idx) => ({ label: `outro.narration[${idx}]`, value: s })),
  ];
  checkMetaBlacklist(fields, metaTextBlacklist, errors);
  checkForbiddenPersonaTokens(personaSpeechFields, opts.forbiddenTokens, opts.hostSelfName, errors);
  checkCompanySpokespersonPhrases(personaSpeechFields, errors);

  return {
    passed: errors.length === 0,
    errors,
    warnings,
  };
}
