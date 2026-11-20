import { PIPELINE_STAGES, type RunEvent, type Trigger } from '@aidaily/contracts';
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Clock,
  Cpu,
  Newspaper,
  Radio,
  Rss,
} from 'lucide-react';
import Link from 'next/link';
import { RunCancelButton } from '@/components/RunCancelAndItemActions';
import { RunLiveLogPanel } from '@/components/RunLiveLogPanel';
import { StartRunModalButton } from '@/components/StartRunModalButton';
import { getCore } from '@/lib/core';
import {
  formatDuration,
  formatTimestamp,
  RUN_STATUS_TEXT,
  runStatusBadgeClass,
  STAGE_LABELS,
  STAGE_STATUS_TEXT,
} from '@/lib/format';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const TRIGGER_TEXT: Record<Trigger, string> = {
  'manual-cli': '命令行触发',
  'manual-web': '网页后台触发',
  schedule: '定时任务触发',
};

/** 管理后台总览页：展示实时运行进度、待处理提醒、全盘关键指标及最近期次记录 */
export default async function DashboardPage() {
  const core = await getCore();
  const settings = core.config.getSettings();
  const bgmFiles = await core.tasks.listBgm();
  const [recentRuns, sourceHealth, schedules, articleOverview] = await Promise.all([
    core.tasks.list({ limit: 10 }),
    core.sources.list(),
    core.scheduler.list(),
    core.articles.list({ page: 1, pageSize: 1 }),
  ]);

  const activeRunSummary = recentRuns.find(
    (r) => r.status === 'running' || r.status === 'queued' || r.status === 'publishing',
  );
  const [activeDetail, activeEvents] = activeRunSummary
    ? await Promise.all([
        core.tasks.get(activeRunSummary.id, { includeArtifacts: false }).catch(() => null),
        core.tasks.recentEvents(activeRunSummary.id, 200).catch((): RunEvent[] => []),
      ])
    : [null, [] as RunEvent[]];

  const reviewPendingRuns = recentRuns.filter(
    (r) =>
      r.status === 'awaiting_audio_review' ||
      r.status === 'awaiting_review' ||
      r.status === 'publish_uncertain',
  );
  const failedRuns = recentRuns.filter(
    (r) => r.status === 'failed' || r.status === 'interrupted' || r.status === 'publish_failed',
  );

  const enabledSources = sourceHealth.filter((s) => s.source.enabled);
  const unhealthySources = enabledSources.filter((s) => !s.healthy);
  const healthySourceCount = enabledSources.length - unhealthySources.length;
  const enabledSchedules = schedules.filter((j) => j.enabled);
  const { statusCounts } = articleOverview;
  const publishedCount = recentRuns.filter((r) => r.status === 'published').length;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-200/80 pb-5">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-bold tracking-tight text-slate-900">控制台总览</h1>
            <span className="rounded-full border border-slate-200 bg-white px-2.5 py-0.5 text-xs font-medium text-slate-600">
              时区：{settings.timezone}
            </span>
          </div>
          <p className="mt-1 text-sm text-slate-600">
            实时掌握新闻抓取池、当期视频生成进度、待审稿件与每日定时调度状态。
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          <Link
            href="/articles"
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-sm font-medium text-slate-700 shadow-xs transition hover:bg-slate-50"
          >
            <Newspaper className="h-4 w-4 text-slate-500" aria-hidden="true" />
            <span>浏览爬取新闻</span>
          </Link>
          <StartRunModalButton bgmFiles={bgmFiles} label="手动启动一期任务" />
        </div>
      </div>

      {reviewPendingRuns.length > 0 && (
        <div className="rounded-2xl border border-amber-300 bg-gradient-to-r from-amber-50 to-orange-50/70 p-4 shadow-xs">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-start gap-3">
              <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-amber-100 text-amber-700">
                <CheckCircle2 className="h-4.5 w-4.5" aria-hidden="true" />
              </span>
              <div>
                <h2 className="text-sm font-semibold text-amber-950">
                  有 {reviewPendingRuns.length} 期任务等待试听配音、人工审核或确认投稿结果
                </h2>
                <p className="mt-0.5 text-xs text-amber-800">
                  可直接核对成片画质与简介文案后一键投稿 B
                  站，或点击「审核通过（不上传视频）」仅本地完结。
                </p>
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              {reviewPendingRuns.map((run) => {
                const targetTab = run.status === 'awaiting_audio_review' ? 'media' : 'publish';
                return (
                  <Link
                    key={run.id}
                    href={`/runs/${run.id}?tab=${targetTab}`}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-amber-600 px-3.5 py-2 text-xs font-medium text-white shadow-xs transition hover:bg-amber-700"
                  >
                    <span>
                      处理 {run.id}（{RUN_STATUS_TEXT[run.status]}）
                    </span>
                    <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
                  </Link>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {failedRuns.length > 0 && (
        <div className="rounded-2xl border border-rose-200 bg-rose-50/90 p-4 shadow-xs">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2.5 text-xs font-medium text-rose-900">
              <AlertTriangle className="h-4 w-4 shrink-0 text-rose-600" aria-hidden="true" />
              <span>
                最近有 {failedRuns.length}{' '}
                期任务处于异常或中断状态，可进入详情从断点继续或从任意步骤重跑：
              </span>
            </div>
            <div className="flex flex-wrap gap-2">
              {failedRuns.slice(0, 3).map((run) => (
                <Link
                  key={run.id}
                  href={`/runs/${run.id}`}
                  className="rounded-lg border border-rose-300 bg-white px-2.5 py-1 text-xs font-medium text-rose-700 transition hover:bg-rose-100"
                >
                  {run.id}（{RUN_STATUS_TEXT[run.status]}）
                </Link>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* 核心运营指标卡片 */}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <div className="rounded-2xl border border-slate-200/90 bg-white p-5 shadow-xs">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-slate-500">近期任务概览</span>
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-sky-50 text-sky-600">
              <Activity className="h-4 w-4" aria-hidden="true" />
            </span>
          </div>
          <div className="mt-3 flex items-baseline gap-2">
            <span className="tabular-nums text-2xl font-bold text-slate-900">
              {activeRunSummary ? '1 运行中' : `${publishedCount} 已完成`}
            </span>
            <span className="text-xs text-slate-500">/ 近 {recentRuns.length} 期</span>
          </div>
          <div className="mt-3 flex items-center justify-between border-t border-slate-100 pt-2.5 text-xs">
            <span className="text-slate-500">
              待审 {reviewPendingRuns.length} · 异常 {failedRuns.length}
            </span>
            <Link href="/runs" className="font-medium text-sky-700 hover:underline">
              任务列表 →
            </Link>
          </div>
        </div>

        <div className="rounded-2xl border border-slate-200/90 bg-white p-5 shadow-xs">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-slate-500">爬取新闻候选池</span>
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-indigo-50 text-indigo-600">
              <Newspaper className="h-4 w-4" aria-hidden="true" />
            </span>
          </div>
          <div className="mt-3 flex items-baseline gap-2">
            <span className="tabular-nums text-2xl font-bold text-slate-900">
              {statusCounts.new}
            </span>
            <span className="text-xs text-slate-500">篇待选新闻</span>
          </div>
          <div className="mt-3 flex items-center justify-between border-t border-slate-100 pt-2.5 text-xs">
            <span className="text-slate-500">
              占用 {statusCounts.reserved} · 已播 {statusCounts.consumed}
            </span>
            <Link href="/articles" className="font-medium text-sky-700 hover:underline">
              查看与清理 →
            </Link>
          </div>
        </div>

        <div className="rounded-2xl border border-slate-200/90 bg-white p-5 shadow-xs">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-slate-500">信源抓取健康</span>
            <span
              className={`flex h-8 w-8 items-center justify-center rounded-lg ${
                unhealthySources.length > 0
                  ? 'bg-rose-50 text-rose-600'
                  : 'bg-emerald-50 text-emerald-600'
              }`}
            >
              <Rss className="h-4 w-4" aria-hidden="true" />
            </span>
          </div>
          <div className="mt-3 flex items-baseline gap-2">
            <span className="tabular-nums text-2xl font-bold text-slate-900">
              {healthySourceCount}
            </span>
            <span className="text-xs text-slate-500">/ {enabledSources.length} 已启用信源正常</span>
          </div>
          <div className="mt-3 flex items-center justify-between border-t border-slate-100 pt-2.5 text-xs">
            <span
              className={
                unhealthySources.length > 0 ? 'truncate text-rose-600' : 'truncate text-emerald-700'
              }
            >
              {unhealthySources.length > 0
                ? `异常：${unhealthySources.map((s) => s.source.name).join('、')}`
                : '全部已启用信源正常'}
            </span>
            <Link href="/sources" className="shrink-0 font-medium text-sky-700 hover:underline">
              管理信源 →
            </Link>
          </div>
        </div>

        <div className="rounded-2xl border border-slate-200/90 bg-white p-5 shadow-xs">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-slate-500">每日定时调度</span>
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-amber-50 text-amber-600">
              <Clock className="h-4 w-4" aria-hidden="true" />
            </span>
          </div>
          <div className="mt-3 flex items-baseline gap-2">
            <span className="tabular-nums text-2xl font-bold text-slate-900">
              {enabledSchedules.length}
            </span>
            <span className="text-xs text-slate-500">/ {schedules.length} 项计划启用中</span>
          </div>
          <div className="mt-3 flex items-center justify-between gap-2 border-t border-slate-100 pt-2.5 text-xs">
            <span className="truncate text-slate-500">
              {enabledSchedules[0]
                ? `下次：${formatTimestamp(enabledSchedules[0].nextRunAt, settings.timezone)}`
                : '暂未启用每日定时'}
            </span>
            <Link href="/schedules" className="shrink-0 font-medium text-sky-700 hover:underline">
              管理定时 →
            </Link>
          </div>
        </div>
      </div>

      {activeDetail && (
        <section className="space-y-4 rounded-2xl border border-sky-200 bg-white p-5 shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 pb-3.5">
            <div className="flex flex-wrap items-center gap-2.5">
              <span className="inline-flex items-center gap-1.5 rounded-full border border-sky-200 bg-sky-50 px-2.5 py-0.5 text-xs font-medium text-sky-700">
                <Radio className="h-3.5 w-3.5 animate-pulse" aria-hidden="true" />
                {RUN_STATUS_TEXT[activeDetail.status]}
              </span>
              <Link
                href={`/runs/${activeDetail.id}`}
                className="font-mono text-sm font-semibold text-slate-900 hover:text-sky-700 hover:underline"
              >
                {activeDetail.id}
              </Link>
              <span className="text-xs text-slate-500">
                目标 {activeDetail.itemCount} 条 · 第 {activeDetail.attempt} 轮执行
              </span>
            </div>
            <div className="flex items-center gap-3">
              <Link
                href={`/runs/${activeDetail.id}`}
                className="rounded-lg border border-sky-200 bg-sky-50 px-3 py-1.5 text-xs font-medium text-sky-700 hover:bg-sky-100"
              >
                打开任务详情 →
              </Link>
              <RunCancelButton runId={activeDetail.id} />
            </div>
          </div>

          <div className="grid grid-cols-3 gap-2 sm:grid-cols-5 lg:grid-cols-9">
            {PIPELINE_STAGES.map((stage, idx) => {
              const rec = activeDetail.stages.find((s) => s.stage === stage);
              const status = rec?.status ?? 'pending';
              const tone =
                status === 'done'
                  ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
                  : status === 'running'
                    ? 'border-sky-300 bg-sky-50 text-sky-900 ring-1 ring-sky-200'
                    : status === 'failed' || status === 'interrupted'
                      ? 'border-rose-200 bg-rose-50 text-rose-800'
                      : 'border-slate-200 bg-slate-50 text-slate-600';

              return (
                <div key={stage} className={`rounded-xl border px-3 py-2 text-xs ${tone}`}>
                  <div className="font-semibold">
                    {idx + 1}. {STAGE_LABELS[stage]}
                  </div>
                  <div className="mt-0.5 text-[11px] opacity-85">{STAGE_STATUS_TEXT[status]}</div>
                </div>
              );
            })}
          </div>

          <RunLiveLogPanel
            runId={activeDetail.id}
            initialEvents={activeEvents}
            isActive={
              activeDetail.status === 'running' ||
              activeDetail.status === 'queued' ||
              activeDetail.status === 'publishing'
            }
          />
        </section>
      )}

      <div className="grid gap-6 xl:grid-cols-3">
        <section className="rounded-2xl border border-slate-200/90 bg-white shadow-xs xl:col-span-2">
          <div className="flex items-center justify-between border-b border-slate-100 px-5 py-4">
            <div>
              <h2 className="text-sm font-semibold text-slate-900">最近 10 期任务</h2>
              <p className="mt-0.5 text-xs text-slate-500">
                点击任务编号进入详情审阅文稿、视频与发布状态
              </p>
            </div>
            <Link href="/runs" className="text-xs font-medium text-sky-700 hover:underline">
              查看全部记录 →
            </Link>
          </div>
          {recentRuns.length === 0 ? (
            <div className="p-10 text-center text-sm text-slate-500">
              暂无运行记录，点击右上角「手动启动一期任务」开始生成第一期 AI 每日报。
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-slate-200 text-left text-xs">
                <thead className="bg-slate-50/80 text-slate-600">
                  <tr>
                    <th className="px-4 py-3 font-medium">任务编号</th>
                    <th className="px-4 py-3 font-medium">状态</th>
                    <th className="px-4 py-3 font-medium">当前步骤</th>
                    <th className="px-4 py-3 font-medium">条数</th>
                    <th className="px-4 py-3 font-medium">触发来源</th>
                    <th className="px-4 py-3 font-medium">创建时间</th>
                    <th className="px-4 py-3 font-medium">耗时</th>
                    <th className="px-4 py-3 text-right font-medium">操作</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {recentRuns.map((run) => (
                    <tr key={run.id} className="transition-colors hover:bg-slate-50/80">
                      <td className="px-4 py-3 font-mono font-medium text-slate-900">
                        <Link
                          href={`/runs/${run.id}`}
                          className="hover:text-sky-700 hover:underline"
                        >
                          {run.id}
                        </Link>
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={`inline-block rounded-full border px-2 py-0.5 text-[11px] font-medium ${runStatusBadgeClass(run.status)}`}
                        >
                          {RUN_STATUS_TEXT[run.status]}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-slate-700">
                        {run.currentStage ? STAGE_LABELS[run.currentStage] : '-'}
                      </td>
                      <td className="tabular-nums px-4 py-3 text-slate-700">{run.itemCount} 条</td>
                      <td className="px-4 py-3 text-slate-600">{TRIGGER_TEXT[run.trigger]}</td>
                      <td className="tabular-nums whitespace-nowrap px-4 py-3 text-slate-600">
                        {formatTimestamp(run.createdAt, settings.timezone)}
                      </td>
                      <td className="tabular-nums whitespace-nowrap px-4 py-3 text-slate-600">
                        {formatDuration(run.startedAt, run.finishedAt)}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <Link
                          href={`/runs/${run.id}`}
                          className="font-medium text-sky-700 hover:underline"
                        >
                          详情
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className="flex flex-col justify-between rounded-2xl border border-slate-200/90 bg-white p-5 shadow-xs">
          <div>
            <div className="flex items-center justify-between border-b border-slate-100 pb-3.5">
              <div className="flex items-center gap-2">
                <Cpu className="h-4 w-4 text-slate-500" aria-hidden="true" />
                <h2 className="text-sm font-semibold text-slate-900">当前引擎与模型配置</h2>
              </div>
              <Link href="/settings" className="text-xs font-medium text-sky-700 hover:underline">
                修改配置
              </Link>
            </div>

            <div className="mt-4 grid grid-cols-2 gap-2.5 text-xs">
              <div className="rounded-xl border border-slate-100 bg-slate-50 p-3">
                <div className="text-[11px] text-slate-500">视频模板</div>
                <div className="mt-1 font-mono font-semibold text-slate-900">
                  {settings.template.active}
                </div>
              </div>
              <div className="rounded-xl border border-slate-100 bg-slate-50 p-3">
                <div className="text-[11px] text-slate-500">语音合成</div>
                <div className="mt-1 font-mono font-semibold text-slate-900">
                  {settings.tts.provider}
                </div>
              </div>
            </div>

            <div className="mt-4 space-y-2">
              <div className="text-[11px] font-medium text-slate-500">AI 各阶段模型路由</div>
              <div className="divide-y divide-slate-100 rounded-xl border border-slate-100 bg-slate-50/60">
                {Object.entries(settings.ai.stages).map(([stageKey, stageCfg]) => (
                  <div
                    key={stageKey}
                    className="flex items-center justify-between gap-2 px-3 py-2 text-xs"
                  >
                    <span className="font-medium text-slate-700">{stageKey}</span>
                    <span
                      className="truncate font-mono text-[11px] text-slate-600"
                      title={`${stageCfg.cli} / ${stageCfg.model}`}
                    >
                      {stageCfg.cli} / {stageCfg.model}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div className="mt-5 rounded-xl border border-slate-100 bg-slate-50 p-3 text-xs text-slate-600">
            <div className="flex items-center justify-between">
              <span>发布模式</span>
              <span className="font-medium text-slate-900">
                {settings.publish.mode === 'manual-review' ? '人工审核后发布' : '自动发布'}
              </span>
            </div>
            <div className="mt-1.5 flex items-center justify-between">
              <span>渲染主题 / 模型套组</span>
              <span className="font-mono text-[11px] text-slate-800">
                {settings.render.theme ?? 'dark'} · {settings.render.live2dPack ?? 'fullbody'}
              </span>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
