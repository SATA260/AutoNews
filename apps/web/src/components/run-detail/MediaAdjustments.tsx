'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { resumeRunAction, setItemImageAction, setRunBgmAction } from '@/app/actions';

/** 审核阶段更换图片、音乐并重新合成画面。 */
export function MediaAdjustments({
  runId,
  items,
  bgmFiles,
  bgmFile,
}: {
  runId: string;
  items: Array<{ id: string; title: string; imageMode?: string }>;
  bgmFiles: string[];
  bgmFile?: string | null;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState('');
  const [images, setImages] = useState<Record<string, File>>({});
  const submit = (
    action: (data: FormData) => Promise<{ ok: boolean; message?: string; error?: string }>,
    form: FormData,
  ) => {
    startTransition(async () => {
      const result = await action(form);
      setMessage(result.message ?? result.error ?? '操作完成');
      if (result.ok) router.refresh();
    });
  };
  return (
    <section className="space-y-4 rounded-xl border border-slate-200 bg-white p-5">
      <h3 className="font-semibold text-slate-900">调整画面与音乐</h3>
      <p className="text-xs text-slate-600">保存修改后重新合成，已完成的配音会保留。</p>
      {items.map((item) => (
        <div
          key={item.id}
          className="space-y-2 rounded border border-slate-200 p-3"
          onPaste={(event) => {
            const file = Array.from(event.clipboardData.files).find((entry) =>
              entry.type.startsWith('image/'),
            );
            if (file) {
              event.preventDefault();
              setImages((current) => ({ ...current, [item.id]: file }));
            }
          }}
        >
          <p className="text-sm font-medium">
            {item.title}{' '}
            <span className="text-xs text-slate-500">当前：{item.imageMode ?? 'auto'}</span>
          </p>
          <input
            type="file"
            accept="image/png,image/jpeg,image/webp"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) setImages((current) => ({ ...current, [item.id]: file }));
            }}
          />
          <p className="text-xs text-slate-500">
            也可点击图片说明输入框后粘贴截图。
            {images[item.id] ? ` 已选择 ${images[item.id]?.name}` : ''}
          </p>
          <input
            id={`caption-${item.id}`}
            maxLength={36}
            placeholder="图片说明（可选）"
            className="w-full rounded border border-slate-300 px-2 py-1 text-sm"
          />
          {(['custom', 'none', 'auto'] as const).map((mode) => (
            <button
              type="button"
              key={mode}
              disabled={pending || (mode === 'custom' && !images[item.id])}
              className="mr-2 rounded border px-3 py-1 text-xs disabled:opacity-40"
              onClick={() => {
                const form = new FormData();
                form.set('runId', runId);
                form.set('itemId', item.id);
                form.set('mode', mode);
                const image = images[item.id];
                if (image) form.set('image', image);
                const caption = document.getElementById(`caption-${item.id}`);
                if (caption instanceof HTMLInputElement) form.set('caption', caption.value);
                submit(setItemImageAction, form);
              }}
            >
              {mode === 'custom' ? '使用图片' : mode === 'none' ? '切换无图' : '自动配图'}
            </button>
          ))}
        </div>
      ))}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const form = new FormData(event.currentTarget);
          form.set('runId', runId);
          submit(setRunBgmAction, form);
        }}
        className="flex gap-2"
      >
        <select
          name="bgmFile"
          defaultValue={bgmFile ?? ''}
          className="rounded border px-2 py-1 text-sm"
          required
        >
          <option value="">选择背景音乐</option>
          {bgmFiles.map((file) => (
            <option key={file} value={file}>
              {file}
            </option>
          ))}
        </select>
        <button disabled={pending} className="rounded border px-3 py-1 text-sm" type="submit">
          保存音乐
        </button>
      </form>
      <button
        disabled={pending}
        type="button"
        className="rounded bg-slate-900 px-3 py-2 text-sm text-white"
        onClick={() => {
          const form = new FormData();
          form.set('runId', runId);
          form.set('fromStage', 'render');
          submit(resumeRunAction, form);
        }}
      >
        重新合成视频
      </button>
      {message ? (
        <p role="status" className="text-xs text-slate-600">
          {message}
        </p>
      ) : null}
    </section>
  );
}
