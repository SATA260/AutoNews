'use client';

import type { DeleteRunsMode, RunStatus } from '@aidaily/contracts';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { deleteRunsAction } from '@/app/actions';
import { formatBytes } from '@/lib/format';

const PROTECTED_RUN_STATUSES = new Set<RunStatus>([
  'queued',
  'running',
  'publishing',
  'publish_uncertain',
]);

/** 单期任务详情页顶部的清理磁盘产物与删除任务按钮组件 */
export function RunDeleteButtons({
  runId,
  runStatus,
  diskBytes,
}: {
  runId: string;
  runStatus: RunStatus;
  diskBytes: number;
}) {
  const router = useRouter();
  const [confirmMode, setConfirmMode] = useState<DeleteRunsMode | null>(null);
  const [feedback, setFeedback] = useState<{ ok: boolean; text: string } | null>(null);
  const [isPending, startTransition] = useTransition();

  if (PROTECTED_RUN_STATUSES.has(runStatus)) {
    return null;
  }

  const handleConfirm = () => {
    if (!confirmMode) {
      return;
    }
    const mode = confirmMode;
    setFeedback(null);
    startTransition(async () => {
      const res = await deleteRunsAction({ runIds: [runId], mode });
      if (!res.ok) {
        setFeedback({ ok: false, text: res.error ?? '操作失败' });
        return;
      }
      setConfirmMode(null);
      if (mode === 'full') {
        router.push('/runs');
        router.refresh();
      } else {
        setFeedback({ ok: true, text: res.message ?? '已清理任务磁盘产物' });
        router.refresh();
      }
    });
  };

  return (
    <div className="flex flex-col items-end gap-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={isPending}
          onClick={() => {
            setFeedback(null);
            setConfirmMode('artifacts_only');
          }}
          className="rounded-lg border border-amber-300 bg-white px-3 py-1.5 text-xs font-medium text-amber-800 hover:bg-amber-50 disabled:opacity-50"
        >
          清理产物（{formatBytes(diskBytes)}）
        </button>
        <button
          type="button"
          disabled={isPending}
          onClick={() => {
            setFeedback(null);
            setConfirmMode('full');
          }}
          className="rounded-lg border border-rose-300 bg-white px-3 py-1.5 text-xs font-medium text-rose-700 hover:bg-rose-50 disabled:opacity-50"
        >
          删除任务
        </button>
      </div>

      {feedback && (
        <span
          role={feedback.ok ? 'status' : 'alert'}
          className={`text-xs ${feedback.ok ? 'text-emerald-700' : 'text-rose-700'}`}
        >
          {feedback.text}
        </span>
      )}

      {confirmMode && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/40 p-4">
          <div className="w-full max-w-md rounded-xl border border-slate-200 bg-white p-6 text-left shadow-xl">
            <h4 className="text-base font-semibold text-slate-900">
              {confirmMode === 'artifacts_only'
                ? `确认清理任务 ${runId} 的本地磁盘产物？`
                : `确认彻底删除任务 ${runId}？`}
            </h4>
            <p className="mt-2 text-xs leading-relaxed text-slate-600">
              {confirmMode === 'artifacts_only'
                ? `将删除该期任务目录中的成片视频、音频与中间检查点（当前占用 ${formatBytes(diskBytes)}），数据库中的任务记录和文稿会继续保留。`
                : `将从数据库删除该期任务记录并清除磁盘产物目录（当前占用 ${formatBytes(diskBytes)}）；若仍占用待选新闻，会自动释放回到待选池（已播防重历史会保留）。`}
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                disabled={isPending}
                onClick={() => setConfirmMode(null)}
                className="rounded-lg border border-slate-300 px-3.5 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50"
              >
                取消
              </button>
              <button
                type="button"
                disabled={isPending}
                onClick={handleConfirm}
                className="rounded-lg bg-rose-600 px-3.5 py-2 text-xs font-medium text-white hover:bg-rose-700 disabled:opacity-50"
              >
                {isPending
                  ? '处理中…'
                  : confirmMode === 'artifacts_only'
                    ? '确认清理产物'
                    : '确认删除任务'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
