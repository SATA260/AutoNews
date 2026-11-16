import { z } from 'zod';

const STRIPPED_SCHEMA_KEYS = new Set([
  '$schema',
  'minLength',
  'maxLength',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'minItems',
  'maxItems',
  'additionalProperties',
]);

/** 递归剔除外部大模型命令行工具可能不支持的长度、范围与附加字段限制，保留基础结构字段 */
function sanitizeJsonSchemaNode(node: unknown): unknown {
  if (Array.isArray(node)) {
    return node.map(sanitizeJsonSchemaNode);
  }
  if (typeof node !== 'object' || node === null) {
    return node;
  }
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(node)) {
    if (STRIPPED_SCHEMA_KEYS.has(key)) {
      continue;
    }
    if (key === 'properties' && typeof val === 'object' && val !== null && !Array.isArray(val)) {
      const nextProps: Record<string, unknown> = {};
      for (const [propName, propSchema] of Object.entries(val)) {
        nextProps[propName] = sanitizeJsonSchemaNode(propSchema);
      }
      out.properties = nextProps;
      continue;
    }
    out[key] = sanitizeJsonSchemaNode(val);
  }
  return out;
}

/**
 * 将 Zod Schema 转换为仅含基础结构关键字（type / properties / required / enum / items）的 Draft-07 JSON Schema，
 * 字数与范围约束统一交由本地 Zod 与规则检查兜底。
 */
export function zodToJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const raw = z.toJSONSchema(schema, { target: 'draft-07' }) as Record<string, unknown>;
  return sanitizeJsonSchemaNode(raw) as Record<string, unknown>;
}
