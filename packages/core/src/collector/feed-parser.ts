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
});

/** 将单个字段或数组统一转为数组形式，简化订阅条目遍历 */
function toArray<T>(val: T | T[] | undefined | null): T[] {
  if (val === undefined || val === null) {
    return [];
  }
  return Array.isArray(val) ? val : [val];
}

/** 从可能是纯字符串、带属性对象或节点数组中提取文本内容 */
function extractText(node: unknown): string | null {
  if (node === undefined || node === null) {
    return null;
  }
  if (typeof node === 'string' || typeof node === 'number' || typeof node === 'boolean') {
    const str = String(node).trim();
    return str.length > 0 ? str : null;
  }
  if (Array.isArray(node)) {
    for (const item of node) {
      const text = extractText(item);
      if (text) {
        return text;
      }
    }
    return null;
  }
  if (typeof node === 'object') {
    const record = node as Record<string, unknown>;
    if ('#text' in record) {
      return extractText(record['#text']);
    }
    if ('_' in record) {
      return extractText(record._);
    }
  }
  return null;
}

/** 清理标题中的内联 HTML 标签、实体编码与多余空白 */
function cleanFeedTitle(raw: string): string {
  return raw
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 尝试将各种常见发布时间格式解析为标准 UTC ISO 时间字符串 */
function parsePublishedAt(raw: string | null): string | null {
  if (!raw) {
    return null;
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }

  let candidate = trimmed;
  // 处理不带时区的 `YYYY-MM-DD HH:mm:ss` 格式
  if (/^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}(:\d{2})?$/.test(candidate)) {
    candidate = candidate.replace(/\s+/, 'T');
  }

  const ms = Date.parse(candidate);
  if (Number.isNaN(ms)) {
    return null;
  }
  return new Date(ms).toISOString();
}

