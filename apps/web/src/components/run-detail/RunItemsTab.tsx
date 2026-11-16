import type { ItemVersion, ItemVersionKind, RunDetail } from '@aidaily/contracts';
import type { RunArticleWithContent } from '@aidaily/core';
import { RetryItemForm } from '@/components/RunCancelAndItemActions';
import { formatTimestamp, ITEM_STATUS_TEXT } from '@/lib/format';

/** 条目与原文核对页签组件的参数定义 */
export interface RunItemsTabProps {
  detail: RunDetail;
  articles: RunArticleWithContent[];
  versionsByItemId: Record<string, ItemVersion[]>;
  canRetryItems: boolean;
  timezone: string;
}

const VERSION_KIND_TEXT: Record<ItemVersionKind, string> = {
  summary: '通俗总结',
  polish: '口播润色',
  revise: '打回微调',
  precheck: '本地预检',
  factcheck: '独立事实核查',
};

/** 条目与原文核对页签：逐条对照最终定稿、逐句口播稿、原文章全文以及每轮润色与核查历史记录 */
export function RunItemsTab({
  detail,
  articles,
  versionsByItemId,
  canRetryItems,
  timezone,
}: RunItemsTabProps) {
  const eventById = new Map(detail.events.map((ev) => [ev.id, ev]));
  const articleById = new Map(articles.map((art) => [art.id, art]));

  const sortedItems = [...detail.items].sort((a, b) => {
    const posDiff =
      (a.position ?? Number.MAX_SAFE_INTEGER) - (b.position ?? Number.MAX_SAFE_INTEGER);
    return posDiff !== 0 ? posDiff : a.id.localeCompare(b.id);
  });

  if (sortedItems.length === 0) {
    return (
      <div className="rounded-xl border border-slate-200 bg-white p-8 text-center text-sm text-slate-500">
        当前任务尚未生成新闻稿件条目。
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {sortedItems.map((item) => {
        const event = eventById.get(item.eventId);
        const relatedArticleIds = Array.from(
          new Set([
            ...(event?.articleIds ?? []),
            ...(item.finalJson?.evidence.map((e) => e.articleId) ?? []),
          ]),
        );
        const relatedArticles = relatedArticleIds
          .map((artId) => articleById.get(artId))
          .filter((art): art is RunArticleWithContent => Boolean(art));
        const versions = versionsByItemId[item.id] ?? [];

        return (
          <article
            key={item.id}
            className="space-y-4 rounded-xl border border-slate-200 bg-white p-5 shadow-xs"
          >
            <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-100 pb-3">
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="rounded bg-slate-100 px-2 py-0.5 font-mono text-xs font-semibold text-slate-700">
                    {item.position !== null ? `#${item.position}` : '未编排位置'}
                  </span>
                  <span
                    className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${
                      item.status === 'passed'
                        ? 'bg-emerald-100 text-emerald-800'
                        : item.status === 'dropped'
                          ? 'bg-rose-100 text-rose-800'
                          : 'bg-sky-100 text-sky-800'
                    }`}
                  >
                    {ITEM_STATUS_TEXT[item.status]}
                  </span>
                  {item.revision > 0 ? (
                    <span className="rounded-full bg-amber-100 px-2.5 py-0.5 text-xs text-amber-800">
                      微调修订 {item.revision} 次
                    </span>
                  ) : null}
                  {event && event.refillRound > 0 ? (
                    <span className="rounded-full bg-indigo-100 px-2.5 py-0.5 text-xs text-indigo-800">
                      第 {event.refillRound} 轮替补入围
                    </span>
                  ) : null}
                  <span className="font-mono text-[11px] text-slate-400">{item.id}</span>
                </div>
                <h3 className="mt-2 text-base font-semibold text-slate-900">
                  {item.finalJson?.title ?? event?.title ?? item.eventId}
                </h3>
              </div>

              <span className="text-xs text-slate-500">
                更新时间：{formatTimestamp(item.updatedAt, timezone)}
              </span>
            </div>

            {item.dropReason ? (
              <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-800">
                剔除说明：{item.dropReason}
              </div>
            ) : null}

            {item.finalJson ? (
              <div className="grid gap-4 lg:grid-cols-2">
                <div className="space-y-2 text-xs text-slate-700">
                  <div className="flex flex-wrap gap-2 text-[11px]">
                    <span className="rounded bg-slate-100 px-2 py-0.5">
                      简题：{item.finalJson.shortTitle}
                    </span>
                    <span className="rounded bg-slate-100 px-2 py-0.5">
                      分类：{item.finalJson.category}
                    </span>
                    <span className="rounded bg-slate-100 px-2 py-0.5">
                      主体：{item.finalJson.entity}
                    </span>
                  </div>
                  <p className="font-medium text-slate-900">概要：{item.finalJson.summary}</p>
                  <div>
                    <p className="font-medium text-slate-800">核心要点：</p>
                    <ul className="mt-1 list-disc space-y-0.5 pl-4">
                      {item.finalJson.keyPoints.map((kp) => (
                        <li key={kp}>{kp}</li>
                      ))}
                    </ul>
                  </div>
                  <p className="leading-relaxed text-slate-700">详述：{item.finalJson.detail}</p>
                  <p className="rounded-md bg-sky-50 px-3 py-2 text-sky-900">
                    主持人点评：{item.finalJson.hostComment}
                  </p>
                  {item.finalJson.officialQuote ? (
                    <p className="rounded-md bg-slate-50 px-3 py-2 italic text-slate-700">
                      原文摘录：“{item.finalJson.officialQuote}”
                    </p>
                  ) : null}
                  {item.finalJson.metrics && item.finalJson.metrics.length > 0 ? (
                    <div className="flex flex-wrap gap-2 pt-1">
                      {item.finalJson.metrics.map((metric) => (
                        <span
                          key={`${metric.label}-${metric.value}`}
                          className="rounded border border-slate-200 bg-slate-50 px-2 py-1 text-[11px]"
                        >
                          {metric.label}：<strong>{metric.value}</strong>
                        </span>
                      ))}
                    </div>
                  ) : null}
                </div>

                <div className="space-y-3 text-xs">
                  <div>
                    <h4 className="font-medium text-slate-800">逐句口播文本（用于配音和字幕）</h4>
                    <ol className="mt-1.5 list-decimal space-y-1 rounded-lg border border-slate-200 bg-slate-50 p-3 pl-7 text-slate-700">
                      {(() => {
                        const seenLines = new Map<string, number>();
                        return item.finalJson.narration.map((line) => {
                          const count = (seenLines.get(line) ?? 0) + 1;
                          seenLines.set(line, count);
                          return <li key={`${item.id}-${line}-${count}`}>{line}</li>;
                        });
                      })()}
                    </ol>
                  </div>

                  <div>
                    <h4 className="font-medium text-slate-800">
                      引用证据对照（{item.finalJson.evidence.length} 项）
                    </h4>
                    <ul className="mt-1.5 space-y-1.5">
                      {(() => {
                        const seenEv = new Map<string, number>();
                        return item.finalJson.evidence.map((ev) => {
                          const baseKey = `${ev.articleId}-${ev.claim}-${ev.quote}`;
                          const count = (seenEv.get(baseKey) ?? 0) + 1;
                          seenEv.set(baseKey, count);
                          const matched = articleById.get(ev.articleId);
                          return (
                            <li
                              key={`${baseKey}-${count}`}
                              className="rounded-lg border border-slate-200 bg-white p-2.5 text-[11px] text-slate-700"
                            >
                              <div className="font-medium text-slate-900">{ev.claim}</div>
                              <div className="mt-1 text-slate-600">原文出处：“{ev.quote}”</div>
                              <div className="mt-1 text-slate-400">
                                来源文章：
                                {matched ? (
                                  <a
                                    href={matched.canonicalUrl}
                                    target="_blank"
                                    rel="noreferrer"
                                    className="text-sky-700 hover:underline"
                                  >
                                    {matched.title}
                                  </a>
                                ) : (
                                  ev.articleId
                                )}
                              </div>
                            </li>
                          );
                        });
                      })()}
                    </ul>
                  </div>
                </div>
              </div>
            ) : null}

            <div className="space-y-2 border-t border-slate-100 pt-3">
              <details className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs">
                <summary className="cursor-pointer font-medium text-slate-800">
                  查看关联原文与提取正文（{relatedArticles.length} 篇）
                </summary>
                <div className="mt-3 space-y-3">
                  {relatedArticles.length === 0 ? (
                    <p className="text-slate-500">未检索到关联原文记录。</p>
                  ) : (
                    relatedArticles.map((art) => (
                      <div
                        key={art.id}
                        className="rounded-lg border border-slate-200 bg-white p-3 text-xs"
                      >
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <a
                            href={art.canonicalUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="font-semibold text-sky-700 hover:underline"
                          >
                            {art.title}
                          </a>
                          <span className="font-mono text-[11px] text-slate-500">
                            {art.sourceId} · 提取：{art.extractStatus}
                          </span>
                        </div>
                        <pre className="mt-2 max-h-60 overflow-y-auto whitespace-pre-wrap rounded bg-slate-50 p-2.5 text-[11px] leading-relaxed text-slate-700">
                          {art.contentText ?? art.excerpt ?? '暂无提取正文，仅存摘要。'}
                        </pre>
                      </div>
                    ))
                  )}
                </div>
              </details>

              <details className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs">
                <summary className="cursor-pointer font-medium text-slate-800">
                  查看各轮改稿与核查历史记录（{versions.length} 条）
                </summary>
                <div className="mt-3 space-y-2">
                  {versions.length === 0 ? (
                    <p className="text-slate-500">暂无中间版本快照。</p>
                  ) : (
                    versions.map((ver) => (
                      <div key={ver.id} className="rounded border border-slate-200 bg-white p-2.5">
                        <div className="flex items-center justify-between text-[11px] text-slate-600">
                          <span className="font-semibold text-slate-800">
                            {VERSION_KIND_TEXT[ver.kind]} · 第 {ver.round} 轮
                          </span>
                          <span>{formatTimestamp(ver.createdAt, timezone)}</span>
                        </div>
                        <pre className="mt-1.5 max-h-56 overflow-y-auto whitespace-pre-wrap rounded bg-slate-900 p-2 font-mono text-[11px] text-slate-100">
                          {JSON.stringify(ver.payload, null, 2)}
                        </pre>
                      </div>
                    ))
                  )}
                </div>
              </details>

              {canRetryItems ? <RetryItemForm runId={detail.id} itemId={item.id} /> : null}
            </div>
          </article>
        );
      })}
    </div>
  );
}
