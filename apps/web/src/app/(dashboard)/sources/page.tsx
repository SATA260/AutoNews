import type { SourceKind } from '@aidaily/contracts';
import { SourceActions } from '@/components/SourceActions';
import { getCore } from '@/lib/core';
import { formatTimestamp } from '@/lib/format';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const KIND_TEXT: Record<SourceKind, string> = {
  rss: 'RSS 订阅',
  'html-list': '官方列表页',
  'x-timeline': 'X 账号动态',
};

/** 信源管理页：展示所有主力和备用新闻源的运行健康状况，支持一键启停和实时无缓存试抓 */
export default async function SourcesPage() {
  const core = await getCore();
  const settings = core.config.getSettings();
  const [sources, xAuth] = await Promise.all([core.sources.list(), core.sources.getXAuthStatus()]);

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-xl font-bold text-slate-900">新闻信源管理</h2>
        <p className="mt-1 text-xs text-slate-600">
          共配置 {sources.length} 个国内外 AI 资讯源，支持 RSS、官网列表页与 X
          账号动态三种协议，修改启停状态会保留原有注释直接更新配置。
        </p>
      </div>

      <div
        className={`rounded-xl border px-4 py-3 text-xs ${
          xAuth.configured
            ? 'border-emerald-200 bg-emerald-50 text-emerald-900'
            : 'border-amber-200 bg-amber-50 text-amber-900'
        }`}
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="font-semibold">
            X (Twitter) 动态抓取登录态：{xAuth.configured ? '已配置' : '未登录'}
          </span>
          <span className="font-mono text-[11px] opacity-80">{xAuth.detail}</span>
        </div>
        {!xAuth.configured ? (
          <p className="mt-1 text-[11px]">
            请在终端运行 <code className="rounded bg-white/70 px-1 py-0.5">aidaily x-login</code>{' '}
            完成扫码/登录，或使用{' '}
            <code className="rounded bg-white/70 px-1 py-0.5">
              aidaily x-login --import cookies.txt
            </code>{' '}
            导入 Cookie；未登录时会自动跳过 X 账号信源，不影响其他新闻抓取。
          </p>
        ) : null}
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        {sources.map(({ source, state, healthy }) => (
          <div
            key={source.id}
            className="flex flex-col justify-between gap-3 rounded-xl border border-slate-200 bg-white p-4 shadow-xs"
          >
            <div className="space-y-1.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <h3 className="text-sm font-semibold text-slate-900">{source.name}</h3>
                  <span className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[11px] text-slate-600">
                    {source.id}
                  </span>
                </div>
                <div className="flex items-center gap-1.5 text-[11px]">
                  <span
                    className={`rounded-full px-2 py-0.5 font-medium ${
                      source.enabled ? 'bg-sky-100 text-sky-800' : 'bg-slate-100 text-slate-600'
                    }`}
                  >
                    {source.enabled ? '已启用' : '已停用'}
                  </span>
                  <span
                    className={`rounded-full px-2 py-0.5 font-medium ${
                      healthy ? 'bg-emerald-100 text-emerald-800' : 'bg-rose-100 text-rose-800'
                    }`}
                  >
                    {healthy ? '健康' : `异常(${state?.consecutiveFailures ?? 0})`}
                  </span>
                </div>
              </div>

              <div className="flex flex-wrap gap-2 text-[11px] text-slate-600">
                <span>池分组：{source.pool === 'primary' ? '主力池' : '备用补充池'}</span>
                <span>语言：{source.lang === 'zh' ? '中文' : '英文'}</span>
                <span>优先级：Tier {source.tier}</span>
                <span>协议：{KIND_TEXT[source.kind] ?? source.kind}</span>
              </div>

              <p className="truncate font-mono text-[11px] text-slate-500" title={source.url}>
                {source.url}
              </p>

              <div className="text-[11px] text-slate-500">
                最近抓取：{formatTimestamp(state?.lastFetchedAt, settings.timezone)} ·
                最新文章时间：
                {formatTimestamp(state?.lastItemPublishedAt, settings.timezone)}
              </div>

              {state?.lastError ? (
                <p className="rounded bg-rose-50 px-2.5 py-1.5 text-[11px] text-rose-700">
                  最近错误：{state.lastError}
                </p>
              ) : null}
            </div>

            <div className="border-t border-slate-100 pt-2.5">
              <SourceActions sourceId={source.id} enabled={source.enabled} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
