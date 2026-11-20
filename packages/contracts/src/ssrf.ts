/** 目标地址或 IP 的网络可达性风险分类 */
export type IpAddressClass = 'public' | 'loopback' | 'metadata' | 'private' | 'benchmark';

/** 检查一段主机名文本是否为严格的十进制 IPv4 四段地址，是则返回 4 个字节数字 */
function parseIpv4Octets(host: string): [number, number, number, number] | null {
  const parts = host.split('.');
  if (parts.length !== 4) {
    return null;
  }
  const nums: number[] = [];
  for (const part of parts) {
    if (!/^(?:0|[1-9]\d{0,2})$/.test(part)) {
      return null;
    }
    const val = Number(part);
    if (!Number.isInteger(val) || val < 0 || val > 255) {
      return null;
    }
    nums.push(val);
  }
  return [nums[0] ?? 0, nums[1] ?? 0, nums[2] ?? 0, nums[3] ?? 0];
}

/** 根据 IPv4 四段字节划分地址风险类别 */
function classifyIpv4Octets(octets: [number, number, number, number]): IpAddressClass {
  const [a, b, c, d] = octets;
  if (a === 127) {
    return 'loopback';
  }
  // 链路本地与 AWS/GCP/Azure 实例元数据地址 169.254.0.0/16
  if (a === 169 && b === 254) {
    return 'metadata';
  }
  // 阿里云 ECS 实例元数据地址 100.100.100.200
  if (a === 100 && b === 100 && c === 100 && d === 200) {
    return 'metadata';
  }
  // 198.18.0.0/15 为压测保留段，常见于桌面代理软件的虚拟 DNS 地址池，单独分类以便区分公网域名解析与直接 IP 访问
  if (a === 198 && (b === 18 || b === 19)) {
    return 'benchmark';
  }
  if (
    a === 0 ||
    a === 10 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 192 && b === 88 && c === 99) ||
    (a === 192 && b === 168) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  ) {
    return 'private';
  }
  return 'public';
}

/** 展开 IPv6（含可选压缩与末尾内嵌 IPv4）为固定长度 8 个 16 位无符号整数组 */
function parseIpv6Hextets(raw: string): number[] | null {
  const withoutBrackets = raw.startsWith('[') && raw.endsWith(']') ? raw.slice(1, -1) : raw;
  const zoneIdx = withoutBrackets.indexOf('%');
  const clean = (zoneIdx >= 0 ? withoutBrackets.slice(0, zoneIdx) : withoutBrackets).toLowerCase();
  if (!clean.includes(':')) {
    return null;
  }

  const dblSplit = clean.split('::');
  if (dblSplit.length > 2) {
    return null;
  }

  const parseSegmentList = (segmentStr: string): number[] | null => {
    if (!segmentStr) {
      return [];
    }
    const items = segmentStr.split(':');
    const result: number[] = [];
    for (let i = 0; i < items.length; i++) {
      const part = items[i] ?? '';
      if (part.includes('.')) {
        if (i !== items.length - 1) {
          return null;
        }
        const ipv4 = parseIpv4Octets(part);
        if (!ipv4) {
          return null;
        }
        result.push(((ipv4[0] << 8) | ipv4[1]) & 0xffff);
        result.push(((ipv4[2] << 8) | ipv4[3]) & 0xffff);
        continue;
      }
      if (!/^[0-9a-f]{1,4}$/.test(part)) {
        return null;
      }
      result.push(Number.parseInt(part, 16));
    }
    return result;
  };

  const head = parseSegmentList(dblSplit[0] ?? '');
  if (!head) {
    return null;
  }
  if (dblSplit.length === 1) {
    return head.length === 8 ? head : null;
  }

  const tail = parseSegmentList(dblSplit[1] ?? '');
  if (!tail || head.length + tail.length > 7) {
    return null;
  }
  const missing = 8 - head.length - tail.length;
  return [...head, ...Array<number>(missing).fill(0), ...tail];
}

