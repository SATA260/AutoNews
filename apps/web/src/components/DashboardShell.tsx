'use client';

import {
  Clock,
  History,
  LayoutDashboard,
  ListVideo,
  Newspaper,
  Rss,
  Settings,
  ShieldAlert,
  Sparkles,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';

interface NavEntry {
  href: string;
  label: string;
  icon: 'dashboard' | 'runs' | 'articles' | 'history' | 'schedules' | 'sources' | 'settings';
}

const NAV_GROUPS: Array<{ title: string; items: readonly NavEntry[] }> = [
  {
    title: '内容生产',
    items: [
      { href: '/', label: '控制台总览', icon: 'dashboard' },
      { href: '/runs', label: '任务列表', icon: 'runs' },
      { href: '/articles', label: '爬取新闻', icon: 'articles' },
      { href: '/history', label: '已播历史', icon: 'history' },
    ],
  },
  {
    title: '自动化与配置',
    items: [
      { href: '/schedules', label: '定时任务', icon: 'schedules' },
      { href: '/sources', label: '信源管理', icon: 'sources' },
      { href: '/settings', label: '系统设置', icon: 'settings' },
    ],
  },
];

/** 按导航项标识渲染对应的线性矢量图标 */
function NavIcon({ icon, active }: { icon: NavEntry['icon']; active: boolean }) {
  const cls = cn('h-4 w-4 shrink-0', active ? 'text-sky-600' : 'text-slate-400');
  switch (icon) {
    case 'dashboard':
      return <LayoutDashboard className={cls} aria-hidden="true" />;
    case 'runs':
      return <ListVideo className={cls} aria-hidden="true" />;
    case 'articles':
      return <Newspaper className={cls} aria-hidden="true" />;
    case 'history':
      return <History className={cls} aria-hidden="true" />;
    case 'schedules':
      return <Clock className={cls} aria-hidden="true" />;
    case 'sources':
      return <Rss className={cls} aria-hidden="true" />;
    case 'settings':
      return <Settings className={cls} aria-hidden="true" />;
  }
}

/** 判断指定导航链接是否处于当前路由激活状态 */
function isNavActive(pathname: string, href: string): boolean {
  if (href === '/') {
    return pathname === '/';
  }
  return pathname === href || pathname.startsWith(`${href}/`);
}

/** 控制台自适应导航外壳：桌面端提供固定侧栏，移动端提供紧凑顶栏横向导航 */
export function DashboardSidebar({ coreVersion }: { coreVersion: string }) {
  const pathname = usePathname() || '/';

  return (
    <aside className="border-b border-slate-200/80 bg-white/95 backdrop-blur-sm lg:sticky lg:top-0 lg:flex lg:h-screen lg:w-64 lg:shrink-0 lg:flex-col lg:justify-between lg:border-r lg:border-b-0">
      <div className="p-4 sm:px-6 lg:p-5">
        <div className="flex items-center justify-between gap-3">
          <Link href="/" className="group flex items-center gap-2.5">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-sky-500 to-indigo-600 text-white shadow-sm">
              <Sparkles className="h-4.5 w-4.5" aria-hidden="true" />
            </span>
            <div>
              <span className="block text-[11px] font-semibold tracking-wider text-sky-600 uppercase">
                AI 每日报
              </span>
              <span className="block text-base font-bold tracking-tight text-slate-900 group-hover:text-sky-700">
                工作流控制台
              </span>
            </div>
          </Link>

          <span className="rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 font-mono text-[11px] text-slate-500 lg:hidden">
            v{coreVersion}
          </span>
        </div>

        {/* 移动端横向胶囊导航 */}
        <nav
          aria-label="移动端主导航"
          className="-mx-1 mt-3 flex gap-1.5 overflow-x-auto px-1 pb-1 lg:hidden"
        >
          {NAV_GROUPS.flatMap((g) => g.items).map((item) => {
            const active = isNavActive(pathname, item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  'inline-flex shrink-0 items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium transition-colors',
                  active
                    ? 'border-sky-200 bg-sky-50 text-sky-700'
                    : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50 hover:text-slate-900',
                )}
              >
                <NavIcon icon={item.icon} active={active} />
                <span>{item.label}</span>
              </Link>
            );
          })}
        </nav>

        {/* 桌面端分组侧栏导航 */}
        <nav aria-label="主导航" className="mt-6 hidden space-y-5 lg:block">
          {NAV_GROUPS.map((group) => (
            <div key={group.title}>
              <div className="px-2.5 text-[11px] font-semibold tracking-wider text-slate-400 uppercase">
                {group.title}
              </div>
              <div className="mt-1.5 space-y-1">
                {group.items.map((item) => {
                  const active = isNavActive(pathname, item.href);
                  return (
                    <Link
                      key={item.href}
                      href={item.href}
                      className={cn(
                        'flex items-center gap-2.5 rounded-xl px-3 py-2 text-sm font-medium transition-all',
                        active
                          ? 'bg-sky-50 text-sky-800 ring-1 ring-sky-200/80'
                          : 'text-slate-600 hover:bg-slate-100/80 hover:text-slate-900',
                      )}
                    >
                      <NavIcon icon={item.icon} active={active} />
                      <span>{item.label}</span>
                    </Link>
                  );
                })}
              </div>
            </div>
          ))}
        </nav>
      </div>

      <div className="hidden space-y-2.5 border-t border-slate-100 p-5 text-xs text-slate-500 lg:block">
        <div className="flex items-start gap-2 rounded-xl border border-amber-200/80 bg-amber-50/80 p-3 text-amber-900">
          <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" aria-hidden="true" />
          <p className="text-[11px] leading-relaxed">
            本地后台未设登录鉴权，请仅绑定本机地址（127.0.0.1），切勿暴露到公网。
          </p>
        </div>
        <div className="flex items-center justify-between px-1 text-[11px] text-slate-400">
          <span>核心引擎</span>
          <span className="font-mono text-slate-500">v{coreVersion}</span>
        </div>
      </div>
    </aside>
  );
}
