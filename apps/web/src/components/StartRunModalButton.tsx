'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { startRunAction } from '@/app/actions';

const CUTOFF_PRESETS: Array<{ value: string; label: string }> = [
  { value: 'none', label: '不限（默认窗口）' },
  { value: 'last-published', label: '上次发布后' },
  { value: 'today', label: '今日 00:00' },
  { value: '12h', label: '近 12 小时' },
  { value: '24h', label: '近 24 小时' },
  { value: '48h', label: '近 48 小时' },
  { value: 'custom', label: '自定义时间' },
];

const HOST_LABELS: Record<string, string> = {
  deepseek: 'DeepSeek 娘（对应 deepseek-bgm.mp3）',
  gpt: 'GPT 娘（对应 gpt-bgm.mp3）',
  gemini: 'Gemini 娘（对应 gemini-bgm.mp3）',
  claude: 'Claude 娘（对应 claude-bgm.mp3）',
};

/** 打开「立即运行」弹窗的按钮与表单组件（必须由用户显式填写正整数条数，不预填任何默认值） */
export function StartRunModalButton({
  label = '立即运行',
  previousHostId = null,
}: {
  label?: string;
  bgmFiles?: string[];
  previousHostId?: string | null;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [itemCountInput, setItemCountInput] = useState('');
  const [notBeforePreset, setNotBeforePreset] = useState('none');
  const [customNotBefore, setCustomNotBefore] = useState('');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const resetModalFields = () => {
    setErrorMsg(null);
    setItemCountInput('');
    setNotBeforePreset('none');
    setCustomNotBefore('');
  };

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
      resetModalFields();
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
          resetModalFields();
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
              请指定本期最多播报的新闻数量，系统会根据新闻质量选择。
            </p>
            <form onSubmit={handleSubmit} className="mt-4 space-y-4">
              <div>
                <label
                  htmlFor="start-run-items"
                  className="block text-sm font-medium text-slate-700"
                >
                  本期新闻条数上限 *
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

              <div>
                <span className="block text-sm font-medium text-slate-700">
                  最早新闻时间（可选）
                </span>
                <p className="mt-0.5 text-xs text-slate-500">
                  设置后早于该时间发布的旧闻与二次转发均不会进入本期视频。
                </p>
                <input type="hidden" name="notBeforePreset" value={notBeforePreset} />
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {CUTOFF_PRESETS.map((preset) => {
                    const active = notBeforePreset === preset.value;
                    return (
                      <button
                        key={preset.value}
                        type="button"
                        onClick={() => setNotBeforePreset(preset.value)}
                        className={`rounded-full border px-2.5 py-1 text-xs transition ${
                          active
                            ? 'border-slate-900 bg-slate-900 text-white'
                            : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-50'
                        }`}
                      >
                        {preset.label}
                      </button>
                    );
                  })}
                </div>
                {notBeforePreset === 'custom' && (
                  <input
                    id="start-run-not-before"
                    name="notBeforeAt"
                    type="datetime-local"
                    required
                    value={customNotBefore}
                    onChange={(e) => setCustomNotBefore(e.target.value)}
                    className="mt-2 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-slate-900 focus:outline-none"
                  />
                )}
              </div>

              <div>
                <label
                  htmlFor="start-run-host"
                  className="block text-sm font-medium text-slate-700"
                >
                  Live2D 主播形象（专属配乐随形象自动绑定）
                </label>
                <p className="mt-0.5 text-xs text-slate-500">
                  自动选择时将由 AI 根据本期新闻内容匹配形象，并严格避开上一期已使用的主播
                  {previousHostId ? `（${previousHostId}）` : ''}
                  ；人工指定可破例选择，背景音乐均自动绑定对应专属曲目。
                </p>
                <select
                  id="start-run-host"
                  name="hostId"
                  className="mt-1.5 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                >
                  <option value="">自动选择（按新闻内容选定且不连任）</option>
                  {(['deepseek', 'gpt', 'gemini', 'claude'] as const).map((id) => (
                    <option key={id} value={id}>
                      {HOST_LABELS[id]}
                      {previousHostId === id ? '（上一期已使用，可人工破例）' : ''}
                    </option>
                  ))}
                </select>
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
