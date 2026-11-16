import { ScheduleManager } from '@/components/ScheduleManager';
import { getCore } from '@/lib/core';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** 定时任务管理页：展示已有每日定时计划，支持新建（强制显式填写时间与条数）、修改、启停和系统同步 */
export default async function SchedulesPage() {
  const core = await getCore();
  const settings = core.config.getSettings();
  const jobs = await core.scheduler.list();

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-xl font-bold text-slate-900">定时任务管理</h2>
        <p className="mt-1 text-xs text-slate-600">
          每个定时计划均需由操作者显式指定每日触发时间（24 小时制
          HH:mm）与当期制作条数，系统不设置默认值。
        </p>
      </div>

      <ScheduleManager jobs={jobs} timezone={settings.timezone} />
    </div>
  );
}
