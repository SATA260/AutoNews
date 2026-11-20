import { NotFoundError } from '@aidaily/core';
import { getCore } from '@/lib/core';
import { verifyLocalWebRequest } from '@/lib/request-security';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const HEARTBEAT_INTERVAL_MS = 15_000;

/** 从请求头 `Last-Event-ID` 或查询参数 `afterId` 严格解析安全范围内的事件游标 */
function parseAfterIdCursor(request: Request): number | null {
  const headerVal = request.headers.get('last-event-id');
  const url = new URL(request.url);
  const raw = headerVal ?? url.searchParams.get('afterId');
  if (raw === null || raw.trim() === '') {
    return 0;
  }
  const trimmed = raw.trim();
  if (!/^(?:0|[1-9]\d*)$/.test(trimmed)) {
    return null;
  }
  const num = Number.parseInt(trimmed, 10);
  return Number.isSafeInteger(num) && String(num) === trimmed ? num : null;
}

/**
 * 提供单期任务实时进度日志的 Server-Sent Events（SSE）推送接口，
 * 建连时立即写出首帧，支持通过 `Last-Event-ID` 断线续传并每 15 秒发送保活注释。
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const sec = verifyLocalWebRequest(request);
  if (!sec.ok) {
    return Response.json({ error: sec.error }, { status: sec.status });
  }

  const { id } = await context.params;
  const afterId = parseAfterIdCursor(request);
  if (afterId === null) {
    return Response.json({ error: '无效的事件游标 afterId' }, { status: 400 });
  }

  const core = await getCore();
  try {
    await core.tasks.getSummary(id);
  } catch (err) {
    if (err instanceof NotFoundError) {
      return Response.json({ error: err.message }, { status: 404 });
    }
    throw err;
  }

  const encoder = new TextEncoder();
  const watchCtrl = new AbortController();
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let streamCtrl: ReadableStreamDefaultController<Uint8Array> | null = null;
  let closed = false;

  const cleanup = () => {
    if (closed) {
      return;
    }
    closed = true;
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    watchCtrl.abort();
    if (streamCtrl) {
      try {
        streamCtrl.close();
      } catch {
        // 读取端已取消或流已关闭时忽略重复关闭异常
      }
      streamCtrl = null;
    }
  };

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      streamCtrl = controller;
      const enqueueText = (payload: string) => {
        if (closed || watchCtrl.signal.aborted) {
          return;
        }
        try {
          controller.enqueue(encoder.encode(payload));
        } catch {
          cleanup();
        }
      };

      const onReqAbort = () => {
        cleanup();
      };
      if (request.signal.aborted) {
        cleanup();
        return;
      }
      request.signal.addEventListener('abort', onReqAbort, { once: true });

      enqueueText(': connected\n\n');
      heartbeatTimer = setInterval(() => {
        enqueueText(': heartbeat\n\n');
      }, HEARTBEAT_INTERVAL_MS);

      try {
        await core.tasks.watch(
          id,
          (ev) => {
            enqueueText(`id: ${ev.id}\nevent: run_event\ndata: ${JSON.stringify(ev)}\n\n`);
          },
          watchCtrl.signal,
          { afterId, pollMs: 200 },
        );
        enqueueText('event: done\ndata: {"done":true}\n\n: done\n\n');
      } catch (err) {
        if (!watchCtrl.signal.aborted && !closed) {
          enqueueText(
            `event: error\ndata: ${JSON.stringify({ message: err instanceof Error ? err.message : String(err) })}\n\n`,
          );
        }
      } finally {
        request.signal.removeEventListener('abort', onReqAbort);
        cleanup();
      }
    },
    cancel() {
      cleanup();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
