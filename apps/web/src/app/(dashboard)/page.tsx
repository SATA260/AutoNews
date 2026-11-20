import { PIPELINE_STAGES, type RunEvent, type Trigger } from '@aidaily/contracts';
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

/** 管理后台总览页：展示正在运行的任务实时状态、待审核提醒、最近任务列表、信源健康及定时计划摘要 */
export default async function DashboardPage() {
  const core = await getCore();
  const settings = core.config.getSettings();
  const bgmFiles = await core.tasks.listBgm();
  const [recentRuns, sourceHealth, schedules] = await Promise.all([
    core.tasks.list({ limit: 10 }),
    core.sources.list(),
    core.scheduler.list(),
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
  const enabledSchedules = schedules.filter((j) => j.enabled);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-bold text-slate-900">控制台总览</h2>
          <p className="mt-1 text-xs text-slate-600">
            展示当前实时运行进度、待审核稿件、信源健康状况与近期期次记录（时区：{settings.timezone}
            ）
          </p>
        </div>
        <StartRunModalButton bgmFiles={bgmFiles} label="手动启动一期任务" />
      </div>

      {reviewPendingRuns.length > 0 && (
        <div className="rounded-xl border border-amber-300 bg-amber-50 p-4 shadow-xs">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h3 className="text-sm font-semibold text-amber-900">
                有 {reviewPendingRuns.length} 期任务等待试听配音、人工审核或确认投稿结果
              </h3>
              <p className="mt-0.5 text-xs text-amber-800">
                请核对成片画质、简介文案及 AI 声明后决定发布、驳回或仅本地完结。
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              {reviewPendingRuns.map((run) => (
                <Link
                  key={run.id}
                  href={`/runs/${run.id}?tab=publish`}
                  className="rounded-lg bg-amber-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-amber-700"
                >
                  处理 {run.id}（{RUN_STATUS_TEXT[run.status]}）
                </Link>
              ))}
            </div>
          </div>
        </div>
      )}

      {failedRuns.length > 0 && (
        <div className="rounded-xl border border-rose-200 bg-rose-50 p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs font-medium text-rose-900">
              最近有 {failedRuns.length}{' '}
              期任务处于异常或中断状态，可进入详情从断点或任意步骤继续执行：
            </span>
            <div className="flex flex-wrap gap-2">
              {failedRuns.slice(0, 3).map((run) => (
                <Link
                  key={run.id}
                  href={`/runs/${run.id}`}
                  className="rounded-md border border-rose-300 bg-white px-2.5 py-1 text-xs font-medium text-rose-700 hover:bg-rose-100"
                >
                  {run.id}（{RUN_STATUS_TEXT[run.status]}）
                </Link>
              ))}
            </div>
          </div>
        </div>
      )}

      {activeDetail && (
        <section className="space-y-4 rounded-xl border border-sky-200 bg-white p-5 shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 pb-3">
            <div className="flex flex-wrap items-center gap-2.5">
              <span
                className={`rounded-full border px-2.5 py-0.5 text-xs font-medium ${runStatusBadgeClass(activeDetail.status)}`}
              >
                {RUN_STATUS_TEXT[activeDetail.status]}
              </span>
              <Link
                href={`/runs/${activeDetail.id}`}
                className="font-mono text-sm font-semibold text-slate-900 hover:text-sky-700"
              >
                {activeDetail.id}
              </Link>
              <span className="text-xs text-slate-600">
                目标 {activeDetail.itemCount} 条 · 第 {activeDetail.attempt} 轮执行
              </span>
            </div>
            <div className="flex items-center gap-3">
              <Link
                href={`/runs/${activeDetail.id}`}
                className="text-xs font-medium text-sky-700 hover:underline"
              >
                打开任务详情 →
              </Link>
              <RunCancelButton runId={activeDetail.id} />
            </div>
          </div>

          <div className="grid grid-cols-3 gap-2 sm:grid-cols-5 lg:grid-cols-9">
            {PIPELINE_STAGES.map((stage) => {
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
                <div key={stage} className={`rounded-lg border px-2.5 py-2 text-xs ${tone}`}>
                  <div className="font-medium">{STAGE_LABELS[stage]}</div>
                  <div className="mt-0.5 text-[11px] opacity-80">{STAGE_STATUS_TEXT[status]}</div>
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

      <div className="grid gap-4 md:grid-cols-3">
        <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-xs">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-slate-900">信源健康概览</h3>
            <Link href="/sources" className="text-xs text-sky-700 hover:underline">
              管理信源
            </Link>
          </div>
          <p className="mt-2 text-2xl font-bold text-slate-900">
            {enabledSources.length - unhealthySources.length}
            <span className="ml-1 text-sm font-normal text-slate-500">
              / {enabledSources.length} 已启用信源正常
            </span>
          </p>
          {unhealthySources.length > 0 ? (
            <p className="mt-2 text-xs text-rose-700">
              异常信源：{unhealthySources.map((s) => s.source.name).join('、')}
            </p>
          ) : (
            <p className="mt-2 text-xs text-emerald-700">所有已启用信源近期抓取状态正常。</p>
          )}
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-xs">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-slate-900">定时调度计划</h3>
            <Link href="/schedules" className="text-xs text-sky-700 hover:underline">
              管理定时
            </Link>
          </div>
          <p className="mt-2 text-2xl font-bold text-slate-900">
            {enabledSchedules.length}
            <span className="ml-1 text-sm font-normal text-slate-500">
              / {schedules.length} 项计划启用中
            </span>
          </p>
          {enabledSchedules.length > 0 ? (
            <ul className="mt-2 space-y-1 text-xs text-slate-600">
              {enabledSchedules.slice(0, 2).map((job) => (
                <li key={job.id} className="truncate">
                  {job.name}（每日 {job.time}，{job.itemCount} 条）· 下次{' '}
                  {formatTimestamp(job.nextRunAt, settings.timezone)}
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-2 text-xs text-slate-500">
              暂未启用每日定时任务，请到定时页面手动创建。
            </p>
          )}
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-xs">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-slate-900">模型与渲染配置</h3>
            <Link href="/settings" className="text-xs text-sky-700 hover:underline">
              切换配置
            </Link>
          </div>
          <p className="mt-2 text-xs text-slate-600">
            视频模板：<span className="font-mono font-medium">{settings.template.active}</span> ·
            语音引擎：<span className="font-mono font-medium">{settings.tts.provider}</span>
          </p>
          <div className="mt-2 flex flex-wrap gap-1.5 text-[11px]">
            {Object.entries(settings.ai.stages).map(([stageKey, stageCfg]) => (
              <span
                key={stageKey}
                className="rounded border border-slate-200 bg-slate-50 px-2 py-0.5 font-mono text-slate-700"
              >
                {stageKey}: {stageCfg.cli}/{stageCfg.model}
              </span>
            ))}
          </div>
        </div>
      </div>

      <section className="rounded-xl border border-slate-200 bg-white shadow-xs">
        <div className="flex items-center justify-between border-b border-slate-100 px-5 py-3.5">
          <h3 className="text-sm font-semibold text-slate-900">最近 10 期任务</h3>
          <Link href="/runs" className="text-xs font-medium text-sky-700 hover:underline">
            查看全部记录 →
          </Link>
        </div>
        {recentRuns.length === 0 ? (
          <div className="p-8 text-center text-sm text-slate-500">
            暂无运行记录，点击右上角「手动启动一期任务」开始生成第一期 AI 每日报。
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-slate-200 text-left text-xs">
              <thead className="bg-slate-50 text-slate-600">
                <tr>
                  <th className="px-4 py-2.5 font-medium">任务编号</th>
                  <th className="px-4 py-2.5 font-medium">状态</th>
                  <th className="px-4 py-2.5 font-medium">当前步骤</th>
                  <th className="px-4 py-2.5 font-medium">条数</th>
                  <th className="px-4 py-2.5 font-medium">触发方式</th>
                  <th className="px-4 py-2.5 font-medium">创建时间</th>
                  <th className="px-4 py-2.5 font-medium">执行耗时</th>
                  <th className="px-4 py-2.5 font-medium">操作</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {recentRuns.map((run) => (
                  <tr key={run.id} className="hover:bg-slate-50">
                    <td className="px-4 py-2.5 font-mono font-medium text-slate-900">{run.id}</td>
                    <td className="px-4 py-2.5">
                      <span
                        className={`inline-block rounded-full border px-2 py-0.5 text-[11px] font-medium ${runStatusBadgeClass(run.status)}`}
                      >
                        {RUN_STATUS_TEXT[run.status]}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-slate-700">
                      {run.currentStage ? STAGE_LABELS[run.currentStage] : '-'}
                    </td>
                    <td className="px-4 py-2.5 text-slate-700">{run.itemCount} 条</td>
                    <td className="px-4 py-2.5 text-slate-600">{TRIGGER_TEXT[run.trigger]}</td>
                    <td className="px-4 py-2.5 text-slate-600">
                      {formatTimestamp(run.createdAt, settings.timezone)}
                    </td>
                    <td className="px-4 py-2.5 text-slate-600">
                      {formatDuration(run.startedAt, run.finishedAt)}
                    </td>
                    <td className="px-4 py-2.5">
                      <Link
                        href={`/runs/${run.id}`}
                        className="font-medium text-sky-700 hover:underline"
                      >
                        查看详情
                      </Link>
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
