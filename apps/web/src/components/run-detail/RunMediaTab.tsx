import type { QaReport, Timeline } from '@aidaily/contracts';
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

/** 音画预览与质检页签：在线流式预览成品 MP4、封面图片、逐项画质检查及按分段时间轴分段试听音频 */
export function RunMediaTab({ runId, artifacts, qaReport, timeline, timezone }: RunMediaTabProps) {
  const hasVideo = artifacts.includes('output/video.mp4');
  const hasCover = artifacts.includes('output/cover.jpg');

  return (
    <div className="space-y-6">
      <div className="grid gap-6 lg:grid-cols-3">
        <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-xs lg:col-span-2">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-slate-900">成片视频预览（MP4）</h3>
            {hasVideo ? (
              <a
                href={buildArtifactUrl(runId, 'output/video.mp4')}
                target="_blank"
                rel="noreferrer"
                className="text-xs font-medium text-sky-700 hover:underline"
              >
                新标签页打开 / 下载
              </a>
            ) : null}
          </div>
          {hasVideo ? (
            <video
              controls
              preload="metadata"
              src={buildArtifactUrl(runId, 'output/video.mp4')}
              className="mt-3 aspect-video w-full rounded-lg border border-slate-200 bg-black"
            >
              <track
                kind="captions"
                src="data:text/vtt;charset=utf-8,WEBVTT"
                label="内嵌画面字幕"
              />
            </video>
          ) : (
            <div className="mt-3 rounded-lg border border-dashed border-slate-200 bg-slate-50 p-10 text-center text-xs text-slate-500">
              暂未生成 `output/video.mp4` 成片文件。
            </div>
          )}
        </section>

        <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-xs">
          <h3 className="text-sm font-semibold text-slate-900">视频封面预览</h3>
          {hasCover ? (
            <div className="mt-3 space-y-2">
              <Image
                src={buildArtifactUrl(runId, 'output/cover.jpg')}
                alt="本期视频封面"
                width={1280}
                height={720}
                unoptimized
                className="w-full rounded-lg border border-slate-200 object-contain"
              />
              <a
                href={buildArtifactUrl(runId, 'output/cover.jpg')}
                target="_blank"
                rel="noreferrer"
                className="inline-block text-xs text-sky-700 hover:underline"
              >
                查看封面原图
              </a>
            </div>
          ) : (
            <div className="mt-3 rounded-lg border border-dashed border-slate-200 bg-slate-50 p-8 text-center text-xs text-slate-500">
              暂未生成封面图 `output/cover.jpg`。
            </div>
          )}
        </section>
      </div>

      <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-xs">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-semibold text-slate-900">成片自动质量检查报告</h3>
          {qaReport ? (
            <span
              className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${
                qaReport.passed ? 'bg-emerald-100 text-emerald-800' : 'bg-rose-100 text-rose-800'
              }`}
            >
              {qaReport.passed ? '质检通过' : '质检未通过'}
            </span>
          ) : null}
        </div>

        {!qaReport ? (
          <p className="mt-3 text-xs text-slate-500">尚未生成质量检查报告。</p>
        ) : (
          <div className="mt-3 space-y-4">
            <div className="grid gap-3 text-xs sm:grid-cols-3 lg:grid-cols-6">
              <div className="rounded-lg bg-slate-50 p-2.5">
                <div className="text-slate-500">画面分辨率</div>
                <div className="mt-0.5 font-mono font-semibold text-slate-900">
                  {qaReport.width}x{qaReport.height} @ {qaReport.fps}fps
                </div>
              </div>
              <div className="rounded-lg bg-slate-50 p-2.5">
                <div className="text-slate-500">视频时长</div>
                <div className="mt-0.5 font-mono font-semibold text-slate-900">
                  {qaReport.videoDurationSec.toFixed(2)} 秒
                </div>
              </div>
              <div className="rounded-lg bg-slate-50 p-2.5">
                <div className="text-slate-500">音频时长</div>
                <div className="mt-0.5 font-mono font-semibold text-slate-900">
                  {qaReport.audioDurationSec.toFixed(2)} 秒
                </div>
              </div>
              <div className="rounded-lg bg-slate-50 p-2.5">
                <div className="text-slate-500">平均音量</div>
                <div className="mt-0.5 font-mono font-semibold text-slate-900">
                  {qaReport.meanVolumeDb !== null ? `${qaReport.meanVolumeDb.toFixed(1)} dB` : '-'}
                </div>
              </div>
              <div className="rounded-lg bg-slate-50 p-2.5">
                <div className="text-slate-500">黑屏比例</div>
                <div className="mt-0.5 font-mono font-semibold text-slate-900">
                  {(qaReport.blackRatio * 100).toFixed(1)}%
                </div>
              </div>
              <div className="rounded-lg bg-slate-50 p-2.5">
                <div className="text-slate-500">检查时间</div>
                <div className="mt-0.5 text-slate-900">
                  {formatTimestamp(qaReport.checkedAt, timezone)}
                </div>
              </div>
            </div>

            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-slate-200 text-left text-xs">
                <thead className="bg-slate-50 text-slate-600">
                  <tr>
                    <th className="px-3 py-2 font-medium">检查项目</th>
                    <th className="px-3 py-2 font-medium">结果</th>
                    <th className="px-3 py-2 font-medium">说明</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {qaReport.checks.map((chk) => (
                    <tr key={chk.name}>
                      <td className="px-3 py-2 font-mono text-slate-900">{chk.name}</td>
                      <td className="px-3 py-2">
                        <span
                          className={
                            chk.passed
                              ? 'font-medium text-emerald-700'
                              : 'font-medium text-rose-700'
                          }
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
          </div>
        )}
      </section>

      <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-xs">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-semibold text-slate-900">音画时间轴与分段配音试听</h3>
          {timeline ? (
            <span className="text-xs text-slate-600">
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
                className="space-y-2 rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span className="rounded bg-white px-2 py-0.5 font-medium text-slate-800">
                      {KIND_LABEL[sec.kind]}
                    </span>
                    <span className="font-mono text-slate-700">{sec.key}</span>
                    {sec.itemId ? (
                      <span className="font-mono text-[11px] text-slate-500">({sec.itemId})</span>
                    ) : null}
                  </div>
                  <span className="font-mono text-[11px] text-slate-600">
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

                <ul className="space-y-0.5 text-[11px] text-slate-700">
                  {(() => {
                    const seenSentences = new Map<string, number>();
                    return sec.sentences.map((s) => {
                      const baseKey = `${sec.key}-${s.startMs}-${s.text}`;
                      const count = (seenSentences.get(baseKey) ?? 0) + 1;
                      seenSentences.set(baseKey, count);
                      return (
                        <li key={`${baseKey}-${count}`}>
                          <span className="font-mono text-slate-400">
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
