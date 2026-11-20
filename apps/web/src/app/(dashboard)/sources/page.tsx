import { SourcesManager } from '@/components/SourcesManager';
import { getCore } from '@/lib/core';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** 信源管理页：展示所有主力和备用新闻源的运行健康状况，支持筛选、一键启停与实时试抓 */
export default async function SourcesPage() {
  const core = await getCore();
  const settings = core.config.getSettings();
  const [sources, xAuth] = await Promise.all([core.sources.list(), core.sources.getXAuthStatus()]);

  return <SourcesManager sources={sources} xAuth={xAuth} timezone={settings.timezone} />;
}
