import { CliBridgeError, type InvokeResult } from '@aidaily/cli-bridge';
import type { AiStageName, Settings } from '@aidaily/contracts';
import type { z } from 'zod';
import type { CoreContext } from '../context.js';
import { PipelineError } from '../errors.js';

/**
 * 按当前任务配置动态选取指定 AI 处理环节对应的命令行工具与模型发起结构化调用，
 * 不在代码中固定任何模型名称；当命令行工具不可用或重试耗尽时统一转为标准流程异常。
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
  const stageCfg = opts.settings.ai.stages[opts.stage];
  try {
    return await opts.ctx.bridge.invoke({
      cli: stageCfg.cli,
      model: stageCfg.model,
      prompt: opts.prompt,
      schema: opts.schema,
      timeoutMs: stageCfg.timeoutSec * 1000,
      retries: stageCfg.retries,
      signal: opts.signal,
      meta: {
        runId: opts.runId,
        stage: opts.stage,
        itemId: opts.itemId,
      },
    });
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw err;
    }
    if (err instanceof CliBridgeError) {
      throw new PipelineError(
        'llm_unavailable',
        `AI 处理环节 ${opts.stage}（CLI=${stageCfg.cli}, model=${stageCfg.model}）调用失败: ${err.message}`,
        { cause: err },
      );
    }
    throw err;
  }
}
