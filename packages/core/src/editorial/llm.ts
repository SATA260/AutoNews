import type { AiStageName, Settings } from '@aidaily/contracts';
import { type InvokeRequest, type InvokeResult, ModelCallError } from '@aidaily/model-runtime';
import type { z } from 'zod';
import type { CoreContext } from '../context.js';
import { PipelineError } from '../errors.js';

/**
 * 按本期配置选择对应阶段的模型调用方式，并把调用失败转换为任务异常。
 */
export async function invokeStageLlm<T>(opts: {
  ctx: CoreContext;
  settings: Settings;
  stage: AiStageName;
  runId: string;
  itemId?: string;
  prompt: string;
  schema: z.ZodType<T>;
  signal?: AbortSignal;
}): Promise<InvokeResult<T>> {
  const { ai, clis } = opts.settings;
  const stageCfg = ai.stages[opts.stage];
  const request: InvokeRequest<T> = {
    cli: stageCfg.cli,
    model: stageCfg.model,
    prompt: opts.prompt,
    schema: opts.schema,
    timeoutMs: stageCfg.timeoutSec * 1000,
    retries: stageCfg.retries,
    signal: opts.signal,
    meta: { runId: opts.runId, stage: opts.stage, itemId: opts.itemId },
  };
  try {
    if (ai.providers && Object.hasOwn(ai.providers, stageCfg.cli)) {
      const provider = ai.providers[stageCfg.cli];
      if (provider) {
        return await opts.ctx.modelApi.invoke(request, provider, ai.maxConcurrentCalls);
      }
    }
    if (!Object.hasOwn(clis, stageCfg.cli)) {
      throw new ModelCallError(`本期配置未定义调用方式 ${stageCfg.cli}`, false);
    }
    return await opts.ctx.bridge.invoke(request, clis[stageCfg.cli], ai.maxConcurrentCalls);
  } catch (err) {
    if (err instanceof ModelCallError) {
      throw new PipelineError(
        'llm_unavailable',
        `AI 处理环节 ${opts.stage}（调用方式 ${stageCfg.cli}，模型 ${stageCfg.model}）调用失败：${err.message}`,
        { cause: err },
      );
    }
    throw err;
  }
}
