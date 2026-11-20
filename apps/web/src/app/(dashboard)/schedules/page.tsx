import { ScheduleManager } from '@/components/ScheduleManager';
import { getCore } from '@/lib/core';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** 定时任务管理页：展示已有每日定时计划，支持新建（强制显式填写时间与条数）、修改、启停和系统同步 */
export default async function SchedulesPage() {
  const core = await getCore();
  const settings = core.config.getSettings();
  const jobs = await core.scheduler.list();
  const bgmFiles = await core.tasks.listBgm();

  return <ScheduleManager jobs={jobs} timezone={settings.timezone} bgmFiles={bgmFiles} />;
}
