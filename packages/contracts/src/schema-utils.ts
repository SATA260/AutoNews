import { z } from 'zod';

/**
 * 将 Zod Schema 转换为不含顶层 `$schema` 的 Draft-07 JSON Schema，
 * 避免部分外部 CLI 工具（如 `agy --json-schema`）因 `$schema` 元字段报错。
 */
export function zodToJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const raw = z.toJSONSchema(schema, { target: 'draft-07' }) as Record<string, unknown>;
  const { $schema: _ignored, ...rest } = raw;
  return rest;
}
