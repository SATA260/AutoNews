'use client';

import type { RunItemStatus } from '@aidaily/contracts';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { cancelRunAction, retryItemAction, retryItemsAction } from '@/app/actions';

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

/** 批量选择多条新闻条目触发并发重做的操作面板 */
export function BatchRetryItemsPanel({
  runId,
  items,
}: {
  runId: string;
  items: Array<{ id: string; label: string; status: RunItemStatus }>;
}) {
  const router = useRouter();
  const [selectedIds, setSelectedIds] = useState<string[]>(() =>
    items.filter((it) => it.status === 'dropped').map((it) => it.id),
  );
  const [fromStep, setFromStep] = useState<'summarize' | 'polish' | 'factcheck'>('polish');
  const [useLatestConfig, setUseLatestConfig] = useState(false);
  const [feedback, setFeedback] = useState<{ ok: boolean; text: string } | null>(null);
  const [isPending, startTransition] = useTransition();

  const toggleItem = (id: string) => {
    setSelectedIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (selectedIds.length === 0) {
      setFeedback({ ok: false, text: '请至少勾选一条新闻后再并发重做' });
      return;
    }
    setFeedback(null);
    const fd = new FormData();
    fd.set('runId', runId);
    for (const id of selectedIds) {
      fd.append('itemIds', id);
    }
    fd.set('fromStep', fromStep);
    if (useLatestConfig) {
      fd.set('useLatestConfig', 'true');
    }
    startTransition(async () => {
      const res = await retryItemsAction(fd);
      setFeedback({
        ok: res.ok,
        text: res.ok ? (res.message ?? '已提交并发重做') : (res.error ?? '提交失败'),
      });
      router.refresh();
    });
  };

  return (
    <form
      onSubmit={handleSubmit}
      className="space-y-3 rounded-xl border border-slate-200 bg-white p-4 shadow-xs"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-slate-900">多条新闻批量并发重做</h3>
          <p className="text-xs text-slate-500">
            勾选多条新闻后可一次性并发执行润色、核查与打回微调，全部完成后统一重跑编排与成片合成。
          </p>
        </div>
        <div className="flex flex-wrap gap-1.5">
          <button
            type="button"
            onClick={() =>
              setSelectedIds(items.filter((it) => it.status === 'dropped').map((it) => it.id))
            }
            className="rounded border border-slate-200 px-2 py-1 text-[11px] text-slate-700 hover:bg-slate-50"
          >
            仅选已剔除
          </button>
          <button
            type="button"
            onClick={() => setSelectedIds(items.map((it) => it.id))}
            className="rounded border border-slate-200 px-2 py-1 text-[11px] text-slate-700 hover:bg-slate-50"
          >
            全选
          </button>
          <button
            type="button"
            onClick={() => setSelectedIds([])}
            className="rounded border border-slate-200 px-2 py-1 text-[11px] text-slate-700 hover:bg-slate-50"
          >
            清空
          </button>
        </div>
      </div>

      <div className="grid gap-1.5 sm:grid-cols-2 lg:grid-cols-3">
        {items.map((item) => {
          const checked = selectedIds.includes(item.id);
          return (
            <label
              key={item.id}
              className={`flex cursor-pointer items-center gap-2 rounded-lg border px-2.5 py-1.5 text-xs transition-colors ${
                checked
                  ? 'border-sky-400 bg-sky-50 text-slate-900'
                  : 'border-slate-200 bg-slate-50/50 text-slate-700 hover:bg-slate-100'
              }`}
            >
              <input
                type="checkbox"
                checked={checked}
                onChange={() => toggleItem(item.id)}
                className="h-3.5 w-3.5 rounded border-slate-300"
              />
              <span className="min-w-0 flex-1 truncate">{item.label}</span>
              <span
                className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium ${
                  item.status === 'passed'
                    ? 'bg-emerald-100 text-emerald-800'
                    : item.status === 'dropped'
                      ? 'bg-rose-100 text-rose-800'
                      : 'bg-slate-200 text-slate-700'
                }`}
              >
                {item.id}
              </span>
            </label>
          );
        })}
      </div>

      <div className="flex flex-wrap items-center gap-2.5 border-t border-slate-100 pt-2.5">
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
          disabled={isPending || selectedIds.length === 0}
          className="rounded-md bg-sky-600 px-3 py-1 text-xs font-medium text-white hover:bg-sky-700 disabled:opacity-50"
        >
          {isPending ? '提交中…' : `并发重做选中（${selectedIds.length} 条）`}
        </button>
        {feedback && (
          <span className={`text-xs ${feedback.ok ? 'text-emerald-700' : 'text-rose-700'}`}>
            {feedback.text}
          </span>
        )}
      </div>
    </form>
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
