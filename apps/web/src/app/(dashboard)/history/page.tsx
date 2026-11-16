import Link from 'next/link';
import { getCore } from '@/lib/core';
import { formatTimestamp } from '@/lib/format';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** 历史已播库查询页：按播报时间倒序展示已确认发布或本地完结的历史事件，用于选题防重复 */
export default async function HistoryPage() {
  const core = await getCore();
  const settings = core.config.getSettings();
  const records = await core.publish.listHistory(100);

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-xl font-bold text-slate-900">历史已播新闻库</h2>
        <p className="mt-1 text-xs text-slate-600">
          展示最近 {records.length} 条已归档播出记录（用于防止短期内重复播报相同资讯）。
        </p>
      </div>

      <section className="rounded-xl border border-slate-200 bg-white shadow-xs">
        {records.length === 0 ? (
          <div className="p-10 text-center text-sm text-slate-500">
            暂未产生已发布或仅本地完结的历史新闻记录。
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-slate-200 text-left text-xs">
              <thead className="bg-slate-50 text-slate-600">
                <tr>
                  <th className="px-4 py-2.5 font-medium">播报时间</th>
                  <th className="px-4 py-2.5 font-medium">新闻标题</th>
                  <th className="px-4 py-2.5 font-medium">核心主体</th>
                  <th className="px-4 py-2.5 font-medium">所属任务</th>
                  <th className="px-4 py-2.5 font-medium">参考信源链接</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {records.map((rec) => (
                  <tr key={rec.eventId} className="hover:bg-slate-50">
                    <td className="whitespace-nowrap px-4 py-2.5 text-slate-600">
                      {formatTimestamp(rec.publishedAt, settings.timezone)}
                    </td>
                    <td className="px-4 py-2.5 font-medium text-slate-900">{rec.title}</td>
                    <td className="px-4 py-2.5 text-slate-600">{rec.entity ?? '-'}</td>
                    <td className="whitespace-nowrap px-4 py-2.5 font-mono">
                      <Link
                        href={`/runs/${encodeURIComponent(rec.runId)}`}
                        className="text-sky-700 hover:underline"
                      >
                        {rec.runId}
                      </Link>
                    </td>
                    <td className="px-4 py-2.5">
                      <ul className="space-y-0.5">
                        {rec.articleUrls.map((url) => (
                          <li key={url}>
                            <a
                              href={url}
                              target="_blank"
                              rel="noreferrer"
                              className="inline-block max-w-sm truncate font-mono text-[11px] text-sky-700 hover:underline"
                            >
                              {url}
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
