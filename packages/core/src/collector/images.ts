import path from 'node:path';
import { writeFileAtomic } from '../storage/files.js';

const DEFAULT_IMAGE_TIMEOUT_MS = 15_000;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const BROWSER_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const MIME_TO_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/avif': 'avif',
  'image/svg+xml': 'svg',
};

/** 从响应头 Content-Type 中识别安全图片文件后缀名（接受所有 `image/*`，未知子类型使用通用 `.img` 后缀） */
function resolveImageExtension(contentType: string | null): string | null {
  if (!contentType) {
    return null;
  }
  const mime = contentType.split(';', 1)[0]?.trim().toLowerCase() ?? '';
  if (!mime.startsWith('image/')) {
    return null;
  }
  return MIME_TO_EXT[mime] ?? 'img';
}

/** 按字节上限流式读取图片响应体，超出上限立即中止读取并返回 null */
async function readImageBytesWithLimit(res: Response, maxBytes: number): Promise<Buffer | null> {
  const lenHeader = res.headers.get('content-length');
  if (lenHeader) {
    const expected = Number(lenHeader);
    if (Number.isFinite(expected) && expected > maxBytes) {
      await res.body?.cancel().catch(() => undefined);
      return null;
    }
  }
  if (!res.body) {
    return null;
  }

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      if (!value) {
        continue;
      }
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  if (total === 0) {
    return null;
  }
  return Buffer.concat(chunks);
}

/**
 * 下载新闻配图并原子写入本地图片目录：
 * 只接受常见 `image/*` 响应（跳过矢量图标）且大小严格限制在 5MB 以内；任意下载失败均静默返回 null，不影响文章入库。
 */
export async function downloadArticleImage(opts: {
  articleId: string;
  imageUrl: string;
  imagesDir: string;
  rootDir: string;
  fetchImpl: typeof fetch;
  fileSuffix?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<string | null> {
  if (opts.signal?.aborted) {
    throw new DOMException('已取消', 'AbortError');
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(opts.imageUrl);
  } catch {
    return null;
  }
  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    return null;
  }

  const timeoutSignal = AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_IMAGE_TIMEOUT_MS);
  const combinedSignal = opts.signal
    ? AbortSignal.any([opts.signal, timeoutSignal])
    : timeoutSignal;

  try {
    const res = await opts.fetchImpl(parsedUrl.toString(), {
      signal: combinedSignal,
      redirect: 'follow',
      headers: {
        'User-Agent': BROWSER_USER_AGENT,
        Accept: 'image/avif,image/webp,image/png,image/jpeg,image/gif,*/*;q=0.5',
      },
    });
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      return null;
    }

    const ext = resolveImageExtension(res.headers.get('content-type'));
    if (!ext || ext === 'svg') {
      await res.body?.cancel().catch(() => undefined);
      return null;
    }

    const data = await readImageBytesWithLimit(res, MAX_IMAGE_BYTES);
    if (!data) {
      return null;
    }

    const safeSuffix = opts.fileSuffix ? `-${opts.fileSuffix.replace(/[^a-zA-Z0-9_-]/g, '')}` : '';
    const destFile = path.join(opts.imagesDir, `${opts.articleId}${safeSuffix}.${ext}`);
    await writeFileAtomic(destFile, data);
    return path.relative(opts.rootDir, destFile);
  } catch (err) {
    if (opts.signal?.aborted) {
      throw err;
    }
    return null;
  }
}
