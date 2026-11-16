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

/** 检查日期字符串末尾是否已包含明确时区偏移信息 */
function hasExplicitTimezone(raw: string): boolean {
  return /(?:Z|[+-]\d{2}:?\d{2}|GMT|UTC|UT|[ECMP][DS]T)$/i.test(raw.trim());
}

/** 将各种常见发布时间格式解析为标准 UTC ISO 时间字符串（无时区时间按配置时区解释） */
function parsePublishedAt(raw: string | null, defaultTimezone = 'UTC'): string | null {
  if (!raw) {
    return null;
  }
  const trimmed = unwrapCdata(raw).trim();
  if (!trimmed) {
    return null;
  }

  // 纯日期格式 YYYY-MM-DD 按配置时区的当天零点转换
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    const tzDate = new TZDate(`${trimmed}T00:00:00`, defaultTimezone);
    return Number.isNaN(tzDate.getTime()) ? null : new Date(tzDate.getTime()).toISOString();
  }

  // 不带时区的 YYYY-MM-DD HH:mm(:ss)?(.sss)? 按配置时区解释
  if (/^\d{4}-\d{2}-\d{2}[T\s]\d{2}:\d{2}(:\d{2}(?:\.\d+)?)?$/.test(trimmed)) {
    const isoLocal = trimmed.replace(/\s+/, 'T');
    if (!hasExplicitTimezone(isoLocal)) {
      const tzDate = new TZDate(isoLocal, defaultTimezone);
      if (!Number.isNaN(tzDate.getTime())) {
        return new Date(tzDate.getTime()).toISOString();
      }
    }
  }

  const ms = Date.parse(trimmed);
  if (Number.isNaN(ms)) {
    return null;
  }
  return new Date(ms).toISOString();
}

/** 将疑似相对链接解析为绝对 http/https 地址，无效地址返回 null */
function resolveHttpUrl(rawUrl: string | null, baseUrl?: string): string | null {
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
