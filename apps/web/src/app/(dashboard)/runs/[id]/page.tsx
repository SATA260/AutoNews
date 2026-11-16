import type { QaReport, Timeline } from '@aidaily/contracts';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { PublishControls } from '@/components/PublishControls';
import { RunCancelButton } from '@/components/RunCancelAndItemActions';
import { RunItemsTab } from '@/components/run-detail/RunItemsTab';
import { RunLlmTab } from '@/components/run-detail/RunLlmTab';
import { RunMediaTab } from '@/components/run-detail/RunMediaTab';
import { RunProgressTab } from '@/components/run-detail/RunProgressTab';
import { getCore } from '@/lib/core';
import {
  formatDuration,
  formatTimestamp,
  RUN_STATUS_TEXT,
  runStatusBadgeClass,
  STAGE_LABELS,
} from '@/lib/format';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type DetailTab = 'progress' | 'items' | 'candidates' | 'media' | 'publish' | 'llm';

const TAB_ITEMS: Array<{ key: DetailTab; label: string }> = [
  { key: 'progress', label: '进度与日志' },
  { key: 'items', label: '条目与原文核对' },
  { key: 'candidates', label: '候选与替补事件' },
  { key: 'media', label: '音画预览与质检' },
  { key: 'publish', label: 'B 站审核与发布' },
  { key: 'llm', label: '模型调用明细' },
];

/** 解析并规范化任务详情页当前激活的页签名称 */
function resolveTab(rawTab: string | undefined): DetailTab {
  const matched = TAB_ITEMS.find((t) => t.key === rawTab);
  return matched ? matched.key : 'progress';
}

