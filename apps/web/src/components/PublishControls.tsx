'use client';

import type { PublishDraft, PublishRecord, RunStatus } from '@aidaily/contracts';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import {
  approvePublishAction,
  confirmUncertainAction,
  markConsumedAction,
  rejectPublishAction,
  retryPublishAction,
  updateDraftAction,
} from '@/app/actions';
import { countCodepoints, PUBLISH_STATUS_TEXT } from '@/lib/format';

/** 发布审核页签的客户端交互组件：支持标题简介编辑及字数实时统计、确认投稿、驳回、仅消费与状态待确认人工定案 */
export function PublishControls({
  runId,
  runStatus,
  mediaDirty,
  draft,
  publishRecord,
  limits,
}: {
  runId: string;
  runStatus: RunStatus;
  mediaDirty?: boolean;
  draft: PublishDraft | null;
  publishRecord: PublishRecord | null;
  limits: { titleMax: number; descMax: number; tagsMax: number };
}) {
  const router = useRouter();
  const initialTitle = draft?.title ?? publishRecord?.title ?? '';
  const initialDescription = draft?.description ?? publishRecord?.description ?? '';
  const initialTagsText = (draft?.tags ?? publishRecord?.tags ?? []).join(', ');

  const [title, setTitle] = useState(initialTitle);
  const [description, setDescription] = useState(initialDescription);
  const [tagsText, setTagsText] = useState(initialTagsText);
  const [rejectReason, setRejectReason] = useState('');
  const [bvidInput, setBvidInput] = useState('');
  const [feedback, setFeedback] = useState<{ ok: boolean; text: string } | null>(null);
  const [isPending, startTransition] = useTransition();

  const titleCount = countCodepoints(title.trim());
  const descCount = countCodepoints(description.trim());
  const tagList = Array.from(
    new Set(
      tagsText
        .split(/[,，\n]/)
        .map((t) => t.trim())
        .filter(Boolean),
    ),
  );
  const canEdit = runStatus === 'awaiting_review' || runStatus === 'publish_failed';
  const isDirty =
    title !== initialTitle || description !== initialDescription || tagsText !== initialTagsText;

  const buildDraftFormData = () => {
    const fd = new FormData();
    fd.set('runId', runId);
    fd.set('title', title);
    fd.set('description', description);
    fd.set('tags', tagsText);
    return fd;
  };

  const runAction = (fn: () => Promise<{ ok: boolean; message?: string; error?: string }>) => {
    setFeedback(null);
    startTransition(async () => {
      const res = await fn();
      setFeedback({
        ok: res.ok,
        text: res.ok ? (res.message ?? '操作成功') : (res.error ?? '操作失败'),
      });
      router.refresh();
    });
  };

  const runActionWithAutoSave = (
    fn: () => Promise<{ ok: boolean; message?: string; error?: string }>,
  ) => {
    runAction(async () => {
      if (isDirty) {
        const saved = await updateDraftAction(buildDraftFormData());
        if (!saved.ok) {
          return saved;
        }
      }
      return fn();
    });
  };

  const handleSaveDraft = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    runAction(() => updateDraftAction(buildDraftFormData()));
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-slate-200/90 bg-white p-4.5 shadow-xs">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-slate-900">投稿状态</span>
            <span className="rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-medium text-slate-700">
              {publishRecord
                ? (PUBLISH_STATUS_TEXT[publishRecord.status] ?? publishRecord.status)
                : '未生成草稿'}
            </span>
            <span className="rounded-full border border-indigo-200 bg-indigo-50 px-2.5 py-0.5 text-xs font-medium text-indigo-700">
              AI 生成内容声明：已强制开启
            </span>
          </div>
          {publishRecord?.bvid && (
            <p className="text-xs text-emerald-700">
              已绑定稿件 BV 号：
              <a
                href={`https://www.bilibili.com/video/${publishRecord.bvid}`}
                target="_blank"
                rel="noreferrer"
                className="font-semibold underline"
              >
                {publishRecord.bvid}
              </a>
            </p>
          )}
          {publishRecord?.error && (
            <p className="text-xs text-rose-700">最近投稿错误：{publishRecord.error}</p>
          )}
        </div>
        {publishRecord && (
          <span className="text-xs text-slate-500">已尝试上传 {publishRecord.attempts} 次</span>
        )}
      </div>

      {mediaDirty && (
        <div className="rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
          画面或音乐已修改，请先在音画预览页重新合成并完成质检。
        </div>
      )}
      {runStatus === 'publish_uncertain' && (
        <div className="rounded-xl border border-rose-300 bg-rose-50 p-5 shadow-sm">
          <h3 className="text-sm font-semibold text-rose-900">
            上传中途中断，平台收稿结果待人工核实（已锁定禁止自动重传）
          </h3>
          <p className="mt-1 text-xs leading-relaxed text-rose-800">
            请先登录 B 站创作平台检查该期视频是否已经上传成功。根据核实结果选择下方任一项操作：
          </p>
          <div className="mt-4 grid gap-4 md:grid-cols-2">
            <div className="rounded-lg border border-rose-200 bg-white p-4">
              <p className="text-xs font-medium text-slate-800">情况一：B 站后台没有该稿件</p>
              <button
                type="button"
                disabled={isPending}
                onClick={() => {
                  const fd = new FormData();
                  fd.set('runId', runId);
                  fd.set('outcome', 'not_published');
                  runAction(() => confirmUncertainAction(fd));
                }}
                className="mt-3 rounded-lg bg-slate-900 px-3.5 py-2 text-xs font-medium text-white hover:bg-slate-800 disabled:opacity-50"
              >
                确认未发布，解锁为可重试
              </button>
            </div>
            <div className="rounded-lg border border-rose-200 bg-white p-4">
              <p className="text-xs font-medium text-slate-800">情况二：B 站后台已收到该稿件</p>
              <div className="mt-2 flex gap-2">
                <input
                  type="text"
                  value={bvidInput}
                  onChange={(e) => setBvidInput(e.target.value)}
                  placeholder="填写 BV 号，例如 BV1xx..."
                  className="flex-1 rounded-lg border border-slate-300 px-3 py-1.5 text-xs"
                />
                <button
                  type="button"
                  disabled={isPending}
                  onClick={() => {
                    const fd = new FormData();
                    fd.set('runId', runId);
                    fd.set('outcome', 'published');
                    fd.set('bvid', bvidInput);
                    runAction(() => confirmUncertainAction(fd));
                  }}
                  className="rounded-lg bg-emerald-700 px-3.5 py-1.5 text-xs font-medium text-white hover:bg-emerald-600 disabled:opacity-50"
                >
                  确认已发布
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {draft || publishRecord ? (
        <form
          onSubmit={handleSaveDraft}
          className="space-y-4 rounded-2xl border border-slate-200/90 bg-white p-5 shadow-xs"
        >
          <div>
            <div className="flex items-center justify-between">
              <label htmlFor="pub-title" className="text-sm font-medium text-slate-700">
                投稿标题
              </label>
              <span
                className={`text-xs ${titleCount > limits.titleMax ? 'font-semibold text-rose-600' : 'text-slate-500'}`}
              >
                {titleCount} / {limits.titleMax} 字
              </span>
            </div>
            <input
              id="pub-title"
              type="text"
              disabled={!canEdit}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="mt-1.5 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 disabled:bg-slate-50"
            />
          </div>

          <div>
            <div className="flex items-center justify-between">
              <label htmlFor="pub-desc" className="text-sm font-medium text-slate-700">
                视频简介（含章节时间轴与 AI 声明）
              </label>
              <span
                className={`text-xs ${descCount > limits.descMax ? 'font-semibold text-rose-600' : 'text-slate-500'}`}
              >
                {descCount} / {limits.descMax} 字
              </span>
            </div>
            <textarea
              id="pub-desc"
              rows={10}
              disabled={!canEdit}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="mt-1.5 w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-xs leading-5 text-slate-900 disabled:bg-slate-50"
            />
          </div>

          <div>
            <div className="flex items-center justify-between">
              <label htmlFor="pub-tags" className="text-sm font-medium text-slate-700">
                标签列表（逗号分隔）
              </label>
              <span
                className={`text-xs ${tagList.length > limits.tagsMax ? 'font-semibold text-rose-600' : 'text-slate-500'}`}
              >
                {tagList.length} / {limits.tagsMax} 个
              </span>
            </div>
            <input
              id="pub-tags"
              type="text"
              disabled={!canEdit}
              value={tagsText}
              onChange={(e) => setTagsText(e.target.value)}
              className="mt-1.5 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 disabled:bg-slate-50"
            />
          </div>

          {canEdit && (
            <div className="space-y-2 pt-2">
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="submit"
                  disabled={isPending}
                  className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-xs font-medium text-slate-800 hover:bg-slate-50 disabled:opacity-50"
                >
                  保存修改文案
                </button>

                {runStatus === 'awaiting_review' && (
                  <button
                    type="button"
                    disabled={isPending || mediaDirty}
                    onClick={() => {
                      const fd = new FormData();
                      fd.set('runId', runId);
                      runActionWithAutoSave(() => approvePublishAction(fd));
                    }}
                    className="rounded-lg bg-slate-900 px-4 py-2 text-xs font-medium text-white hover:bg-slate-800 disabled:opacity-50"
                  >
                    确认审核通过并投稿 B 站
                  </button>
                )}

                {runStatus === 'publish_failed' && (
                  <button
                    type="button"
                    disabled={isPending || mediaDirty}
                    onClick={() => {
                      const fd = new FormData();
                      fd.set('runId', runId);
                      runActionWithAutoSave(() => retryPublishAction(fd));
                    }}
                    className="rounded-lg bg-slate-900 px-4 py-2 text-xs font-medium text-white hover:bg-slate-800 disabled:opacity-50"
                  >
                    重试投稿 B 站
                  </button>
                )}

                <button
                  type="button"
                  disabled={isPending}
                  onClick={() => {
                    const fd = new FormData();
                    fd.set('runId', runId);
                    runActionWithAutoSave(() => markConsumedAction(fd));
                  }}
                  className="rounded-lg border border-emerald-600 bg-emerald-600 px-4 py-2 text-xs font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
                >
                  审核通过（不上传视频）
                </button>
              </div>
              <p className="text-xs text-slate-500">
                点击「审核通过（不上传视频）」会保存文案修改、把本期新闻记入已播历史并标记任务完成，但不会向
                B 站上传视频。
              </p>
            </div>
          )}
        </form>
      ) : (
        <div className="space-y-3 rounded-xl border border-slate-200 bg-white p-5 text-sm text-slate-600 shadow-sm">
          <p>整期编排与时间轴尚未生成，完成后此处将显示待审核投稿草稿。</p>
          {canEdit && (
            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                disabled={isPending}
                onClick={() => {
                  const fd = new FormData();
                  fd.set('runId', runId);
                  runAction(() => markConsumedAction(fd));
                }}
                className="rounded-lg border border-emerald-600 bg-emerald-600 px-4 py-2 text-xs font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
              >
                审核通过（不上传视频）
              </button>
              <span className="text-xs text-slate-500">
                仅将本期新闻记入已播历史并标记任务完成，不向 B 站上传视频。
              </span>
            </div>
          )}
        </div>
      )}

      {canEdit && (
        <div className="rounded-2xl border border-slate-200/90 bg-white p-4.5 shadow-xs">
          <div className="flex flex-wrap items-center gap-2">
            <input
              type="text"
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
              placeholder="填写驳回原因（可选）"
              className="flex-1 rounded-lg border border-slate-300 px-3 py-1.5 text-xs text-slate-900"
            />
            <button
              type="button"
              disabled={isPending}
              onClick={() => {
                const fd = new FormData();
                fd.set('runId', runId);
                fd.set('reason', rejectReason);
                runAction(() => rejectPublishAction(fd));
              }}
              className="rounded-lg border border-rose-300 bg-white px-3.5 py-1.5 text-xs font-medium text-rose-700 hover:bg-rose-50 disabled:opacity-50"
            >
              驳回本期并释放文章
            </button>
          </div>
        </div>
      )}

      {feedback && (
        <div
          className={`rounded-lg border px-4 py-2.5 text-xs ${
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
