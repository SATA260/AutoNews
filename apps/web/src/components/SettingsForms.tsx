'use client';

import type { AiStageName, Settings } from '@aidaily/contracts';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, useTransition } from 'react';
import {
  loadModelRoutesAction,
  updateStageRoutingAction,
  updateWorkflowSettingsAction,
} from '@/app/actions';

const AI_STAGE_INFO: Array<{ key: AiStageName; title: string; hint: string }> = [
  { key: 'select', title: '选题聚类', hint: '结合近期已播库筛选普通受众关心的新闻事件' },
  { key: 'summarize', title: '通俗总结', hint: '提取核心事实、可用范围并保留原文逐字引语' },
  { key: 'polish', title: '中文口播润色', hint: '转换为口语化字幕文案与分句口播稿' },
  { key: 'factcheck', title: '独立事实核查', hint: '仅对照原文独立审查数字、时间、可用性与依据' },
  { key: 'package', title: '整期编排与包装', hint: '确定新闻先后顺序、开场总结词与标题标签' },
];

/** 客户端维护的单条调用方式模型候选与拉取状态记录 */
interface RouteModelEntry {
  cacheKey: string;
  models: string[];
  status: 'ready' | 'error';
  error?: string;
}

/** 根据服务端下发的已缓存模型映射构建本地就绪状态 */
function buildInitialModelEntries(
  modelsByCli: Record<string, string[]>,
  routeCacheKeys: Record<string, string>,
): Record<string, RouteModelEntry> {
  const entries: Record<string, RouteModelEntry> = {};
  for (const [cli, models] of Object.entries(modelsByCli)) {
    entries[cli] = {
      cacheKey: routeCacheKeys[cli] ?? '',
      models,
      status: 'ready',
    };
  }
  return entries;
}

