import { TZDate } from '@date-fns/tz';
import { XMLParser } from 'fast-xml-parser';

/** 从 RSS 或 Atom 订阅源解析并归一化后的单条新闻条目 */
export interface ParsedFeedItem {
  url: string;
  title: string;
  publishedAt: string | null;
  summary: string | null;
  content: string | null;
}

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseTagValue: false,
  trimValues: true,
  processEntities: true,
  htmlEntities: true,
  stopNodes: [
    '*.title',
    '*.description',
    '*.content:encoded',
    '*.summary',
    '*.content',
    '*.atom:title',
    '*.atom:summary',
    '*.atom:content',
  ],
});

const NAMED_HTML_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  mdash: '—',
  ndash: '–',
  hellip: '…',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
};

/** 去掉 XML 标签上的命名空间前缀 */
function stripTagPrefix(tagName: string): string {
  const idx = tagName.indexOf(':');
  return idx === -1 ? tagName : tagName.slice(idx + 1);
}

/** 从对象中读取匹配指定局部名称或带常见前缀的属性值 */
function pickByLocalName(obj: Record<string, unknown>, localName: string): unknown {
  if (localName in obj) {
    return obj[localName];
  }
  for (const [key, val] of Object.entries(obj)) {
    if (key.startsWith('@_')) {
      continue;
    }
    if (stripTagPrefix(key) === localName) {
      return val;
    }
  }
  return undefined;
}

/** 将单个字段或数组统一转为数组形式，简化订阅条目遍历 */
function toArray<T>(val: T | T[] | undefined | null): T[] {
  if (val === undefined || val === null) {
    return [];
  }
  return Array.isArray(val) ? val : [val];
}

/** 剥离可能被 `stopNodes` 原样保留的 CDATA 包裹标记 */
function unwrapCdata(raw: string): string {
  return raw.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim();
}

/** 解码常见具名与数字 HTML 字符引用 */
function decodeHtmlEntities(raw: string): string {
  return raw.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (full, entity: string) => {
    if (entity.startsWith('#x') || entity.startsWith('#X')) {
      const cp = Number.parseInt(entity.slice(2), 16);
      return Number.isInteger(cp) && cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : full;
    }
    if (entity.startsWith('#')) {
      const cp = Number.parseInt(entity.slice(1), 10);
      return Number.isInteger(cp) && cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : full;
    }
    return NAMED_HTML_ENTITIES[entity.toLowerCase()] ?? full;
  });
}

/** 递归提取节点及其子节点中的文本或原始片段（兼容 `stopNodes` 字符串、对象与混合数组） */
function extractText(node: unknown): string | null {
  if (node === undefined || node === null) {
    return null;
  }
  if (typeof node === 'string' || typeof node === 'number' || typeof node === 'boolean') {
    const str = unwrapCdata(String(node));
    return str.length > 0 ? str : null;
  }
  if (Array.isArray(node)) {
    const parts = node
      .map((item) => extractText(item))
      .filter((part): part is string => Boolean(part));
    return parts.length > 0 ? parts.join(' ') : null;
  }
  if (typeof node === 'object') {
    const record = node as Record<string, unknown>;
    if ('#text' in record) {
      return extractText(record['#text']);
    }
    if ('_' in record) {
      return extractText(record._);
    }
    const childTexts: string[] = [];
    for (const [key, val] of Object.entries(record)) {
      if (key.startsWith('@_')) {
        continue;
      }
      const sub = extractText(val);
      if (sub) {
        childTexts.push(sub);
      }
    }
    return childTexts.length > 0 ? childTexts.join(' ') : null;
  }
  return null;
}

/** 清理标题中的内联 HTML 标签、数字与具名实体引用及多余空白 */
function cleanFeedTitle(raw: string): string {
  const withoutCdata = unwrapCdata(raw);
  const withoutTags = withoutCdata.replace(/<[^>]+>/g, ' ');
  return decodeHtmlEntities(withoutTags).replace(/\s+/g, ' ').trim();
}

