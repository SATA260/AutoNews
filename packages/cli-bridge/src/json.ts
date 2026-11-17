import {
  extractJsonFromText as extractModelJson,
  ModelOutputError,
  validateWithSchema as validateModelOutput,
} from '@aidaily/model-runtime';
import type { z } from 'zod';
import { CliOutputError } from './errors.js';

/** 保留 CLI 调用者使用的结构化输出错误类型 */
function withCliOutputError<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    if (err instanceof ModelOutputError) {
      throw new CliOutputError(err.message, err.issuesSummary, err.rawOutput, err.cause);
    }
    throw err;
  }
}

/** 提取并解析子进程返回的 JSON */
export function extractJsonFromText(raw: string): unknown {
  return withCliOutputError(() => extractModelJson(raw));
}

/** 使用原有 CLI 错误类型报告输出校验失败 */
export function validateWithSchema<T>(
  payload: unknown,
  schema: z.ZodType<T>,
  rawOutput: string,
): T {
  return withCliOutputError(() => validateModelOutput(payload, schema, rawOutput));
}