/** 按阶段选择调用方式，可从模型列表选择或手填模型 ID */
export function StageRoutingForm({
  settings,
  modelRoutes,
  modelsByCli,
  routeCacheKeys,
  modelsRevision = 0,
}: {
  settings: Settings;
  modelRoutes: string[];
  modelsByCli: Record<string, string[]>;
  routeCacheKeys?: Record<string, string>;
  modelsRevision?: number;
}) {
  const router = useRouter();
  const effectiveKeys = routeCacheKeys ?? {};
  const [stageState, setStageState] = useState(settings.ai.stages);
  const [maxConcurrentCalls, setMaxConcurrentCalls] = useState(
    String(settings.ai.maxConcurrentCalls),
  );
  const [prevAiConfigJson, setPrevAiConfigJson] = useState(() =>
    JSON.stringify({
      stages: settings.ai.stages,
      maxConcurrentCalls: settings.ai.maxConcurrentCalls,
    }),
  );

  const [clientRevision, setClientRevision] = useState(modelsRevision);
  const [modelEntries, setModelEntries] = useState<Record<string, RouteModelEntry>>(() =>
    buildInitialModelEntries(modelsByCli, effectiveKeys),
  );
  const [prevSyncSignature, setPrevSyncSignature] = useState(() =>
    JSON.stringify({ modelsByCli, effectiveKeys, modelRoutes, modelsRevision }),
  );
  const [isRefreshingModels, setIsRefreshingModels] = useState(false);
  const [modelLoadWarning, setModelLoadWarning] = useState<string | null>(null);
  const pendingLoadsRef = useRef(0);
  const manualRefreshSeqRef = useRef(0);
  const [feedback, setFeedback] = useState<{ ok: boolean; text: string } | null>(null);
  const [isPending, startTransition] = useTransition();

  const nextAiConfigJson = JSON.stringify({
    stages: settings.ai.stages,
    maxConcurrentCalls: settings.ai.maxConcurrentCalls,
  });
  if (nextAiConfigJson !== prevAiConfigJson) {
    setPrevAiConfigJson(nextAiConfigJson);
    setStageState(settings.ai.stages);
    setMaxConcurrentCalls(String(settings.ai.maxConcurrentCalls));
  }

  const syncSignature = JSON.stringify({ modelsByCli, effectiveKeys, modelRoutes, modelsRevision });
  if (syncSignature !== prevSyncSignature) {
    setPrevSyncSignature(syncSignature);
    const nextRev = Math.max(clientRevision, modelsRevision);
    if (nextRev !== clientRevision) {
      setClientRevision(nextRev);
    }
    setModelEntries((prev) => {
      const next: Record<string, RouteModelEntry> = {};
      for (const cli of modelRoutes) {
        const expectedKey = effectiveKeys[cli] ?? '';
        const localEntry = prev[cli];
        const localMatchesKey = Boolean(localEntry && localEntry.cacheKey === expectedKey);
        const serverHasRoute = Object.hasOwn(modelsByCli, cli);

        if (localMatchesKey && localEntry?.status === 'ready' && modelsRevision < clientRevision) {
          next[cli] = localEntry;
        } else if (serverHasRoute) {
          next[cli] = {
            cacheKey: expectedKey,
            models: modelsByCli[cli] ?? [],
            status: 'ready',
          };
        } else if (localMatchesKey && localEntry) {
          next[cli] = localEntry;
        }
      }
      return next;
    });
  }

  const missingTargets = modelRoutes
    .filter((cli) => {
      const entry = modelEntries[cli];
      return !entry || entry.cacheKey !== (effectiveKeys[cli] ?? '');
    })
    .map((cli) => ({ cli, cacheKey: effectiveKeys[cli] ?? '' }));
  const missingJson = JSON.stringify(missingTargets);

  useEffect(() => {
    const targets = JSON.parse(missingJson) as Array<{ cli: string; cacheKey: string }>;
    if (targets.length === 0) {
      return;
    }
    let cancelled = false;
    const observedRefreshSeq = manualRefreshSeqRef.current;
    pendingLoadsRef.current += 1;
    setIsRefreshingModels(true);

    loadModelRoutesAction({
      routes: targets.map((item) => item.cli),
      forceRefresh: false,
    })
      .then((res) => {
        if (cancelled || observedRefreshSeq !== manualRefreshSeqRef.current) {
          return;
        }
        const payload = res.data;
        if (payload) {
          setClientRevision((prev) => Math.max(prev, payload.revision));
        }
        const failedNotices: string[] = [];
        setModelEntries((prev) => {
          const next = { ...prev };
          for (const { cli, cacheKey } of targets) {
            if (payload && Object.hasOwn(payload.modelsByCli, cli)) {
              next[cli] = {
                cacheKey,
                models: payload.modelsByCli[cli] ?? [],
                status: 'ready',
              };
            } else {
              const errReason =
                payload?.errorsByCli[cli] ?? res.error ?? '未能获取该调用方式的模型列表';
              failedNotices.push(`${cli}（${errReason}）`);
              next[cli] = {
                cacheKey,
                models: prev[cli]?.cacheKey === cacheKey ? prev[cli].models : [],
                status: 'error',
                error: errReason,
              };
            }
          }
          return next;
        });
        if (failedNotices.length > 0) {
          setModelLoadWarning(
            `部分调用方式暂未获取到模型列表：${failedNotices.join('；')}。可直接手填模型 ID，或点击「刷新模型列表」重试。`,
          );
        } else {
          setModelLoadWarning(null);
        }
      })
      .catch((err) => {
        if (cancelled || observedRefreshSeq !== manualRefreshSeqRef.current) {
          return;
        }
        const errReason = err instanceof Error ? err.message : '网络或服务异常';
        setModelEntries((prev) => {
          const next = { ...prev };
          for (const { cli, cacheKey } of targets) {
            next[cli] = {
              cacheKey,
              models: prev[cli]?.cacheKey === cacheKey ? prev[cli].models : [],
              status: 'error',
              error: errReason,
            };
          }
          return next;
        });
        setModelLoadWarning(
          `加载可选模型列表失败（${errReason}），可直接手填模型 ID 或点击「刷新模型列表」重试。`,
        );
      })
      .finally(() => {
        pendingLoadsRef.current = Math.max(0, pendingLoadsRef.current - 1);
        setIsRefreshingModels(pendingLoadsRef.current > 0);
      });

    return () => {
      cancelled = true;
    };
  }, [missingJson]);

  /** 手动强制重新拉取全部调用方式的可用模型列表，失败路由保留原已加载列表并提示具体错误 */
  const handleRefreshModels = () => {
    setFeedback(null);
    setModelLoadWarning(null);
    const reqSeq = ++manualRefreshSeqRef.current;
    pendingLoadsRef.current += 1;
    setIsRefreshingModels(true);
    const snapshotRoutes = [...modelRoutes];
    const snapshotKeys = { ...effectiveKeys };
    loadModelRoutesAction({ forceRefresh: true })
      .then((res) => {
        if (reqSeq !== manualRefreshSeqRef.current) {
          return;
        }
        const payload = res.data;
        if (payload) {
          setClientRevision((prev) => Math.max(prev, payload.revision));
          setModelEntries((prev) => {
            const next = { ...prev };
            for (const cli of snapshotRoutes) {
              const expectedKey = snapshotKeys[cli] ?? '';
              const routeFailed = Object.hasOwn(payload.errorsByCli, cli);
              const hasValidServerList = Object.hasOwn(payload.modelsByCli, cli);
              if (!routeFailed && hasValidServerList) {
                next[cli] = {
                  cacheKey: expectedKey,
                  models: payload.modelsByCli[cli] ?? [],
                  status: 'ready',
                };
              } else {
                const prevSameKey =
                  prev[cli] && prev[cli].cacheKey === expectedKey ? prev[cli] : undefined;
                if (prevSameKey && prevSameKey.status === 'ready') {
                  next[cli] = prevSameKey;
                } else if (hasValidServerList) {
                  next[cli] = {
                    cacheKey: expectedKey,
                    models: payload.modelsByCli[cli] ?? [],
                    status: 'ready',
                  };
                } else {
                  next[cli] = {
                    cacheKey: expectedKey,
                    models: prevSameKey?.models ?? [],
                    status: 'error',
                    error: payload.errorsByCli[cli] ?? res.error ?? '刷新失败',
                  };
                }
              }
            }
            return next;
          });
        }
        if (res.ok) {
          setFeedback({ ok: true, text: res.message ?? '可用模型列表已刷新' });
        } else {
          setFeedback({ ok: false, text: res.error ?? '刷新模型列表失败' });
        }
      })
      .catch((err) => {
        if (reqSeq !== manualRefreshSeqRef.current) {
          return;
        }
        setFeedback({
          ok: false,
          text: err instanceof Error ? err.message : '刷新模型列表失败',
        });
      })
      .finally(() => {
        pendingLoadsRef.current = Math.max(0, pendingLoadsRef.current - 1);
        setIsRefreshingModels(pendingLoadsRef.current > 0);
      });
  };

  /** 更新单个阶段表单项的本地草稿状态；目标调用方式模型列表尚未就绪时保留原模型 ID */
  const updateField = (
    stageKey: AiStageName,
    field: 'cli' | 'model' | 'timeoutSec' | 'retries',
    value: string,
  ) => {
    setStageState((prev) => {
      const next = { ...prev };
      const draft = prev[stageKey];
      const curr = modelRoutes.includes(draft.cli) ? draft : settings.ai.stages[stageKey];
      if (field === 'cli') {
        const savedStage = settings.ai.stages[stageKey];
        const savedModelForTarget = value === savedStage.cli ? savedStage.model : '';
        const targetEntry = modelEntries[value];
        const nextModel =
          targetEntry?.status === 'ready'
            ? targetEntry.models.includes(curr.model)
              ? curr.model
              : savedModelForTarget
            : curr.model || savedModelForTarget;
        next[stageKey] = { ...curr, cli: value, model: nextModel };
      } else if (field === 'model') {
        next[stageKey] = { ...curr, model: value };
      } else if (field === 'timeoutSec') {
        next[stageKey] = { ...curr, timeoutSec: Number(value) || curr.timeoutSec };
      } else {
        next[stageKey] = { ...curr, retries: Number(value) };
      }
      return next;
    });
  };

  /** 提交保存各阶段调用方式与模型配置 */
  const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setFeedback(null);
    const fd = new FormData(event.currentTarget);
    startTransition(async () => {
      const res = await updateStageRoutingAction(fd);
      setFeedback({
        ok: res.ok,
        text: res.ok ? (res.message ?? '阶段模型配置已保存') : (res.error ?? '保存失败'),
      });
      router.refresh();
    });
  };

  return (
    <form
      onSubmit={handleSubmit}
      className="space-y-4 rounded-xl border border-slate-200 bg-white p-5 shadow-sm"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 pb-3">
        <div>
          <h2 className="text-base font-semibold text-slate-900">分阶段模型设置</h2>
          <p className="mt-0.5 text-xs text-slate-600">
            每个环节可独立选择调用方式和模型，保存后对新任务生效。
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={isRefreshingModels}
            onClick={handleRefreshModels}
            className="rounded-lg border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-50"
          >
            {isRefreshingModels ? '刷新模型中…' : '刷新模型列表'}
          </button>
          <label htmlFor="ai-max-concurrency" className="text-xs font-medium text-slate-700">
            最大模型并发数
          </label>
          <input
            id="ai-max-concurrency"
            name="maxConcurrentCalls"
            type="number"
            min={1}
            max={10}
            value={maxConcurrentCalls}
            onChange={(e) => setMaxConcurrentCalls(e.target.value)}
            className="w-20 rounded-lg border border-slate-300 px-2.5 py-1 text-xs"
          />
        </div>
      </div>

      {modelLoadWarning && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          {modelLoadWarning}
        </div>
      )}

      <div className="space-y-3">
        {AI_STAGE_INFO.map(({ key, title, hint }) => {
          const draft = stageState[key];
          const cfg = modelRoutes.includes(draft.cli) ? draft : settings.ai.stages[key];
          const routeModels = modelEntries[cfg.cli]?.models ?? [];
          const modelCandidates = Array.from(new Set([cfg.model, ...routeModels].filter(Boolean)));
          return (
            <div
              key={key}
              className="grid gap-3 rounded-lg border border-slate-200 bg-slate-50/70 p-3 md:grid-cols-12 md:items-center"
            >
              <div className="md:col-span-4">
                <div className="text-sm font-medium text-slate-900">{title}</div>
                <div className="text-[11px] text-slate-500">{hint}</div>
              </div>

              <div className="md:col-span-2">
                <label className="block text-[11px] text-slate-500">
                  调用方式
                  <select
                    name={`stage_${key}_cli`}
                    value={modelRoutes.includes(cfg.cli) ? cfg.cli : ''}
                    required
                    onChange={(e) => updateField(key, 'cli', e.target.value)}
                    className="mt-1 w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-xs font-normal text-slate-900"
                  >
                    <option value="" disabled>
                      请选择调用方式
                    </option>
                    {modelRoutes.map((cliName) => (
                      <option key={cliName} value={cliName}>
                        {cliName}
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              <div className="md:col-span-4">
                <label className="block text-[11px] text-slate-500">
                  模型 ID
                  <input
                    name={`stage_${key}_model`}
                    list={`stage_${key}_models`}
                    required
                    value={cfg.model}
                    onChange={(e) => updateField(key, 'model', e.target.value)}
                    className="mt-1 w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 font-mono text-xs font-normal text-slate-900"
                  />
                  <datalist id={`stage_${key}_models`}>
                    {modelCandidates.map((m) => (
                      <option key={m} value={m} />
                    ))}
                  </datalist>
                </label>
              </div>

              <div className="md:col-span-1">
                <label className="block text-[11px] text-slate-500">
                  超时(秒)
                  <input
                    name={`stage_${key}_timeoutSec`}
                    type="number"
                    min={1}
                    value={cfg.timeoutSec}
                    onChange={(e) => updateField(key, 'timeoutSec', e.target.value)}
                    className="mt-1 w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-xs font-normal text-slate-900"
                  />
                </label>
              </div>

              <div className="md:col-span-1">
                <label className="block text-[11px] text-slate-500">
                  重试次
                  <input
                    name={`stage_${key}_retries`}
                    type="number"
                    min={0}
                    value={cfg.retries}
                    onChange={(e) => updateField(key, 'retries', e.target.value)}
                    className="mt-1 w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-xs font-normal text-slate-900"
                  />
                </label>
              </div>
            </div>
          );
        })}
      </div>

      {feedback && (
        <div
          className={`rounded-lg border px-3 py-2 text-xs ${
            feedback.ok
              ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
              : 'border-rose-200 bg-rose-50 text-rose-700'
          }`}
        >
          {feedback.text}
        </div>
      )}

      <div className="flex justify-end">
        <button
          type="submit"
          disabled={isPending}
          className="rounded-lg bg-slate-900 px-4 py-2 text-xs font-medium text-white hover:bg-slate-800 disabled:opacity-50"
        >
          {isPending ? '保存中…' : '保存模型路由设置'}
        </button>
      </div>
    </form>
  );
}

/** 补抓策略、模板、画面与 B 站发布通用配置表单组件（AI 声明强制锁定为开启） */
export function WorkflowSettingsForm({ settings }: { settings: Settings }) {
  const router = useRouter();
  const [feedback, setFeedback] = useState<{ ok: boolean; text: string } | null>(null);
  const [isPending, startTransition] = useTransition();
  const templateNames = Object.keys(settings.template.registry);
  const workflowValuesKey = JSON.stringify({
    timezone: settings.timezone,
    issue: settings.issue,
    retry: settings.retry,
    editorial: settings.editorial,
    activeTemplate: settings.template.active,
    pagePaddingSec: settings.render.pagePaddingSec,
    publish: settings.publish,
  });

  /** 提交保存工作流、渲染与发布参数 */
  const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setFeedback(null);
    const fd = new FormData(event.currentTarget);
    startTransition(async () => {
      const res = await updateWorkflowSettingsAction(fd);
      setFeedback({
        ok: res.ok,
        text: res.ok ? (res.message ?? '通用配置已保存') : (res.error ?? '保存失败'),
      });
      router.refresh();
    });
  };

  return (
    <form
      onSubmit={handleSubmit}
      className="space-y-5 rounded-xl border border-slate-200 bg-white p-5 shadow-sm"
    >
      <div className="border-b border-slate-100 pb-3">
        <h2 className="text-base font-semibold text-slate-900">选题补抓、模板渲染与发布设置</h2>
        <p className="mt-0.5 text-xs text-slate-600">
          注意：每期新闻条数与每日定时时间不在全局设置默认值，需在启动任务或创建定时任务时填写。
        </p>
      </div>

      <div key={workflowValuesKey} className="grid gap-4 md:grid-cols-3">
        <div>
          <label className="block text-xs font-medium text-slate-700">
            展示时区
            <input
              name="timezone"
              type="text"
              defaultValue={settings.timezone}
              className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-normal"
            />
          </label>
        </div>
        <div>
          <label className="block text-xs font-medium text-slate-700">
            新闻新鲜度窗口（小时）
            <input
              name="freshnessHours"
              type="number"
              min={1}
              defaultValue={settings.issue.freshnessHours}
              className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-normal"
            />
          </label>
        </div>
        <div>
          <label className="block text-xs font-medium text-slate-700">
            同时处理新闻并发数
            <input
              name="itemConcurrency"
              type="number"
              min={1}
              max={10}
              defaultValue={settings.issue.itemConcurrency}
              className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-normal"
            />
          </label>
        </div>

        <div>
          <label className="block text-xs font-medium text-slate-700">
            缺条最大补抓轮次
            <input
              name="maxRounds"
              type="number"
              min={0}
              max={10}
              defaultValue={settings.issue.refill.maxRounds}
              className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-normal"
            />
          </label>
        </div>
        <div>
          <label className="block text-xs font-medium text-slate-700">
            每轮放宽时效（小时）
            <input
              name="lookbackStepHours"
              type="number"
              min={1}
              defaultValue={settings.issue.refill.lookbackStepHours}
              className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-normal"
            />
          </label>
        </div>
        <div>
          <label className="block text-xs font-medium text-slate-700">
            最大回溯时长上限（小时）
            <input
              name="maxLookbackHours"
              type="number"
              min={1}
              defaultValue={settings.issue.refill.maxLookbackHours}
              className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-normal"
            />
          </label>
        </div>

        <div>
          <label className="block text-xs font-medium text-slate-700">
            中断保留重试时长（小时）
            <input
              name="reservationHoldHours"
              type="number"
              min={1}
              defaultValue={settings.retry.reservationHoldHours}
              className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-normal"
            />
          </label>
        </div>
        <div>
          <label className="block text-xs font-medium text-slate-700">
            单条核查打回微调上限
            <input
              name="maxRevisions"
              type="number"
              min={0}
              max={5}
              defaultValue={settings.editorial.maxRevisions}
              className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-normal"
            />
          </label>
        </div>
        <div className="flex items-end pb-1.5">
          <label className="inline-flex items-center gap-2 text-xs font-medium text-slate-700">
            <input
              name="useBackupSources"
              type="checkbox"
              defaultChecked={settings.issue.refill.useBackupSources}
              value="true"
              className="h-4 w-4 rounded border-slate-300"
            />
            缺条时启用备用新闻信源池
          </label>
        </div>

        <div>
          <label className="block text-xs font-medium text-slate-700">
            视频合成前端模板
            <select
              name="activeTemplate"
              defaultValue={settings.template.active}
              className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-normal"
            >
              {templateNames.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div>
          <label className="block text-xs font-medium text-slate-700">
            每页画面停顿缓冲（秒）
            <input
              name="pagePaddingSec"
              type="number"
              step="0.1"
              min={0}
              defaultValue={settings.render.pagePaddingSec}
              className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-normal"
            />
          </label>
        </div>
        <div>
          <label className="block text-xs font-medium text-slate-700">
            发布审批模式
            <select
              name="publishMode"
              defaultValue={settings.publish.mode}
              className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-normal"
            >
              <option value="manual-review">人工审核后发布（推荐）</option>
              <option value="auto">质检通过后自动投稿</option>
            </select>
          </label>
        </div>

        <div>
          <label className="block text-xs font-medium text-slate-700">
            B 站投稿分区 ID
            <input
              name="bilibiliTid"
              type="number"
              min={0}
              defaultValue={settings.publish.bilibili.tid}
              className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-normal"
            />
          </label>
        </div>
        <div>
          <label className="block text-xs font-medium text-slate-700">
            标题字数上限
            <input
              name="titleMax"
              type="number"
              min={1}
              defaultValue={settings.publish.bilibili.titleMax}
              className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-normal"
            />
          </label>
        </div>
        <div>
          <label className="block text-xs font-medium text-slate-700">
            简介字数上限
            <input
              name="descMax"
              type="number"
              min={1}
              defaultValue={settings.publish.bilibili.descMax}
              className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-normal"
            />
          </label>
        </div>

        <div>
          <label className="block text-xs font-medium text-slate-700">
            标签数量上限
            <input
              name="tagsMax"
              type="number"
              min={1}
              defaultValue={settings.publish.bilibili.tagsMax}
              className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-normal"
            />
          </label>
        </div>
        <div className="md:col-span-2">
          <label className="block text-xs font-medium text-slate-700">
            默认固定标签（逗号分隔）
            <input
              name="defaultTags"
              type="text"
              defaultValue={settings.publish.bilibili.defaultTags.join(', ')}
              className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-normal"
            />
          </label>
        </div>

        <div className="md:col-span-3">
          <div className="flex items-center justify-between">
            <label
              htmlFor="workflow-ai-disclaimer-input"
              className="block text-xs font-medium text-slate-700"
            >
              AI 生成内容声明尾部文案
            </label>
            <span className="rounded bg-indigo-50 px-2 py-0.5 text-[11px] font-medium text-indigo-700">
              平台 AI 声明开关已强制锁定开启
            </span>
          </div>
          <input
            id="workflow-ai-disclaimer-input"
            name="aiDisclaimerText"
            type="text"
            defaultValue={settings.publish.bilibili.aiDisclaimerText}
            className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-1.5 text-xs"
          />
        </div>
      </div>

      {feedback && (
        <div
          className={`rounded-lg border px-3 py-2 text-xs ${
            feedback.ok
              ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
              : 'border-rose-200 bg-rose-50 text-rose-700'
          }`}
        >
          {feedback.text}
        </div>
      )}

      <div className="flex justify-end">
        <button
          type="submit"
          disabled={isPending}
          className="rounded-lg bg-slate-900 px-4 py-2 text-xs font-medium text-white hover:bg-slate-800 disabled:opacity-50"
        >
          {isPending ? '保存中…' : '保存工作流与发布设置'}
        </button>
      </div>
    </form>
  );
}
