'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { startRunAction } from '@/app/actions';

/** 打开「立即运行」弹窗的按钮与表单组件（必须由用户显式填写正整数条数，不预填任何默认值） */
export function StartRunModalButton({ label = '立即运行' }: { label?: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [itemCountInput, setItemCountInput] = useState('');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setErrorMsg(null);
    const formData = new FormData(event.currentTarget);
    startTransition(async () => {
      const res = await startRunAction(formData);
      if (!res.ok) {
        setErrorMsg(res.error ?? '启动任务失败');
        return;
      }
      setOpen(false);
      setItemCountInput('');
      if (res.data?.runId) {
        router.push(`/runs/${res.data.runId}`);
      } else {
        router.refresh();
      }
    });
  };

  return (
    <>
      <button
        type="button"
        onClick={() => {
          setErrorMsg(null);
          setItemCountInput('');
          setOpen(true);
        }}
        className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white shadow-sm transition hover:bg-slate-800"
      >
        {label}
      </button>

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/40 p-4">
          <div className="w-full max-w-md rounded-xl border border-slate-200 bg-white p-6 shadow-xl">
            <h2 className="text-lg font-semibold text-slate-900">立即运行一期 AI 每日报</h2>
            <p className="mt-1 text-sm text-slate-600">
              系统不预设默认新闻条数，请手动指定本期最终要产出并播报的新闻数量。
            </p>
            <form onSubmit={handleSubmit} className="mt-4 space-y-4">
              <div>
                <label
                  htmlFor="start-run-items"
                  className="block text-sm font-medium text-slate-700"
                >
                  本期新闻条数 *
                </label>
                <input
                  id="start-run-items"
                  name="itemCount"
                  type="number"
                  min={1}
                  step={1}
                  required
                  value={itemCountInput}
                  onChange={(e) => setItemCountInput(e.target.value)}
                  placeholder="例如：6"
                  className="mt-1.5 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-slate-900 focus:outline-none"
                />
              </div>

              {errorMsg && (
                <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
                  {errorMsg}
                </div>
              )}

              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  disabled={isPending}
                  onClick={() => setOpen(false)}
                  className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
                >
                  取消
                </button>
                <button
                  type="submit"
                  disabled={isPending}
                  className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
                >
                  {isPending ? '正在启动…' : '确认启动'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
}
