'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { cancelRunAction, retryItemAction } from '@/app/actions';

/** 取消正在排队或运行中任务的按钮组件 */
export function RunCancelButton({ runId }: { runId: string }) {
  const router = useRouter();
  const [feedback, setFeedback] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const handleCancel = () => {
    setFeedback(null);
    const fd = new FormData();
    fd.set('runId', runId);
    startTransition(async () => {
      const res = await cancelRunAction(fd);
      setFeedback(res.ok ? (res.message ?? '已发送取消请求') : (res.error ?? '取消失败'));
      router.refresh();
    });
  };

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        disabled={isPending}
        onClick={handleCancel}
        className="rounded-lg border border-rose-300 bg-white px-3 py-1.5 text-xs font-medium text-rose-700 hover:bg-rose-50 disabled:opacity-50"
      >
        {isPending ? '停止中…' : '取消任务'}
      </button>
      {feedback && <span className="text-xs text-slate-600">{feedback}</span>}
    </div>
  );
}

/** 针对单条新闻触发独立重做的表单控制条（可选从总结、润色或核查步骤重新开始） */
export function RetryItemForm({ runId, itemId }: { runId: string; itemId: string }) {
  const router = useRouter();
  const [fromStep, setFromStep] = useState<'summarize' | 'polish' | 'factcheck'>('polish');
  const [useLatestConfig, setUseLatestConfig] = useState(false);
  const [feedback, setFeedback] = useState<{ ok: boolean; text: string } | null>(null);
  const [isPending, startTransition] = useTransition();

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setFeedback(null);
    const fd = new FormData();
    fd.set('runId', runId);
    fd.set('itemId', itemId);
    fd.set('fromStep', fromStep);
    if (useLatestConfig) {
      fd.set('useLatestConfig', 'true');
    }
    startTransition(async () => {
      const res = await retryItemAction(fd);
      setFeedback({
        ok: res.ok,
        text: res.ok ? (res.message ?? '已提交单条重做') : (res.error ?? '提交失败'),
      });
      router.refresh();
    });
  };

  return (
    <form onSubmit={handleSubmit} className="flex flex-wrap items-center gap-2">
      <select
        value={fromStep}
        onChange={(e) => setFromStep(e.target.value as 'summarize' | 'polish' | 'factcheck')}
        className="rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs text-slate-700"
      >
        <option value="summarize">从总结重写</option>
        <option value="polish">从中文润色重跑</option>
        <option value="factcheck">从事实核查重审</option>
      </select>
      <label className="inline-flex items-center gap-1 text-xs text-slate-600">
        <input
          type="checkbox"
          checked={useLatestConfig}
          onChange={(e) => setUseLatestConfig(e.target.checked)}
          className="h-3.5 w-3.5 rounded border-slate-300"
        />
        用最新配置
      </label>
      <button
        type="submit"
        disabled={isPending}
        className="rounded-md bg-slate-900 px-3 py-1 text-xs font-medium text-white hover:bg-slate-800 disabled:opacity-50"
      >
        {isPending ? '提交中…' : '重试这条'}
      </button>
      {feedback && (
        <span className={`text-xs ${feedback.ok ? 'text-emerald-700' : 'text-rose-700'}`}>
          {feedback.text}
        </span>
      )}
    </form>
  );
}
