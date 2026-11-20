import type { AiStageName, Settings } from '@aidaily/contracts';

/** 全部需要配置大模型路由的阶段顺序清单 */
export const AI_STAGE_KEYS: readonly AiStageName[] = [
  'select',
  'summarize',
  'polish',
  'factcheck',
  'package',
];

/** 根据目标渠道与可选统一模型 ID 计算全部阶段统一切换后的表单状态，并列出缺失模型 ID 的阶段 */
export function resolveUnifiedStageSwitch(opts: {
  currentStages: Settings['ai']['stages'];
  savedStages: Settings['ai']['stages'];
  modelRoutes: readonly string[];
  readyModelsByCli: Record<string, readonly string[] | undefined>;
  targetCli: string;
  unifiedModel?: string;
}): {
  nextStages: Settings['ai']['stages'];
  missingModelStages: AiStageName[];
} {
  const { currentStages, savedStages, modelRoutes, readyModelsByCli, targetCli } = opts;
  const trimmedBulkModel = (opts.unifiedModel ?? '').trim();
  const readyModels = readyModelsByCli[targetCli];
  const hasReadyModels = Array.isArray(readyModels);

  const nextStages = { ...currentStages };
  const missingModelStages: AiStageName[] = [];

  for (const key of AI_STAGE_KEYS) {
    const draft = currentStages[key];
    const curr = modelRoutes.includes(draft.cli) ? draft : savedStages[key];
    const savedStage = savedStages[key];
    const savedModelForTarget = targetCli === savedStage.cli ? savedStage.model : '';

    let nextModel = trimmedBulkModel;
    if (!nextModel) {
      if (curr.cli === targetCli && curr.model.trim()) {
        nextModel = curr.model;
      } else if (savedModelForTarget) {
        nextModel = savedModelForTarget;
      } else if (hasReadyModels) {
        nextModel = readyModels.includes(curr.model) ? curr.model : (readyModels[0] ?? '');
      } else {
        nextModel = '';
      }
    }

    if (!nextModel.trim()) {
      missingModelStages.push(key);
    }
    nextStages[key] = { ...curr, cli: targetCli, model: nextModel };
  }

  return { nextStages, missingModelStages };
}
