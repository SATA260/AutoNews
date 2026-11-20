import { HistoryManager } from '@/components/HistoryManager';
import { getCore } from '@/lib/core';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** 历史已播库查询页：按播报时间倒序展示已确认发布或审核完结的历史事件，支持快速过滤搜索 */
export default async function HistoryPage() {
  const core = await getCore();
  const settings = core.config.getSettings();
  const records = await core.publish.listHistory(100);

  return <HistoryManager records={records} timezone={settings.timezone} />;
}
