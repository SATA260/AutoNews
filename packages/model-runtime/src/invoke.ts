import { setTimeout as delay } from 'node:timers/promises';
import type { LlmCallStatus, LlmStage } from '@aidaily/contracts';
import type { z } from 'zod';
import { ModelCallError } from './errors.js';
import { validateWithSchema } from './json.js';
import { Semaphore } from './semaphore.js';

/** 关联一次模型调用所属的任务、阶段和新闻条目 */
export interface InvokeMeta {
  runId?: string;
  stage?: LlmStage;
  itemId?: string;
}

/** 供本机和网络调用共用的模型请求 */
export interface InvokeRequest<T> {
  cli: string;
  prompt: string;
  schema?: z.ZodType<T>;
  model?: string;
  timeoutMs: number;
  retries: number;
  signal?: AbortSignal;
  meta?: InvokeMeta;
}

/** 模型调用消耗的输入与输出 Token 数量 */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

/** 适配器从一轮调用得到的内容和服务方统计信息 */
export interface ModelAttemptResult {
  payload: unknown;
  usage?: TokenUsage;
  conversationId?: string;
}

/** 一次模型调用完成后的统一结果 */
export interface InvokeResult<T> {
  data: T;
  rawStdout: string;
  durationMs: number;
  attempts: number;
  usage?: TokenUsage;
  conversationId?: string;
}

/** 适配器在解析或报错前记录本轮可写入审计的输出和参数 */
export interface AttemptTrace {
  args: string[];
  rawStdout: string;
  rawStderr: string;
  durationMs?: number;
}

/** 保存一次尝试及其结果的审计记录 */
export interface CallRecord extends Omit<AttemptTrace, 'durationMs'>, InvokeMeta {
  cli: string;
  model?: string;
  attempt: number;
  status: LlmCallStatus;
  durationMs: number;
  inputTokens?: number;
  outputTokens?: number;
  conversationId?: string;
  prompt: string;
  parsed?: unknown;
  error?: string;
  createdAt: string;
}

/** 调整并发、重试间隔及审计输出 */
export interface ModelRuntimeOptions {
  maxConcurrentCalls?: number;
  retryDelaysMs?: readonly number[];
  logCall?: (record: CallRecord) => Promise<void> | void;
  now?: () => Date;
}

/** 执行单次请求并在解析之前记录可审计的信息 */
export type ModelAttempt = (
  request: InvokeRequest<unknown>,
  trace: AttemptTrace,
) => Promise<ModelAttemptResult>;

const DEFAULT_RETRY_DELAYS_MS = [2_000, 8_000, 20_000];

/** 统一处理模型调用的排队、重试、输出校验和逐次审计 */
export class ModelRuntime {
  private readonly semaphores = new Map<string, Semaphore>();

  constructor(private readonly options: ModelRuntimeOptions = {}) {}

  /** 使用调用名称和本期并发限制取得队列 */
  private getSemaphore(name: string, limit: number): Semaphore {
    const key = JSON.stringify([name, limit]);
    let semaphore = this.semaphores.get(key);
    if (!semaphore) {
      semaphore = new Semaphore(limit);
      this.semaphores.set(key, semaphore);
    }
    return semaphore;
  }

  /** 发送调用审计，审计写入失败时保留原始调用结果 */
  private async log(record: CallRecord): Promise<void> {
    try {
      await this.options.logCall?.(record);
    } catch {
      // 审计写入异常不能覆盖模型调用结果。
    }
  }

  /** 调用指定适配器，校验输出，并在可恢复的错误发生后重试 */
  async invoke<T>(
    request: InvokeRequest<T>,
    execute: ModelAttempt,
    limit = this.options.maxConcurrentCalls ?? 3,
  ): Promise<InvokeResult<T>> {
    const semaphore = this.getSemaphore(request.cli, limit);
    const retryDelays = this.options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
    let prompt = request.prompt;
    let totalDurationMs = 0;
    const maxAttempts = 1 + Math.max(0, request.retries);

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      if (request.signal?.aborted) {
        throw new DOMException('已取消', 'AbortError');
      }
      const trace: AttemptTrace = { args: [], rawStdout: '', rawStderr: '' };
      const startedAt = Date.now();
      const record = {
        ...request.meta,
        cli: request.cli,
        model: request.model,
        attempt,
        prompt,
        createdAt: (this.options.now?.() ?? new Date()).toISOString(),
      };
      try {
        const result = await semaphore.run(async () => {
          if (request.signal?.aborted) {
            throw new DOMException('已取消', 'AbortError');
          }
          const output = await execute({ ...request, prompt }, trace);
          const data = request.schema
            ? validateWithSchema(output.payload, request.schema, trace.rawStdout)
            : (output.payload as T);
          return { data, usage: output.usage, conversationId: output.conversationId };
        }, request.signal);
        const durationMs = trace.durationMs ?? Date.now() - startedAt;
        await this.log({
          ...record,
          ...trace,
          durationMs,
          status: 'ok',
          inputTokens: result.usage?.inputTokens,
          outputTokens: result.usage?.outputTokens,
          conversationId: result.conversationId,
          parsed: result.data,
        });
        return {
          ...result,
          rawStdout: trace.rawStdout,
          durationMs: totalDurationMs + durationMs,
          attempts: attempt,
        };
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') {
          throw err;
        }
        const durationMs = trace.durationMs ?? Date.now() - startedAt;
        totalDurationMs += durationMs;
        const failure = err instanceof ModelCallError ? err : undefined;
        await this.log({
          ...record,
          ...trace,
          durationMs,
          status: failure?.status ?? 'exit_error',
          error: err instanceof Error ? err.message : String(err),
        });
        if (!failure?.retryable || attempt >= maxAttempts) {
          throw err;
        }
        if (failure.issuesSummary) {
          prompt = `${request.prompt}\n\n[上次输出格式校验失败，请严格按 JSON Schema 修正以下问题后重新输出]: ${failure.issuesSummary}`;
        }
        const retryDelay = retryDelays[Math.min(attempt - 1, retryDelays.length - 1)] ?? 2_000;
        if (retryDelay > 0) {
          await delay(retryDelay, undefined, { signal: request.signal });
        }
      }
    }
    throw new Error('模型调用未执行任何尝试');
  }
}
