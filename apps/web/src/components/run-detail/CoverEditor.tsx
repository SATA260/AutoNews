'use client';

import Image from 'next/image';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { updateCoverAction } from '@/app/actions';
import { buildArtifactUrl } from '@/components/run-detail/artifact-url';

/** 封面文字来源的中文说明 */
const SOURCE_TEXT: Record<'manual' | 'package' | 'fallback', string> = {
  manual: '人工修改',
  package: 'AI 编排生成',
  fallback: '由头条导语自动截取',
};

/** 统计封面文字字数：按完整字符计，不计用于高亮的星号 */
function coverLength(text: string): number {
  return Array.from(text.trim().replace(/\*/g, '')).length;
}

/** 封面编辑卡片：预览当前封面，修改主标题与副标题后只重新生成封面图片 */
export function CoverEditor({
  runId,
  editable,
  cover,
}: {
  runId: string;
  editable: boolean;
  cover: {
    title: string;
    subtitle: string;
    source: 'manual' | 'package' | 'fallback';
    limits: { titleMax: number; subtitleMax: number };
    coverUpdatedAt: string | null;
  } | null;
}) {
  const router = useRouter();
  const [title, setTitle] = useState(cover?.title ?? '');
  const [subtitle, setSubtitle] = useState(cover?.subtitle ?? '');
  const [feedback, setFeedback] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, startTransition] = useTransition();

  if (!cover) {
    return (
      <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <h3 className="text-sm font-semibold text-slate-900">视频封面</h3>
        <p className="mt-2 text-xs text-slate-500">本期尚未完成整期编排，暂无封面文字。</p>
      </section>
    );
  }

  const titleCount = coverLength(title);
  const subtitleCount = coverLength(subtitle);
  const titleOver = titleCount > cover.limits.titleMax;
  const subtitleOver = subtitleCount > cover.limits.subtitleMax;
  const isDirty = title !== cover.title || subtitle !== cover.subtitle;
  // 用封面生成时间作为图片地址参数，保证重新出图后浏览器显示新图
  const imageUrl = cover.coverUpdatedAt
    ? `${buildArtifactUrl(runId, 'output/cover.jpg')}?v=${encodeURIComponent(cover.coverUpdatedAt)}`
    : null;

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setFeedback(null);
    const form = new FormData();
    form.set('runId', runId);
    form.set('title', title);
    form.set('subtitle', subtitle);
    startTransition(async () => {
      const res = await updateCoverAction(form);
      setFeedback({
        ok: res.ok,
        text: res.ok ? (res.message ?? '封面已更新') : (res.error ?? '封面更新失败'),
      });
      if (res.ok) router.refresh();
    });
  };

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-slate-900">视频封面（上传 B 站时使用）</h3>
        <span className="rounded-full bg-slate-100 px-2.5 py-0.5 text-xs text-slate-600">
          当前文字来源：{SOURCE_TEXT[cover.source]}
        </span>
      </div>
      <div className="mt-4 grid gap-5 lg:grid-cols-5">
        <div className="lg:col-span-3">
          {imageUrl ? (
            <Image
              src={imageUrl}
              alt="本期视频封面"
              width={1920}
              height={1080}
              unoptimized
              className="w-full rounded-lg border border-slate-200 object-contain"
            />
          ) : (
            <div className="flex aspect-video items-center justify-center rounded-lg border border-dashed border-slate-200 bg-slate-50 text-xs text-slate-500">
              尚未生成封面图片，合成视频时会自动生成。
            </div>
          )}
        </div>
        <form onSubmit={handleSubmit} className="space-y-4 lg:col-span-2">
          <label className="block space-y-1">
            <span className="flex items-center justify-between text-xs font-medium text-slate-700">
              主标题（大字）
              <span className={titleOver ? 'text-rose-600' : 'text-slate-400'}>
                {titleCount}/{cover.limits.titleMax}
              </span>
            </span>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              disabled={!editable || pending}
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm disabled:bg-slate-50"
            />
            <span className="block text-[11px] text-slate-500">
              用一对 *星号* 包住要高亮的词，如 GPT-6.2 *翻车了*
            </span>
          </label>
          <label className="block space-y-1">
            <span className="flex items-center justify-between text-xs font-medium text-slate-700">
              副标题（一句话钩子，可留空）
              <span className={subtitleOver ? 'text-rose-600' : 'text-slate-400'}>
                {subtitleCount}/{cover.limits.subtitleMax}
              </span>
            </span>
            <input
              value={subtitle}
              onChange={(e) => setSubtitle(e.target.value)}
              disabled={!editable || pending}
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm disabled:bg-slate-50"
            />
          </label>
          <button
            type="submit"
            disabled={
              !editable || pending || !isDirty || !title.trim() || titleOver || subtitleOver
            }
            className="rounded-lg bg-slate-900 px-4 py-2 text-xs font-medium text-white disabled:opacity-40"
          >
            {pending ? '正在重新生成封面…' : '保存并重新生成封面'}
          </button>
          {!editable ? (
            <p className="text-xs text-slate-500">只有待审核、投稿失败或已发布的任务可以修改封面。</p>
          ) : (
            <p className="text-xs text-slate-500">只重新生成封面图片，不会重新合成视频。</p>
          )}
          {feedback ? (
            <p className={`text-xs ${feedback.ok ? 'text-emerald-700' : 'text-rose-700'}`}>
              {feedback.text}
            </p>
          ) : null}
        </form>
      </div>
    </section>
  );
}
