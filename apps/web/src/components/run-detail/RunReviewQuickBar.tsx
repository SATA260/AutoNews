'use client';

import type { RunStatus } from '@aidaily/contracts';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { markConsumedAction } from '@/app/actions';

/** 任务详情页快捷审核栏：允许用户在任意非发布页签直接完成审核但不上传视频 */
export function RunReviewQuickBar({ runId, runStatus }: { runId: string; runStatus: RunStatus }) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [feedback, setFeedback] = useState<{ ok: boolean; text: string } | null>(null);
  const [isPending, startTransition] = useTransition();

  const handleConfirmSkipUpload = () => {
    setFeedback(null);
    const fd = new FormData();
    fd.set('runId', runId);
    startTransition(async () => {
      const res = await markConsumedAction(fd);
      setConfirming(false);
      setFeedback({
        ok: res.ok,
        text: res.ok ? (res.message ?? '已审核通过（不上传视频）') : (res.error ?? '操作失败'),
      });
      router.refresh();
    });
  };

  return (
    <div className="rounded-xl border border-amber-300 bg-amber-50 p-4 shadow-xs">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-amber-950">
            {runStatus === 'publish_failed'
              ? '本期投稿曾上传失败，可前往投稿页重试，或直接审核通过（不上传视频）'
              : '本期成片已就绪，等待人工审核确认'}
          </p>
          <p className="mt-0.5 text-xs text-amber-800">
            如仅需在本地保存成片并把新闻记入已播历史、无需上传 B 站，可直接点击右侧按钮完结本期。
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Link
            href={`/runs/${encodeURIComponent(runId)}?tab=publish`}
            className="rounded-lg border border-amber-400 bg-white px-3.5 py-2 text-xs font-medium text-amber-900 hover:bg-amber-100"
          >
            前往发布页投稿 B 站
          </Link>

          {confirming ? (
            <div className="flex items-center gap-1.5 rounded-lg border border-emerald-300 bg-white px-2.5 py-1">
              <span className="text-xs text-slate-700">确认不上传 B 站并记入已播历史？</span>
              <button
                type="button"
                disabled={isPending}
                onClick={handleConfirmSkipUpload}
                className="rounded bg-emerald-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
              >
                {isPending ? '提交中…' : '确认不上传并完结'}
              </button>
              <button
                type="button"
                disabled={isPending}
                onClick={() => setConfirming(false)}
                className="rounded border border-slate-300 px-2 py-1 text-xs text-slate-600 hover:bg-slate-50"
              >
                取消
              </button>
            </div>
          ) : (
            <button
              type="button"
              disabled={isPending}
              onClick={() => {
                setFeedback(null);
                setConfirming(true);
              }}
              className="rounded-lg bg-emerald-600 px-3.5 py-2 text-xs font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
            >
              审核通过（不上传视频）
            </button>
          )}
        </div>
      </div>

      {feedback && (
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
      )}
    </div>
  );
}
