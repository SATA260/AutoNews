'use client';

import type {
  DeleteRunsInput,
  DeleteRunsMode,
  DeleteRunsResult,
  RunStatus,
  RunSummary,
  Trigger,
} from '@aidaily/contracts';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState, useTransition } from 'react';
import { deleteRunsAction, previewDeleteRunsAction } from '@/app/actions';
import {
  formatBytes,
  formatDateTimeLocalInTz,
  formatDuration,
  formatTimestamp,
  RUN_STATUS_TEXT,
  runStatusBadgeClass,
  STAGE_LABELS,
} from '@/lib/format';

/** 任务列表及批量删除管理组件的参数定义 */
export interface RunsManagerProps {
  runs: RunSummary[];
  diskUsageByRunId: Record<string, number>;
  timezone: string;
  initialPresetKey: string;
  initialFrom: string;
  initialTo: string;
  filterError?: string | null;
}

const TRIGGER_TEXT: Record<Trigger, string> = {
  'manual-cli': '命令行触发',
  'manual-web': '网页后台触发',
  schedule: '定时任务触发',
};

const FILTER_PRESETS: Array<{ key: string; label: string }> = [
  { key: 'all', label: '全部任务' },
  { key: 'active', label: '进行中' },
  { key: 'awaiting_review', label: '待试听 / 待审核' },
  { key: 'published', label: '已完成' },
  { key: 'recoverable', label: '失败 / 中断' },
  { key: 'closed', label: '取消 / 驳回 / 放弃' },
];

const PROTECTED_RUN_STATUSES = new Set<RunStatus>([
  'queued',
  'running',
  'publishing',
  'publish_uncertain',
]);

const BATCH_STATUS_OPTIONS: Array<{ status: RunStatus; label: string }> = [
  { status: 'published', label: RUN_STATUS_TEXT.published },
  { status: 'failed', label: RUN_STATUS_TEXT.failed },
  { status: 'interrupted', label: RUN_STATUS_TEXT.interrupted },
  { status: 'cancelled', label: RUN_STATUS_TEXT.cancelled },
  { status: 'rejected', label: RUN_STATUS_TEXT.rejected },
  { status: 'abandoned', label: RUN_STATUS_TEXT.abandoned },
  { status: 'skipped', label: RUN_STATUS_TEXT.skipped },
  { status: 'publish_failed', label: RUN_STATUS_TEXT.publish_failed },
  { status: 'awaiting_audio_review', label: RUN_STATUS_TEXT.awaiting_audio_review },
  { status: 'awaiting_review', label: RUN_STATUS_TEXT.awaiting_review },
];

/** 构造带状态预设和创建时间范围的任务列表链接 */
function buildRunsHref(statusKey: string, from: string, to: string): string {
  const sp = new URLSearchParams();
  if (statusKey && statusKey !== 'all') sp.set('status', statusKey);
  if (from) sp.set('from', from);
  if (to) sp.set('to', to);
  const qs = sp.toString();
  return qs ? `/runs?${qs}` : '/runs';
}

