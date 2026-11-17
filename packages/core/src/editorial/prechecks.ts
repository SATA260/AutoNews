import type { ContentLimits, IssuePackage, PolishedItem, Settings } from '@aidaily/contracts';

/** 确定性规则预检结果（未通过时附带可供模型微调的具体批注） */
export interface PrecheckResult {
  passed: boolean;
  errors: string[];
  warnings: string[];
}

const URL_PATTERN = /https?:\/\/|www\./i;
const MARKDOWN_PATTERN = /[`*]|\b__|(^|\n)\s*#{1,6}\s|\[[^\]]+\]\([^)]+\)/;
const CHINESE_CHAR_PATTERN = /[\u4e00-\u9fff]/;
const CHINESE_NUMBER_PHRASE_PATTERN =
  /[零一二两三四五六七八九十百千万亿]{2,}|[一二两三四五六七八九十]+点[零一二三四五六七八九十]+|[一二两三四五六七八九十][万亿倍成个家款代次年月天小时分秒%％]/g;

/** 统计字符串按 Unicode 字符个数计算的长度（准确计入双字节与表情符号） */
function charLength(text: string): number {
  return Array.from(text.trim()).length;
}

/** 归一化文本用于原文引语比对：NFKC 规范化、统一全半角与弯引号、压缩连续空白 */
export function normalizeForQuoteCheck(text: string): string {
  return text
    .normalize('NFKC')
    .replace(/[\u2018\u2019\u201A]/g, "'")
    .replace(/[\u201C\u201D\u201E]/g, '"')
    .replace(/[\u2013\u2014]/g, '-')
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

/** 提取文本中的标准化阿拉伯数字（全角转半角并移除千位分隔符） */
export function extractArabicNumbers(text: string): string[] {
  const normalized = text.normalize('NFKC').replace(/(?<=\d),(?=\d)/g, '');
  const matches = normalized.match(/\d+(?:\.\d+)?/g);
  return matches ? Array.from(new Set(matches)) : [];
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
}): PrecheckResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const { item, articlesById, limits, metaTextBlacklist } = opts;

  // 1. 校验每条引文在对应原始文章正文中确实存在（精确子串，或最长公共子串达到 90%）
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
    const normQuote = normalizeForQuoteCheck(ev.quote);
    const normBody = normalizeForQuoteCheck(article.text);
    if (!normQuote) {
      errors.push(`第 ${i + 1} 条引文依据 quote 为空`);
      continue;
    }
    if (normBody.includes(normQuote)) {
      exactMatchedQuotes.push(ev.quote);
    } else {
      const lcsLen = longestCommonSubstringLength(normQuote, normBody);
      const ratio = lcsLen / normQuote.length;
      if (ratio < 0.9) {
        errors.push(
          `第 ${i + 1} 条引文依据（articleId=${ev.articleId}）与原文匹配率仅为 ${Math.round(ratio * 100)}%，低于 90% 下限`,
        );
      }
    }
  }

  // 2. 校验稿件各展示与口播字段中的阿拉伯数字必须全部在已精确匹配的引文或原文正文中出现过
  const groundedSourceChunks: string[] = [...exactMatchedQuotes];
  for (const article of articlesById.values()) {
    groundedSourceChunks.push(article.text);
  }
  const groundedNumbers = new Set(extractArabicNumbers(groundedSourceChunks.join('\n')));

  const draftFields: Array<{ label: string; value: string }> = [
    { label: 'title', value: item.title },
    { label: 'shortTitle', value: item.shortTitle },
    { label: 'category', value: item.category },
    { label: 'entity', value: item.entity },
    { label: 'summary', value: item.summary },
    ...item.keyPoints.map((kp, idx) => ({ label: `keyPoints[${idx}]`, value: kp })),
    { label: 'detail', value: item.detail },
    { label: 'hostComment', value: item.hostComment },
    ...item.narration.map((line, idx) => ({ label: `narration[${idx}]`, value: line })),
  ];
  if (item.officialQuote) {
    draftFields.push({ label: 'officialQuote', value: item.officialQuote });
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

  // 3. 校验各字段字数上限及要点数量上限
  const lengthChecks: Array<[string, string, number]> = [
    ['title', item.title, limits.title],
    ['shortTitle', item.shortTitle, limits.shortTitle],
    ['category', item.category, limits.category],
    ['summary', item.summary, limits.summary],
    ['detail', item.detail, limits.detail],
    ['hostComment', item.hostComment, limits.hostComment],
  ];
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

  if (opts.compact) {
    if (charLength(item.title) > 22 || charLength(item.shortTitle) > 16)
      errors.push('标题或短标题超过新版字数上限');
    if (!item.highlight || charLength(item.highlight) > 18)
      errors.push('核心高亮必须为不超过十八字的客观结论');
    if (
      item.keyPoints.length < 2 ||
      item.keyPoints.length > 3 ||
      item.keyPoints.some((point) => charLength(point) > 15)
    )
      errors.push('核心要点须为二到三条，每条不超过十五字');
    const total = item.narration.reduce((sum, sentence) => sum + charLength(sentence), 0);
    if (item.narration.length < 4 || item.narration.length > 7 || total < 110 || total > 180)
      errors.push('口播应为四到七句，总长一百一十到一百八十字');
    if (item.narration.some((sentence) => charLength(sentence) < 14 || charLength(sentence) > 30))
      errors.push('每句口播须为十四到三十字');
    if (item.narration.some((sentence) => /[~～♪♫]|……|呐呐|呢喵/.test(sentence)))
      errors.push('口播包含不适合语音合成的符号或语气词');
  }

  // 4. 检查自我描述黑名单
  checkMetaBlacklist(draftFields, metaTextBlacklist, errors);

  // 5. 校验口播分句规则
  for (let i = 0; i < item.narration.length; i++) {
    checkNarrationSentence(item.narration[i] ?? '', i, limits.narrationSentence, '', errors);
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

  const fields: Array<{ label: string; value: string }> = [
    { label: 'headline', value: pkg.headline },
    { label: 'leadSummary', value: pkg.leadSummary },
    { label: 'intro.hostComment', value: pkg.intro.hostComment },
    { label: 'outro.hostComment', value: pkg.outro.hostComment },
    { label: 'outro.cta', value: pkg.outro.cta },
    { label: 'publish.title', value: pkg.publish.title },
    { label: 'publish.descriptionIntro', value: pkg.publish.descriptionIntro },
    ...pkg.intro.narration.map((s, idx) => ({ label: `intro.narration[${idx}]`, value: s })),
    ...pkg.outro.narration.map((s, idx) => ({ label: `outro.narration[${idx}]`, value: s })),
  ];
  checkMetaBlacklist(fields, metaTextBlacklist, errors);

  return {
    passed: errors.length === 0,
    errors,
    warnings,
  };
}
