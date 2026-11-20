import type { AiStageName, LlmStage, Settings, Stage } from '@aidaily/contracts';
import { type InvokeRequest, type InvokeResult, ModelCallError } from '@aidaily/model-runtime';
import type { z } from 'zod';
import type { CoreContext } from '../context.js';
import { PipelineError } from '../errors.js';
import { emitRunEvent } from '../workflow/events.js';

/** 解析后的单个可执行 AI 渠道参数 */
export interface ResolvedAiChannel {
  cli: string;
  model: string;
  retries: number;
  timeoutSec: number;
  source: 'stage_custom' | 'channel_pool' | 'stage_legacy';
}

function toRunEventStage(stage: LlmStage): Stage {
  if (stage === 'select' || stage === 'package') return stage;
  return 'edit';
}

function isAbortError(err: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  return err instanceof Error && err.name === 'AbortError';
}

function tryEmitChannelEvent(ctx: CoreContext, input: Parameters<typeof emitRunEvent>[1]): void {
  try {
    if (!ctx.repos?.runEvents) return;
    emitRunEvent(ctx, input);
  } catch (eventErr) {
    ctx.logger?.warn?.(
      { runId: input.runId, type: input.type, err: String(eventErr) },
      '写入渠道切换日志失败，已跳过',
    );
  }
}

/**
 * 按当前配置解析指定 AI 环节的有序渠道尝试列表：
 * - 若阶段设为跟随全局渠道池，优先按启用渠道顺序依次尝试；
 * - 若阶段设为单独指定主渠道，先试主渠道再按全局启用渠道列表兜底，自动去重。
 */
export function resolveStageChannelPlan(
  settings: Settings,
  stage: AiStageName,
): ResolvedAiChannel[] {
  const stageCfg = settings.ai.stages[stage];
  const poolChannels: ResolvedAiChannel[] = (settings.ai.channels ?? [])
    .filter((ch) => ch.enabled !== false)
    .map((ch) => ({
      cli: ch.cli,
      model: ch.model,
      retries: ch.retries,
      timeoutSec: ch.timeoutSec ?? stageCfg.timeoutSec,
      source: 'channel_pool' as const,
    }));

  const rawPlan: ResolvedAiChannel[] = [];
  if (stageCfg.mode === 'pool') {
    if (poolChannels.length > 0) {
      rawPlan.push(...poolChannels);
    } else {
      rawPlan.push({
        cli: stageCfg.cli,
        model: stageCfg.model,
        retries: stageCfg.retries,
        timeoutSec: stageCfg.timeoutSec,
        source: 'stage_legacy',
      });
    }
  } else {
    rawPlan.push({
      cli: stageCfg.cli,
      model: stageCfg.model,
      retries: stageCfg.retries,
      timeoutSec: stageCfg.timeoutSec,
      source: stageCfg.mode === 'custom' ? 'stage_custom' : 'stage_legacy',
    });
    rawPlan.push(...poolChannels);
  }

  const seen = new Set<string>();
  const deduped: ResolvedAiChannel[] = [];
  for (const ch of rawPlan) {
    const key = `${ch.cli}:::${ch.model}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(ch);
  }
  return deduped;
}

/**
 * 按渠道顺序与各自重试次数调用对应阶段的模型（支持额外指定审计记录展示阶段名），前一渠道失败后自动切换到后续兜底渠道。
 */
export async function invokeStageLlm<T>(opts: {
  ctx: CoreContext;
  settings: Settings;
  stage: AiStageName;
  auditStage?: LlmStage;
  runId: string;
  itemId?: string;
  prompt: string;
  schema: z.ZodType<T>;
  signal?: AbortSignal;
}): Promise<InvokeResult<T>> {
  const { ai, clis } = opts.settings;
  const recordedStage = opts.auditStage ?? opts.stage;
  const eventStage = toRunEventStage(recordedStage);
  const plan = resolveStageChannelPlan(opts.settings, opts.stage);
  const failures: Array<{ channel: ResolvedAiChannel; message: string; cause: ModelCallError }> =
    [];

  for (let index = 0; index < plan.length; index += 1) {
    const channel = plan[index];
    if (!channel) continue;
    const request: InvokeRequest<T> = {
      cli: channel.cli,
      model: channel.model,
      prompt: opts.prompt,
      schema: opts.schema,
      timeoutMs: channel.timeoutSec * 1000,
      retries: channel.retries,
      signal: opts.signal,
      meta: { runId: opts.runId, stage: recordedStage, itemId: opts.itemId },
    };

    try {
      let result: InvokeResult<T>;
      if (ai.providers && Object.hasOwn(ai.providers, channel.cli)) {
        const provider = ai.providers[channel.cli];
        if (!provider) {
          throw new ModelCallError(`本期配置未定义调用方式 ${channel.cli}`, false);
        }
        result = await opts.ctx.modelApi.invoke(request, provider, ai.maxConcurrentCalls);
      } else {
        if (!Object.hasOwn(clis, channel.cli)) {
          throw new ModelCallError(`本期配置未定义调用方式 ${channel.cli}`, false);
        }
        result = await opts.ctx.bridge.invoke(request, clis[channel.cli], ai.maxConcurrentCalls);
      }

      if (failures.length > 0) {
        tryEmitChannelEvent(opts.ctx, {
          runId: opts.runId,
          level: 'info',
          stage: eventStage,
          itemId: opts.itemId ?? null,
          type: 'llm_fallback_succeeded',
          message: `环节 ${recordedStage} 已切换至兜底渠道 ${channel.cli}/${channel.model} 并调用成功`,
          data: {
            stage: recordedStage,
            cli: channel.cli,
            model: channel.model,
            failedAttempts: failures.length,
          },
        });
      }
      return result;
    } catch (err) {
      if (isAbortError(err, opts.signal)) {
        throw err;
      }
      if (err instanceof ModelCallError) {
        failures.push({ channel, message: err.message, cause: err });
        const nextChannel = plan[index + 1];
        if (nextChannel) {
          tryEmitChannelEvent(opts.ctx, {
            runId: opts.runId,
            level: 'warn',
            stage: eventStage,
            itemId: opts.itemId ?? null,
            type: 'llm_fallback',
            message: `环节 ${recordedStage} 渠道 ${channel.cli}/${channel.model} 失败（${err.message}），正在切换至下一渠道 ${nextChannel.cli}/${nextChannel.model}`,
            data: {
              stage: recordedStage,
              fromCli: channel.cli,
              fromModel: channel.model,
              toCli: nextChannel.cli,
              toModel: nextChannel.model,
              reason: err.message,
            },
          });
        }
        continue;
      }
      throw err;
    }
  }

  const lastFailure = failures[failures.length - 1];
  if (failures.length <= 1 && lastFailure) {
    throw new PipelineError(
      'llm_unavailable',
      `AI 处理环节 ${recordedStage}（调用方式 ${lastFailure.channel.cli}，模型 ${lastFailure.channel.model}）调用失败：${lastFailure.message}`,
      { cause: lastFailure.cause },
    );
  }
  const summary = failures
    .map((f) => `${f.channel.cli}/${f.channel.model}: ${f.message}`)
    .join('；');
  throw new PipelineError(
    'llm_unavailable',
    `AI 处理环节 ${recordedStage} 全部 ${failures.length} 个渠道均调用失败：${summary}`,
    { cause: lastFailure?.cause },
  );
}
