'use client';

import type { ScheduleJob } from '@aidaily/contracts';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import {
  createScheduleAction,
  removeScheduleAction,
  syncSchedulesAction,
  updateScheduleAction,
} from '@/app/actions';
import { formatTimestamp } from '@/lib/format';

/** 定时任务管理交互组件（新建时执行时间与新闻条数均必须空白手动填写） */
export function ScheduleManager({ jobs, timezone }: { jobs: ScheduleJob[]; timezone: string }) {
  const router = useRouter();
  const [modalOpen, setModalOpen] = useState(false);
  const [editingJob, setEditingJob] = useState<ScheduleJob | null>(null);
  const [createTime, setCreateTime] = useState('');
  const [createCount, setCreateCount] = useState('');
  const [createName, setCreateName] = useState('');
  const [feedback, setFeedback] = useState<{ ok: boolean; text: string } | null>(null);
  const [isPending, startTransition] = useTransition();

  const handleAction = (
    fn: () => Promise<{ ok: boolean; message?: string; error?: string }>,
    onSuccess?: () => void,
  ) => {
    setFeedback(null);
    startTransition(async () => {
      const res = await fn();
      setFeedback({
        ok: res.ok,
        text: res.ok ? (res.message ?? '已保存') : (res.error ?? '操作失败'),
      });
      if (res.ok) {
        onSuccess?.();
      }
      router.refresh();
    });
  };

  const handleCreate = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const fd = new FormData(event.currentTarget);
    handleAction(
      () => createScheduleAction(fd),
      () => {
        setModalOpen(false);
        setCreateTime('');
        setCreateCount('');
        setCreateName('');
      },
    );
  };

  const handleEditSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const fd = new FormData(event.currentTarget);
    handleAction(
      () => updateScheduleAction(fd),
      () => setEditingJob(null),
    );
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">定时任务管理</h1>
          <p className="mt-1 text-sm text-slate-600">
            通过 macOS launchd
            每日按指定时间自动运行一期生产流程。新建任务时执行时间与每期条数均为必填项。
          </p>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={isPending}
            onClick={() => handleAction(() => syncSchedulesAction())}
            className="rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
          >
            全量重同步 launchd
          </button>
          <button
            type="button"
            onClick={() => {
              setCreateTime('');
              setCreateCount('');
              setCreateName('');
              setModalOpen(true);
            }}
            className="rounded-lg bg-slate-900 px-4 py-2 text-xs font-medium text-white hover:bg-slate-800"
          >
            新建定时任务
          </button>
        </div>
      </div>

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

      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
        <table className="min-w-full divide-y divide-slate-200 text-left text-sm">
          <thead className="bg-slate-50 text-xs font-medium text-slate-500">
            <tr>
              <th className="px-4 py-3">名称 / ID</th>
              <th className="px-4 py-3">每日时间</th>
              <th className="px-4 py-3">每期条数</th>
              <th className="px-4 py-3">状态与挂载</th>
              <th className="px-4 py-3">下次执行时间</th>
              <th className="px-4 py-3">最近触发任务</th>
              <th className="px-4 py-3 text-right">操作</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 text-xs text-slate-700">
            {jobs.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-slate-500">
                  暂无定时任务，点击右上角「新建定时任务」开始配置。
                </td>
              </tr>
            ) : (
              jobs.map((job) => (
                <tr key={job.id}>
                  <td className="px-4 py-3">
                    <div className="font-medium text-slate-900">{job.name}</div>
                    <div className="font-mono text-[11px] text-slate-500">{job.id}</div>
                  </td>
                  <td className="px-4 py-3 font-mono font-semibold text-slate-900">{job.time}</td>
                  <td className="px-4 py-3">{job.itemCount} 条</td>
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap gap-1.5">
                      <span
                        className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${
                          job.enabled
                            ? 'bg-emerald-100 text-emerald-800'
                            : 'bg-slate-100 text-slate-600'
                        }`}
                      >
                        {job.enabled ? '已启用' : '已停用'}
                      </span>
                      <span
                        className={`rounded-full px-2 py-0.5 text-[11px] ${
                          job.installed ? 'bg-sky-100 text-sky-800' : 'bg-slate-100 text-slate-500'
                        }`}
                      >
                        {job.installed ? 'launchd 已挂载' : '未挂载'}
                      </span>
                    </div>
                  </td>
                  <td className="px-4 py-3">{formatTimestamp(job.nextRunAt, timezone)}</td>
                  <td className="px-4 py-3">
                    {job.lastRunId ? (
                      <Link
                        href={`/runs/${job.lastRunId}`}
                        className="font-mono text-indigo-700 underline"
                      >
                        {job.lastRunId}
                      </Link>
                    ) : (
                      '-'
                    )}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <div className="inline-flex items-center gap-1.5">
                      <button
                        type="button"
                        disabled={isPending}
                        onClick={() => {
                          const fd = new FormData();
                          fd.set('id', job.id);
                          fd.set('enabled', job.enabled ? 'false' : 'true');
                          handleAction(() => updateScheduleAction(fd));
                        }}
                        className="rounded border border-slate-300 px-2.5 py-1 hover:bg-slate-50"
                      >
                        {job.enabled ? '停用' : '启用'}
                      </button>
                      <button
                        type="button"
                        disabled={isPending}
                        onClick={() => setEditingJob(job)}
                        className="rounded border border-slate-300 px-2.5 py-1 hover:bg-slate-50"
                      >
                        编辑
                      </button>
                      <button
                        type="button"
                        disabled={isPending}
                        onClick={() => {
                          const fd = new FormData();
                          fd.set('id', job.id);
                          handleAction(() => removeScheduleAction(fd));
                        }}
                        className="rounded border border-rose-200 px-2.5 py-1 text-rose-700 hover:bg-rose-50"
                      >
                        删除
                      </button>
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {modalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/40 p-4">
          <div className="w-full max-w-md rounded-xl border border-slate-200 bg-white p-6 shadow-xl">
            <h2 className="text-base font-semibold text-slate-900">新建每日定时任务</h2>
            <p className="mt-1 text-xs text-slate-600">
              每日执行时间（HH:mm）与每期新闻条数均不设默认值，请显式填写。
            </p>
            <form onSubmit={handleCreate} className="mt-4 space-y-3">
              <div>
                <label
                  htmlFor="create-sched-name"
                  className="block text-xs font-medium text-slate-700"
                >
                  任务名称（可选）
                </label>
                <input
                  id="create-sched-name"
                  name="name"
                  type="text"
                  value={createName}
                  onChange={(e) => setCreateName(e.target.value)}
                  placeholder="例如：早间 AI 播报"
                  className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label
                  htmlFor="create-sched-time"
                  className="block text-xs font-medium text-slate-700"
                >
                  每日执行时间 (HH:mm) *
                </label>
                <input
                  id="create-sched-time"
                  name="time"
                  type="time"
                  required
                  value={createTime}
                  onChange={(e) => setCreateTime(e.target.value)}
                  className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label
                  htmlFor="create-sched-items"
                  className="block text-xs font-medium text-slate-700"
                >
                  每期新闻条数 *
                </label>
                <input
                  id="create-sched-items"
                  name="itemCount"
                  type="number"
                  min={1}
                  step={1}
                  required
                  value={createCount}
                  onChange={(e) => setCreateCount(e.target.value)}
                  placeholder="例如：6"
                  className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                />
              </div>
              <input type="hidden" name="enabled" value="true" />
              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setModalOpen(false)}
                  className="rounded-lg border border-slate-300 px-3.5 py-2 text-xs font-medium text-slate-700"
                >
                  取消
                </button>
                <button
                  type="submit"
                  disabled={isPending}
                  className="rounded-lg bg-slate-900 px-4 py-2 text-xs font-medium text-white hover:bg-slate-800 disabled:opacity-50"
                >
                  {isPending ? '保存中…' : '确认创建并挂载'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {editingJob && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/40 p-4">
          <div className="w-full max-w-md rounded-xl border border-slate-200 bg-white p-6 shadow-xl">
            <h2 className="text-base font-semibold text-slate-900">编辑定时任务</h2>
            <form onSubmit={handleEditSubmit} className="mt-4 space-y-3">
              <input type="hidden" name="id" value={editingJob.id} />
              <div>
                <label
                  htmlFor="edit-sched-name"
                  className="block text-xs font-medium text-slate-700"
                >
                  任务名称
                </label>
                <input
                  id="edit-sched-name"
                  name="name"
                  type="text"
                  defaultValue={editingJob.name}
                  required
                  className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label
                  htmlFor="edit-sched-time"
                  className="block text-xs font-medium text-slate-700"
                >
                  每日执行时间 (HH:mm)
                </label>
                <input
                  id="edit-sched-time"
                  name="time"
                  type="time"
                  defaultValue={editingJob.time}
                  required
                  className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label
                  htmlFor="edit-sched-items"
                  className="block text-xs font-medium text-slate-700"
                >
                  每期新闻条数
                </label>
                <input
                  id="edit-sched-items"
                  name="itemCount"
                  type="number"
                  min={1}
                  step={1}
                  defaultValue={editingJob.itemCount}
                  required
                  className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                />
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setEditingJob(null)}
                  className="rounded-lg border border-slate-300 px-3.5 py-2 text-xs font-medium text-slate-700"
                >
                  取消
                </button>
                <button
                  type="submit"
                  disabled={isPending}
                  className="rounded-lg bg-slate-900 px-4 py-2 text-xs font-medium text-white hover:bg-slate-800 disabled:opacity-50"
                >
                  {isPending ? '更新中…' : '保存更改'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
