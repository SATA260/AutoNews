import { zodToJsonSchema } from '@aidaily/contracts';
import { z } from 'zod';
import { extractJsonFromText } from './json.js';

/** Zod 可读取的对象形式 JSON Schema */
type JsonSchema = Exclude<Parameters<typeof z.fromJSONSchema>[0], boolean>;

/** 描述当前新闻输出所用的基本 JSON Schema 结构 */
interface SchemaNode extends JsonSchema {
  properties?: Record<string, SchemaNode>;
  items?: SchemaNode;
  anyOf?: SchemaNode[];
  oneOf?: SchemaNode[];
}

/** 判断字段是否已允许 null，以保留业务明确接受的空值 */
function allowsNull(node: SchemaNode): boolean {
  return (
    node.type === 'null' ||
    (Array.isArray(node.type) && node.type.includes('null')) ||
    node.enum?.includes(null) === true ||
    (node.anyOf ?? node.oneOf)?.some(allowsNull) === true
  );
}

/** 为严格输出补齐对象的必填属性，并用 null 表达可省略的字段 */
function makeStrict(node: SchemaNode): SchemaNode {
  const { oneOf, ...result } = node;
  if (node.properties) {
    const required = new Set(node.required);
    result.properties = Object.fromEntries(
      Object.entries(node.properties).map(([key, value]) => {
        const field = makeStrict(value);
        return [
          key,
          required.has(key) || allowsNull(value) ? field : { anyOf: [field, { type: 'null' }] },
        ];
      }),
    );
    result.required = Object.keys(node.properties);
    result.additionalProperties = false;
  }
  if (node.items) {
    result.items = makeStrict(node.items);
  }
  const options = node.anyOf ?? oneOf;
  if (options) {
    result.anyOf = options.map(makeStrict);
  }
  return result;
}

/** 找到与原始联合类型兼容的结果，并优先保留有效的原值 */
function restoreUnion(options: SchemaNode[], value: unknown): unknown {
  const candidates = options.map((option) => ({
    schema: z.fromJSONSchema(option),
    value: restoreOptionalFields(option, value),
  }));
  if (candidates.some(({ schema }) => schema.safeParse(value).success)) {
    return value;
  }
  return (
    candidates.find((candidate) => candidate.schema.safeParse(candidate.value).success)?.value ??
    value
  );
}

/** 把为严格输出额外引入的 null 字段还原为缺省状态 */
function restoreOptionalFields(node: SchemaNode, value: unknown): unknown {
  const { items, properties } = node;
  const options = node.anyOf ?? node.oneOf;
  if (options) {
    return restoreUnion(options, value);
  }
  if (items && Array.isArray(value)) {
    return value.map((item) => restoreOptionalFields(items, item));
  }
  if (!properties || typeof value !== 'object' || value === null || Array.isArray(value)) {
    return value;
  }
  const required = new Set(node.required);
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, fieldValue]) => {
      const field = Object.hasOwn(properties, key) ? properties[key] : undefined;
      if (!field) {
        return [[key, fieldValue]];
      }
      if (fieldValue === null && !required.has(key) && !allowsNull(field)) {
        return [];
      }
      return [[key, restoreOptionalFields(field, fieldValue)]];
    }),
  );
}

/** 生成 Codex 与 Responses 需要的严格输出契约，保留原有 Zod 校验规则 */
export function createStrictOutputSchema(schema: z.ZodType): {
  schema: SchemaNode;
  restore: (value: unknown) => unknown;
} {
  const original = zodToJsonSchema(schema) as SchemaNode;
  return {
    schema: makeStrict(original),
    /** 解析模型输出并还原可选字段 */
    restore(value) {
      return restoreOptionalFields(
        original,
        typeof value === 'string' ? extractJsonFromText(value) : value,
      );
    },
  };
}
