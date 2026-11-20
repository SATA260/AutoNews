'use client';

import type { NarrationSectionView, RunStatus } from '@aidaily/contracts';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import {
  resetSectionNarrationAction,
  resumeRunAction,
  updateSectionNarrationAction,
} from '@/app/actions';
import { buildArtifactUrl } from '@/components/run-detail/artifact-url';

/** 分段配音编辑器的参数：当前文案、可选引擎，以及是否需要继续合成视频 */
export interface NarrationSectionEditorProps {
  runId: string;
  sections: NarrationSectionView[];
  providers: string[];
  runStatus: RunStatus;
  mediaDirty: boolean;
  renderStale: boolean;
}

/** 某一段的语音文本、画面字幕和引擎选择 */
function SectionCard({
  runId,
  section,
  providers,
}: {
  runId: string;
  section: NarrationSectionView;
  providers: string[];
}) {
  const router = useRouter();
  const [ttsText, setTtsText] = useState(section.ttsText);
  const [subtitleText, setSubtitleText] = useState(section.subtitleText);
  const [provider, setProvider] = useState(section.provider);
  const [feedback, setFeedback] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, startTransition] = useTransition();
  const providerChoices = providers.includes(section.provider)
    ? providers
    : [section.provider, ...providers];

  /** 提交这一段的文本。重新生成会换音频，只保存字幕则保留现有音频 */
  const save = (regenerateAudio: boolean) => {
    setFeedback(null);
    const form = new FormData();
    form.set('runId', runId);
    form.set('sectionKey', section.key);
    form.set('ttsText', ttsText);
    form.set('subtitleText', subtitleText);
    form.set('provider', provider);
    form.set('regenerateAudio', regenerateAudio ? 'true' : 'false');
    startTransition(async () => {
      const result = await updateSectionNarrationAction(form);
      setFeedback({
        ok: result.ok,
        text: result.ok ? (result.message ?? '已保存') : (result.error ?? '保存失败'),
      });
      if (result.ok) router.refresh();
    });
  };

  /** 丢掉人工修改，按这一段的原稿重新配音 */
  const reset = () => {
    setFeedback(null);
    const form = new FormData();
    form.set('runId', runId);
    form.set('sectionKey', section.key);
    startTransition(async () => {
      const result = await resetSectionNarrationAction(form);
      setFeedback({
        ok: result.ok,
        text: result.ok ? (result.message ?? '已恢复原稿') : (result.error ?? '恢复失败'),
      });
      if (result.ok) router.refresh();
    });
  };

  return (
    <article className="space-y-3 rounded-lg border border-slate-200 bg-slate-50 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-xs">
          <span className="rounded bg-white px-2 py-0.5 font-medium text-slate-800">
            {section.label}
          </span>
          <span className="font-mono text-slate-500">{section.key}</span>
          {section.hasOverride ? (
            <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[11px] text-amber-800">
              已手动调整
            </span>
          ) : null}
        </div>
        {section.speechMs !== null ? (
          <span className="font-mono text-[11px] text-slate-500">
            音频 {(section.speechMs / 1000).toFixed(2)} 秒
          </span>
        ) : null}
      </div>

      {section.audioFile ? (
        <audio
          controls
          preload="none"
          src={buildArtifactUrl(runId, section.audioFile)}
          className="h-8 w-full"
        >
          <track kind="captions" src="data:text/vtt;charset=utf-8,WEBVTT" label="本段字幕" />
        </audio>
      ) : (
        <p className="text-[11px] text-slate-500">这一段还没有音频，请先重新生成本段音频。</p>
      )}

      <div className="grid gap-3 md:grid-cols-2">
        <label className="block text-xs font-medium text-slate-700">
          语音用的文本
          <textarea
            value={ttsText}
            onChange={(event) => setTtsText(event.target.value)}
            rows={5}
            className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-xs font-normal leading-5"
          />
        </label>
        <label className="block text-xs font-medium text-slate-700">
          字幕展示的文本
          <textarea
            value={subtitleText}
            onChange={(event) => setSubtitleText(event.target.value)}
            rows={5}
            className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-xs font-normal leading-5"
          />
        </label>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={pending}
          onClick={() => setSubtitleText(ttsText)}
          className="rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-[11px] text-slate-700 hover:bg-slate-100 disabled:opacity-50"
        >
          复制语音到字幕
        </button>
        <button
          type="button"
          disabled={pending}
          onClick={() => setTtsText(subtitleText)}
          className="rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-[11px] text-slate-700 hover:bg-slate-100 disabled:opacity-50"
        >
          复制字幕到语音
        </button>
        <label className="ml-auto flex items-center gap-2 text-[11px] text-slate-600">
          语音引擎
          <select
            value={provider}
            onChange={(event) => setProvider(event.target.value)}
            className="rounded-lg border border-slate-300 bg-white px-2 py-1 text-xs"
          >
            {providerChoices.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={pending}
          onClick={() => save(true)}
          className="rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-800 disabled:opacity-50"
        >
          {pending ? '处理中…' : '重新生成本段音频'}
        </button>
        <button
          type="button"
          disabled={pending || !section.audioFile}
          onClick={() => save(false)}
          className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-50"
        >
          仅保存字幕文本
        </button>
        <button
          type="button"
          disabled={pending || !section.hasOverride}
          onClick={reset}
          className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-50"
        >
          恢复原稿
        </button>
      </div>

      {feedback ? (
        <p
          role={feedback.ok ? 'status' : 'alert'}
          className={`text-xs ${feedback.ok ? 'text-emerald-700' : 'text-rose-700'}`}
        >
          {feedback.text}
        </p>
      ) : null}
    </article>
  );
}

