import type { z } from 'zod';
import { CliOutputError } from './errors.js';

/** 从可能夹杂解释文字或 Markdown 代码块的模型输出中提取并解析 JSON */
export function extractJsonFromText(raw: string): unknown {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new CliOutputError('模型输出为空，无法解析 JSON', '空输出', raw);
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    // 尝试提取 Markdown 代码块
  }

  const fenceMatch = /```(?:json)?\s*([\s\S]*?)\s*```/i.exec(trimmed);
  if (fenceMatch?.[1]) {
    try {
      return JSON.parse(fenceMatch[1].trim());
    } catch {
      // 若代码块内部非合法 JSON，则继续尝试大括号匹配
    }
  }

  const firstObj = trimmed.indexOf('{');
  const firstArr = trimmed.indexOf('[');
  const start =
    firstObj === -1 ? firstArr : firstArr === -1 ? firstObj : Math.min(firstObj, firstArr);

  if (start !== -1) {
    const openChar = trimmed[start];
    const closeChar = openChar === '{' ? '}' : ']';
    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let i = start; i < trimmed.length; i++) {
      const ch = trimmed[i];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === '\\') {
        escaped = true;
        continue;
      }
      if (ch === '"') {
        inString = !inString;
        continue;
      }
      if (inString) {
        continue;
      }
      if (ch === openChar) {
        depth += 1;
      } else if (ch === closeChar) {
        depth -= 1;
        if (depth === 0) {
          const slice = trimmed.slice(start, i + 1);
          try {
            return JSON.parse(slice);
          } catch {
            break;
          }
        }
      }
    }
  }

  throw new CliOutputError('无法从输出中解析有效 JSON', '输出不是合法 JSON 格式', raw);
}

/** 用 Zod 规则校验解析结果，不通过时整理字段错误摘要并抛出输出异常 */
export function validateWithSchema<T>(
  payload: unknown,
  schema: z.ZodType<T>,
  rawOutput: string,
): T {
  let candidate = payload;
  if (typeof candidate === 'string') {
    candidate = extractJsonFromText(candidate);
  }
  const parsed = schema.safeParse(candidate);
  if (!parsed.success) {
    const issuesSummary = parsed.error.issues
      .slice(0, 6)
      .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
      .join('; ');
    throw new CliOutputError(
      `结构化输出校验失败: ${issuesSummary}`,
      issuesSummary,
      rawOutput,
      parsed.error,
    );
  }
  return parsed.data;
}
