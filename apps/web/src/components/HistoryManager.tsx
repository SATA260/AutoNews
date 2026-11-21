'use client';

import { ExternalLink, History, RotateCcw, Search } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { markHistoryUnplayedAction } from '@/app/actions';
import { formatTimestamp } from '@/lib/format';

/** 单条历史已播新闻展示数据 */
export interface HistoryRecordView {
  eventId: string;
  runId: string;
  title: string;
  titleNorm: string;
  entity: string | null;
  articleUrls: string[];
  publishedAt: string;
}

/** 提取链接主机名用于友好展示 */
function extractDomainLabel(rawUrl: string): string {
  try {
    return new URL(rawUrl).hostname.replace(/^www\./, '');
  } catch {
    return rawUrl;
  }
}

/** 已播新闻历史浏览、关键词过滤与手动标记未播组件 */
export function HistoryManager({
  records,
  timezone,
}: {
  records: HistoryRecordView[];
  timezone: string;
}) {
  const router = useRouter();
  const [query, setQuery] = useState('');
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const [feedback, setFeedback] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const trimmed = query.trim().toLowerCase();

  const filtered = trimmed
    ? records.filter((rec) => {
        const haystack = [rec.title, rec.entity ?? '', rec.runId, ...rec.articleUrls]
          .join(' ')
          .toLowerCase();
        return haystack.includes(trimmed);
      })
    : records;

  const handleMarkUnplayed = (rec: HistoryRecordView) => {
    setFeedback(null);
    setPendingId(rec.eventId);
    startTransition(async () => {
      const res = await markHistoryUnplayedAction(rec.eventId);
      setPendingId(null);
      if (res.ok) {
        setFeedback({ kind: 'ok', text: res.message ?? '已标记为未播' });
        router.refresh();
      } else {
        setFeedback({ kind: 'err', text: res.error ?? '操作失败' });
      }
    });
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-200/80 pb-5">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">历史已播新闻库</h1>
          <p className="mt-1 text-sm text-slate-600">
            展示最近 {records.length}{' '}
            条已发布或审核完结的播报记录（用于跨期选题防重复，可手动标记为未播以重新参与选题）。
          </p>
        </div>

        <div className="relative">
          <Search
            className="pointer-events-none absolute top-1/2 left-3 h-3.5 w-3.5 -translate-y-1/2 text-slate-400"
            aria-hidden="true"
          />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索标题、主体或任务号…"
            aria-label="搜索历史已播记录"
            className="w-64 rounded-xl border border-slate-300 bg-white py-2 pr-3 pl-9 text-xs text-slate-900 shadow-xs placeholder:text-slate-400 focus:border-sky-500 focus:outline-none"
          />
        </div>
      </div>

      {feedback ? (
        <div
          role={feedback.kind === 'err' ? 'alert' : 'status'}
          className={
            feedback.kind === 'ok'
              ? 'rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-2.5 text-xs text-emerald-800'
              : 'rounded-xl border border-rose-200 bg-rose-50 px-4 py-2.5 text-xs text-rose-800'
          }
        >
          {feedback.text}
        </div>
      ) : null}

      <section className="rounded-2xl border border-slate-200/90 bg-white shadow-xs">
        {filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 p-12 text-center text-sm text-slate-500">
            <History className="h-8 w-8 text-slate-300" aria-hidden="true" />
            <p>
              {records.length === 0
                ? '暂未产生已发布或审核完结的历史新闻记录。'
                : '没有符合当前关键词的已播历史记录。'}
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-slate-200 text-left text-xs">
              <thead className="bg-slate-50/80 text-slate-600">
                <tr>
                  <th className="px-4 py-3 font-medium">播报时间</th>
                  <th className="px-4 py-3 font-medium">新闻标题</th>
                  <th className="px-4 py-3 font-medium">核心主体</th>
                  <th className="px-4 py-3 font-medium">所属任务</th>
                  <th className="px-4 py-3 font-medium">参考信源链接</th>
                  <th className="px-4 py-3 text-right font-medium">操作</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {filtered.map((rec) => {
                  const isRowPending = isPending && pendingId === rec.eventId;
                  return (
                    <tr
                      key={rec.eventId}
                      className="align-top transition-colors hover:bg-slate-50/80"
                    >
                      <td className="tabular-nums whitespace-nowrap px-4 py-3 text-slate-600">
                        {formatTimestamp(rec.publishedAt, timezone)}
                      </td>
                      <td className="max-w-md px-4 py-3 font-medium text-slate-900">{rec.title}</td>
                      <td className="whitespace-nowrap px-4 py-3">
                        {rec.entity ? (
                          <span className="rounded-md bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-700">
                            {rec.entity}
                          </span>
                        ) : (
                          <span className="text-slate-400">-</span>
                        )}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 font-mono">
                        <Link
                          href={`/runs/${encodeURIComponent(rec.runId)}`}
                          className="font-medium text-sky-700 hover:underline"
                        >
                          {rec.runId}
                        </Link>
                      </td>
                      <td className="px-4 py-3">
                        <ul className="flex flex-wrap gap-1.5">
                          {rec.articleUrls.map((url) => (
                            <li key={url}>
                              <a
                                href={url}
                                target="_blank"
                                rel="noreferrer"
                                title={url}
                                className="inline-flex max-w-xs items-center gap-1 rounded-md border border-slate-200 bg-slate-50 px-2 py-0.5 font-mono text-[11px] text-sky-700 hover:border-sky-300 hover:bg-sky-50"
                              >
                                <span className="truncate">{extractDomainLabel(url)}</span>
                                <ExternalLink className="h-3 w-3 shrink-0" aria-hidden="true" />
                              </a>
                            </li>
                          ))}
                        </ul>
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 text-right">
                        <button
                          type="button"
                          disabled={isPending}
                          onClick={() => handleMarkUnplayed(rec)}
                          title="移出已播历史并将对应文章重置为待选（未播）"
                          className="inline-flex items-center gap-1 rounded-lg border border-amber-200 bg-amber-50 px-2.5 py-1 text-[11px] font-medium text-amber-800 hover:border-amber-300 hover:bg-amber-100 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          <RotateCcw className="h-3 w-3" aria-hidden="true" />
                          {isRowPending ? '处理中…' : '标为未播'}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