/** 分段试听并分别修改语音文本和画面字幕，满意后继续合成整期视频 */
export function NarrationSectionEditor({
  runId,
  sections,
  providers,
  runStatus,
  mediaDirty,
  renderStale,
}: NarrationSectionEditorProps) {
  const router = useRouter();
  const [feedback, setFeedback] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, startTransition] = useTransition();
  const needsVideo = runStatus === 'awaiting_audio_review' || mediaDirty || renderStale;
  const continueLabel =
    runStatus === 'awaiting_audio_review' && !mediaDirty && !renderStale
      ? '继续合成视频'
      : '重新合成视频';

  /** 从当前进度继续做视频。已完成的任务会先备份旧成片 */
  const continueRender = () => {
    setFeedback(null);
    const form = new FormData();
    form.set('runId', runId);
    startTransition(async () => {
      const result = await resumeRunAction(form);
      setFeedback({
        ok: result.ok,
        text: result.ok ? (result.message ?? '已开始合成视频') : (result.error ?? '合成未能开始'),
      });
      if (result.ok) router.refresh();
    });
  };

  return (
    <section className="space-y-4 rounded-2xl border border-slate-200/90 bg-white p-5 shadow-xs">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-100 pb-3">
        <div>
          <h3 className="text-sm font-semibold text-slate-900">分段配音与字幕调整</h3>
          <p className="mt-1 text-xs leading-5 text-slate-600">
            左边改读音，右边改画面字幕（每行一句）。只改字幕不重做配音；修改读音或切换引擎后再重新生成本段。
          </p>
        </div>
      </div>

      {needsVideo ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-sky-200 bg-sky-50 px-3 py-2">
          <p className="text-xs text-sky-900">
            {runStatus === 'awaiting_audio_review' && !mediaDirty && !renderStale
              ? '配音已经完成。试听满意后，再合成整期视频。'
              : runStatus === 'published'
                ? '配音、字幕或画面有改动。确认后重新合成视频，旧成片会备份。'
                : '配音、字幕或画面有改动。确认后重新合成视频。'}
          </p>
          <button
            type="button"
            disabled={pending}
            onClick={continueRender}
            className="rounded-lg bg-sky-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-sky-800 disabled:opacity-50"
          >
            {pending ? '正在启动…' : continueLabel}
          </button>
        </div>
      ) : null}
      {feedback ? (
        <p
          role={feedback.ok ? 'status' : 'alert'}
          className={`text-xs ${feedback.ok ? 'text-emerald-700' : 'text-rose-700'}`}
        >
          {feedback.text}
        </p>
      ) : null}

      <div className="space-y-3">
        {sections.map((section) => (
          <SectionCard
            key={`${section.key}:${section.ttsText}:${section.subtitleText}:${section.provider}:${section.speechMs ?? 0}`}
            runId={runId}
            section={section}
            providers={providers}
          />
        ))}
      </div>
    </section>
  );
}
