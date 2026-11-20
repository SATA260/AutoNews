import type { Settings } from '@aidaily/contracts';
import { Suspense } from 'react';
import { ModelApiConnections } from '@/components/ModelApiConnections';
import { StageRoutingForm, WorkflowSettingsForm } from '@/components/SettingsForms';
import { SystemDoctorPanel, SystemDoctorSkeleton } from '@/components/SystemDoctorPanel';
import { getCore } from '@/lib/core';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** 异步执行或复用进行中的环境自检，异常时将具体错误原因透传给诊断面板 */
async function AsyncDoctorSection({ settings }: { settings: Settings }) {
  const core = await getCore();
  try {
    const report = await core.system.doctor({ useCache: true });
    return <SystemDoctorPanel settings={settings} initialReport={report} />;
  } catch (err) {
    const initialError = err instanceof Error ? err.message : '环境自检执行失败';
    return (
      <SystemDoctorPanel settings={settings} initialReport={null} initialError={initialError} />
    );
  }
}

/** 系统配置页：同步读取内存配置与缓存快照即时渲染表单，未命中的环境自检异步流式加载 */
export default async function SettingsPage() {
  const core = await getCore();
  const settings = core.config.getSettings();
  const modelRoutes = core.system.getModelRoutes();
  const modelsSnapshot = core.system.getCachedModelsSnapshot();
  const cachedDoctor = core.system.getCachedDoctor();

  const selectedRoutes = new Set(Object.values(settings.ai.stages).map(({ cli }) => cli));
  for (const ch of settings.ai.channels ?? []) {
    selectedRoutes.add(ch.cli);
  }
  const connections = Object.entries(settings.ai.providers ?? {}).map(([name, provider]) => ({
    name,
    baseUrl: provider.baseUrl,
    protocol: provider.protocol,
    jsonMode: provider.jsonMode,
    hasCredential: Boolean(provider.apiKeyEnv || provider.apiKeyFile),
    inUse: selectedRoutes.has(name),
  }));

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-200/80 pb-5">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">系统配置与模型路由</h1>
          <p className="mt-1 text-sm text-slate-600">
            所有配置变更均以安全覆盖方式写入配置文件；B 站 AI
            生成内容声明在流程内强制保留为开启状态。
          </p>
        </div>

        <nav aria-label="设置快捷导航" className="flex flex-wrap gap-1.5 text-xs">
          <a
            href="#api-connections"
            className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 font-medium text-slate-700 hover:bg-slate-50"
          >
            模型 API 连接
          </a>
          <a
            href="#stage-routing"
            className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 font-medium text-slate-700 hover:bg-slate-50"
          >
            分阶段模型
          </a>
          <a
            href="#system-doctor"
            className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 font-medium text-slate-700 hover:bg-slate-50"
          >
            环境自检
          </a>
          <a
            href="#workflow-settings"
            className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 font-medium text-slate-700 hover:bg-slate-50"
          >
            工作流与发布
          </a>
        </nav>
      </div>

      <div id="api-connections" className="scroll-mt-6">
        <ModelApiConnections connections={connections} />
      </div>
      <div id="stage-routing" className="scroll-mt-6">
        <StageRoutingForm
          settings={settings}
          modelRoutes={modelRoutes}
          modelsByCli={modelsSnapshot.modelsByCli}
          routeCacheKeys={modelsSnapshot.routeCacheKeys}
          modelsRevision={modelsSnapshot.revision}
        />
      </div>

      <div id="system-doctor" className="scroll-mt-6">
        {cachedDoctor ? (
          <SystemDoctorPanel settings={settings} initialReport={cachedDoctor} />
        ) : (
          <Suspense fallback={<SystemDoctorSkeleton settings={settings} />}>
            <AsyncDoctorSection settings={settings} />
          </Suspense>
        )}
      </div>

      <div id="workflow-settings" className="scroll-mt-6">
        <WorkflowSettingsForm settings={settings} />
      </div>
    </div>
  );
}