/** 任务列表筛选、勾选清理产物与按时间批量删除管理组件 */
export function RunsManager({
  runs,
  diskUsageByRunId,
  timezone,
  initialPresetKey,
  initialFrom,
  initialTo,
  filterError,
}: RunsManagerProps) {
  const router = useRouter();
  const [from, setFrom] = useState(initialFrom);
  const [to, setTo] = useState(initialTo);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [feedback, setFeedback] = useState<{ ok: boolean; text: string } | null>(null);
  const [isPending, startTransition] = useTransition();

  // 勾选任务删除确认弹窗状态
  const [selectedModalMode, setSelectedModalMode] = useState<DeleteRunsMode | null>(null);
  const [selectedPreview, setSelectedPreview] = useState<DeleteRunsResult | null>(null);
  const [selectedPreviewError, setSelectedPreviewError] = useState<string | null>(null);

  // 按时间范围批量删除弹窗状态
  const [batchModalOpen, setBatchModalOpen] = useState(false);
  const [batchMode, setBatchMode] = useState<DeleteRunsMode>('artifacts_only');
  const [batchPreset, setBatchPreset] = useState<'24h' | '3d' | '7d' | '30d' | 'custom'>('7d');
  const [batchFrom, setBatchFrom] = useState('');
  const [batchTo, setBatchTo] = useState('');
  const [batchStatuses, setBatchStatuses] = useState<RunStatus[]>([]);
  const [batchPreview, setBatchPreview] = useState<DeleteRunsResult | null>(null);
  const [batchError, setBatchError] = useState<string | null>(null);

  useEffect(() => {
    setFrom(initialFrom);
    setTo(initialTo);
  }, [initialFrom, initialTo]);

  const selectableIds = runs
    .filter((run) => !PROTECTED_RUN_STATUSES.has(run.status))
    .map((run) => run.id);
  const selectableIdSet = new Set(selectableIds);
  const activeSelectedIds = selectedIds.filter((id) => selectableIdSet.has(id));
  const allSelectableChecked =
    selectableIds.length > 0 && activeSelectedIds.length === selectableIds.length;

  const toggleOne = (id: string) => {
    setSelectedIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };

  const toggleAll = () => {
    if (allSelectableChecked) {
      setSelectedIds([]);
    } else {
      setSelectedIds(selectableIds);
    }
  };

  const handleTimeFilterSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    router.push(buildRunsHref(initialPresetKey, from, to));
  };

  const openSelectedConfirm = (mode: DeleteRunsMode) => {
    if (activeSelectedIds.length === 0) {
      return;
    }
    setSelectedModalMode(mode);
    setSelectedPreview(null);
    setSelectedPreviewError(null);
    startTransition(async () => {
      const res = await previewDeleteRunsAction({ runIds: activeSelectedIds, mode });
      if (!res.ok || !res.data) {
        setSelectedPreviewError(res.error ?? '预览待删除任务失败');
        return;
      }
      setSelectedPreview(res.data);
    });
  };

  const handleConfirmSelected = () => {
    if (!selectedModalMode || activeSelectedIds.length === 0) {
      return;
    }
    const mode = selectedModalMode;
    startTransition(async () => {
      const res = await deleteRunsAction({ runIds: activeSelectedIds, mode });
      if (!res.ok) {
        setSelectedPreviewError(res.error ?? '执行删除失败');
        return;
      }
      setSelectedModalMode(null);
      setSelectedPreview(null);
      setSelectedIds([]);
      setFeedback({ ok: true, text: res.message ?? '操作完成' });
      router.refresh();
    });
  };

  const applyBatchPreset = (preset: '24h' | '3d' | '7d' | '30d' | 'custom') => {
    setBatchPreset(preset);
    setBatchPreview(null);
    setBatchError(null);
    if (preset === 'custom') {
      return;
    }
    const hoursMap: Record<'24h' | '3d' | '7d' | '30d', number> = {
      '24h': 24,
      '3d': 72,
      '7d': 24 * 7,
      '30d': 24 * 30,
    };
    const cutoffDate = new Date(Date.now() - hoursMap[preset] * 3600_000);
    setBatchFrom('');
    setBatchTo(formatDateTimeLocalInTz(cutoffDate, timezone));
  };

  const openBatchModal = () => {
    setBatchModalOpen(true);
    setBatchMode('artifacts_only');
    setBatchStatuses([]);
    setBatchPreview(null);
    setBatchError(null);
    applyBatchPreset('7d');
  };

  const toggleBatchStatus = (st: RunStatus) => {
    setBatchPreview(null);
    setBatchStatuses((prev) => (prev.includes(st) ? prev.filter((x) => x !== st) : [...prev, st]));
  };

  const buildBatchInput = (): DeleteRunsInput => {
    const input: DeleteRunsInput = {
      mode: batchMode,
    };
    if (batchFrom.trim()) input.from = batchFrom.trim();
    if (batchTo.trim()) input.to = batchTo.trim();
    if (batchStatuses.length > 0) input.statuses = batchStatuses;
    return input;
  };

  const handlePreviewBatch = () => {
    setBatchError(null);
    setBatchPreview(null);
    const input = buildBatchInput();
    startTransition(async () => {
      const res = await previewDeleteRunsAction(input);
      if (!res.ok || !res.data) {
        setBatchError(res.error ?? '预览失败');
        return;
      }
      setBatchPreview(res.data);
    });
  };

  const handleExecuteBatch = () => {
    setBatchError(null);
    const input = buildBatchInput();
    startTransition(async () => {
      const res = await deleteRunsAction(input);
      if (!res.ok) {
        setBatchError(res.error ?? '执行删除失败');
        return;
      }
      setBatchModalOpen(false);
      setBatchPreview(null);
      setSelectedIds([]);
      setFeedback({ ok: true, text: res.message ?? '批量删除完成' });
      router.refresh();
    });
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-2">
          {FILTER_PRESETS.map((preset) => {
            const active = initialPresetKey === preset.key;
            return (
              <Link
                key={preset.key}
                href={buildRunsHref(preset.key, initialFrom, initialTo)}
                className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
                  active
                    ? 'border-sky-600 bg-sky-600 text-white'
                    : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-100'
                }`}
              >
                {preset.label}
              </Link>
            );
          })}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={isPending || activeSelectedIds.length === 0}
            onClick={() => openSelectedConfirm('artifacts_only')}
            className="rounded-lg border border-amber-300 bg-white px-3 py-1.5 text-xs font-medium text-amber-800 hover:bg-amber-50 disabled:cursor-not-allowed disabled:opacity-50"
          >
            仅清理选中产物（{activeSelectedIds.length} 项）
          </button>
          <button
            type="button"
            disabled={isPending || activeSelectedIds.length === 0}
            onClick={() => openSelectedConfirm('full')}
            className="rounded-lg border border-rose-300 bg-white px-3 py-1.5 text-xs font-medium text-rose-700 hover:bg-rose-50 disabled:cursor-not-allowed disabled:opacity-50"
          >
            彻底删除选中任务（{activeSelectedIds.length} 项）
          </button>
          <button
            type="button"
            disabled={isPending}
            onClick={openBatchModal}
            className="rounded-lg bg-rose-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-rose-700 disabled:opacity-50"
          >
            按时间筛选批量删除
          </button>
        </div>
      </div>

      <form
        onSubmit={handleTimeFilterSubmit}
        className="flex flex-wrap items-end gap-3 rounded-xl border border-slate-200 bg-white px-4 py-3 text-xs shadow-xs"
      >
        <div>
          <label htmlFor="runs-from" className="block text-[11px] font-medium text-slate-600">
            创建起始时间
          </label>
          <input
            id="runs-from"
            type="datetime-local"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            className="mt-1 rounded-lg border border-slate-300 px-2.5 py-1.5 text-xs text-slate-900"
          />
        </div>
        <div>
          <label htmlFor="runs-to" className="block text-[11px] font-medium text-slate-600">
            创建截止时间
          </label>
          <input
            id="runs-to"
            type="datetime-local"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            className="mt-1 rounded-lg border border-slate-300 px-2.5 py-1.5 text-xs text-slate-900"
          />
        </div>
        <div className="flex items-center gap-2">
          <button
            type="submit"
            className="rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-800"
          >
            按时间筛选
          </button>
          {(initialFrom || initialTo) && (
            <Link
              href={buildRunsHref(initialPresetKey, '', '')}
              className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-50"
            >
              清空时间
            </Link>
          )}
        </div>
        <span className="ml-auto text-[11px] text-slate-500">展示时区：{timezone}</span>
      </form>

      {filterError && (
        <div className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-2.5 text-xs text-rose-700">
          时间筛选参数有误：{filterError}
        </div>
      )}

      {feedback && (
        <div
          role={feedback.ok ? 'status' : 'alert'}
          className={`rounded-lg border px-4 py-2.5 text-xs ${
            feedback.ok
              ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
              : 'border-rose-200 bg-rose-50 text-rose-700'
          }`}
        >
          {feedback.text}
        </div>
      )}

      <section className="rounded-xl border border-slate-200 bg-white shadow-xs">
        {runs.length === 0 ? (
          <div className="p-10 text-center text-sm text-slate-500">
            当前筛选条件下暂无任务记录。
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-slate-200 text-left text-xs">
              <thead className="bg-slate-50 text-slate-600">
                <tr>
                  <th className="w-10 px-3 py-2.5">
                    <input
                      type="checkbox"
                      aria-label="全选当前列表中可操作任务"
                      checked={allSelectableChecked}
                      disabled={selectableIds.length === 0}
                      onChange={toggleAll}
                      className="h-3.5 w-3.5 rounded border-slate-300"
                    />
                  </th>
                  <th className="px-4 py-2.5 font-medium">任务编号</th>
                  <th className="px-4 py-2.5 font-medium">状态</th>
                  <th className="px-4 py-2.5 font-medium">步骤 / 轮次</th>
                  <th className="px-4 py-2.5 font-medium">条数</th>
                  <th className="px-4 py-2.5 font-medium">触发来源</th>
                  <th className="px-4 py-2.5 font-medium">创建时间</th>
                  <th className="px-4 py-2.5 font-medium">耗时</th>
                  <th className="px-4 py-2.5 font-medium">产物大小</th>
                  <th className="px-4 py-2.5 font-medium">错误摘要</th>
                  <th className="px-4 py-2.5 font-medium">操作</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {runs.map((run) => {
                  const isProtected = PROTECTED_RUN_STATUSES.has(run.status);
                  const checked = activeSelectedIds.includes(run.id);
                  const diskBytes = diskUsageByRunId[run.id] ?? 0;
                  return (
                    <tr key={run.id} className="hover:bg-slate-50">
                      <td className="px-3 py-2.5">
                        <input
                          type="checkbox"
                          aria-label={`选择任务 ${run.id}`}
                          checked={checked}
                          disabled={isProtected}
                          title={
                            isProtected
                              ? '进行中或待核实投稿的任务受保护，禁止删除'
                              : '勾选以清理产物或删除任务'
                          }
                          onChange={() => toggleOne(run.id)}
                          className="h-3.5 w-3.5 rounded border-slate-300 disabled:cursor-not-allowed disabled:opacity-40"
                        />
                      </td>
                      <td className="px-4 py-2.5 font-mono font-medium text-slate-900">
                        <Link
                          href={`/runs/${run.id}`}
                          className="hover:text-sky-700 hover:underline"
                        >
                          {run.id}
                        </Link>
                      </td>
                      <td className="px-4 py-2.5">
                        <span
                          className={`inline-block rounded-full border px-2 py-0.5 text-[11px] font-medium ${runStatusBadgeClass(run.status)}`}
                        >
                          {RUN_STATUS_TEXT[run.status]}
                        </span>
                      </td>
                      <td className="px-4 py-2.5 text-slate-700">
                        {run.currentStage ? STAGE_LABELS[run.currentStage] : '-'}
                        <span className="ml-1 text-slate-400">（第 {run.attempt} 轮）</span>
                      </td>
                      <td className="px-4 py-2.5 text-slate-700">{run.itemCount} 条</td>
                      <td className="px-4 py-2.5 text-slate-600">
                        {TRIGGER_TEXT[run.trigger]}
                        {run.scheduleId ? (
                          <span className="ml-1 font-mono text-[11px] text-slate-400">
                            ({run.scheduleId})
                          </span>
                        ) : null}
                      </td>
                      <td className="px-4 py-2.5 text-slate-600">
                        {formatTimestamp(run.createdAt, timezone)}
                      </td>
                      <td className="px-4 py-2.5 text-slate-600">
                        {formatDuration(run.startedAt, run.finishedAt)}
                      </td>
                      <td className="whitespace-nowrap px-4 py-2.5 font-mono text-[11px] text-slate-700">
                        {diskBytes > 0 ? formatBytes(diskBytes) : '无本地文件'}
                      </td>
                      <td className="max-w-xs truncate px-4 py-2.5 text-rose-700">
                        {run.error ?? run.errorCode ?? '-'}
                      </td>
                      <td className="px-4 py-2.5">
                        <Link
                          href={`/runs/${run.id}`}
                          className="font-medium text-sky-700 hover:underline"
                        >
                          进入详情
                        </Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {selectedModalMode && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/40 p-4">
          <div className="w-full max-w-md rounded-xl border border-slate-200 bg-white p-6 shadow-xl">
            <h4 className="text-base font-semibold text-slate-900">
              {selectedModalMode === 'artifacts_only'
                ? `确认清理选中 ${activeSelectedIds.length} 期任务的磁盘产物？`
                : `确认彻底删除选中的 ${activeSelectedIds.length} 期任务及产物？`}
            </h4>
            <p className="mt-1.5 text-xs leading-relaxed text-slate-600">
              {selectedModalMode === 'artifacts_only'
                ? '仅删除任务目录下生成的视频、音频、封面和临时产物，保留数据库中的任务记录和文稿。'
                : '将从数据库移除所选任务关联记录并删除对应产物目录；若任务仍占用待选新闻，会自动释放回待选库（已播防重历史会保留）。'}
            </p>

            {selectedPreview && (
              <div className="mt-3 space-y-1 rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs text-slate-700">
                <div>匹配任务：{selectedPreview.matchedCount} 期</div>
                <div>
                  可执行数量：<strong>{selectedPreview.affectedRunIds.length} 期</strong>
                  {selectedPreview.skippedProtectedRunIds.length > 0
                    ? `（受保护跳过 ${selectedPreview.skippedProtectedRunIds.length} 期）`
                    : ''}
                </div>
                {selectedModalMode === 'full' && (
                  <div>将释放被占用文章：{selectedPreview.releasedArticlesCount} 篇</div>
                )}
                <div>
                  预计回收磁盘空间：<strong>{formatBytes(selectedPreview.reclaimedBytes)}</strong>
                </div>
              </div>
            )}

            {!selectedPreview && !selectedPreviewError && (
              <p className="mt-3 text-xs text-slate-500">正在统计任务产物大小…</p>
            )}

            {selectedPreviewError && (
              <div className="mt-3 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
                {selectedPreviewError}
              </div>
            )}

            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                disabled={isPending}
                onClick={() => {
                  setSelectedModalMode(null);
                  setSelectedPreview(null);
                }}
                className="rounded-lg border border-slate-300 px-3.5 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50"
              >
                取消
              </button>
              <button
                type="button"
                disabled={
                  isPending || !selectedPreview || selectedPreview.affectedRunIds.length === 0
                }
                onClick={handleConfirmSelected}
                className="rounded-lg bg-rose-600 px-3.5 py-2 text-xs font-medium text-white hover:bg-rose-700 disabled:opacity-50"
              >
                {isPending
                  ? '处理中…'
                  : selectedModalMode === 'artifacts_only'
                    ? '确认清理产物'
                    : '确认彻底删除'}
              </button>
            </div>
          </div>
        </div>
      )}

      {batchModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/40 p-4">
          <div className="w-full max-w-lg rounded-xl border border-slate-200 bg-white p-6 shadow-xl">
            <h4 className="text-base font-semibold text-slate-900">按时间筛选批量删除任务或产物</h4>
            <p className="mt-1 text-xs text-slate-600">
              先设置清理方式与任务创建时间条件并点击「预览待删范围」，确认受影响期数及释放空间后再执行；进行中与待核实投稿的任务始终受保护跳过。
            </p>

            <div className="mt-4 space-y-3 text-xs">
              <div>
                <span className="block font-medium text-slate-700">清理方式</span>
                <div className="mt-1.5 grid gap-2 sm:grid-cols-2">
                  <label
                    className={`flex cursor-pointer items-start gap-2 rounded-lg border p-2.5 ${
                      batchMode === 'artifacts_only'
                        ? 'border-sky-500 bg-sky-50 text-slate-900'
                        : 'border-slate-200 bg-white text-slate-700'
                    }`}
                  >
                    <input
                      type="radio"
                      name="batchRunMode"
                      checked={batchMode === 'artifacts_only'}
                      onChange={() => {
                        setBatchMode('artifacts_only');
                        setBatchPreview(null);
                      }}
                      className="mt-0.5"
                    />
                    <span>
                      <strong className="block">仅清理磁盘产物</strong>
                      <span className="text-[11px] text-slate-500">保留任务记录与文字稿</span>
                    </span>
                  </label>
                  <label
                    className={`flex cursor-pointer items-start gap-2 rounded-lg border p-2.5 ${
                      batchMode === 'full'
                        ? 'border-rose-500 bg-rose-50 text-slate-900'
                        : 'border-slate-200 bg-white text-slate-700'
                    }`}
                  >
                    <input
                      type="radio"
                      name="batchRunMode"
                      checked={batchMode === 'full'}
                      onChange={() => {
                        setBatchMode('full');
                        setBatchPreview(null);
                      }}
                      className="mt-0.5"
                    />
                    <span>
                      <strong className="block">彻底删除任务及产物</strong>
                      <span className="text-[11px] text-slate-500">保留已播防重历史</span>
                    </span>
                  </label>
                </div>
              </div>

              <div>
                <span className="block font-medium text-slate-700">快捷时间范围</span>
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {(
                    [
                      ['24h', '24 小时前之前'],
                      ['3d', '3 天前之前'],
                      ['7d', '7 天前之前'],
                      ['30d', '30 天前之前'],
                      ['custom', '自定义时间范围'],
                    ] as const
                  ).map(([key, label]) => (
                    <button
                      key={key}
                      type="button"
                      onClick={() => applyBatchPreset(key)}
                      className={`rounded-full border px-2.5 py-1 transition ${
                        batchPreset === key
                          ? 'border-slate-900 bg-slate-900 text-white'
                          : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-50'
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <label htmlFor="batch-run-from" className="block font-medium text-slate-700">
                    创建起始时间（含，留空不限）
                  </label>
                  <input
                    id="batch-run-from"
                    type="datetime-local"
                    value={batchFrom}
                    onChange={(e) => {
                      setBatchPreset('custom');
                      setBatchFrom(e.target.value);
                      setBatchPreview(null);
                    }}
                    className="mt-1 w-full rounded-lg border border-slate-300 px-2.5 py-1.5 text-slate-900"
                  />
                </div>
                <div>
                  <label htmlFor="batch-run-to" className="block font-medium text-slate-700">
                    创建截止时间（含，留空不限）
                  </label>
                  <input
                    id="batch-run-to"
                    type="datetime-local"
                    value={batchTo}
                    onChange={(e) => {
                      setBatchPreset('custom');
                      setBatchTo(e.target.value);
                      setBatchPreview(null);
                    }}
                    className="mt-1 w-full rounded-lg border border-slate-300 px-2.5 py-1.5 text-slate-900"
                  />
                </div>
              </div>

              <div>
                <span className="block font-medium text-slate-700">
                  可选状态筛选（全不选表示匹配上述时间内所有可清理任务）
                </span>
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {BATCH_STATUS_OPTIONS.map((opt) => {
                    const checked = batchStatuses.includes(opt.status);
                    return (
                      <label
                        key={opt.status}
                        className={`inline-flex cursor-pointer items-center gap-1 rounded border px-2 py-1 text-[11px] ${
                          checked
                            ? 'border-sky-500 bg-sky-50 text-sky-900'
                            : 'border-slate-200 bg-slate-50 text-slate-700'
                        }`}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => toggleBatchStatus(opt.status)}
                          className="h-3 w-3 rounded border-slate-300"
                        />
                        {opt.label}
                      </label>
                    );
                  })}
                </div>
              </div>

              {batchPreview && (
                <div className="space-y-1 rounded-lg border border-amber-200 bg-amber-50 p-3 text-slate-800">
                  <div>命中任务：{batchPreview.matchedCount} 期</div>
                  <div>
                    实际可执行：<strong>{batchPreview.affectedRunIds.length} 期</strong>
                    {batchPreview.skippedProtectedRunIds.length > 0
                      ? `（其中 ${batchPreview.skippedProtectedRunIds.length} 期受保护任务将保留）`
                      : ''}
                  </div>
                  {batchPreview.mode === 'full' && (
                    <div>将释放被占用文章：{batchPreview.releasedArticlesCount} 篇</div>
                  )}
                  <div>
                    预计回收磁盘空间：<strong>{formatBytes(batchPreview.reclaimedBytes)}</strong>
                  </div>
                </div>
              )}

              {batchError && (
                <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-rose-700">
                  {batchError}
                </div>
              )}
            </div>

            <div className="mt-5 flex flex-wrap justify-end gap-2">
              <button
                type="button"
                disabled={isPending}
                onClick={() => setBatchModalOpen(false)}
                className="rounded-lg border border-slate-300 px-3.5 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50"
              >
                取消
              </button>
              <button
                type="button"
                disabled={isPending}
                onClick={handlePreviewBatch}
                className="rounded-lg border border-slate-900 bg-white px-3.5 py-2 text-xs font-medium text-slate-900 hover:bg-slate-100 disabled:opacity-50"
              >
                {isPending ? '计算中…' : '预览待删范围'}
              </button>
              <button
                type="button"
                disabled={isPending || !batchPreview || batchPreview.affectedRunIds.length === 0}
                onClick={handleExecuteBatch}
                className="rounded-lg bg-rose-600 px-3.5 py-2 text-xs font-medium text-white hover:bg-rose-700 disabled:opacity-50"
              >
                {isPending ? '执行中…' : '确认执行'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
