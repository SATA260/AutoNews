'use client';

import type { DoctorReport, Settings } from '@aidaily/contracts';
import { useState, useTransition } from 'react';
import { runDoctorCheckAction } from '@/app/actions';
import { formatTimestamp } from '@/lib/format';

/** 语音合成与通知接口静态参数网格，供骨架态与完成态共用 */
export function TtsAndNotifyMetaGrid({ settings }: { settings: Settings }) {
  return (
    <div className="grid gap-3 text-xs sm:grid-cols-2 lg:grid-cols-4">
      <div className="rounded-lg border border-slate-100 bg-slate-50 p-3">
        <div className="text-slate-500">当前语音合成提供方</div>
        <div className="mt-1 font-mono font-semibold text-slate-900">{settings.tts.provider}</div>
      </div>
      <div className="rounded-lg border border-slate-100 bg-slate-50 p-3">
        <div className="text-slate-500">音频采样与目标响度</div>
        <div className="mt-1 font-mono font-semibold text-slate-900">
          {settings.tts.postprocess.sampleRate}Hz · {settings.tts.postprocess.loudnessLUFS} LUFS
        </div>
      </div>
      <div className="rounded-lg border border-slate-100 bg-slate-50 p-3">
        <div className="text-slate-500">句间 / 段间停顿参数</div>
        <div className="mt-1 font-mono font-semibold text-slate-900">
          {settings.tts.postprocess.sentenceGapMs}ms / {settings.tts.postprocess.sectionGapMs}ms
        </div>
      </div>
      <div className="rounded-lg border border-slate-100 bg-slate-50 p-3">
        <div className="text-slate-500">当前通知渠道提供方</div>
        <div className="mt-1 font-mono font-semibold text-slate-900">
          {settings.notify.provider}
        </div>
      </div>
    </div>
  );
}

/** 首次无缓存进入设置页时的异步环境自检占位卡片，不阻塞表单渲染与编辑 */
export function SystemDoctorSkeleton({ settings }: { settings: Settings }) {
  return (
    <section className="space-y-4 rounded-xl border border-slate-200 bg-white p-5 shadow-xs">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 pb-3">
        <div>
          <h3 className="text-base font-semibold text-slate-900">
            语音合成、通知接口与环境自检状态
          </h3>
          <p className="mt-0.5 text-xs text-slate-600">
            语音引擎与消息通知均采用抽象扩展接口，方便后续按需接入外部配音服务与飞书群机器人。
          </p>
        </div>
        <span className="rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-medium text-slate-600">
          正在后台执行环境自检…
        </span>
      </div>

      <TtsAndNotifyMetaGrid settings={settings} />

      <div className="rounded-lg border border-dashed border-slate-200 bg-slate-50/70 px-4 py-6 text-center text-xs text-slate-500">
        正在并行检测本地工具版本与模型连通性，上方与下方配置表单现在即可直接修改保存…
      </div>
    </section>
  );
}

/** 展示环境自检结果并提供手动重新自检按钮的交互面板 */
export function SystemDoctorPanel({
  settings,
  initialReport,
  initialError = null,
}: {
  settings: Settings;
  initialReport: DoctorReport | null;
  initialError?: string | null;
}) {
  const [report, setReport] = useState<DoctorReport | null>(initialReport);
  const [errorText, setErrorText] = useState<string | null>(initialError);
  const [prevSyncKey, setPrevSyncKey] = useState<string>(() =>
    JSON.stringify({ initialReport, initialError }),
  );
  const [isPending, startTransition] = useTransition();

  const nextSyncKey = JSON.stringify({ initialReport, initialError });
  if (nextSyncKey !== prevSyncKey) {
    setPrevSyncKey(nextSyncKey);
    setReport(initialReport);
    setErrorText(initialError);
  }

  /** 手动触发强制环境自检并更新当前展示结果 */
  const handleRecheck = () => {
    setErrorText(null);
    startTransition(async () => {
      const res = await runDoctorCheckAction({ forceRefresh: true });
      if (res.ok && res.data) {
        setReport(res.data);
      } else {
        setErrorText(res.error ?? '重新自检失败');
      }
    });
  };

  return (
    <section className="space-y-4 rounded-xl border border-slate-200 bg-white p-5 shadow-xs">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 pb-3">
        <div>
          <h3 className="text-base font-semibold text-slate-900">
            语音合成、通知接口与环境自检状态
          </h3>
          <p className="mt-0.5 text-xs text-slate-600">
            语音引擎与消息通知均采用抽象扩展接口，方便后续按需接入外部配音服务与飞书群机器人。
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {report ? (
            <span
              className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${
                report.ok ? 'bg-emerald-100 text-emerald-800' : 'bg-amber-100 text-amber-800'
              }`}
            >
              {report.ok ? '必备环境就绪' : '存在待排查检查项'} · 自检于{' '}
              {formatTimestamp(report.checkedAt, settings.timezone)}
            </span>
          ) : (
            <span className="rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-medium text-slate-600">
              尚未获取自检结果
            </span>
          )}
          <button
            type="button"
            disabled={isPending}
            onClick={handleRecheck}
            className="rounded-lg border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-50"
          >
            {isPending ? '自检中…' : '重新自检'}
          </button>
        </div>
      </div>

      <TtsAndNotifyMetaGrid settings={settings} />

      {errorText && (
        <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
          {errorText}
        </div>
      )}

      {report ? (
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-slate-200 text-left text-xs">
            <thead className="bg-slate-50 text-slate-600">
              <tr>
                <th className="px-3 py-2 font-medium">环境检查项</th>
                <th className="px-3 py-2 font-medium">必需项</th>
                <th className="px-3 py-2 font-medium">结果</th>
                <th className="px-3 py-2 font-medium">说明</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {report.checks.map((item) => (
                <tr key={item.name}>
                  <td className="px-3 py-2 font-mono text-slate-900">{item.name}</td>
                  <td className="px-3 py-2 text-slate-600">{item.required ? '是' : '可选'}</td>
                  <td className="px-3 py-2">
                    <span
                      className={
                        item.ok ? 'font-medium text-emerald-700' : 'font-medium text-rose-700'
                      }
                    >
                      {item.ok ? '通过' : '异常'}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-slate-700">{item.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-4 text-xs text-slate-600">
          暂未读取到环境自检报告，可点击右上角「重新自检」立即检测。
        </div>
      )}
    </section>
  );
}
