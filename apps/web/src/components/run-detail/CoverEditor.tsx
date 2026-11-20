'use client';

import Image from 'next/image';
import { useRouter } from 'next/navigation';
import { useEffect, useState, useTransition } from 'react';
import { updateCoverAction } from '@/app/actions';
import { buildArtifactUrl } from '@/components/run-detail/artifact-url';

/** 封面文字来源的中文说明 */
const SOURCE_TEXT: Record<'manual' | 'package' | 'fallback', string> = {
  manual: '人工修改',
  package: 'AI 编排生成',
  fallback: '由头条导语自动截取',
};

/** 统计封面文字字数：按完整字符计，不计用于高亮的星号与换行符 */
function coverLength(text: string): number {
  return Array.from(
    text
      .trim()
      .replace(/\\n/g, '')
      .replace(/[*\r\n]/g, ''),
  ).length;
}

/** 计算封面主标题的非空行数，用于校验手动换行次数 */
function countTitleLines(text: string): number {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/\\n/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0).length;
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

  useEffect(() => {
    setTitle(cover?.title ?? '');
    setSubtitle(cover?.subtitle ?? '');
  }, [cover?.title, cover?.subtitle]);

  if (!cover) {
    return (
      <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <h3 className="text-sm font-semibold text-slate-900">视频封面</h3>
        <p className="mt-2 text-xs text-slate-500">本期尚未完成整期编排，暂无封面文字。</p>
      </section>
    );
  }

  const titleCount = coverLength(title);
  const titleLines = countTitleLines(title);
  const subtitleCount = coverLength(subtitle);
  const titleOver = titleCount > cover.limits.titleMax;
  const titleTooManyLines = titleLines > 3;
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
    <section className="rounded-2xl border border-slate-200/90 bg-white p-5 shadow-xs">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 pb-3">
        <h3 className="text-sm font-semibold text-slate-900">视频封面预览与文字调整</h3>
        <span className="rounded-full bg-slate-100 px-2.5 py-0.5 text-[11px] font-medium text-slate-600">
          来源：{SOURCE_TEXT[cover.source]}
        </span>
      </div>
      <div className="mt-4 space-y-4">
        <div>
          {imageUrl ? (
            <div className="overflow-hidden rounded-xl border border-slate-200 bg-slate-950/5">
              <Image
                src={imageUrl}
                alt="本期视频封面"
                width={1920}
                height={1080}
                unoptimized
                className="aspect-video w-full object-contain"
              />
            </div>
          ) : (
            <div className="flex aspect-video items-center justify-center rounded-xl border border-dashed border-slate-200 bg-slate-50 text-xs text-slate-500">
              尚未生成封面图片，合成视频时会自动生成。
            </div>
          )}
        </div>
        <form onSubmit={handleSubmit} className="space-y-3.5">
          <label className="block space-y-1">
            <span className="flex items-center justify-between text-xs font-medium text-slate-700">
              主标题（大字，支持按回车手动换行）
              <span
                className={
                  titleOver || titleTooManyLines
                    ? 'tabular-nums text-rose-600'
                    : 'tabular-nums text-slate-400'
                }
              >
                {titleCount}/{cover.limits.titleMax}
                {titleLines > 1 ? ` · ${titleLines}/3 行` : ''}
              </span>
            </span>
            <textarea
              rows={2}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              disabled={!editable || pending}
              placeholder={'例如：英伟达\n*停发*H200'}
              className="w-full resize-none rounded-lg border border-slate-300 px-3 py-2 text-sm leading-snug focus:border-sky-500 focus:outline-none disabled:bg-slate-50"
            />
            <span className="block text-[11px] leading-relaxed text-slate-500">
              用一对 *星号* 包住要高亮的词，按回车可手动控制换行位置（最多 3 行，如
              英伟达↵*停发*H200）
            </span>
            {titleTooManyLines ? (
              <span className="block text-[11px] text-rose-600">
                封面主标题最多分 3 行（当前 {titleLines} 行）
              </span>
            ) : null}
          </label>
          <label className="block space-y-1">
            <span className="flex items-center justify-between text-xs font-medium text-slate-700">
              副标题（一句话钩子，可留空）
              <span
                className={
                  subtitleOver ? 'tabular-nums text-rose-600' : 'tabular-nums text-slate-400'
                }
              >
                {subtitleCount}/{cover.limits.subtitleMax}
              </span>
            </span>
            <input
              value={subtitle}
              onChange={(e) => setSubtitle(e.target.value)}
              disabled={!editable || pending}
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-sky-500 focus:outline-none disabled:bg-slate-50"
            />
          </label>
          <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
            <button
              type="submit"
              disabled={
                !editable ||
                pending ||
                !isDirty ||
                !title.trim() ||
                titleOver ||
                titleTooManyLines ||
                subtitleOver
              }
              className="rounded-lg bg-slate-900 px-4 py-2 text-xs font-medium text-white shadow-xs transition hover:bg-slate-800 disabled:opacity-40"
            >
              {pending ? '正在重新生成封面…' : '保存并重新生成封面'}
            </button>
            <p className="text-[11px] text-slate-500">
              {!editable ? '仅待审核、失败或已发布任务可改封面' : '只重绘封面图片，不重合成视频'}
            </p>
          </div>
          {feedback ? (
            <p
              className={`rounded-lg border px-3 py-2 text-xs ${
                feedback.ok
                  ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                  : 'border-rose-200 bg-rose-50 text-rose-700'
              }`}
            >
              {feedback.text}
            </p>
          ) : null}
        </form>
      </div>
    </section>
  );
}
