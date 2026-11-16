'use client';

import type { SourceTestResult } from '@aidaily/contracts';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { testSourceAction, toggleSourceAction } from '@/app/actions';

/** 单个订阅信源的启用开关与即时试抓交互控件 */
export function SourceActions({ sourceId, enabled }: { sourceId: string; enabled: boolean }) {
  const router = useRouter();
  const [testResult, setTestResult] = useState<SourceTestResult | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const handleToggle = () => {
    setErrorMsg(null);
    const fd = new FormData();
    fd.set('sourceId', sourceId);
    fd.set('enabled', enabled ? 'false' : 'true');
    startTransition(async () => {
      const res = await toggleSourceAction(fd);
      if (!res.ok) {
        setErrorMsg(res.error ?? '切换失败');
      }
      router.refresh();
    });
  };

  const handleTest = () => {
    setErrorMsg(null);
    setTestResult(null);
    const fd = new FormData();
    fd.set('sourceId', sourceId);
    startTransition(async () => {
      const res = await testSourceAction(fd);
      if (res.data) {
        setTestResult(res.data);
      }
      if (!res.ok && !res.data) {
        setErrorMsg(res.error ?? '试抓失败');
      }
      router.refresh();
    });
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-end gap-1.5">
        <button
          type="button"
          disabled={isPending}
          onClick={handleToggle}
          className={`rounded border px-2.5 py-1 text-xs font-medium ${
            enabled
              ? 'border-slate-300 text-slate-700 hover:bg-slate-50'
              : 'border-emerald-300 bg-emerald-50 text-emerald-800 hover:bg-emerald-100'
          }`}
        >
          {enabled ? '停用' : '启用'}
        </button>
        <button
          type="button"
          disabled={isPending}
          onClick={handleTest}
          className="rounded border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
        >
          {isPending ? '探测中…' : '试抓'}
        </button>
      </div>

      {errorMsg && <p className="text-right text-[11px] text-rose-600">{errorMsg}</p>}

      {testResult && (
        <div
          className={`rounded-lg border p-2 text-left text-[11px] ${
            testResult.ok
              ? 'border-emerald-200 bg-emerald-50 text-emerald-900'
              : 'border-rose-200 bg-rose-50 text-rose-800'
          }`}
        >
          <div className="font-medium">
            {testResult.ok
              ? `试抓成功：${testResult.itemCount} 条（HTTP ${testResult.statusCode ?? 200}，${testResult.durationMs}ms）`
              : `试抓失败：${testResult.error ?? '未知错误'}`}
          </div>
          {testResult.sampleTitles.length > 0 && (
            <ul className="mt-1 list-inside list-disc space-y-0.5 text-slate-700">
              {testResult.sampleTitles.slice(0, 3).map((t) => (
                <li key={t} className="truncate">
                  {t}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