/** 在已有基础地址之上叠加 `xml:base` 属性生成新的基准 URL */
function resolveXmlBase(node: Record<string, unknown>, parentBase?: string): string | undefined {
  const xmlBase = extractText(node['@_xml:base']);
  if (!xmlBase) {
    return parentBase;
  }
  try {
    return parentBase ? new URL(xmlBase, parentBase).toString() : new URL(xmlBase).toString();
  } catch {
    return parentBase;
  }
}

const ENGLISH_MONTH_MAP: Record<string, number> = {
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12,
};

/** 检查日期字符串末尾是否已包含明确时区偏移信息 */
function hasExplicitTimezone(raw: string): boolean {
  return /(?:Z|[+-]\d{2}:?\d{2}|GMT|UTC|UT|[ECMP][DS]T)(?:\s*\([^)]+\))?$/i.test(raw.trim());
}

/** 将无时区偏移的年月日时分秒毫秒按目标时区构造为精确的 UTC ISO 时间字符串 */
function buildWallClockIso(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  ms: number,
  timezone: string,
): string | null {
  if (
    !Number.isInteger(year) ||
    !Number.isInteger(month) ||
    month < 1 ||
    month > 12 ||
    !Number.isInteger(day) ||
    day < 1 ||
    day > 31 ||
    hour < 0 ||
    hour > 23 ||
    minute < 0 ||
    minute > 59 ||
    second < 0 ||
    second > 59 ||
    ms < 0 ||
    ms > 999
  ) {
    return null;
  }
  const tzDate = new TZDate(year, month - 1, day, hour, minute, second, ms, timezone);
  if (
    Number.isNaN(tzDate.getTime()) ||
    tzDate.getFullYear() !== year ||
    tzDate.getMonth() + 1 !== month ||
    tzDate.getDate() !== day
  ) {
    return null;
  }
  return new Date(tzDate.getTime()).toISOString();
}

/** 将不带时区的英文月份日期（如 `Nov 18, 2026` 或 `18 November 2026 14:30`）转为按指定时区解释的 UTC ISO 时间 */
function parseTimezoneLessEnglishMonthDate(raw: string, defaultTimezone: string): string | null {
  if (hasExplicitTimezone(raw)) {
    return null;
  }
  const timeSuffix =
    '(?:(?:\\s*,?\\s*(?:at\\s+)?)(\\d{1,2}):(\\d{2})(?::(\\d{2}))?(?:\\s*(AM|PM))?)?';
  const monthFirst = new RegExp(
    `^(?:[A-Za-z]{3,9},?\\s+)?([A-Za-z]{3,9})\\.?\\s+(\\d{1,2}),?\\s+(\\d{4})${timeSuffix}$`,
    'i',
  ).exec(raw);
  const dayFirst = monthFirst
    ? null
    : new RegExp(
        `^(?:[A-Za-z]{3,9},?\\s+)?(\\d{1,2})\\s+([A-Za-z]{3,9})\\.?,?\\s+(\\d{4})${timeSuffix}$`,
        'i',
      ).exec(raw);

  const match = monthFirst ?? dayFirst;
  if (!match) {
    return null;
  }

  const monthToken = (monthFirst ? match[1] : match[2])?.toLowerCase();
  const dayToken = monthFirst ? match[2] : match[1];
  const yearToken = match[3];
  const month = monthToken ? ENGLISH_MONTH_MAP[monthToken] : undefined;
  const day = dayToken ? Number.parseInt(dayToken, 10) : Number.NaN;
  const year = yearToken ? Number.parseInt(yearToken, 10) : Number.NaN;
  if (!month) {
    return null;
  }

  let hour = 0;
  let minute = 0;
  let second = 0;
  if (match[4] && match[5]) {
    hour = Number.parseInt(match[4], 10);
    minute = Number.parseInt(match[5], 10);
    second = match[6] ? Number.parseInt(match[6], 10) : 0;
    const ampm = match[7]?.toUpperCase();
    if (ampm === 'PM' && hour < 12) {
      hour += 12;
    } else if (ampm === 'AM' && hour === 12) {
      hour = 0;
    }
  }

  return buildWallClockIso(year, month, day, hour, minute, second, 0, defaultTimezone);
}