/** 将疑似相对链接解析为绝对 http/https 地址，无效地址返回 null */
function resolveHttpUrl(rawUrl: string | null, feedUrl?: string): string | null {
  if (!rawUrl) {
    return null;
  }
  try {
    const parsed = feedUrl ? new URL(rawUrl.trim(), feedUrl) : new URL(rawUrl.trim());
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null;
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

/** 从 RSS 条目中提取文章链接 */
function extractRssLink(item: Record<string, unknown>, feedUrl?: string): string | null {
  for (const linkNode of toArray(item.link)) {
    if (typeof linkNode === 'string') {
      const resolved = resolveHttpUrl(linkNode, feedUrl);
      if (resolved) {
        return resolved;
      }
    } else if (typeof linkNode === 'object' && linkNode !== null) {
      const rec = linkNode as Record<string, unknown>;
      const href = extractText(rec['@_href']) ?? extractText(rec);
      const resolved = resolveHttpUrl(href, feedUrl);
      if (resolved) {
        return resolved;
      }
    }
  }

  const guid = item.guid;
  if (typeof guid === 'string') {
    return resolveHttpUrl(guid, feedUrl);
  }
  if (typeof guid === 'object' && guid !== null) {
    const rec = guid as Record<string, unknown>;
    if (rec['@_isPermaLink'] !== 'false') {
      return resolveHttpUrl(extractText(rec), feedUrl);
    }
  }
  return null;
}

/** 从 Atom 条目中提取主网页链接（优先选择 alternate 或未标明类型的链接） */
function extractAtomLink(entry: Record<string, unknown>, feedUrl?: string): string | null {
  const links = toArray(entry.link);
  let fallbackUrl: string | null = null;

  for (const linkNode of links) {
    if (typeof linkNode === 'string') {
      const resolved = resolveHttpUrl(linkNode, feedUrl);
      if (resolved) {
        return resolved;
      }
      continue;
    }
    if (typeof linkNode !== 'object' || linkNode === null) {
      continue;
    }
    const rec = linkNode as Record<string, unknown>;
    const href = extractText(rec['@_href']) ?? extractText(rec);
    const resolved = resolveHttpUrl(href, feedUrl);
    if (!resolved) {
      continue;
    }
    const rel = extractText(rec['@_rel'])?.toLowerCase();
    if (!rel || rel === 'alternate') {
      return resolved;
    }
    if (!fallbackUrl) {
      fallbackUrl = resolved;
    }
  }

  if (fallbackUrl) {
    return fallbackUrl;
  }
  return resolveHttpUrl(extractText(entry.id), feedUrl);
}

/**
 * 解析 RSS 2.0、RSS 1.0/RDF 与 Atom XML 文本，输出统一格式的订阅新闻列表；
 * 若输入内容明显是网页错误页或非订阅 XML，则抛出明确解析异常。
 */
export function parseFeedXml(xml: string, feedUrl?: string): ParsedFeedItem[] {
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

  if ('rss' in root && typeof root.rss === 'object' && root.rss !== null) {
    const rss = root.rss as Record<string, unknown>;
    const channels = toArray(rss.channel);
    for (const channel of channels) {
      if (typeof channel !== 'object' || channel === null) {
        continue;
      }
      const ch = channel as Record<string, unknown>;
      for (const rawItem of toArray(ch.item)) {
        if (typeof rawItem !== 'object' || rawItem === null) {
          continue;
        }
        const item = rawItem as Record<string, unknown>;
        const url = extractRssLink(item, feedUrl);
        const rawTitle = extractText(item.title);
        const title = rawTitle ? cleanFeedTitle(rawTitle) : '';
        if (!url || !title) {
          continue;
        }
        const pubRaw =
          extractText(item.pubDate) ??
          extractText(item['dc:date']) ??
          extractText(item.published) ??
          extractText(item.updated) ??
          extractText(item['a10:updated']);
        results.push({
          url,
          title,
          publishedAt: parsePublishedAt(pubRaw),
          summary: extractText(item.description) ?? extractText(item.summary),
          content: extractText(item['content:encoded']) ?? extractText(item.content),
        });
      }
    }
    return results;
  }

  if ('rdf:RDF' in root && typeof root['rdf:RDF'] === 'object' && root['rdf:RDF'] !== null) {
    const rdf = root['rdf:RDF'] as Record<string, unknown>;
    for (const rawItem of toArray(rdf.item)) {
      if (typeof rawItem !== 'object' || rawItem === null) {
        continue;
      }
      const item = rawItem as Record<string, unknown>;
      const url = extractRssLink(item, feedUrl);
      const rawTitle = extractText(item.title);
      const title = rawTitle ? cleanFeedTitle(rawTitle) : '';
      if (!url || !title) {
        continue;
      }
      const pubRaw = extractText(item['dc:date']) ?? extractText(item.pubDate);
      results.push({
        url,
        title,
        publishedAt: parsePublishedAt(pubRaw),
        summary: extractText(item.description),
        content: extractText(item['content:encoded']),
      });
    }
    return results;
  }

  if ('feed' in root && typeof root.feed === 'object' && root.feed !== null) {
    const feed = root.feed as Record<string, unknown>;
    for (const rawEntry of toArray(feed.entry)) {
      if (typeof rawEntry !== 'object' || rawEntry === null) {
        continue;
      }
      const entry = rawEntry as Record<string, unknown>;
      const url = extractAtomLink(entry, feedUrl);
      const rawTitle = extractText(entry.title);
      const title = rawTitle ? cleanFeedTitle(rawTitle) : '';
      if (!url || !title) {
        continue;
      }
      const pubRaw = extractText(entry.published) ?? extractText(entry.updated);
      results.push({
        url,
        title,
        publishedAt: parsePublishedAt(pubRaw),
        summary: extractText(entry.summary),
        content: extractText(entry.content) ?? extractText(entry['content:encoded']),
      });
    }
    return results;
  }

  throw new Error('返回内容不是标准的 RSS 或 Atom 订阅格式');
}
