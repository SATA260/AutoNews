const DEFAULT_ALLOWED_LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/** 从带端口的 Host 请求头中提取规范化后的小写主机名 */
function extractNormalizedHostname(hostHeaderValue: string): string | null {
  const trimmed = hostHeaderValue.trim().toLowerCase();
  if (!trimmed || /[\s/\\@#]/.test(trimmed)) {
    return null;
  }
  if (trimmed.startsWith('[')) {
    const closeIdx = trimmed.indexOf(']');
    if (closeIdx <= 1) {
      return null;
    }
    const inner = trimmed.slice(1, closeIdx);
    const rest = trimmed.slice(closeIdx + 1);
    if (rest && !/^:\d+$/.test(rest)) {
      return null;
    }
    return inner;
  }
  const colonIdx = trimmed.indexOf(':');
  if (colonIdx === -1) {
    return trimmed;
  }
  const hostPart = trimmed.slice(0, colonIdx);
  const portPart = trimmed.slice(colonIdx + 1);
  if (!hostPart || !/^\d+$/.test(portPart)) {
    return null;
  }
  return hostPart;
}

/** 构造当前环境允许访问网页管理台的主机名白名单 */
function resolveAllowedHosts(): Set<string> {
  const hosts = new Set(DEFAULT_ALLOWED_LOCAL_HOSTS);
  const extra = process.env.AIDAILY_WEB_ALLOWED_HOSTS;
  if (extra) {
    for (const part of extra.split(',')) {
      const clean = part.trim().toLowerCase();
      if (clean) {
        hosts.add(clean);
      }
    }
  }
  return hosts;
}

/** 判断主机名是否属于当前允许的本机回环或白名单主机 */
function isAllowedWebHostname(hostname: string, allowedHosts: Set<string>): boolean {
  const clean = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return allowedHosts.has(clean) || allowedHosts.has(`[${clean}]`);
}

/** 从 Cookie 请求头按名称提取值 */
function readCookieValue(cookieHeader: string | null, name: string): string | null {
  if (!cookieHeader) {
    return null;
  }
  for (const part of cookieHeader.split(';')) {
    const eqIdx = part.indexOf('=');
    if (eqIdx <= 0) {
      continue;
    }
    const k = part.slice(0, eqIdx).trim();
    if (k === name) {
      return decodeURIComponent(part.slice(eqIdx + 1).trim());
    }
  }
  return null;
}

/** 常数时间字符串比对，避免可选令牌比对产生时序差异 */
function safeEqualString(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * 校验 Web 后台及接口请求来源是否安全：
 * 1) 严格限制 Host 与 X-Forwarded-Host 为本机回环（或显式允许的白名单域名），阻断 DNS 重绑定攻击；
 * 2) 拒绝来自外部站点的 Sec-Fetch-Site、Origin 与 Referer 跨站请求；
 * 3) 若配置了 `AIDAILY_WEB_TOKEN`，额外核对请求令牌。
 */
export function verifyLocalWebRequest(
  request: Request,
): { ok: true } | { ok: false; status: 403 | 401; error: string } {
  const allowedHosts = resolveAllowedHosts();
  const urlHost = new URL(request.url).host.toLowerCase();
  const hostHeader = request.headers.get('host');
  const effectiveHost = (hostHeader ?? urlHost).trim().toLowerCase();
  const hostName = extractNormalizedHostname(effectiveHost);
  if (!hostName || !isAllowedWebHostname(hostName, allowedHosts)) {
    return { ok: false, status: 403, error: '仅允许通过本机回环地址访问管理后台' };
  }

  const forwardedHost = request.headers.get('x-forwarded-host');
  if (forwardedHost) {
    for (const entry of forwardedHost.split(',')) {
      const fwdName = extractNormalizedHostname(entry);
      if (!fwdName || !isAllowedWebHostname(fwdName, allowedHosts)) {
        return { ok: false, status: 403, error: '非法的代理转发主机头 X-Forwarded-Host' };
      }
    }
  }

  const secFetchSite = request.headers.get('sec-fetch-site')?.trim().toLowerCase();
  if (secFetchSite === 'cross-site') {
    return { ok: false, status: 403, error: '已拦截来自外部站点的跨站请求' };
  }

  const originHeader = request.headers.get('origin');
  if (originHeader !== null) {
    if (originHeader.trim().toLowerCase() === 'null') {
      return { ok: false, status: 403, error: '已拦截匿名跨站 Origin 请求' };
    }
    let originUrl: URL;
    try {
      originUrl = new URL(originHeader);
    } catch {
      return { ok: false, status: 403, error: '请求头 Origin 格式非法' };
    }
    if (originUrl.protocol !== 'http:' && originUrl.protocol !== 'https:') {
      return { ok: false, status: 403, error: '请求头 Origin 协议不被允许' };
    }
    if (
      !isAllowedWebHostname(originUrl.hostname, allowedHosts) ||
      originUrl.host.toLowerCase() !== effectiveHost
    ) {
      return { ok: false, status: 403, error: '已拦截跨源或主机名不匹配的请求' };
    }
  }

  const refererHeader = request.headers.get('referer');
  if (refererHeader) {
    let refUrl: URL;
    try {
      refUrl = new URL(refererHeader);
    } catch {
      return { ok: false, status: 403, error: '请求头 Referer 格式非法' };
    }
    if (
      (refUrl.protocol !== 'http:' && refUrl.protocol !== 'https:') ||
      !isAllowedWebHostname(refUrl.hostname, allowedHosts)
    ) {
      return { ok: false, status: 403, error: '已拦截来自外部站点的 Referer 请求' };
    }
  }

  const expectedToken = process.env.AIDAILY_WEB_TOKEN?.trim();
  if (expectedToken) {
    const authHeader = request.headers.get('authorization');
    const bearer = authHeader?.toLowerCase().startsWith('bearer ')
      ? authHeader.slice(7).trim()
      : null;
    const tokenHeader = request.headers.get('x-aidaily-token')?.trim() ?? null;
    const cookieToken = readCookieValue(request.headers.get('cookie'), 'aidaily_token');
    const candidate = bearer ?? tokenHeader ?? cookieToken;
    if (!candidate || !safeEqualString(candidate, expectedToken)) {
      return { ok: false, status: 401, error: '缺少或无效的管理后台访问令牌' };
    }
  }

  return { ok: true };
}