/** 将 12 小时制可选上午/下午时间片段规范化为两位小数的 `HH:mm[:ss]` 文本 */
function normalizeOptionalTimeToken(rawTime: string | undefined, ampm?: string): string | null {
  if (!rawTime) {
    return null;
  }
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/.exec(rawTime.trim());
  if (!m) {
    return rawTime.trim();
  }
  let hour = Number.parseInt(m[1] ?? '0', 10);
  const minute = m[2] ?? '00';
  const second = m[3];
  const ms = m[4];
  const period = ampm?.toUpperCase();
  if (period === 'PM' && hour < 12) {
    hour += 12;
  } else if (period === 'AM' && hour === 12) {
    hour = 0;
  }
  const base = `${String(hour).padStart(2, '0')}:${minute}${second ? `:${second}` : ''}`;
  return ms ? `${base}.${ms}` : base;
}

/** 将中文年月日、斜杠分隔及单数月日格式规整为标准连字符日期格式 */
function normalizeDateSeparators(raw: string): string {
  const cnMatch =
    /^(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日(?:\s+(\d{1,2}:\d{2}(?::\d{2})?)(?:\s*(AM|PM))?)?$/i.exec(
      raw,
    );
  if (cnMatch) {
    const y = cnMatch[1];
    const m = cnMatch[2]?.padStart(2, '0');
    const d = cnMatch[3]?.padStart(2, '0');
    const time = normalizeOptionalTimeToken(cnMatch[4], cnMatch[5]);
    return time ? `${y}-${m}-${d}T${time}` : `${y}-${m}-${d}`;
  }
  const slashMatch =
    /^(\d{4})\/(\d{1,2})\/(\d{1,2})(?:[T\s]+(\d{1,2}:\d{2}(?::\d{2})?)(?:\s*(AM|PM))?)?$/i.exec(
      raw,
    );
  if (slashMatch) {
    const y = slashMatch[1];
    const m = slashMatch[2]?.padStart(2, '0');
    const d = slashMatch[3]?.padStart(2, '0');
    const time = normalizeOptionalTimeToken(slashMatch[4], slashMatch[5]);
    return time ? `${y}-${m}-${d}T${time}` : `${y}-${m}-${d}`;
  }
  const mdySlashMatch =
    /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[T\s,]+(\d{1,2}:\d{2}(?::\d{2})?)(?:\s*(AM|PM))?)?$/i.exec(
      raw,
    );
  if (mdySlashMatch) {
    const first = Number.parseInt(mdySlashMatch[1] ?? '0', 10);
    const second = Number.parseInt(mdySlashMatch[2] ?? '0', 10);
    const y = mdySlashMatch[3];
    const [monthNum, dayNum] = first > 12 && second <= 12 ? [second, first] : [first, second];
    const m = String(monthNum).padStart(2, '0');
    const d = String(dayNum).padStart(2, '0');
    const time = normalizeOptionalTimeToken(mdySlashMatch[4], mdySlashMatch[5]);
    return time ? `${y}-${m}-${d}T${time}` : `${y}-${m}-${d}`;
  }
  const dashLocalMatch =
    /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T\s]+(\d{1,2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?)(?:\s*(AM|PM))?)?$/i.exec(
      raw,
    );
  if (dashLocalMatch) {
    const y = dashLocalMatch[1];
    const m = dashLocalMatch[2]?.padStart(2, '0');
    const d = dashLocalMatch[3]?.padStart(2, '0');
    const time = normalizeOptionalTimeToken(dashLocalMatch[4], dashLocalMatch[5]);
    return time ? `${y}-${m}-${d}T${time}` : `${y}-${m}-${d}`;
  }
  return raw;
}

