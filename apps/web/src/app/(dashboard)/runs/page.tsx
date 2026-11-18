import { type RunStatus, RunStatusSchema, type Trigger } from '@aidaily/contracts';
import Link from 'next/link';
import { StartRunModalButton } from '@/components/StartRunModalButton';
import { getCore } from '@/lib/core';
import {
  formatDuration,
  formatTimestamp,
  RUN_STATUS_TEXT,
  runStatusBadgeClass,
  STAGE_LABELS,
} from '@/lib/format';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const TRIGGER_TEXT: Record<Trigger, string> = {
  'manual-cli': '命令行触发',
  'manual-web': '网页后台触发',
  schedule: '定时任务触发',
};

const FILTER_PRESETS: Array<{ key: string; label: string; statuses?: RunStatus[] }> = [
  { key: 'all', label: '全部任务' },
  {
    key: 'active',
    label: '进行中',
    statuses: ['queued', 'running', 'publishing'],
  },
  {
    key: 'awaiting_review',
    label: '待试听 / 待审核',
    statuses: ['awaiting_audio_review', 'awaiting_review', 'publish_uncertain'],
  },
  {
    key: 'published',
    label: '已完成',
    statuses: ['published'],
  },
  {
    key: 'recoverable',
    label: '失败 / 中断',
    statuses: ['failed', 'interrupted', 'publish_failed'],
  },
  {
    key: 'closed',
    label: '取消 / 驳回 / 放弃',
    statuses: ['cancelled', 'rejected', 'abandoned'],
  },
];

/** 从 URL 查询参数中解析需要过滤的任务状态列表 */
function parseStatusFilter(rawStatus: string | undefined): {
  presetKey: string;
  statuses: RunStatus[] | undefined;
} {
  const trimmed = rawStatus?.trim();
  if (!trimmed || trimmed === 'all') {
    return { presetKey: 'all', statuses: undefined };
  }
  const matchedPreset = FILTER_PRESETS.find((p) => p.key === trimmed);
  if (matchedPreset?.statuses) {
    return { presetKey: matchedPreset.key, statuses: matchedPreset.statuses };
  }
  const parsed: RunStatus[] = [];
  for (const part of trimmed.split(',')) {
    const check = RunStatusSchema.safeParse(part.trim());
    if (check.success) {
      parsed.push(check.data);
    }
  }
  return parsed.length > 0
    ? { presetKey: trimmed, statuses: parsed }
    : { presetKey: 'all', statuses: undefined };
}

/** 任务列表页：支持按运行状态筛选任务并快速发起新一期制作 */
export default async function RunsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const sp = await searchParams;
  const { presetKey, statuses } = parseStatusFilter(sp.status);

  const core = await getCore();
  const settings = core.config.getSettings();
  const bgmFiles = await core.tasks.listBgm();
  const runs = await core.tasks.list({
    ...(statuses ? { status: statuses } : {}),
    limit: 100,
  });

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-bold text-slate-900">任务列表</h2>
          <p className="mt-1 text-xs text-slate-600">
            查看全部生成任务，按状态筛选或点击进入任务详情审查文稿、成片与中断重跑选项。
          </p>
        </div>
        <StartRunModalButton bgmFiles={bgmFiles} label="新建一期任务" />
      </div>

      <div className="flex flex-wrap gap-2">
        {FILTER_PRESETS.map((preset) => {
          const active = presetKey === preset.key;
          return (
            <Link
              key={preset.key}
              href={preset.key === 'all' ? '/runs' : `/runs?status=${preset.key}`}
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
                  <th className="px-4 py-2.5 font-medium">任务编号</th>
                  <th className="px-4 py-2.5 font-medium">状态</th>
                  <th className="px-4 py-2.5 font-medium">步骤 / 轮次</th>
                  <th className="px-4 py-2.5 font-medium">条数</th>
                  <th className="px-4 py-2.5 font-medium">触发来源</th>
                  <th className="px-4 py-2.5 font-medium">创建时间</th>
                  <th className="px-4 py-2.5 font-medium">耗时</th>
                  <th className="px-4 py-2.5 font-medium">错误摘要</th>
                  <th className="px-4 py-2.5 font-medium">操作</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {runs.map((run) => (
                  <tr key={run.id} className="hover:bg-slate-50">
                    <td className="px-4 py-2.5 font-mono font-medium text-slate-900">
                      <Link href={`/runs/${run.id}`} className="hover:text-sky-700 hover:underline">
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
                      {formatTimestamp(run.createdAt, settings.timezone)}
                    </td>
                    <td className="px-4 py-2.5 text-slate-600">
                      {formatDuration(run.startedAt, run.finishedAt)}
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
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
