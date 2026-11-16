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

type ParsedRangeResult =
  | { kind: 'slice'; start: number; end: number }
  | { kind: 'ignore' }
  | { kind: 'invalid' };

/** 根据产物文件扩展名推断安全的 HTTP `Content-Type` 响应头 */
function detectMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_BY_EXT[ext] ?? 'application/octet-stream';
}

/** 严格解析非负安全整数字符串，防止超出安全范围的数值发生隐式舍入 */
function parseStrictSafeNonNegativeInt(raw: string): number | null {
  if (!/^(?:0|[1-9]\d*)$/.test(raw)) {
    return null;
  }
  const num = Number.parseInt(raw, 10);
  return Number.isSafeInteger(num) && String(num) === raw ? num : null;
}

/**
 * 解析 HTTP `Range` 请求头：
 * - 非 `bytes=` 单位或包含多段范围的请求按规范忽略并返回完整内容；
 * - 单段语法非法或越界返回 `invalid`，触发 `416 Range Not Satisfiable`。
 */
function parseByteRange(rangeHeader: string, fileSize: number): ParsedRangeResult {
  const trimmed = rangeHeader.trim();
  const eqIdx = trimmed.indexOf('=');
  if (eqIdx <= 0) {
    return { kind: 'invalid' };
  }
  const unit = trimmed.slice(0, eqIdx).trim().toLowerCase();
  const rangeSpec = trimmed.slice(eqIdx + 1).trim();
  if (unit !== 'bytes') {
    return { kind: 'ignore' };
  }
  if (rangeSpec.includes(',')) {
    return { kind: 'ignore' };
  }
  const match = /^(\d*)-(\d*)$/.exec(rangeSpec);
  if (!match) {
    return { kind: 'invalid' };
  }
  const [, startRaw, endRaw] = match;
  if (!startRaw && !endRaw) {
    return { kind: 'invalid' };
  }
  if (fileSize <= 0) {
    return { kind: 'invalid' };
  }

  if (!startRaw && endRaw) {
    if (!/^\d+$/.test(endRaw)) {
      return { kind: 'invalid' };
    }
    const bigSuffix = BigInt(endRaw);
    if (bigSuffix <= 0n) {
      return { kind: 'invalid' };
    }
    const cappedSuffix = bigSuffix >= BigInt(fileSize) ? fileSize : Number(bigSuffix);
    const start = Math.max(0, fileSize - cappedSuffix);
    return { kind: 'slice', start, end: fileSize - 1 };
  }

  const start = parseStrictSafeNonNegativeInt(startRaw ?? '');
  if (start === null || start >= fileSize) {
    return { kind: 'invalid' };
  }
  if (!endRaw) {
    return { kind: 'slice', start, end: fileSize - 1 };
  }
  const parsedEnd = parseStrictSafeNonNegativeInt(endRaw);
  if (parsedEnd === null) {
    // 若客户端传了极大结束偏移（只要格式为纯数字），则裁剪至文件末尾
    if (/^\d+$/.test(endRaw) && BigInt(endRaw) >= BigInt(fileSize)) {
      return { kind: 'slice', start, end: fileSize - 1 };
    }
    return { kind: 'invalid' };
  }
  const end = Math.min(parsedEnd, fileSize - 1);
  if (start > end) {
    return { kind: 'invalid' };
  }
  return { kind: 'slice', start, end };
}

/** 基于已打开的只读文件句柄构造 Web 可读流，随请求取消即时销毁流并释放文件描述符 */
function streamFromHandle(
  handle: fs.FileHandle,
  signal: AbortSignal,
  start?: number,
  end?: number,
): BodyInit {
  const nodeStream = handle.createReadStream(
    start !== undefined && end !== undefined
      ? { start, end, autoClose: true }
      : { autoClose: true },
  );
  const onAbort = () => {
    nodeStream.destroy();
    void handle.close().catch(() => undefined);
  };
  signal.addEventListener('abort', onAbort, { once: true });
  nodeStream.once('close', () => {
    signal.removeEventListener('abort', onAbort);
    void handle.close().catch(() => undefined);
  });
  return Readable.toWeb(nodeStream) as unknown as BodyInit;
}

/**
 * 安全输出指定期次任务目录内的视频、封面、音频或文本检查点产物，
 * 通过原子禁止软链接打开防范文件替换风险，并支持 HTTP `Range` 分片拖拽播放。
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string; path: string[] }> },
): Promise<Response> {
  if (request.signal.aborted) {
    return new Response(null, { status: 499 });
  }

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

  if (request.signal.aborted) {
    return new Response(null, { status: 499 });
  }

  const openFlags = fsSync.constants.O_RDONLY | (fsSync.constants.O_NOFOLLOW ?? 0);
  let handle: fs.FileHandle;
  try {
    handle = await fs.open(absPath, openFlags);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ELOOP') {
      return Response.json({ error: '禁止直接访问符号链接文件' }, { status: 403 });
    }
    return Response.json({ error: '未找到指定产物文件' }, { status: 404 });
  }

  let fileSize = 0;
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) {
      await handle.close().catch(() => undefined);
      return Response.json({ error: '目标路径不是普通文件' }, { status: 404 });
    }
    fileSize = stat.size;
  } catch {
    await handle.close().catch(() => undefined);
    return Response.json({ error: '读取产物文件信息失败' }, { status: 404 });
  }

  if (request.signal.aborted) {
    await handle.close().catch(() => undefined);
    return new Response(null, { status: 499 });
  }

  const contentType = detectMimeType(absPath);
  const rangeHeader = request.headers.get('range');

  if (rangeHeader) {
    const parsedRange = parseByteRange(rangeHeader, fileSize);
    if (parsedRange.kind === 'invalid') {
      await handle.close().catch(() => undefined);
      return new Response(null, {
        status: 416,
        headers: {
          'Accept-Ranges': 'bytes',
          'Content-Range': `bytes */${fileSize}`,
        },
      });
    }
    if (parsedRange.kind === 'slice') {
      const { start, end } = parsedRange;
      const chunkSize = end - start + 1;
      return new Response(streamFromHandle(handle, request.signal, start, end), {
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
  }

  if (fileSize === 0) {
    await handle.close().catch(() => undefined);
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

  return new Response(streamFromHandle(handle, request.signal), {
    status: 200,
    headers: {
      'Content-Type': contentType,
      'Accept-Ranges': 'bytes',
      'Content-Length': String(fileSize),
      'Cache-Control': 'no-store',
    },
  });
}
