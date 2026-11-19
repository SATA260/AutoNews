/** 卡片正文切分后的片段：普通文字，或需要强调显示的「数字 + 单位」 */
export interface CardBodySegment {
  kind: 'text' | 'figure';
  value: string;
}

/** 每张卡片最多强调的数字处数，太多反而没有重点 */
export const MAX_FIGURES_PER_CARD = 2;

/**
 * 识别「约/近/超 + 数字 + 量级 + 单位」这类组合，例如：约1.5万亿美元、14.7%、6万名、2.1 倍、220ms。
 * 数字前面紧挨着英文字母、数字或连字符时不算（如 GPT-5、H100、Genie4），避免把型号当成数据强调。
 */
const FIGURE_PATTERN =
  /(?<![A-Za-z0-9\-_.])(?:约|近|超过|超|逾|不到|仅)?[$￥¥€£]?\d+(?:[.,]\d+)*(?:\s?(?:%|％|‰|倍|成))?(?:\s?(?:万亿|千亿|百亿|亿|千万|百万|万|千|百))?(?:\s?(?:美元|美金|港元|欧元|英镑|日元|韩元|人民币|元|块|名|人|位|股|台|部|个月|个|款|家|项|条|次|张|篇|页|行|倍|小时|分钟|毫秒|秒|ms|天|周|月|年|号|GB|TB|PB|MB|K|M|B|T|tokens?|Tokens?|fps|FPS|Hz|W|nm))?(?![A-Za-z0-9])/g;

/** 判断匹配到的数字是否没有强调价值：光秃秃的数字、纯年份、月份日期 */
function isLowValueFigure(value: string): boolean {
  return (
    /^\d+(?:[.,]\d+)*$/.test(value) ||
    /^\d{4}年$/.test(value) ||
    /^\d{1,2}(?:月|日|号)$/.test(value)
  );
}

/** 去掉卡片正文末尾的句号（卡片是信息短语，不是完整句子），问号和叹号保留 */
export function trimCardTerminalPeriod(body: string): string {
  return body.replace(/[。．.]+$/u, '').trimEnd();
}

/** 把卡片正文切成普通文字和数字片段，只强调前几处数字，其余数字按普通文字显示 */
export function splitCardBody(
  body: string,
  maxFigures: number = MAX_FIGURES_PER_CARD,
): CardBodySegment[] {
  const segments: CardBodySegment[] = [];
  if (!body) {
    return segments;
  }

  let cursor = 0;
  let figureCount = 0;
  FIGURE_PATTERN.lastIndex = 0;
  for (const match of body.matchAll(FIGURE_PATTERN)) {
    if (figureCount >= maxFigures) {
      break;
    }
    const value = match[0];
    const start = match.index ?? 0;
    // 光秃秃的数字、纯年份和月份日期没有信息量，不做强调
    if (isLowValueFigure(value)) {
      continue;
    }
    if (start > cursor) {
      segments.push({ kind: 'text', value: body.slice(cursor, start) });
    }
    segments.push({ kind: 'figure', value });
    cursor = start + value.length;
    figureCount += 1;
  }
  if (cursor < body.length) {
    segments.push({ kind: 'text', value: body.slice(cursor) });
  }
  return segments;
}
