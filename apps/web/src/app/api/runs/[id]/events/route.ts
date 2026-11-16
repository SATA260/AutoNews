import { getCore } from '@/lib/core';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const HEARTBEAT_INTERVAL_MS = 15_000;

/** 从请求头 `Last-Event-ID` 或查询参数 `afterId` 解析事件流断点续传游标 */
function parseAfterIdCursor(request: Request): number | null {
  const headerVal = request.headers.get('last-event-id');
  const url = new URL(request.url);
  const raw = headerVal ?? url.searchParams.get('afterId');
  if (raw === null || raw.trim() === '') {
    return 0;
  }
  if (!/^\d+$/.test(raw.trim())) {
    return null;
  }
  const num = Number.parseInt(raw.trim(), 10);
  return Number.isSafeInteger(num) && num >= 0 ? num : null;
}

/**
 * 提供单期任务实时进度日志的 Server-Sent Events（SSE）推送接口，
 * 支持通过 `Last-Event-ID` 断线续传并每 15 秒发送保活心跳注释。
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params;
  const afterId = parseAfterIdCursor(request);
  if (afterId === null) {
    return Response.json({ error: '无效的事件游标 afterId' }, { status: 400 });
  }

  const core = await getCore();
  try {
    await core.tasks.get(id);
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : `未找到任务: ${id}` },
      { status: 404 },
    );
  }

  const encoder = new TextEncoder();
  const watchCtrl = new AbortController();
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
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
  };

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
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
      request.signal.addEventListener('abort', onReqAbort, { once: true });

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
        enqueueText(': done\n\n');
        if (!closed) {
          closed = true;
          if (heartbeatTimer) {
            clearInterval(heartbeatTimer);
            heartbeatTimer = null;
          }
          controller.close();
        }
      } catch (err) {
        if (!watchCtrl.signal.aborted && !closed) {
          enqueueText(
            `event: error\ndata: ${JSON.stringify({ message: err instanceof Error ? err.message : String(err) })}\n\n`,
          );
          cleanup();
          controller.close();
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
    },
  });
}
