import Link from 'next/link';
import type { ReactNode } from 'react';
import { getCoreVersion } from '@/lib/core';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const NAV_ITEMS = [
  { href: '/', label: '控制台总览' },
  { href: '/runs', label: '任务列表' },
  { href: '/schedules', label: '定时任务' },
  { href: '/sources', label: '信源管理' },
  { href: '/history', label: '已播历史' },
  { href: '/settings', label: '系统设置' },
] as const;

/** 控制台公共导航布局：包含侧栏菜单、本地绑定安全提示与核心版本号 */
export default function DashboardLayout({ children }: { children: ReactNode }) {
  const version = getCoreVersion();

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <div className="mx-auto flex min-h-screen max-w-7xl flex-col lg:flex-row">
        <aside className="border-b border-slate-200 bg-white lg:w-64 lg:shrink-0 lg:border-r lg:border-b-0">
          <div className="flex h-full flex-col justify-between p-5">
            <div>
              <Link href="/" className="block">
                <p className="text-xs font-semibold tracking-wider text-sky-600 uppercase">
                  AI 每日报
                </p>
                <h1 className="mt-1 text-lg font-bold text-slate-900">工作流管理台</h1>
              </Link>

              <nav aria-label="主导航" className="mt-6 flex flex-wrap gap-1.5 lg:flex-col">
                {NAV_ITEMS.map((item) => (
                  <Link
                    key={item.href}
                    href={item.href}
                    className="rounded-lg px-3 py-2 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-100 hover:text-slate-900"
                  >
                    {item.label}
                  </Link>
                ))}
              </nav>
            </div>

            <div className="mt-6 hidden space-y-2 border-t border-slate-100 pt-4 text-xs text-slate-500 lg:block">
              <p className="rounded-md bg-amber-50 px-2.5 py-2 text-amber-800">
                安全提示：后台未设登录鉴权，请仅绑定本机回环地址（127.0.0.1），切勿暴露到公网。
              </p>
              <p>核心版本：{version}</p>
            </div>
          </div>
        </aside>

        <main className="min-w-0 flex-1 px-4 py-6 sm:px-6 lg:px-8">{children}</main>
      </div>
    </div>
  );
}