/** 解析单个 IPv4 或 IPv6 字面量并返回风险分类，若不是合法 IP 字面量则返回 null */
export function classifyIpAddress(rawIp: string): IpAddressClass | null {
  const trimmed = rawIp.trim();
  const ipv4 = parseIpv4Octets(trimmed);
  if (ipv4) {
    return classifyIpv4Octets(ipv4);
  }
  const h = parseIpv6Hextets(trimmed);
  if (!h) {
    return null;
  }

  const allZeroExceptLast =
    h[0] === 0 && h[1] === 0 && h[2] === 0 && h[3] === 0 && h[4] === 0 && h[5] === 0 && h[6] === 0;
  // :: 未指定地址
  if (allZeroExceptLast && h[7] === 0) {
    return 'private';
  }
  // ::1 回环地址
  if (allZeroExceptLast && h[7] === 1) {
    return 'loopback';
  }

  // IPv4 映射地址 ::ffff:a.b.c.d / NAT64 64:ff9b::a.b.c.d
  const isIpv4Mapped =
    h[0] === 0 && h[1] === 0 && h[2] === 0 && h[3] === 0 && h[4] === 0 && h[5] === 0xffff;
  const isIpv4Translated =
    h[0] === 0 && h[1] === 0 && h[2] === 0 && h[3] === 0 && h[4] === 0xffff && h[5] === 0;
  const isNat64 =
    (h[0] === 0x0064 && h[1] === 0xff9b && h[2] === 0 && h[3] === 0 && h[4] === 0 && h[5] === 0) ||
    (h[0] === 0x0064 && h[1] === 0xff9b && h[2] === 0x0001);
  if (isIpv4Mapped || isIpv4Translated || isNat64) {
    const hi = h[6] ?? 0;
    const lo = h[7] ?? 0;
    return classifyIpv4Octets([(hi >> 8) & 0xff, hi & 0xff, (lo >> 8) & 0xff, lo & 0xff]);
  }

  // AWS EC2 IPv6 元数据 fd00:ec2::254
  if (
    h[0] === 0xfd00 &&
    h[1] === 0x0ec2 &&
    h[2] === 0 &&
    h[3] === 0 &&
    h[4] === 0 &&
    h[5] === 0 &&
    h[6] === 0 &&
    h[7] === 0x0254
  ) {
    return 'metadata';
  }
  // fe80::/10 链路本地（常用于本机网卡与云主机内部元数据服务）
  if (((h[0] ?? 0) & 0xffc0) === 0xfe80) {
    return 'metadata';
  }
  // fc00::/7 唯一本地私网、fec0::/10 站点本地、ff00::/8 组播、100::/64 丢弃、文档/过渡隧道网段
  if (
    ((h[0] ?? 0) & 0xfe00) === 0xfc00 ||
    ((h[0] ?? 0) & 0xffc0) === 0xfec0 ||
    ((h[0] ?? 0) & 0xff00) === 0xff00 ||
    (h[0] === 0x0100 && h[1] === 0 && h[2] === 0 && h[3] === 0) ||
    (h[0] === 0x2001 && h[1] === 0x0db8) ||
    (h[0] === 0x2001 && h[1] === 0x0000) ||
    h[0] === 0x2002
  ) {
    return 'private';
  }
  return 'public';
}

/** 对目标主机名（IP 字面量或域名）进行网络边界分类 */
export function classifyTargetHostname(rawHost: string): IpAddressClass {
  const noBrackets =
    rawHost.startsWith('[') && rawHost.endsWith(']') ? rawHost.slice(1, -1) : rawHost;
  const clean = noBrackets.replace(/\.+$/, '').trim().toLowerCase();
  if (!clean) {
    return 'private';
  }

  const ipClass = classifyIpAddress(clean);
  if (ipClass !== null) {
    return ipClass;
  }

  if (
    clean === 'metadata.google.internal' ||
    clean === 'metadata.goog' ||
    clean === 'metadata' ||
    clean === 'instance-data'
  ) {
    return 'metadata';
  }
  if (clean === 'localhost' || clean.endsWith('.localhost')) {
    return 'loopback';
  }
  if (
    !clean.includes('.') ||
    clean.endsWith('.local') ||
    clean.endsWith('.internal') ||
    clean.endsWith('.arpa')
  ) {
    return 'private';
  }
  return 'public';
}

/**
 * 判断解析出的 IP 类别是否允许访问目标 URL：
 * 云元数据网段与未授权内网一律拒绝；本机回环仅在显式开启开关或位于受信本源列表时放行；
 * 基准测试保留段仅在开启选项且目标本身为公共域名时放行，避免桌面代理虚拟 DNS 被误拦截。
 */
export function isAllowedResolvedIpClass(
  ipClass: IpAddressClass,
  targetUrl: URL,
  opts?: {
    allowLoopback?: boolean;
    allowBenchmarkDns?: boolean;
    allowedOrigins?: readonly string[];
  },
): boolean {
  if (ipClass === 'metadata') {
    return false;
  }
  if (ipClass === 'public') {
    return true;
  }
  if (ipClass === 'benchmark') {
    return (
      Boolean(opts?.allowBenchmarkDns) && classifyTargetHostname(targetUrl.hostname) === 'public'
    );
  }
  if (opts?.allowedOrigins?.includes(targetUrl.origin)) {
    return true;
  }
  return ipClass === 'loopback' && Boolean(opts?.allowLoopback);
}

/**
 * 判断完整 URL 是否可以安全发起服务端外网请求，阻断内网、回环及云元数据地址探测。
 */
export function isAllowedUrlTarget(
  targetUrl: URL,
  opts?: { allowLoopback?: boolean; allowedOrigins?: readonly string[] },
): boolean {
  if (targetUrl.protocol !== 'http:' && targetUrl.protocol !== 'https:') {
    return false;
  }
  const hostClass = classifyTargetHostname(targetUrl.hostname);
  return isAllowedResolvedIpClass(hostClass, targetUrl, opts);
}
