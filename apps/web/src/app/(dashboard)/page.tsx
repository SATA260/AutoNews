export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export default function DashboardPage() {
  return (
    <main className="mx-auto max-w-5xl px-6 py-12">
      <div className="rounded-xl border border-slate-200 bg-white p-8 shadow-sm">
        <p className="text-xs font-medium tracking-wider text-slate-500 uppercase">
          AI 每日报 · 控制台
        </p>
        <h1 className="mt-2 text-2xl font-semibold text-slate-900">工作流后台已就绪</h1>
        <p className="mt-3 text-sm text-slate-600">
          当前处于工程脚手架阶段（M0）。任务调度、原文核查透视、成片预览与 B
          站发布界面将在后续里程碑陆续接入。
        </p>
      </div>
    </main>
  );
}
