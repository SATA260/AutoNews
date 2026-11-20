import { type RunStatus, RunStatusSchema } from '@aidaily/contracts';
import { RunsManager } from '@/components/RunsManager';
import { StartRunModalButton } from '@/components/StartRunModalButton';
import { getCore } from '@/lib/core';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const FILTER_PRESETS: Array<{ key: string; statuses?: RunStatus[] }> = [
  { key: 'all' },
  {
    key: 'active',
    statuses: ['queued', 'running', 'publishing'],
  },
  {
    key: 'awaiting_review',
    statuses: ['awaiting_audio_review', 'awaiting_review', 'publish_uncertain'],
  },
  {
    key: 'published',
    statuses: ['published'],
  },
  {
    key: 'recoverable',
    statuses: ['failed', 'interrupted', 'publish_failed'],
  },
  {
    key: 'closed',
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

/** 任务列表页：支持按运行状态和创建时间筛选任务、快速发起新任务及选择性或按时间批量清理产物与任务 */
export default async function RunsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; from?: string; to?: string }>;
}) {
  const sp = await searchParams;
  const { presetKey, statuses } = parseStatusFilter(sp.status);
  const from = sp.from?.trim() || '';
  const to = sp.to?.trim() || '';

  const core = await getCore();
  const settings = core.config.getSettings();
  const bgmFiles = await core.tasks.listBgm();

  let runs: Awaited<ReturnType<typeof core.tasks.list>> = [];
  let filterError: string | null = null;
  try {
    runs = await core.tasks.list({
      ...(statuses ? { status: statuses } : {}),
      ...(from ? { from } : {}),
      ...(to ? { to } : {}),
      limit: 100,
    });
  } catch (err) {
    filterError = err instanceof Error ? err.message : String(err);
  }

  const diskUsageByRunId =
    runs.length > 0 ? await core.tasks.listRunDiskUsage(runs.map((r) => r.id)) : {};

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-200/80 pb-5">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">任务列表</h1>
          <p className="mt-1 text-sm text-slate-600">
            查看全部生成任务，按状态与创建时间筛选、清理本地磁盘产物或批量删除历史任务。
          </p>
        </div>
        <StartRunModalButton bgmFiles={bgmFiles} label="新建一期任务" />
      </div>

      <RunsManager
        runs={runs}
        diskUsageByRunId={diskUsageByRunId}
        timezone={settings.timezone}
        initialPresetKey={presetKey}
        initialFrom={from}
        initialTo={to}
        filterError={filterError}
      />
    </div>
  );
}
