import crypto from 'node:crypto';

const EXACT_TRACKING_PARAMS = new Set([
  'ref',
  'ref_src',
  'ref_url',
  'fbclid',
  'gclid',
  'mc_cid',
  'mc_eid',
  'spm',
  'from',
  'hmsr',
]);

/** 判断查询参数名是否属于用于流量归因的追踪参数 */
function isTrackingParam(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.startsWith('utm_') || EXACT_TRACKING_PARAMS.has(lower);
}

/**
 * 规范化新闻链接：统一小写域名、去除追踪查询参数与页内锚点、移除多余末尾斜杠并排序剩余参数，
 * 确保同一篇文章不会因分享追踪参数不同而被重复抓取。
 */
export function canonicalizeUrl(rawUrl: string, baseUrl?: string): string {
  let url: URL;
  try {
    url = baseUrl ? new URL(rawUrl.trim(), baseUrl) : new URL(rawUrl.trim());
  } catch (err) {
    throw new Error(`非法的文章链接: ${rawUrl}`, { cause: err });
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`仅支持 http/https 协议链接: ${rawUrl}`);
  }

  url.protocol = url.protocol.toLowerCase();
  url.hostname = url.hostname.toLowerCase();
  if (
    (url.protocol === 'http:' && url.port === '80') ||
    (url.protocol === 'https:' && url.port === '443')
  ) {
    url.port = '';
  }

  url.hash = '';

  const keptParams: Array<[string, string]> = [];
  for (const [key, value] of url.searchParams.entries()) {
    if (!isTrackingParam(key)) {
      keptParams.push([key, value]);
    }
  }
  keptParams.sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]));

  url.search = '';
  for (const [key, value] of keptParams) {
    url.searchParams.append(key, value);
  }

  if (url.pathname.length > 1) {
    url.pathname = url.pathname.replace(/\/+$/, '') || '/';
  }

  return url.toString();
}

/** 根据规范化后的文章链接计算固定长度的 SHA-1 唯一文章标识 */
export function computeArticleId(canonicalUrl: string): string {
  return crypto.createHash('sha1').update(canonicalUrl, 'utf8').digest('hex');
}

/** 将文章或事件标题归一化为用于去重比较的纯文本形式 */
export function normalizeTitle(title: string): string {
  return title
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/^[\s\p{P}\p{S}]+|[\s\p{P}\p{S}]+$/gu, '')
    .trim();
}
