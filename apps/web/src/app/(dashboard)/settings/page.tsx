import { ModelApiConnections } from '@/components/ModelApiConnections';
import { StageRoutingForm, WorkflowSettingsForm } from '@/components/SettingsForms';
import { getCore } from '@/lib/core';
import { formatTimestamp } from '@/lib/format';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** 系统配置页：管理 API 连接、阶段模型和其他运行参数 */
export default async function SettingsPage() {
  const core = await getCore();
  const settings = core.config.getSettings();
  const modelRoutes = core.system.getModelRoutes();
  const selectedRoutes = new Set(Object.values(settings.ai.stages).map(({ cli }) => cli));
  const connections = Object.entries(settings.ai.providers ?? {}).map(([name, provider]) => ({
    name,
    baseUrl: provider.baseUrl,
    protocol: provider.protocol,
    jsonMode: provider.jsonMode,
    hasCredential: Boolean(provider.apiKeyEnv || provider.apiKeyFile),
    inUse: selectedRoutes.has(name),
  }));

  const [doctor, ...modelPairs] = await Promise.all([
    core.system.doctor(),
    ...modelRoutes.map(
      async (cli) => [cli, await core.system.listModels(cli).catch(() => [] as string[])] as const,
    ),
  ]);
  const modelsByCli = Object.fromEntries(modelPairs);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-bold text-slate-900">系统配置与模型路由</h2>
        <p className="mt-1 text-xs text-slate-600">
          所有配置变更均以安全覆盖方式写入配置文件；B 站 AI 生成内容声明在流程内强制保留为开启状态。
        </p>
      </div>

      <ModelApiConnections connections={connections} />
      <StageRoutingForm settings={settings} modelRoutes={modelRoutes} modelsByCli={modelsByCli} />

      <section className="space-y-4 rounded-xl border border-slate-200 bg-white p-5 shadow-xs">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 pb-3">
          <div>
            <h3 className="text-base font-semibold text-slate-900">
              语音合成、通知接口与环境自检状态
            </h3>
            <p className="mt-0.5 text-xs text-slate-600">
              语音引擎与消息通知均采用抽象扩展接口，方便后续按需接入外部配音服务与飞书群机器人。
            </p>
          </div>
          <span
            className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${
              doctor.ok ? 'bg-emerald-100 text-emerald-800' : 'bg-amber-100 text-amber-800'
            }`}
          >
            {doctor.ok ? '必备环境就绪' : '存在待排查检查项'} · 自检于{' '}
            {formatTimestamp(doctor.checkedAt, settings.timezone)}
          </span>
        </div>

        <div className="grid gap-3 text-xs sm:grid-cols-2 lg:grid-cols-4">
          <div className="rounded-lg border border-slate-100 bg-slate-50 p-3">
            <div className="text-slate-500">当前语音合成提供方</div>
            <div className="mt-1 font-mono font-semibold text-slate-900">
              {settings.tts.provider}
            </div>
          </div>
          <div className="rounded-lg border border-slate-100 bg-slate-50 p-3">
            <div className="text-slate-500">音频采样与目标响度</div>
            <div className="mt-1 font-mono font-semibold text-slate-900">
              {settings.tts.postprocess.sampleRate}Hz · {settings.tts.postprocess.loudnessLUFS} LUFS
            </div>
          </div>
          <div className="rounded-lg border border-slate-100 bg-slate-50 p-3">
            <div className="text-slate-500">句间 / 段间停顿参数</div>
            <div className="mt-1 font-mono font-semibold text-slate-900">
              {settings.tts.postprocess.sentenceGapMs}ms / {settings.tts.postprocess.sectionGapMs}ms
            </div>
          </div>
          <div className="rounded-lg border border-slate-100 bg-slate-50 p-3">
            <div className="text-slate-500">当前通知渠道提供方</div>
            <div className="mt-1 font-mono font-semibold text-slate-900">
              {settings.notify.provider}
            </div>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-slate-200 text-left text-xs">
            <thead className="bg-slate-50 text-slate-600">
              <tr>
                <th className="px-3 py-2 font-medium">环境检查项</th>
                <th className="px-3 py-2 font-medium">必需项</th>
                <th className="px-3 py-2 font-medium">结果</th>
                <th className="px-3 py-2 font-medium">说明</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {doctor.checks.map((item) => (
                <tr key={item.name}>
                  <td className="px-3 py-2 font-mono text-slate-900">{item.name}</td>
                  <td className="px-3 py-2 text-slate-600">{item.required ? '是' : '可选'}</td>
                  <td className="px-3 py-2">
                    <span
                      className={
                        item.ok ? 'font-medium text-emerald-700' : 'font-medium text-rose-700'
                      }
                    >
                      {item.ok ? '通过' : '异常'}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-slate-700">{item.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <WorkflowSettingsForm settings={settings} />
    </div>
  );
}
