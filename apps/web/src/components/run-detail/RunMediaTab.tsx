import type { QaReport, Timeline } from '@aidaily/contracts';
import { ExternalLink, Film, ImageIcon, ShieldCheck, Volume2 } from 'lucide-react';
import Image from 'next/image';
import { buildArtifactUrl } from '@/components/run-detail/artifact-url';
import { formatTimestamp } from '@/lib/format';

/** 音画预览与质检报告页签组件的参数定义 */
export interface RunMediaTabProps {
  runId: string;
  artifacts: string[];
  qaReport: QaReport | null;
  timeline: Timeline | null;
  timezone: string;
}

const KIND_LABEL: Record<'intro' | 'item' | 'outro', string> = {
  intro: '开场导语',
  item: '新闻正文',
  outro: '片尾总结',
};

/** 音画成品预览卡片：优先于顶部展示成片 MP4 播放器、封面预览与核心质检指标 */
export function RunVideoAndCoverSection({
  runId,
  artifacts,
  qaReport,
  timezone,
}: Omit<RunMediaTabProps, 'timeline'>) {
  const hasVideo = artifacts.includes('output/video.mp4');
  const hasCover = artifacts.includes('output/cover.jpg');

  return (
    <div className="space-y-5">
      <div className="grid gap-5 lg:grid-cols-12">
        <section className="rounded-2xl border border-slate-200/90 bg-white p-5 shadow-xs lg:col-span-8">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 pb-3">
            <div className="flex items-center gap-2">
              <Film className="h-4 w-4 text-sky-600" aria-hidden="true" />
              <h3 className="text-sm font-semibold text-slate-900">成片视频预览（MP4）</h3>
            </div>
            {hasVideo ? (
              <a
                href={buildArtifactUrl(runId, 'output/video.mp4')}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1 text-xs font-medium text-sky-700 hover:bg-sky-50"
              >
                <span>新标签页打开 / 下载</span>
                <ExternalLink className="h-3 w-3" aria-hidden="true" />
              </a>
            ) : null}
          </div>
          {hasVideo ? (
            <video
              controls
              preload="metadata"
              src={buildArtifactUrl(runId, 'output/video.mp4')}
              className="mt-4 aspect-video w-full rounded-xl border border-slate-200 bg-black shadow-xs"
            >
              <track
                kind="captions"
                src="data:text/vtt;charset=utf-8,WEBVTT"
                label="内嵌画面字幕"
              />
            </video>
          ) : (
            <div className="mt-4 flex aspect-video items-center justify-center rounded-xl border border-dashed border-slate-200 bg-slate-50 text-xs text-slate-500">
              暂未生成 `output/video.mp4` 成片文件。
            </div>
          )}
        </section>

        <section className="flex flex-col justify-between gap-4 rounded-2xl border border-slate-200/90 bg-white p-5 shadow-xs lg:col-span-4">
          <div>
            <div className="flex items-center justify-between border-b border-slate-100 pb-3">
              <div className="flex items-center gap-2">
                <ImageIcon className="h-4 w-4 text-indigo-600" aria-hidden="true" />
                <h3 className="text-sm font-semibold text-slate-900">视频封面</h3>
              </div>
              {hasCover ? (
                <a
                  href={buildArtifactUrl(runId, 'output/cover.jpg')}
                  target="_blank"
                  rel="noreferrer"
                  className="text-xs font-medium text-sky-700 hover:underline"
                >
                  查看原图
                </a>
              ) : null}
            </div>
            {hasCover ? (
              <div className="mt-4 overflow-hidden rounded-xl border border-slate-200 bg-slate-50">
                <Image
                  src={buildArtifactUrl(runId, 'output/cover.jpg')}
                  alt="本期视频封面"
                  width={1280}
                  height={720}
                  unoptimized
                  className="aspect-video w-full object-contain"
                />
              </div>
            ) : (
              <div className="mt-4 flex aspect-video items-center justify-center rounded-xl border border-dashed border-slate-200 bg-slate-50 text-xs text-slate-500">
                暂未生成封面图 `output/cover.jpg`。
              </div>
            )}
          </div>

          <div className="rounded-xl border border-slate-100 bg-slate-50/90 p-3.5 text-xs">
            <div className="flex items-center justify-between">
              <span className="inline-flex items-center gap-1.5 font-semibold text-slate-800">
                <ShieldCheck className="h-4 w-4 text-slate-500" aria-hidden="true" />
                质检摘要
              </span>
              {qaReport ? (
                <span
                  className={`rounded-full px-2.5 py-0.5 text-[11px] font-medium ${
                    qaReport.passed
                      ? 'bg-emerald-100 text-emerald-800'
                      : 'bg-rose-100 text-rose-800'
                  }`}
                >
                  {qaReport.passed ? '质检通过' : '质检未通过'}
                </span>
              ) : (
                <span className="text-[11px] text-slate-400">未检查</span>
              )}
            </div>
            {qaReport ? (
              <div className="mt-3 grid grid-cols-2 gap-2 text-[11px]">
                <div className="rounded-lg bg-white px-2.5 py-1.5">
                  <span className="block text-slate-400">分辨率 / 帧率</span>
                  <span className="tabular-nums font-mono font-semibold text-slate-900">
                    {qaReport.width}x{qaReport.height} @ {qaReport.fps}fps
                  </span>
                </div>
                <div className="rounded-lg bg-white px-2.5 py-1.5">
                  <span className="block text-slate-400">音画时长</span>
                  <span className="tabular-nums font-mono font-semibold text-slate-900">
                    {qaReport.videoDurationSec.toFixed(1)}s / {qaReport.audioDurationSec.toFixed(1)}
                    s
                  </span>
                </div>
                <div className="rounded-lg bg-white px-2.5 py-1.5">
                  <span className="block text-slate-400">平均音量</span>
                  <span className="tabular-nums font-mono font-semibold text-slate-900">
                    {qaReport.meanVolumeDb !== null
                      ? `${qaReport.meanVolumeDb.toFixed(1)} dB`
                      : '-'}
                  </span>
                </div>
                <div className="rounded-lg bg-white px-2.5 py-1.5">
                  <span className="block text-slate-400">黑屏比例</span>
                  <span className="tabular-nums font-mono font-semibold text-slate-900">
                    {(qaReport.blackRatio * 100).toFixed(1)}%
                  </span>
                </div>
                <div className="col-span-2 text-right text-[10px] text-slate-400">
                  检查于 {formatTimestamp(qaReport.checkedAt, timezone)}
                </div>
              </div>
            ) : (
              <p className="mt-2 text-[11px] text-slate-500">成片合成后将自动执行音画质量检查。</p>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}

/** 详细质检项排查表与分段时间轴明细组件 */
export function RunQaAndTimelineSection({
  runId,
  qaReport,
  timeline,
  timezone,
}: Omit<RunMediaTabProps, 'artifacts'>) {
  return (
    <div className="space-y-5">
      <section className="rounded-2xl border border-slate-200/90 bg-white p-5 shadow-xs">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 pb-3">
          <h3 className="text-sm font-semibold text-slate-900">成片自动质量检查明细</h3>
          {qaReport ? (
            <span className="text-xs text-slate-500">
              检查时间：{formatTimestamp(qaReport.checkedAt, timezone)}
            </span>
          ) : null}
        </div>

        {!qaReport ? (
          <p className="mt-3 text-xs text-slate-500">尚未生成质量检查报告。</p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="min-w-full divide-y divide-slate-200 text-left text-xs">
              <thead className="bg-slate-50 text-slate-600">
                <tr>
                  <th className="px-3 py-2.5 font-medium">检查项目</th>
                  <th className="px-3 py-2.5 font-medium">结果</th>
                  <th className="px-3 py-2.5 font-medium">说明</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {qaReport.checks.map((chk) => (
                  <tr key={chk.name} className="hover:bg-slate-50/70">
                    <td className="px-3 py-2 font-mono text-slate-900">{chk.name}</td>
                    <td className="px-3 py-2">
                      <span
                        className={`inline-block rounded-full px-2 py-0.5 text-[11px] font-medium ${
                          chk.passed
                            ? 'bg-emerald-100 text-emerald-800'
                            : 'bg-rose-100 text-rose-800'
                        }`}
                      >
                        {chk.passed ? '通过' : '不通过'}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-slate-700">{chk.detail}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="rounded-2xl border border-slate-200/90 bg-white p-5 shadow-xs">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 pb-3">
          <div className="flex items-center gap-2">
            <Volume2 className="h-4 w-4 text-sky-600" aria-hidden="true" />
            <h3 className="text-sm font-semibold text-slate-900">音画时间轴与分段配音试听</h3>
          </div>
          {timeline ? (
            <span className="tabular-nums text-xs text-slate-600">
              总时长：{(timeline.totalMs / 1000).toFixed(2)} 秒 · 共 {timeline.sections.length} 段
            </span>
          ) : null}
        </div>
        {!timeline ? (
          <p className="mt-3 text-xs text-slate-500">尚未生成音画时间轴 `timeline.json`。</p>
        ) : (
          <div className="mt-3 space-y-3">
            {timeline.sections.map((sec) => (
              <div
                key={sec.key}
                className="space-y-2 rounded-xl border border-slate-200 bg-slate-50/70 p-3.5 text-xs"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span className="rounded-md bg-white px-2 py-0.5 font-medium text-slate-800 shadow-2xs">
                      {KIND_LABEL[sec.kind]}
                    </span>
                    <span className="font-mono text-slate-700">{sec.key}</span>
                    {sec.itemId ? (
                      <span className="font-mono text-[11px] text-slate-500">({sec.itemId})</span>
                    ) : null}
                  </div>
                  <span className="tabular-nums font-mono text-[11px] text-slate-600">
                    起始 {(sec.startMs / 1000).toFixed(2)}s · 语音{' '}
                    {(sec.speechMs / 1000).toFixed(2)}s · 整页 {(sec.pageMs / 1000).toFixed(2)}s
                  </span>
                </div>

                <audio
                  controls
                  preload="none"
                  src={buildArtifactUrl(runId, sec.audioFile)}
                  className="h-8 w-full"
                >
                  <track
                    kind="captions"
                    src="data:text/vtt;charset=utf-8,WEBVTT"
                    label="口播字幕文本"
                  />
                </audio>

                <ul className="space-y-0.5 text-[11px] leading-relaxed text-slate-700">
                  {(() => {
                    const seenSentences = new Map<string, number>();
                    return sec.sentences.map((s) => {
                      const baseKey = `${sec.key}-${s.startMs}-${s.text}`;
                      const count = (seenSentences.get(baseKey) ?? 0) + 1;
                      seenSentences.set(baseKey, count);
                      return (
                        <li key={`${baseKey}-${count}`}>
                          <span className="tabular-nums font-mono text-slate-400">
                            [{(s.startMs / 1000).toFixed(2)}s]
                          </span>{' '}
                          {s.text}
                        </li>
                      );
                    });
                  })()}
                </ul>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

/** 音画预览与质检页签：组合顶部成片封面预览与下方质检时间轴明细 */
export function RunMediaTab({ runId, artifacts, qaReport, timeline, timezone }: RunMediaTabProps) {
  return (
    <div className="space-y-5">
      <RunVideoAndCoverSection
        runId={runId}
        artifacts={artifacts}
        qaReport={qaReport}
        timezone={timezone}
      />
      <RunQaAndTimelineSection
        runId={runId}
        qaReport={qaReport}
        timeline={timeline}
        timezone={timezone}
      />
    </div>
  );
}