/** 将各种常见发布时间格式解析为标准 UTC ISO 时间字符串（无时区时间按配置时区解释） */
export function parsePublishedAt(raw: string | null, defaultTimezone = 'UTC'): string | null {
  if (!raw) {
    return null;
  }
  const trimmed = normalizeDateSeparators(unwrapCdata(raw).trim());
  if (!trimmed) {
    return null;
  }

  // 纯日期格式 YYYY-MM-DD（兼容单位月日）按配置时区的当天零点转换
  const dateOnlyMatch = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(trimmed);
  if (dateOnlyMatch) {
    return buildWallClockIso(
      Number.parseInt(dateOnlyMatch[1] ?? '', 10),
      Number.parseInt(dateOnlyMatch[2] ?? '', 10),
      Number.parseInt(dateOnlyMatch[3] ?? '', 10),
      0,
      0,
      0,
      0,
      defaultTimezone,
    );
  }

  // 不带时区的 YYYY-MM-DD HH:mm(:ss)?(.sss)? 按配置时区解释
  const localDateTimeMatch =
    /^(\d{4})-(\d{1,2})-(\d{1,2})[T\s](\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/.exec(
      trimmed,
    );
  if (localDateTimeMatch && !hasExplicitTimezone(trimmed)) {
    const msRaw = localDateTimeMatch[7] ?? '0';
    return buildWallClockIso(
      Number.parseInt(localDateTimeMatch[1] ?? '', 10),
      Number.parseInt(localDateTimeMatch[2] ?? '', 10),
      Number.parseInt(localDateTimeMatch[3] ?? '', 10),
      Number.parseInt(localDateTimeMatch[4] ?? '', 10),
      Number.parseInt(localDateTimeMatch[5] ?? '', 10),
      Number.parseInt(localDateTimeMatch[6] ?? '0', 10),
      Number.parseInt(msRaw.padEnd(3, '0'), 10),
      defaultTimezone,
    );
  }

  // 不带时区的英文月份日期（如 Nov 18, 2026）按配置时区解释，避免受宿主机本地时区影响
  const englishMonthIso = parseTimezoneLessEnglishMonthDate(trimmed, defaultTimezone);
  if (englishMonthIso) {
    return englishMonthIso;
  }

  const ms = Date.parse(trimmed);
  if (Number.isNaN(ms)) {
    return null;
  }
  if (hasExplicitTimezone(trimmed)) {
    return new Date(ms).toISOString();
  }
  const wallClock = new Date(ms);
  return buildWallClockIso(
    wallClock.getFullYear(),
    wallClock.getMonth() + 1,
    wallClock.getDate(),
    wallClock.getHours(),
    wallClock.getMinutes(),
    wallClock.getSeconds(),
    wallClock.getMilliseconds(),
    defaultTimezone,
  );
}

/** 将疑似相对链接解析为绝对 http/https 地址，无效地址返回 null */
export function resolveHttpUrl(rawUrl: string | null, baseUrl?: string): string | null {
  if (!rawUrl) {
    return null;
  }
  try {
    const parsed = baseUrl ? new URL(rawUrl.trim(), baseUrl) : new URL(rawUrl.trim());
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null;
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

/** 从 RSS 条目中提取文章链接 */
function extractRssLink(item: Record<string, unknown>, baseUrl?: string): string | null {
  const itemBase = resolveXmlBase(item, baseUrl);
  for (const linkNode of toArray(pickByLocalName(item, 'link'))) {
    if (typeof linkNode === 'string') {
      const resolved = resolveHttpUrl(linkNode, itemBase);
      if (resolved) {
        return resolved;
      }
    } else if (typeof linkNode === 'object' && linkNode !== null) {
      const rec = linkNode as Record<string, unknown>;
      const href = extractText(rec['@_href']) ?? extractText(rec);
      const resolved = resolveHttpUrl(href, itemBase);
      if (resolved) {
        return resolved;
      }
    }
  }

  const guid = pickByLocalName(item, 'guid');
  if (typeof guid === 'string') {
    return resolveHttpUrl(guid, itemBase);
  }
  if (typeof guid === 'object' && guid !== null) {
    const rec = guid as Record<string, unknown>;
    if (rec['@_isPermaLink'] !== 'false') {
      return resolveHttpUrl(extractText(rec), itemBase);
    }
  }
  return null;
}

/** 为 Atom 链接节点计算优先级分数（优先 `text/html` 与 `alternate`，跳过订阅自引用链接） */
function scoreAtomLinkCandidate(rec: Record<string, unknown>): number | null {
  const rel = (extractText(rec['@_rel']) ?? 'alternate').toLowerCase();
  const type = (extractText(rec['@_type']) ?? '').toLowerCase();

  if (rel === 'self' || rel === 'enclosure' || rel === 'replies') {
    return null;
  }
  if (type === 'application/atom+xml' || type === 'application/rss+xml') {
    return null;
  }

  let score = rel === 'alternate' ? 100 : rel === 'related' || rel === 'via' ? 10 : 40;
  if (type === 'text/html') {
    score += 30;
  } else if (type === 'application/xhtml+xml') {
    score += 20;
  } else if (!type) {
    score += 10;
  }
  return score;
}

/** 从 Atom 条目中提取主网页链接（优先 `text/html` 的 `alternate` 链接并支持 `xml:base`） */
function extractAtomLink(entry: Record<string, unknown>, baseUrl?: string): string | null {
  const entryBase = resolveXmlBase(entry, baseUrl);
  const links = toArray(pickByLocalName(entry, 'link'));
  let bestUrl: string | null = null;
  let bestScore = -1;

  for (const linkNode of links) {
    if (typeof linkNode === 'string') {
      const resolved = resolveHttpUrl(linkNode, entryBase);
      if (resolved && bestScore < 50) {
        bestScore = 50;
        bestUrl = resolved;
      }
      continue;
    }
    if (typeof linkNode !== 'object' || linkNode === null) {
      continue;
    }
    const rec = linkNode as Record<string, unknown>;
    const score = scoreAtomLinkCandidate(rec);
    if (score === null) {
      continue;
    }
    const linkBase = resolveXmlBase(rec, entryBase);
    const href = extractText(rec['@_href']) ?? extractText(rec);
    const resolved = resolveHttpUrl(href, linkBase);
    if (resolved && score > bestScore) {
      bestScore = score;
      bestUrl = resolved;
    }
  }

  if (bestUrl) {
    return bestUrl;
  }
  return resolveHttpUrl(extractText(pickByLocalName(entry, 'id')), entryBase);
}

/**
 * 解析 RSS 2.0、RSS 1.0/RDF 与 Atom XML 文本（兼容带命名空间前缀及无时区本地时间），
 * 输出统一格式的订阅新闻列表；若输入内容明显是网页错误页或非订阅 XML，则抛出明确解析异常。
 */
export function parseFeedXml(
  xml: string,
  feedUrl?: string,
  defaultTimezone = 'UTC',
): ParsedFeedItem[] {
  const trimmed = xml.trim();
  if (!trimmed) {
    throw new Error('订阅源返回内容为空');
  }

  let doc: unknown;
  try {
    doc = xmlParser.parse(trimmed);
  } catch (err) {
    throw new Error(`订阅 XML 解析失败: ${err instanceof Error ? err.message : String(err)}`, {
      cause: err,
    });
  }

  if (typeof doc !== 'object' || doc === null) {
    throw new Error('订阅源返回内容不是有效的 XML 文档');
  }

  const root = doc as Record<string, unknown>;
  const results: ParsedFeedItem[] = [];

  const rssNode = pickByLocalName(root, 'rss');
  if (typeof rssNode === 'object' && rssNode !== null) {
    const rss = rssNode as Record<string, unknown>;
    const rssBase = resolveXmlBase(rss, feedUrl);
    for (const channel of toArray(pickByLocalName(rss, 'channel'))) {
      if (typeof channel !== 'object' || channel === null) {
        continue;
      }
      const ch = channel as Record<string, unknown>;
      const chBase = resolveXmlBase(ch, rssBase);
      for (const rawItem of toArray(pickByLocalName(ch, 'item'))) {
        if (typeof rawItem !== 'object' || rawItem === null) {
          continue;
        }
        const item = rawItem as Record<string, unknown>;
        const url = extractRssLink(item, chBase);
        const rawTitle = extractText(pickByLocalName(item, 'title'));
        const title = rawTitle ? cleanFeedTitle(rawTitle) : '';
        if (!url || !title) {
          continue;
        }
        const pubRaw =
          extractText(pickByLocalName(item, 'pubDate')) ??
          extractText(item['dc:date']) ??
          extractText(pickByLocalName(item, 'published')) ??
          extractText(pickByLocalName(item, 'updated')) ??
          extractText(item['a10:updated']);
        results.push({
          url,
          title,
          publishedAt: parsePublishedAt(pubRaw, defaultTimezone),
          summary:
            extractText(pickByLocalName(item, 'description')) ??
            extractText(pickByLocalName(item, 'summary')),
          content:
            extractText(item['content:encoded']) ?? extractText(pickByLocalName(item, 'content')),
        });
      }
    }
    return results;
  }

  const rdfNode = root['rdf:RDF'] ?? pickByLocalName(root, 'RDF');
  if (typeof rdfNode === 'object' && rdfNode !== null) {
    const rdf = rdfNode as Record<string, unknown>;
    const rdfBase = resolveXmlBase(rdf, feedUrl);
    for (const rawItem of toArray(pickByLocalName(rdf, 'item'))) {
      if (typeof rawItem !== 'object' || rawItem === null) {
        continue;
      }
      const item = rawItem as Record<string, unknown>;
      const url = extractRssLink(item, rdfBase);
      const rawTitle = extractText(pickByLocalName(item, 'title'));
      const title = rawTitle ? cleanFeedTitle(rawTitle) : '';
      if (!url || !title) {
        continue;
      }
      const pubRaw = extractText(item['dc:date']) ?? extractText(pickByLocalName(item, 'pubDate'));
      results.push({
        url,
        title,
        publishedAt: parsePublishedAt(pubRaw, defaultTimezone),
        summary: extractText(pickByLocalName(item, 'description')),
        content: extractText(item['content:encoded']),
      });
    }
    return results;
  }

  const feedNode = pickByLocalName(root, 'feed');
  if (typeof feedNode === 'object' && feedNode !== null) {
    const feed = feedNode as Record<string, unknown>;
    const feedBase = resolveXmlBase(feed, feedUrl);
    for (const rawEntry of toArray(pickByLocalName(feed, 'entry'))) {
      if (typeof rawEntry !== 'object' || rawEntry === null) {
        continue;
      }
      const entry = rawEntry as Record<string, unknown>;
      const url = extractAtomLink(entry, feedBase);
      const rawTitle = extractText(pickByLocalName(entry, 'title'));
      const title = rawTitle ? cleanFeedTitle(rawTitle) : '';
      if (!url || !title) {
        continue;
      }
      const pubRaw =
        extractText(pickByLocalName(entry, 'published')) ??
        extractText(pickByLocalName(entry, 'updated'));
      results.push({
        url,
        title,
        publishedAt: parsePublishedAt(pubRaw, defaultTimezone),
        summary: extractText(pickByLocalName(entry, 'summary')),
        content:
          extractText(pickByLocalName(entry, 'content')) ?? extractText(entry['content:encoded']),
      });
    }
    return results;
  }

  throw new Error('返回内容不是标准的 RSS 或 Atom 订阅格式');
}