/** 单期任务详情页：提供进度日志、原文对照、候选替补、音画质检、发布审核与模型调用六个视图页签 */
export default async function RunDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tab?: string; callId?: string }>;
}) {
  const [{ id }, sp] = await Promise.all([params, searchParams]);
  const activeTab = resolveTab(sp.tab);

  const core = await getCore();
  const detail = await core.tasks.get(id).catch(() => null);
  if (!detail) {
    notFound();
  }

  const settings = core.config.getSettings();
  const retryOptions = await core.tasks.getRetryOptions(id);
  const isActive =
    detail.status === 'running' || detail.status === 'queued' || detail.status === 'publishing';
  const canRetryItems =
    !isActive &&
    detail.status !== 'published' &&
    detail.status !== 'abandoned' &&
    detail.status !== 'publish_uncertain';

  return (
    <div className="space-y-5">
      <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-xs">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="space-y-1.5">
            <div className="flex flex-wrap items-center gap-2.5">
              <Link href="/runs" className="text-xs text-slate-500 hover:text-slate-800">
                ← 返回任务列表
              </Link>
              <span
                className={`rounded-full border px-2.5 py-0.5 text-xs font-medium ${runStatusBadgeClass(detail.status)}`}
              >
                {RUN_STATUS_TEXT[detail.status]}
              </span>
              {detail.cancelRequested ? (
                <span className="rounded-full bg-orange-100 px-2.5 py-0.5 text-xs text-orange-800">
                  已收到取消请求
                </span>
              ) : null}
            </div>
            <h2 className="font-mono text-xl font-bold text-slate-900">{detail.id}</h2>
            <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-slate-600">
              <span>目标条数：{detail.itemCount} 条</span>
              <span>执行轮次：第 {detail.attempt} 轮</span>
              <span>
                当前步骤：{detail.currentStage ? STAGE_LABELS[detail.currentStage] : '未开始'}
              </span>
              <span>创建：{formatTimestamp(detail.createdAt, settings.timezone)}</span>
              <span>耗时：{formatDuration(detail.startedAt, detail.finishedAt)}</span>
              {detail.pid ? <span className="font-mono">进程 PID：{detail.pid}</span> : null}
            </div>
          </div>

          {isActive ? <RunCancelButton runId={detail.id} /> : null}
        </div>

        {detail.error || detail.errorCode ? (
          <div className="mt-4 rounded-lg border border-rose-200 bg-rose-50 px-3.5 py-2.5 text-xs text-rose-800">
            <span className="font-semibold">
              {detail.errorCode ? `[${detail.errorCode}] ` : ''}
            </span>
            {detail.error ?? '任务发生异常'}
          </div>
        ) : null}

        <nav
          aria-label="任务详情页签"
          className="mt-4 flex flex-wrap gap-2 border-t border-slate-100 pt-3"
        >
          {TAB_ITEMS.map((tab) => {
            const active = activeTab === tab.key;
            return (
              <Link
                key={tab.key}
                href={`/runs/${encodeURIComponent(detail.id)}?tab=${tab.key}`}
                className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
                  active
                    ? 'bg-sky-600 text-white'
                    : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
                }`}
              >
                {tab.label}
              </Link>
            );
          })}
        </nav>
      </div>

      {activeTab === 'progress'
        ? await (async () => {
            const runEvents = await core.tasks.events(detail.id, 0, 300);
            return (
              <RunProgressTab
                detail={detail}
                retryOptions={retryOptions}
                runEvents={runEvents}
                isActive={isActive}
                timezone={settings.timezone}
              />
            );
          })()
        : null}

      {activeTab === 'items'
        ? await (async () => {
            const [articles, historyPairs] = await Promise.all([
              core.tasks.getRunArticles(detail.id),
              Promise.all(
                detail.items.map(
                  async (item) => [item.id, await core.tasks.getItemHistory(item.id)] as const,
                ),
              ),
            ]);
            const versionsByItemId = Object.fromEntries(historyPairs);
            return (
              <RunItemsTab
                detail={detail}
                articles={articles}
                versionsByItemId={versionsByItemId}
                canRetryItems={canRetryItems}
                timezone={settings.timezone}
              />
            );
          })()
        : null}

      {activeTab === 'candidates' ? (
        <section className="rounded-xl border border-slate-200 bg-white shadow-xs">
          <div className="border-b border-slate-100 px-5 py-3.5">
            <h3 className="text-sm font-semibold text-slate-900">
              候选新闻事件与替补队列（共 {detail.events.length} 个主题事件）
            </h3>
          </div>
          {detail.events.length === 0 ? (
            <div className="p-8 text-center text-sm text-slate-500">尚未生成聚类候选事件。</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-slate-200 text-left text-xs">
                <thead className="bg-slate-50 text-slate-600">
                  <tr>
                    <th className="px-3 py-2.5 font-medium">顺位</th>
                    <th className="px-3 py-2.5 font-medium">队列分工</th>
                    <th className="px-3 py-2.5 font-medium">事件标题</th>
                    <th className="px-3 py-2.5 font-medium">分类 / 主体</th>
                    <th className="px-3 py-2.5 font-medium">综合评分 / 受众度</th>
                    <th className="px-3 py-2.5 font-medium">关联原文数</th>
                    <th className="px-3 py-2.5 font-medium">补位轮次</th>
                    <th className="px-3 py-2.5 font-medium">入选说明</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {detail.events.map((ev) => (
                    <tr key={ev.id} className="hover:bg-slate-50">
                      <td className="px-3 py-2.5 font-mono text-slate-900">#{ev.rank}</td>
                      <td className="px-3 py-2.5">
                        <span
                          className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${
                            ev.role === 'primary'
                              ? 'bg-sky-100 text-sky-800'
                              : 'bg-slate-100 text-slate-700'
                          }`}
                        >
                          {ev.role === 'primary' ? '主选' : '替补'}
                        </span>
                      </td>
                      <td className="px-3 py-2.5 font-medium text-slate-900">{ev.title}</td>
                      <td className="px-3 py-2.5 text-slate-600">
                        {ev.category ?? '-'} / {ev.entity ?? '-'}
                      </td>
                      <td className="px-3 py-2.5 font-mono text-slate-700">
                        {ev.score.toFixed(1)} /{' '}
                        {ev.publicAppeal !== null ? ev.publicAppeal.toFixed(1) : '-'}
                      </td>
                      <td className="px-3 py-2.5 text-slate-700">{ev.articleIds.length} 篇</td>
                      <td className="px-3 py-2.5 text-slate-700">第 {ev.refillRound} 轮</td>
                      <td className="max-w-xs px-3 py-2.5 text-slate-600">{ev.reason ?? '-'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      ) : null}

      {activeTab === 'media'
        ? await (async () => {
            const [qaReport, timeline] = await Promise.all([
              core.tasks.readArtifactJson<QaReport>(detail.id, 'qa.json').catch(() => null),
              core.tasks.readArtifactJson<Timeline>(detail.id, 'timeline.json').catch(() => null),
            ]);
            return (
              <RunMediaTab
                runId={detail.id}
                artifacts={detail.artifacts}
                qaReport={qaReport}
                timeline={timeline}
                timezone={settings.timezone}
              />
            );
          })()
        : null}

      {activeTab === 'publish'
        ? await (async () => {
            const draft = await core.publish.getDraft(detail.id).catch(() => null);
            return (
              <PublishControls
                runId={detail.id}
                runStatus={detail.status}
                draft={draft}
                publishRecord={detail.publishRecord}
                limits={{
                  titleMax: settings.publish.bilibili.titleMax,
                  descMax: settings.publish.bilibili.descMax,
                  tagsMax: settings.publish.bilibili.tagsMax,
                }}
              />
            );
          })()
        : null}

      {activeTab === 'llm'
        ? await (async () => {
            const calls = await core.tasks.getLlmCalls(detail.id);
            const rawCallId = sp.callId?.trim() ?? '';
            const parsedCallId =
              /^[1-9]\d*$/.test(rawCallId) && Number.isSafeInteger(Number(rawCallId))
                ? Number.parseInt(rawCallId, 10)
                : null;
            const selectedCallLog =
              parsedCallId !== null
                ? await core.tasks.getLlmCallLog(detail.id, parsedCallId).catch(() => null)
                : null;
            return (
              <RunLlmTab
                runId={detail.id}
                calls={calls}
                selectedCallId={parsedCallId}
                selectedCallLog={selectedCallLog}
                timezone={settings.timezone}
              />
            );
          })()
        : null}
    </div>
  );
}
