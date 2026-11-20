'use client';

import Image from 'next/image';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { resumeRunAction, setItemImageAction, setRunBgmAction } from '@/app/actions';
import { buildArtifactUrl } from '@/components/run-detail/artifact-url';

/** 网页端展示的单个候选视觉素材信息 */
export interface MediaCandidateView {
  id: string;
  kind: 'cover' | 'chart' | 'table_shot' | 'tweet_shot' | 'tweet_media' | 'screenshot';
  score: number;
  captionHint: string;
  contextSnippet: string;
  artifactRelPath: string;
}

/** 审核阶段更换配图（支持单张候选图一键选用与本地上传）、音乐并重新合成画面。 */
export interface MediaAdjustmentsItemView {
  id: string;
  title: string;
  imageMode?: string;
  primaryMediaId?: string | null;
  imageCaption?: string | null;
}

const KIND_LABELS: Record<MediaCandidateView['kind'], string> = {
  tweet_shot: '推文截图',
  tweet_media: '推文附图',
  table_shot: '表格截图',
  chart: '跑分图表',
  screenshot: '正文配图',
  cover: '网页封面',
};

/** 审核阶段更换配图（每条新闻最多 1 张，支持候选选图与本地上传）、音乐并重新合成画面。 */
export function MediaAdjustments({
  runId,
  items,
  candidatesByItemId = {},
  bgmFiles,
  bgmFile,
}: {
  runId: string;
  items: MediaAdjustmentsItemView[];
  candidatesByItemId?: Record<string, MediaCandidateView[]>;
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

  const readCaptionValue = (itemId: string): string | undefined => {
    const captionEl = document.getElementById(`caption-${itemId}`);
    return captionEl instanceof HTMLInputElement ? captionEl.value : undefined;
  };

  return (
    <section className="space-y-4 rounded-2xl border border-slate-200/90 bg-white p-5 shadow-xs">
      <div className="border-b border-slate-100 pb-3">
        <h3 className="text-sm font-semibold text-slate-900">调整新闻配图与背景音乐</h3>
        <p className="mt-1 text-xs text-slate-600">
          每条新闻最多展示 1
          张配图：可从已抓取的高分图表、表格截图或推文原帖截图中一键选用，或上传/粘贴本地截图；调整后点击底部「重新合成视频」。
        </p>
      </div>
      {items.map((item) => {
        const candidates = candidatesByItemId[item.id] ?? [];
        return (
          <div
            key={item.id}
            className="space-y-3 rounded-lg border border-slate-200 p-3.5"
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
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm font-medium text-slate-900">
                {item.title}{' '}
                <span className="ml-1 rounded bg-slate-100 px-1.5 py-0.5 text-xs font-normal text-slate-600">
                  模式：{item.imageMode ?? 'auto'}
                </span>
              </p>
            </div>

            {candidates.length > 0 ? (
              <div className="space-y-1.5">
                <p className="text-xs font-medium text-slate-700">
                  已抓取候选素材（共 {candidates.length} 张，单选）：
                </p>
                <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                  {candidates.map((cand) => {
                    const isPrimary = item.imageMode !== 'none' && item.primaryMediaId === cand.id;
                    return (
                      <div
                        key={cand.id}
                        className={`flex flex-col justify-between gap-2 rounded-lg border p-2 text-xs ${
                          isPrimary
                            ? 'border-sky-500 bg-sky-50/50'
                            : 'border-slate-200 bg-slate-50/40'
                        }`}
                      >
                        <div className="space-y-1">
                          <div className="relative h-28 w-full overflow-hidden rounded border border-slate-200 bg-white">
                            <Image
                              src={buildArtifactUrl(runId, cand.artifactRelPath)}
                              alt={cand.captionHint || KIND_LABELS[cand.kind]}
                              fill
                              unoptimized
                              className="object-contain"
                            />
                          </div>
                          <div className="flex items-center justify-between gap-1 text-[11px]">
                            <span className="rounded bg-slate-200/70 px-1.5 py-0.5 font-medium text-slate-700">
                              {KIND_LABELS[cand.kind]}
                            </span>
                            <span className="text-slate-500">推荐分 {cand.score}</span>
                          </div>
                          <p
                            className="line-clamp-2 text-[11px] text-slate-600"
                            title={cand.captionHint || cand.contextSnippet}
                          >
                            {cand.captionHint || cand.contextSnippet || cand.id}
                          </p>
                        </div>

                        <div className="flex flex-wrap items-center gap-1.5">
                          <button
                            type="button"
                            disabled={pending}
                            onClick={() => {
                              const form = new FormData();
                              form.set('runId', runId);
                              form.set('itemId', item.id);
                              form.set('mode', 'custom');
                              form.set('selectedPrimaryMediaId', cand.id);
                              const cap = readCaptionValue(item.id);
                              if (cap !== undefined) form.set('caption', cap);
                              submit(setItemImageAction, form);
                            }}
                            className={`rounded border px-2 py-1 text-[11px] font-medium ${
                              isPrimary
                                ? 'border-sky-600 bg-sky-600 text-white'
                                : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-50'
                            }`}
                          >
                            {isPrimary ? '当前配图' : '选作配图'}
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            ) : null}

            <div className="text-xs">
              <label className="block space-y-1 text-slate-600">
                <span>本地上传配图：</span>
                <input
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file) setImages((current) => ({ ...current, [item.id]: file }));
                  }}
                />
                {images[item.id] ? (
                  <span className="block text-[11px] text-sky-700">
                    已选配图：{images[item.id]?.name}
                  </span>
                ) : null}
              </label>
            </div>

            <p className="text-xs text-slate-500">
              也可点击图片说明输入框后直接 Ctrl/Cmd+V 粘贴截图作为配图。
            </p>

            <input
              id={`caption-${item.id}`}
              maxLength={44}
              defaultValue={item.imageCaption ?? ''}
              placeholder="图片说明（可选，最多 44 字）"
              className="w-full rounded border border-slate-300 px-2 py-1 text-sm"
            />
            <div className="flex flex-wrap gap-2">
              {(['custom', 'none', 'auto'] as const).map((mode) => (
                <button
                  type="button"
                  key={mode}
                  disabled={pending || (mode === 'custom' && !images[item.id])}
                  className="rounded border px-3 py-1 text-xs disabled:opacity-40"
                  onClick={() => {
                    const form = new FormData();
                    form.set('runId', runId);
                    form.set('itemId', item.id);
                    form.set('mode', mode);
                    const image = images[item.id];
                    if (image) form.set('image', image);
                    const cap = readCaptionValue(item.id);
                    if (cap !== undefined) form.set('caption', cap);
                    submit(setItemImageAction, form);
                  }}
                >
                  {mode === 'custom'
                    ? '使用上传图片'
                    : mode === 'none'
                      ? '切换无图'
                      : '恢复自动选图'}
                </button>
              ))}
            </div>
          </div>
        );
      })}
      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 pt-3">
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            form.set('runId', runId);
            submit(setRunBgmAction, form);
          }}
          className="flex flex-wrap items-center gap-2"
        >
          <select
            name="bgmFile"
            defaultValue={bgmFile ?? ''}
            className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs text-slate-900"
            required
          >
            <option value="">选择背景音乐</option>
            {bgmFiles.map((file) => (
              <option key={file} value={file}>
                {file}
              </option>
            ))}
          </select>
          <button
            disabled={pending}
            className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
            type="submit"
          >
            保存音乐
          </button>
        </form>
        <button
          disabled={pending}
          type="button"
          className="rounded-lg bg-slate-900 px-4 py-2 text-xs font-medium text-white shadow-xs transition hover:bg-slate-800 disabled:opacity-50"
          onClick={() => {
            const form = new FormData();
            form.set('runId', runId);
            form.set('fromStage', 'render');
            submit(resumeRunAction, form);
          }}
        >
          重新合成视频
        </button>
      </div>
      {message ? (
        <p
          role="status"
          className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-700"
        >
          {message}
        </p>
      ) : null}
    </section>
  );
}
