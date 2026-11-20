import type { ReactNode } from 'react';
import { DashboardSidebar } from '@/components/DashboardShell';
import { getCoreVersion } from '@/lib/core';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** 控制台公共导航布局：包含自适应高亮侧栏菜单与宽松工作区容器 */
export default function DashboardLayout({ children }: { children: ReactNode }) {
  const version = getCoreVersion();

  return (
    <div className="min-h-screen bg-[#f3f5f8] text-slate-900">
      <div className="mx-auto flex min-h-screen max-w-[1600px] flex-col lg:flex-row">
        <DashboardSidebar coreVersion={version} />
        <main className="min-w-0 flex-1 px-4 py-6 sm:px-6 lg:px-8 lg:py-7">
          <div className="mx-auto w-full max-w-[1280px]">{children}</div>
        </main>
      </div>
    </div>
  );
}
