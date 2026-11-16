export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** 后台管理首页组件 */
export default function DashboardPage() {
  return (
    <main className="mx-auto max-w-5xl px-6 py-12">
      <div className="rounded-xl border border-slate-200 bg-white p-8 shadow-sm">
        <p className="text-xs font-medium tracking-wider text-slate-500 uppercase">
          AI 每日报 · 控制台
        </p>
        <h1 className="mt-2 text-2xl font-semibold text-slate-900">工作流后台已就绪</h1>
        <p className="mt-3 text-sm text-slate-600">
          工作流后台基础框架已就绪，后续将在此接入任务运行监控、原文核查对照、成片预览与 B
          站投稿功能。
        </p>
      </div>
    </main>
  );
}
