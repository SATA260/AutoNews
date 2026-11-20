import {
  PIPELINE_STAGES,
  type RetryOptions,
  type RunDetail,
  type RunEvent,
} from '@aidaily/contracts';
import { RunLiveLogPanel } from '@/components/RunLiveLogPanel';
import { RunRetryPanel } from '@/components/RunRetryPanel';
import { buildArtifactUrl } from '@/components/run-detail/artifact-url';
import { formatTimestamp, STAGE_LABELS, STAGE_STATUS_TEXT } from '@/lib/format';

/** 进度与日志页签组件的参数定义 */
export interface RunProgressTabProps {
  detail: RunDetail;
  retryOptions: RetryOptions;
  runEvents: RunEvent[];
  isActive: boolean;
  timezone: string;
}

const STAGE_BADGE_CLASS: Record<string, string> = {
  done: 'border-emerald-200 bg-emerald-50 text-emerald-800',
  running: 'border-sky-300 bg-sky-50 text-sky-900',
  failed: 'border-rose-200 bg-rose-50 text-rose-800',
  interrupted: 'border-orange-200 bg-orange-50 text-orange-800',
  stale: 'border-amber-200 bg-amber-50 text-amber-800',
  skipped: 'border-slate-200 bg-slate-100 text-slate-600',
  pending: 'border-slate-200 bg-white text-slate-600',
};

/** 任务进度页签：展示步骤状态时间轴、断点/指定阶段重跑面板、实时日志流、重试记录及归档文件列表 */
export function RunProgressTab({
  detail,
  retryOptions,
  runEvents,
  isActive,
  timezone,
}: RunProgressTabProps) {
  const retryDeadlineFormatted = formatTimestamp(retryOptions.retryDeadlineAt, timezone);
  const auditEvents = runEvents.filter(
    (ev) =>
      ev.type === 'retry_started' ||
      ev.type === 'run_revived' ||
      ev.type === 'run_abandoned' ||
      ev.type === 'stage_failed' ||
      ev.type === 'run_interrupted' ||
      ev.type === 'run_cancelled',
  );
  const archivedArtifacts = detail.artifacts.filter((rel) => rel.startsWith('archive/'));
  const currentArtifacts = detail.artifacts.filter((rel) => !rel.startsWith('archive/'));

  return (
    <div className="space-y-5">
      <section className="rounded-2xl border border-slate-200/90 bg-white p-5 shadow-xs">
        <h3 className="text-sm font-semibold text-slate-900">流程步骤状态</h3>
        <div className="mt-3 grid gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
          {PIPELINE_STAGES.map((stage, index) => {
            const rec = detail.stages.find((s) => s.stage === stage);
            const status = rec?.status ?? 'pending';
            const cardClass = STAGE_BADGE_CLASS[status] ?? STAGE_BADGE_CLASS.pending;
            return (
              <div key={stage} className={`rounded-lg border p-3 text-xs ${cardClass}`}>
                <div className="flex items-center justify-between gap-2">
                  <span className="font-semibold">
                    {index + 1}. {STAGE_LABELS[stage]}
                  </span>
                  <span className="rounded bg-white/70 px-1.5 py-0.5 text-[11px] font-medium">
                    {STAGE_STATUS_TEXT[status]}
                  </span>
                </div>
                <div className="mt-1.5 space-y-0.5 text-[11px] opacity-85">
                  <div>
                    执行轮次：{rec ? `第 ${rec.attempt} 轮` : '尚未开始'} · 检查点：
                    {rec?.checkpointPath ?? '-'}
                  </div>
                  <div>开始：{formatTimestamp(rec?.startedAt, timezone)}</div>
                  <div>结束：{formatTimestamp(rec?.finishedAt, timezone)}</div>
                  {rec?.error ? <div className="text-rose-700">错误：{rec.error}</div> : null}
                </div>
              </div>
            );
          })}
        </div>
      </section>

      <RunRetryPanel
        runId={detail.id}
        retryOptions={retryOptions}
        retryDeadlineFormatted={retryDeadlineFormatted}
        runStatus={detail.status}
      />

      <RunLiveLogPanel runId={detail.id} initialEvents={runEvents} isActive={isActive} />

      <div className="grid gap-4 lg:grid-cols-2">
        <section className="rounded-2xl border border-slate-200/90 bg-white p-5 shadow-xs">
          <h3 className="text-sm font-semibold text-slate-900">中断与重跑历史</h3>
          {auditEvents.length === 0 ? (
            <p className="mt-2 text-xs text-slate-500">本期任务暂未发生中断或重跑记录。</p>
          ) : (
            <ul className="mt-3 space-y-2 text-xs">
              {auditEvents.map((ev) => (
                <li
                  key={ev.id}
                  className="rounded-lg border border-slate-100 bg-slate-50 px-3 py-2 text-slate-700"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-mono text-[11px] font-medium text-slate-600">
                      {ev.type}
                    </span>
                    <span className="text-[11px] text-slate-500">
                      {formatTimestamp(ev.ts, timezone)}
                    </span>
                  </div>
                  <p className="mt-1">{ev.message}</p>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="rounded-2xl border border-slate-200/90 bg-white p-5 shadow-xs">
          <h3 className="text-sm font-semibold text-slate-900">产物文件与重跑归档快照</h3>
          <div className="mt-3 space-y-3 text-xs">
            <div>
              <h4 className="font-medium text-slate-700">
                当前工作产物（{currentArtifacts.length}）
              </h4>
              {currentArtifacts.length === 0 ? (
                <p className="mt-1 text-slate-500">暂无输出文件。</p>
              ) : (
                <ul className="mt-1 max-h-40 space-y-1 overflow-y-auto font-mono text-[11px]">
                  {currentArtifacts.map((rel) => (
                    <li key={rel}>
                      <a
                        href={buildArtifactUrl(detail.id, rel)}
                        target="_blank"
                        rel="noreferrer"
                        className="text-sky-700 hover:underline"
                      >
                        {rel}
                      </a>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div>
              <h4 className="font-medium text-slate-700">
                历史归档快照（{archivedArtifacts.length}）
              </h4>
              {archivedArtifacts.length === 0 ? (
                <p className="mt-1 text-slate-500">尚未触发从指定阶段回退重跑，暂无归档文件。</p>
              ) : (
                <ul className="mt-1 max-h-40 space-y-1 overflow-y-auto font-mono text-[11px]">
                  {archivedArtifacts.map((rel) => (
                    <li key={rel}>
                      <a
                        href={buildArtifactUrl(detail.id, rel)}
                        target="_blank"
                        rel="noreferrer"
                        className="text-amber-700 hover:underline"
                      >
                        {rel}
                      </a>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
