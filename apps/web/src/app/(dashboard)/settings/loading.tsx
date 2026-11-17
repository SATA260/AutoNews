/** 设置页路由切换时的即时轻量占位骨架，确保侧栏点击后立即响应 */
export default function SettingsLoading() {
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-bold text-slate-900">系统配置与模型路由</h2>
        <p className="mt-1 text-xs text-slate-600">正在读取当前配置…</p>
      </div>
      <div className="h-32 animate-pulse rounded-xl border border-slate-200 bg-white p-5" />
      <div className="h-72 animate-pulse rounded-xl border border-slate-200 bg-white p-5" />
      <div className="h-56 animate-pulse rounded-xl border border-slate-200 bg-white p-5" />
    </div>
  );
}
