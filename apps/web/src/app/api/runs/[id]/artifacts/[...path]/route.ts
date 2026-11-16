import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { getCore } from '@/lib/core';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MIME_BY_EXT: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.json': 'application/json; charset=utf-8',
  '.log': 'text/plain; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

/** 根据产物文件扩展名推断安全的 HTTP `Content-Type` 响应头 */
function detectMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_BY_EXT[ext] ?? 'application/octet-stream';
}

/** 解析单个 HTTP `Range: bytes=start-end` 请求区间 */
function parseByteRange(
  rangeHeader: string,
  fileSize: number,
): { ok: true; start: number; end: number } | { ok: false } {
  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
  if (!match) {
    return { ok: false };
  }
  const [, startRaw, endRaw] = match;
  if (!startRaw && !endRaw) {
    return { ok: false };
  }
  if (fileSize <= 0) {
    return { ok: false };
  }

  if (!startRaw && endRaw) {
    const suffixLen = Number.parseInt(endRaw, 10);
    if (!Number.isSafeInteger(suffixLen) || suffixLen <= 0) {
      return { ok: false };
    }
    const start = Math.max(0, fileSize - suffixLen);
    return { ok: true, start, end: fileSize - 1 };
  }

  const start = Number.parseInt(startRaw ?? '', 10);
  const end = endRaw ? Math.min(Number.parseInt(endRaw, 10), fileSize - 1) : fileSize - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0) {
    return { ok: false };
  }
  if (start >= fileSize || start > end) {
    return { ok: false };
  }
  return { ok: true, start, end };
}

/** 将 Node 文件读取流封装为随 HTTP 请求取消而立即销毁资源的 Web 可读流 */
function streamFileSlice(
  absPath: string,
  signal: AbortSignal,
  start?: number,
  end?: number,
): BodyInit {
  const nodeStream = fsSync.createReadStream(
    absPath,
    start !== undefined && end !== undefined ? { start, end } : undefined,
  );
  const onAbort = () => {
    nodeStream.destroy();
  };
  signal.addEventListener('abort', onAbort, { once: true });
  nodeStream.once('close', () => {
    signal.removeEventListener('abort', onAbort);
  });
  return Readable.toWeb(nodeStream) as unknown as BodyInit;
}

/**
 * 安全输出指定期次任务目录内的视频、封面、音频或文本检查点产物，
 * 自动拦截目录穿越攻击并支持 HTTP `Range` 字节断点分片拖拽播放。
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string; path: string[] }> },
): Promise<Response> {
  const { id, path: pathSegments } = await context.params;
  if (!pathSegments || pathSegments.length === 0) {
    return Response.json({ error: '缺少产物相对路径' }, { status: 400 });
  }

  const relPath = pathSegments.join('/');
  const core = await getCore();

  let absPath: string;
  try {
    absPath = core.tasks.resolveArtifact(id, relPath);
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : '非法的产物访问路径' },
      { status: 403 },
    );
  }

  let stat: import('node:fs').Stats;
  try {
    stat = await fs.stat(absPath);
  } catch {
    return Response.json({ error: '未找到指定产物文件' }, { status: 404 });
  }
  if (!stat.isFile()) {
    return Response.json({ error: '目标路径不是普通文件' }, { status: 404 });
  }

  const contentType = detectMimeType(absPath);
  const fileSize = stat.size;
  const rangeHeader = request.headers.get('range');

  if (rangeHeader) {
    const parsedRange = parseByteRange(rangeHeader, fileSize);
    if (!parsedRange.ok) {
      return new Response(null, {
        status: 416,
        headers: {
          'Accept-Ranges': 'bytes',
          'Content-Range': `bytes */${fileSize}`,
        },
      });
    }
    const { start, end } = parsedRange;
    const chunkSize = end - start + 1;
    return new Response(streamFileSlice(absPath, request.signal, start, end), {
      status: 206,
      headers: {
        'Content-Type': contentType,
        'Accept-Ranges': 'bytes',
        'Content-Range': `bytes ${start}-${end}/${fileSize}`,
        'Content-Length': String(chunkSize),
        'Cache-Control': 'no-store',
      },
    });
  }

  if (fileSize === 0) {
    return new Response(new Uint8Array(0), {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Accept-Ranges': 'bytes',
        'Content-Length': '0',
        'Cache-Control': 'no-store',
      },
    });
  }

  return new Response(streamFileSlice(absPath, request.signal), {
    status: 200,
    headers: {
      'Content-Type': contentType,
      'Accept-Ranges': 'bytes',
      'Content-Length': String(fileSize),
      'Cache-Control': 'no-store',
    },
  });
}
