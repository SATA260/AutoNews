'use client';

import { ExternalLink, History, Search } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
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

/** 已播新闻历史浏览与关键词过滤组件 */
export function HistoryManager({
  records,
  timezone,
}: {
  records: HistoryRecordView[];
  timezone: string;
}) {
  const [query, setQuery] = useState('');
  const trimmed = query.trim().toLowerCase();

  const filtered = trimmed
    ? records.filter((rec) => {
        const haystack = [rec.title, rec.entity ?? '', rec.runId, ...rec.articleUrls]
          .join(' ')
          .toLowerCase();
        return haystack.includes(trimmed);
      })
    : records;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-200/80 pb-5">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">历史已播新闻库</h1>
          <p className="mt-1 text-sm text-slate-600">
            展示最近 {records.length}{' '}
            条已发布或审核完结的播报记录（用于跨期选题防重复，删除历史任务时该库仍会保留）。
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
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {filtered.map((rec) => (
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
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
