'use client';

import type { RunEvent } from '@aidaily/contracts';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';

/** 触发页面刷新的关键阶段与终态事件类型集合 */
const REFRESH_TRIGGER_EVENTS = new Set<string>([
  'stage_done',
  'awaiting_audio_review',
  'awaiting_review',
  'run_revived',
  'section_narration_updated',
  'run_failed',
  'run_cancelled',
  'run_skipped',
  'run_abandoned',
  'run_interrupted',
  'run_rejected',
  'run_consumed_only',
  'run_published',
  'publish_failed',
  'publish_uncertain',
]);

/** 实时展示并自动跟踪单期任务事件流的客户端面板组件 */
export function RunLiveLogPanel({
  runId,
  initialEvents,
  isActive,
}: {
  runId: string;
  initialEvents: RunEvent[];
  isActive: boolean;
}) {
  const router = useRouter();
  const [events, setEvents] = useState<RunEvent[]>(initialEvents);
  const [connected, setConnected] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const lastIdRef = useRef<number>(
    initialEvents.length > 0 ? (initialEvents[initialEvents.length - 1]?.id ?? 0) : 0,
  );

  useEffect(() => {
    setEvents(initialEvents);
    lastIdRef.current =
      initialEvents.length > 0 ? (initialEvents[initialEvents.length - 1]?.id ?? 0) : 0;
  }, [initialEvents]);

  useEffect(() => {
    if (!isActive) {
      setConnected(false);
      return;
    }

    const afterId = lastIdRef.current;
    const source = new EventSource(
      `/api/runs/${encodeURIComponent(runId)}/events?afterId=${afterId}`,
    );

    const onOpen = () => {
      setConnected(true);
    };
    const onRunEvent = (msg: MessageEvent<string>) => {
      try {
        const parsed = JSON.parse(msg.data) as RunEvent;
        lastIdRef.current = Math.max(lastIdRef.current, parsed.id);
        setEvents((prev) => {
          if (prev.some((existing) => existing.id === parsed.id)) {
            return prev;
          }
          return [...prev, parsed];
        });
        if (REFRESH_TRIGGER_EVENTS.has(parsed.type)) {
          router.refresh();
        }
      } catch {
        // 忽略格式异常的单条推送数据
      }
    };
    const onDone = () => {
      setConnected(false);
      source.close();
      router.refresh();
    };
    const onError = () => {
      setConnected(false);
    };

    source.addEventListener('open', onOpen);
    source.addEventListener('run_event', onRunEvent as EventListener);
    source.addEventListener('done', onDone);
    source.addEventListener('error', onError);

    return () => {
      setConnected(false);
      source.removeEventListener('open', onOpen);
      source.removeEventListener('run_event', onRunEvent as EventListener);
      source.removeEventListener('done', onDone);
      source.removeEventListener('error', onError);
      source.close();
    };
  }, [runId, isActive, router]);

  useEffect(() => {
    const el = containerRef.current;
    if (el) {
      el.dataset.eventCount = String(events.length);
      el.scrollTop = el.scrollHeight;
    }
  }, [events.length]);

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex items-center justify-between border-b border-slate-100 pb-3">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold text-slate-900">实时运行日志</h3>
          {isActive ? (
            <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
              {connected ? '实时连接中' : '等待推送'}
            </span>
          ) : (
            <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600">
              已停止实时推送
            </span>
          )}
        </div>
        <span className="text-xs text-slate-500">共 {events.length} 条事件</span>
      </div>

      <div
        ref={containerRef}
        className="mt-3 max-h-80 overflow-y-auto rounded-lg bg-slate-950 p-3 font-mono text-xs leading-6 text-slate-100"
      >
        {events.length === 0 ? (
          <p className="text-slate-400">暂无日志记录。</p>
        ) : (
          events.map((ev) => {
            const levelColor =
              ev.level === 'error'
                ? 'text-rose-400'
                : ev.level === 'warn'
                  ? 'text-amber-300'
                  : 'text-sky-300';
            return (
              <div key={ev.id} className="break-words">
                <span className="text-slate-500">{ev.ts.slice(11, 19)}</span>{' '}
                <span className={levelColor}>[{ev.level}]</span>{' '}
                {ev.stage && <span className="text-indigo-300">[{ev.stage}]</span>}{' '}
                {ev.itemId && <span className="text-teal-300">({ev.itemId})</span>}{' '}
                <span>{ev.message}</span>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
