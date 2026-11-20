'use client';

import type { SourceHealth, SourceKind } from '@aidaily/contracts';
import type { XAuthStatus } from '@aidaily/core';
import { CheckCircle2, Search, ShieldAlert } from 'lucide-react';
import { useState } from 'react';
import { SourceActions } from '@/components/SourceActions';
import { formatTimestamp } from '@/lib/format';
import { cn } from '@/lib/utils';

type SourceQuickTab = 'all' | 'primary' | 'backup' | 'unhealthy' | 'disabled';

const KIND_TEXT: Record<SourceKind, string> = {
  rss: 'RSS 订阅',
  'html-list': '官方列表页',
  'x-timeline': 'X 账号动态',
};

/** 新闻信源交互式管理面板：支持分组统计筛选、关键词检索、启停开关与即时试抓 */
export function SourcesManager({
  sources,
  xAuth,
  timezone,
}: {
  sources: SourceHealth[];
  xAuth: XAuthStatus;
  timezone: string;
}) {
  const [tab, setTab] = useState<SourceQuickTab>('all');
  const [kindFilter, setKindFilter] = useState<string>('');
  const [langFilter, setLangFilter] = useState<string>('');
  const [query, setQuery] = useState('');

  const primaryCount = sources.filter((s) => s.source.pool === 'primary').length;
  const backupCount = sources.filter((s) => s.source.pool === 'backup').length;
  const unhealthyCount = sources.filter((s) => s.source.enabled && !s.healthy).length;
  const disabledCount = sources.filter((s) => !s.source.enabled).length;

  const trimmedQuery = query.trim().toLowerCase();
  const filtered = sources.filter(({ source, healthy }) => {
    if (tab === 'primary' && source.pool !== 'primary') return false;
    if (tab === 'backup' && source.pool !== 'backup') return false;
    if (tab === 'unhealthy' && (!source.enabled || healthy)) return false;
    if (tab === 'disabled' && source.enabled) return false;
    if (kindFilter && source.kind !== kindFilter) return false;
    if (langFilter && source.lang !== langFilter) return false;
    if (trimmedQuery) {
      const haystack = `${source.name} ${source.id} ${source.url}`.toLowerCase();
      if (!haystack.includes(trimmedQuery)) return false;
    }
    return true;
  });

  const tabs: Array<{ key: SourceQuickTab; label: string; count: number }> = [
    { key: 'all', label: '全部信源', count: sources.length },
    { key: 'primary', label: '主力池', count: primaryCount },
    { key: 'backup', label: '备用池', count: backupCount },
    { key: 'unhealthy', label: '抓取异常', count: unhealthyCount },
    { key: 'disabled', label: '已停用', count: disabledCount },
  ];

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-200/80 pb-5">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">新闻信源管理</h1>
          <p className="mt-1 text-sm text-slate-600">
            共配置 {sources.length} 个国内外 AI 资讯源，支持 RSS、官网列表页与 X
            账号动态三种协议，修改启停状态会保留原有注释直接写回配置。
          </p>
        </div>
      </div>

      <div
        className={cn(
          'rounded-2xl border px-4 py-3.5 text-xs shadow-xs',
          xAuth.configured
            ? 'border-emerald-200 bg-emerald-50/80 text-emerald-900'
            : 'border-amber-200 bg-amber-50/90 text-amber-900',
        )}
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="inline-flex items-center gap-2 font-semibold">
            {xAuth.configured ? (
              <CheckCircle2 className="h-4 w-4 text-emerald-600" aria-hidden="true" />
            ) : (
              <ShieldAlert className="h-4 w-4 text-amber-600" aria-hidden="true" />
            )}
            <span>X (Twitter) 动态抓取登录态：{xAuth.configured ? '已配置' : '未登录'}</span>
          </span>
          <span className="font-mono text-[11px] opacity-80">{xAuth.detail}</span>
        </div>
        {!xAuth.configured ? (
          <p className="mt-1.5 text-[11px] leading-relaxed">
            请在终端运行 <code className="rounded bg-white/80 px-1.5 py-0.5">aidaily x-login</code>{' '}
            完成扫码/登录，或使用{' '}
            <code className="rounded bg-white/80 px-1.5 py-0.5">
              aidaily x-login --import cookies.txt
            </code>{' '}
            导入 Cookie；未登录时会自动跳过 X 账号信源，不影响其他新闻抓取。
          </p>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-slate-200/90 bg-white p-4 shadow-xs">
        <div className="flex flex-wrap gap-1.5">
          {tabs.map((item) => {
            const active = tab === item.key;
            return (
              <button
                key={item.key}
                type="button"
                onClick={() => setTab(item.key)}
                className={cn(
                  'rounded-full border px-3 py-1 text-xs font-medium transition-colors',
                  active
                    ? 'border-slate-900 bg-slate-900 text-white'
                    : 'border-slate-200 bg-slate-50 text-slate-700 hover:bg-slate-100',
                )}
              >
                {item.label}（{item.count}）
              </button>
            );
          })}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="relative">
            <Search
              className="pointer-events-none absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2 text-slate-400"
              aria-hidden="true"
            />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜索名称、ID 或 URL…"
              aria-label="搜索信源"
              className="w-48 rounded-lg border border-slate-300 bg-white py-1.5 pr-3 pl-8 text-xs text-slate-900 placeholder:text-slate-400 focus:border-sky-500 focus:outline-none sm:w-56"
            />
          </div>

          <select
            aria-label="按协议筛选"
            value={kindFilter}
            onChange={(e) => setKindFilter(e.target.value)}
            className="rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs text-slate-700"
          >
            <option value="">全部协议</option>
            <option value="rss">RSS 订阅</option>
            <option value="html-list">官方列表页</option>
            <option value="x-timeline">X 账号动态</option>
          </select>

          <select
            aria-label="按语言筛选"
            value={langFilter}
            onChange={(e) => setLangFilter(e.target.value)}
            className="rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs text-slate-700"
          >
            <option value="">全部语言</option>
            <option value="zh">中文</option>
            <option value="en">英文</option>
          </select>
        </div>
      </div>

      {filtered.length === 0 ? (
        <div className="rounded-2xl border border-slate-200/90 bg-white p-10 text-center text-sm text-slate-500 shadow-xs">
          当前筛选条件下没有匹配的信源。
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {filtered.map(({ source, state, healthy }) => (
            <div
              key={source.id}
              className="flex flex-col justify-between gap-3 rounded-2xl border border-slate-200/90 bg-white p-4.5 shadow-xs transition-shadow hover:shadow-sm"
            >
              <div className="space-y-2">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span
                        className={cn(
                          'h-2 w-2 shrink-0 rounded-full',
                          !source.enabled
                            ? 'bg-slate-300'
                            : healthy
                              ? 'bg-emerald-500'
                              : 'bg-rose-500',
                        )}
                      />
                      <h2 className="text-sm font-semibold text-slate-900">{source.name}</h2>
                      <span className="rounded-md bg-slate-100 px-1.5 py-0.5 font-mono text-[11px] text-slate-600">
                        {source.id}
                      </span>
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5 text-[11px]">
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

                <div className="flex flex-wrap gap-1.5 text-[11px] text-slate-600">
                  <span className="rounded-md border border-slate-200/80 bg-slate-50 px-2 py-0.5">
                    {source.pool === 'primary' ? '主力池' : '备用补充池'}
                  </span>
                  <span className="rounded-md border border-slate-200/80 bg-slate-50 px-2 py-0.5">
                    {source.lang === 'zh' ? '中文' : '英文'}
                  </span>
                  <span className="rounded-md border border-slate-200/80 bg-slate-50 px-2 py-0.5">
                    Tier {source.tier}
                  </span>
                  <span className="rounded-md border border-slate-200/80 bg-slate-50 px-2 py-0.5">
                    {KIND_TEXT[source.kind] ?? source.kind}
                  </span>
                </div>

                <p className="truncate font-mono text-[11px] text-slate-500" title={source.url}>
                  {source.url}
                </p>

                <div className="tabular-nums text-[11px] text-slate-500">
                  最近抓取：{formatTimestamp(state?.lastFetchedAt, timezone)} · 最新文章：
                  {formatTimestamp(state?.lastItemPublishedAt, timezone)}
                </div>

                {state?.lastError ? (
                  <p className="rounded-lg border border-rose-200 bg-rose-50 px-2.5 py-1.5 text-[11px] text-rose-700">
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
      )}
    </div>
  );
}
