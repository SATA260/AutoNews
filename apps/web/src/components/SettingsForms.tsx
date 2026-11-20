'use client';

import type { AiStageName, Settings } from '@aidaily/contracts';
import { ArrowRightLeft } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, useTransition } from 'react';
import {
  loadModelRoutesAction,
  updateStageRoutingAction,
  updateWorkflowSettingsAction,
} from '@/app/actions';
import { resolveUnifiedStageSwitch } from '@/lib/stage-routing';

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
  const [bulkCli, setBulkCli] = useState<string>(() => settings.ai.stages.select.cli);
  const [bulkModel, setBulkModel] = useState('');
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

  const effectiveBulkCli = modelRoutes.includes(bulkCli)
    ? bulkCli
    : modelRoutes.includes(settings.ai.stages.select.cli)
      ? settings.ai.stages.select.cli
      : (modelRoutes[0] ?? '');
  const bulkModelCandidates = modelEntries[effectiveBulkCli]?.models ?? [];
  const activeStageClis = Array.from(
    new Set(
      AI_STAGE_INFO.map(({ key }) => {
        const draft = stageState[key];
        return modelRoutes.includes(draft.cli) ? draft.cli : settings.ai.stages[key].cli;
      }),
    ),
  );
  const currentUnifiedCli = activeStageClis.length === 1 ? (activeStageClis[0] ?? null) : null;

  /** 根据目标渠道与可选统一模型 ID 计算全部五个环节切换后的草稿配置 */
  const buildSwitchedStageState = (
    targetCli: string,
    targetModelRaw: string,
  ): { nextStages: Settings['ai']['stages']; missingModelStages: AiStageName[] } => {
    const readyModelsByCli: Record<string, readonly string[] | undefined> = {};
    for (const [cliName, entry] of Object.entries(modelEntries)) {
      if (entry.status === 'ready') {
        readyModelsByCli[cliName] = entry.models;
      }
    }
    return resolveUnifiedStageSwitch({
      currentStages: stageState,
      savedStages: settings.ai.stages,
      modelRoutes,
      readyModelsByCli,
      targetCli,
      unifiedModel: targetModelRaw,
    });
  };

  /** 仅将所有环节的渠道与模型状态切换到目标渠道，留待用户逐项核对后再点击保存 */
  const handleApplyBulkToDraft = () => {
    if (!effectiveBulkCli) {
      setFeedback({ ok: false, text: '当前没有可用的模型渠道，请先配置调用方式或 API 连接' });
      return;
    }
    const { nextStages, missingModelStages } = buildSwitchedStageState(effectiveBulkCli, bulkModel);
    setStageState(nextStages);
    if (missingModelStages.length > 0) {
      setFeedback({
        ok: false,
        text: `已将全部环节渠道切换至「${effectiveBulkCli}」，其中 ${missingModelStages.length} 个环节尚缺模型 ID，请补充后再保存`,
      });
      return;
    }
    setFeedback({
      ok: true,
      text: `已将全部 ${AI_STAGE_INFO.length} 个环节切换至渠道「${effectiveBulkCli}」，点击「保存模型路由设置」即可生效`,
    });
  };

  /** 一键将所有环节切换至选定渠道（及可选统一模型）并立即提交保存到配置文件 */
  const handleSwitchAllAndSave = () => {
    if (!effectiveBulkCli) {
      setFeedback({ ok: false, text: '当前没有可用的模型渠道，请先配置调用方式或 API 连接' });
      return;
    }
    const { nextStages, missingModelStages } = buildSwitchedStageState(effectiveBulkCli, bulkModel);
    setStageState(nextStages);

    if (missingModelStages.length > 0) {
      const missingTitles = AI_STAGE_INFO.filter(({ key }) => missingModelStages.includes(key)).map(
        ({ title }) => title,
      );
      setFeedback({
        ok: false,
        text: `已将全部环节渠道切换至「${effectiveBulkCli}」，请先为「${missingTitles.join('、')}」填写模型 ID（或上方指定统一模型 ID）后再保存`,
      });
      return;
    }

    const fd = new FormData();
    fd.set('maxConcurrentCalls', maxConcurrentCalls);
    for (const { key } of AI_STAGE_INFO) {
      const cfg = nextStages[key];
      fd.set(`stage_${key}_cli`, cfg.cli);
      fd.set(`stage_${key}_model`, cfg.model.trim());
      fd.set(`stage_${key}_timeoutSec`, String(cfg.timeoutSec));
      fd.set(`stage_${key}_retries`, String(cfg.retries));
    }

    setFeedback(null);
    startTransition(async () => {
      const res = await updateStageRoutingAction(fd);
      setFeedback({
        ok: res.ok,
        text: res.ok
          ? `已将全部模型切换至渠道「${effectiveBulkCli}」并保存，对新任务生效`
          : (res.error ?? '保存失败'),
      });
      router.refresh();
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
      className="space-y-4 rounded-2xl border border-slate-200/90 bg-white p-5 shadow-xs"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 pb-3.5">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-base font-semibold text-slate-900">分阶段模型设置</h2>
            <span
              className={`rounded-full px-2.5 py-0.5 text-[11px] font-medium ${
                currentUnifiedCli
                  ? 'bg-emerald-50 text-emerald-800 ring-1 ring-emerald-200/80'
                  : 'bg-slate-100 text-slate-600'
              }`}
            >
              {currentUnifiedCli ? `当前统一渠道：${currentUnifiedCli}` : '当前多渠道混用'}
            </span>
          </div>
          <p className="mt-0.5 text-xs text-slate-600">
            每个环节可独立选择调用方式和模型，也支持一键统一切换至同一渠道；保存后对新任务生效。
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
            max={20}
            value={maxConcurrentCalls}
            onChange={(e) => setMaxConcurrentCalls(e.target.value)}
            className="w-20 rounded-lg border border-slate-300 px-2.5 py-1 text-xs"
          />
        </div>
      </div>

      {modelRoutes.length > 0 && (
        <div className="space-y-3 rounded-xl border border-sky-200/80 bg-sky-50/60 p-3.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-xs font-semibold text-slate-900">
              <ArrowRightLeft className="h-3.5 w-3.5 text-sky-600" aria-hidden="true" />
              <span>一键切换所有环节为同一渠道</span>
            </div>
            <span className="text-[11px] text-slate-500">
              将选题、总结、润色、核查与编排统一切换至选定渠道；各环节超时与重试次数保持不变。
            </span>
          </div>

          <div className="grid gap-2.5 sm:grid-cols-12 sm:items-end">
            <div className="sm:col-span-4">
              <label
                htmlFor="bulk-stage-cli"
                className="block text-[11px] font-medium text-slate-600"
              >
                目标渠道（调用方式）
              </label>
              <select
                id="bulk-stage-cli"
                value={effectiveBulkCli}
                onChange={(e) => {
                  const nextCli = e.target.value;
                  setBulkCli(nextCli);
                  const nextModels = modelEntries[nextCli]?.models ?? [];
                  if (bulkModel && nextModels.length > 0 && !nextModels.includes(bulkModel)) {
                    setBulkModel('');
                  }
                }}
                className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs text-slate-900"
              >
                {modelRoutes.map((cliName) => (
                  <option key={cliName} value={cliName}>
                    {cliName}
                  </option>
                ))}
              </select>
            </div>

            <div className="sm:col-span-4">
              <label
                htmlFor="bulk-stage-model"
                className="block text-[11px] font-medium text-slate-600"
              >
                统一模型 ID（可选，留空自动匹配）
              </label>
              <input
                id="bulk-stage-model"
                type="text"
                list="bulk-stage-models"
                value={bulkModel}
                onChange={(e) => setBulkModel(e.target.value)}
                placeholder={
                  bulkModelCandidates.length > 0
                    ? `例如：${bulkModelCandidates[0]}`
                    : '留空或输入要统一使用的模型 ID'
                }
                className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 font-mono text-xs text-slate-900 placeholder:font-sans placeholder:text-slate-400"
              />
              <datalist id="bulk-stage-models">
                {bulkModelCandidates.map((m) => (
                  <option key={m} value={m} />
                ))}
              </datalist>
            </div>

            <div className="flex flex-wrap items-center justify-end gap-2 sm:col-span-4">
              <button
                type="button"
                disabled={isPending || !effectiveBulkCli}
                onClick={handleApplyBulkToDraft}
                className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-50"
              >
                应用到下方列表
              </button>
              <button
                type="button"
                disabled={isPending || !effectiveBulkCli}
                onClick={handleSwitchAllAndSave}
                className="rounded-lg bg-sky-600 px-3.5 py-1.5 text-xs font-medium text-white shadow-xs hover:bg-sky-700 disabled:opacity-50"
              >
                {isPending ? '切换保存中…' : '统一切换并保存'}
              </button>
            </div>
          </div>
        </div>
      )}

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
  const ttsProviders = Object.keys(settings.tts.providers);
  const workflowValuesKey = JSON.stringify({
    timezone: settings.timezone,
    issue: settings.issue,
    retry: settings.retry,
    editorial: settings.editorial,
    ttsProvider: settings.tts.provider,
    pauseAfterNarrate: settings.tts.pauseAfterNarrate,
    activeTemplate: settings.template.active,
    renderTheme: settings.render.theme ?? 'dark',
    renderLive2dPack: settings.render.live2dPack ?? 'fullbody',
    pagePaddingSec: settings.render.pagePaddingSec,
    bgmVolumeDb: settings.render.bgm.volumeDb,
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
      className="space-y-6 rounded-2xl border border-slate-200/90 bg-white p-5 shadow-xs"
    >
      <div className="border-b border-slate-100 pb-3.5">
        <h2 className="text-base font-semibold text-slate-900">选题补抓、模板渲染与发布设置</h2>
        <p className="mt-0.5 text-xs text-slate-600">
          注意：每期新闻条数与每日定时时间不在全局设置默认值，需在启动任务或创建定时任务时填写。
        </p>
      </div>

      <div key={workflowValuesKey} className="space-y-6">
        <section className="rounded-xl border border-slate-200/80 bg-slate-50/60 p-4">
          <div className="mb-3 border-b border-slate-200/70 pb-2">
            <h3 className="text-xs font-semibold text-slate-900">
              1. 新闻抓取、选题并发与重试策略
            </h3>
            <p className="mt-0.5 text-[11px] text-slate-500">
              控制新闻时效窗口、缺条自动补抓上限及单条稿件核查打回规则。
            </p>
          </div>
          <div className="grid gap-4 md:grid-cols-3">
            <div>
              <label className="block text-xs font-medium text-slate-700">
                展示时区
                <input
                  name="timezone"
                  type="text"
                  defaultValue={settings.timezone}
                  className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-normal"
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
                  className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-normal"
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
                  max={20}
                  defaultValue={settings.issue.itemConcurrency}
                  className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-normal"
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
                  className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-normal"
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
                  className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-normal"
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
                  className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-normal"
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
                  className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-normal"
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
                  className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-normal"
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
          </div>
        </section>

        <section className="rounded-xl border border-slate-200/80 bg-slate-50/60 p-4">
          <div className="mb-3 border-b border-slate-200/70 pb-2">
            <h3 className="text-xs font-semibold text-slate-900">2. 语音合成与视频模板渲染</h3>
            <p className="mt-0.5 text-[11px] text-slate-500">
              设置配音引擎、试听暂停开关、背景音乐音量以及前端视频模板参数。
            </p>
          </div>
          <div className="grid gap-4 md:grid-cols-3">
            <div>
              <label className="block text-xs font-medium text-slate-700">
                语音合成引擎
                <select
                  name="ttsProvider"
                  defaultValue={settings.tts.provider}
                  className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-normal"
                >
                  {ttsProviders.map((name) => (
                    <option key={name} value={name}>
                      {name === 'indextts'
                        ? 'indextts（本地 IndexTTS2.5）'
                        : name === 'qwen-local'
                          ? 'qwen-local（本地 Qwen3-TTS）'
                          : name}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700">
                背景音乐基准音量（dB）
                <input
                  name="bgmVolumeDb"
                  type="number"
                  step="1"
                  min={-30}
                  max={0}
                  defaultValue={settings.render.bgm.volumeDb}
                  className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-normal"
                />
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
                  className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-normal"
                />
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
                视频模板外观主题
                <select
                  name="renderTheme"
                  defaultValue={settings.render.theme ?? 'dark'}
                  className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-normal"
                >
                  <option value="dark">深色模式（dark）</option>
                  <option value="light">浅色模式（light）</option>
                </select>
              </label>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700">
                看板娘 Live2D 模型套组
                <select
                  name="renderLive2dPack"
                  defaultValue={settings.render.live2dPack ?? 'fullbody'}
                  className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-normal"
                >
                  <option value="fullbody">全身动作版（fullbody）</option>
                  <option value="expression">仅表情版（expression）</option>
                </select>
              </label>
            </div>

            <div className="md:col-span-3">
              <label className="inline-flex items-center gap-2 text-xs font-medium text-slate-700">
                <input
                  name="pauseAfterNarrate"
                  type="checkbox"
                  defaultChecked={settings.tts.pauseAfterNarrate}
                  value="true"
                  className="h-4 w-4 rounded border-slate-300"
                />
                配音完成后先停下来试听，确认后再合成视频
              </label>
            </div>
          </div>
        </section>

        <section className="rounded-xl border border-slate-200/80 bg-slate-50/60 p-4">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2 border-b border-slate-200/70 pb-2">
            <div>
              <h3 className="text-xs font-semibold text-slate-900">3. B 站投稿与 AI 内容声明</h3>
              <p className="mt-0.5 text-[11px] text-slate-500">
                配置发布审批方式、B 站分区、文案限制与固定默认标签。
              </p>
            </div>
            <span className="rounded-full bg-indigo-50 px-2.5 py-0.5 text-[11px] font-medium text-indigo-700 ring-1 ring-indigo-200/80">
              平台 AI 声明开关已强制锁定开启
            </span>
          </div>
          <div className="grid gap-4 md:grid-cols-3">
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
                  className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-normal"
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
                  className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-normal"
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
                  className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-normal"
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
                  className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-normal"
                />
              </label>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700">
                默认固定标签（逗号分隔）
                <input
                  name="defaultTags"
                  type="text"
                  defaultValue={settings.publish.bilibili.defaultTags.join(', ')}
                  className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-normal"
                />
              </label>
            </div>

            <div className="md:col-span-3">
              <label
                htmlFor="workflow-ai-disclaimer-input"
                className="block text-xs font-medium text-slate-700"
              >
                AI 生成内容声明尾部文案
              </label>
              <input
                id="workflow-ai-disclaimer-input"
                name="aiDisclaimerText"
                type="text"
                defaultValue={settings.publish.bilibili.aiDisclaimerText}
                className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs"
              />
            </div>
          </div>
        </section>
      </div>

      {feedback && (
        <div
          className={`rounded-xl border px-3.5 py-2.5 text-xs ${
            feedback.ok
              ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
              : 'border-rose-200 bg-rose-50 text-rose-700'
          }`}
        >
          {feedback.text}
        </div>
      )}

      <div className="flex justify-end border-t border-slate-100 pt-3">
        <button
          type="submit"
          disabled={isPending}
          className="rounded-lg bg-slate-900 px-5 py-2 text-xs font-medium text-white shadow-xs transition hover:bg-slate-800 disabled:opacity-50"
        >
          {isPending ? '保存中…' : '保存工作流与发布设置'}
        </button>
      </div>
    </form>
  );
}
