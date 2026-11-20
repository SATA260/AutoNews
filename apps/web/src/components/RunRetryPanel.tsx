'use client';

import { PIPELINE_STAGES, type RetryOptions, type RunStatus, type Stage } from '@aidaily/contracts';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { abandonRunAction, resumeRunAction } from '@/app/actions';
import { STAGE_LABELS } from '@/lib/format';

/** 中断、失败、已取消、驳回或已出片任务的重跑控制与归档确认面板 */
export function RunRetryPanel({
  runId,
  retryOptions,
  retryDeadlineFormatted,
  runStatus,
}: {
  runId: string;
  retryOptions: RetryOptions;
  retryDeadlineFormatted: string;
  runStatus?: RunStatus;
}) {
  const router = useRouter();
  const [useLatestConfig, setUseLatestConfig] = useState(true);
  const [confirmStage, setConfirmStage] = useState<Stage | null>(null);
  const [feedback, setFeedback] = useState<{ ok: boolean; text: string } | null>(null);
  const [isPending, startTransition] = useTransition();

  const feedbackMessage = feedback && (
    <div
      role={feedback.ok ? 'status' : 'alert'}
      className={`mt-3 rounded-lg border px-3 py-2 text-xs ${
        feedback.ok
          ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
          : 'border-rose-200 bg-rose-50 text-rose-700'
      }`}
    >
      {feedback.text}
    </div>
  );
  if (!retryOptions.resumable) {
    return feedbackMessage;
  }

  /** 提交重跑并等后台确认启动，随后更新任务详情 */
  const handleResume = (fromStage?: Stage) => {
    setFeedback(null);
    const fd = new FormData();
    fd.set('runId', runId);
    if (fromStage) {
      fd.set('fromStage', fromStage);
    }
    fd.set('useLatestConfig', useLatestConfig ? 'true' : 'false');
    startTransition(async () => {
      try {
        const res = await resumeRunAction(fd);
        setFeedback({
          ok: res.ok,
          text: res.ok ? (res.message ?? '重跑已启动') : (res.error ?? '重跑启动失败'),
        });
      } catch {
        setFeedback({ ok: false, text: '未能取得重跑结果，请刷新页面查看任务状态后再试' });
      } finally {
        setConfirmStage(null);
        router.refresh();
      }
    });
  };

  const handleAbandon = () => {
    setFeedback(null);
    const fd = new FormData();
    fd.set('runId', runId);
    startTransition(async () => {
      const res = await abandonRunAction(fd);
      setFeedback({
        ok: res.ok,
        text: res.ok ? (res.message ?? '已放弃本期') : (res.error ?? '操作失败'),
      });
      router.refresh();
    });
  };

  const invalidatedForStage = (targetStage: Stage): Stage[] => {
    const idx = PIPELINE_STAGES.indexOf(targetStage as (typeof PIPELINE_STAGES)[number]);
    if (idx === -1) {
      return [];
    }
    return PIPELINE_STAGES.slice(idx);
  };

  const published = runStatus === 'published';

  return (
    <div className="rounded-xl border border-amber-200 bg-amber-50/70 p-4 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-slate-900">
            {published ? '复活已发布任务并从指定阶段重跑' : '任务恢复与指定阶段重跑'}
          </h3>
          <p className="mt-0.5 text-xs text-slate-600">
            {published
              ? '旧成片会自动备份到 archive/。重跑完成后进入待审核，可以改简介，再选择投稿或仅本地完结。'
              : `已预留的文章与检查点保留至：${retryDeadlineFormatted}`}
          </p>
        </div>

        <label className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700">
          <input
            type="checkbox"
            checked={useLatestConfig}
            onChange={(e) => setUseLatestConfig(e.target.checked)}
            className="h-3.5 w-3.5 rounded border-slate-300"
          />
          按当前显示设置执行（默认开启，取消则沿用创建时旧快照）
        </label>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        {retryOptions.resumeFrom && (
          <button
            type="button"
            disabled={isPending}
            onClick={() => handleResume(undefined)}
            className="rounded-lg bg-slate-900 px-3.5 py-2 text-xs font-medium text-white hover:bg-slate-800 disabled:opacity-50"
          >
            {isPending && !confirmStage
              ? '正在处理…'
              : `从中断处继续（${STAGE_LABELS[retryOptions.resumeFrom]}）`}
          </button>
        )}

        {retryOptions.allowedFromStages.map((stage) => (
          <button
            key={stage}
            type="button"
            disabled={isPending}
            onClick={() => setConfirmStage(stage)}
            className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
          >
            从「{STAGE_LABELS[stage] ?? stage}」重跑
          </button>
        ))}

        {published ? null : (
          <button
            type="button"
            disabled={isPending}
            onClick={handleAbandon}
            className="ml-auto rounded-lg border border-rose-300 bg-white px-3 py-2 text-xs font-medium text-rose-700 hover:bg-rose-50 disabled:opacity-50"
          >
            放弃本期并释放文章
          </button>
        )}
      </div>

      {feedbackMessage}

      {confirmStage && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/40 p-4">
          <div className="w-full max-w-md rounded-xl border border-slate-200 bg-white p-6 shadow-xl">
            <h4 className="text-base font-semibold text-slate-900">
              确认从「{STAGE_LABELS[confirmStage] ?? confirmStage}」重新运行？
            </h4>
            <p className="mt-2 text-xs leading-relaxed text-slate-600">
              以下阶段的旧产物将被自动移动到该任务目录的{' '}
              <code className="rounded bg-slate-100 px-1 py-0.5">archive/</code>{' '}
              子目录中备份，数据库对应步骤将重置并从头执行：
            </p>
            <div className="mt-3 flex flex-wrap gap-1.5">
              {invalidatedForStage(confirmStage).map((s) => (
                <span
                  key={s}
                  className="rounded-md bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800"
                >
                  {STAGE_LABELS[s] ?? s}
                </span>
              ))}
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                disabled={isPending}
                onClick={() => setConfirmStage(null)}
                className="rounded-lg border border-slate-300 px-3.5 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50"
              >
                取消
              </button>
              <button
                type="button"
                disabled={isPending}
                onClick={() => handleResume(confirmStage)}
                className="rounded-lg bg-slate-900 px-3.5 py-2 text-xs font-medium text-white hover:bg-slate-800 disabled:opacity-50"
              >
                {isPending ? '正在启动…' : '确认归档并重跑'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
