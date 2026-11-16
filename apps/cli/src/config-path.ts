import type { DeepPartial, Settings } from '@aidaily/contracts';

const FORBIDDEN_PATH_SEGMENTS = new Set(['__proto__', 'constructor', 'prototype']);

/** 命令行参数格式、必填项或取值校验失败时抛出的错误（对应退出码 2） */
export class CliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliUsageError';
  }
}

/** 将命令行传入的配置值文本解析为布尔值、安全精度数字、JSON 值或纯字符串 */
export function parseCliValue(raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed === 'true') {
    return true;
  }
  if (trimmed === 'false') {
    return false;
  }
  if (trimmed === 'null') {
    return null;
  }
  // 带前导零的数字串（如 03000）按字符串保留，并校验整数转换无精度丢失
  if (/^-?(0|[1-9]\d*)(\.\d+)?$/.test(trimmed)) {
    const num = Number(trimmed);
    if (trimmed.includes('.')) {
      if (Number.isFinite(num)) {
        return num;
      }
    } else if (Number.isSafeInteger(num) && String(num) === trimmed) {
      return num;
    }
  }
  if (trimmed.startsWith('{') || trimmed.startsWith('[') || trimmed.startsWith('"')) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed;
    }
  }
  return trimmed;
}

/** 按点号分隔的配置路径校验并返回合法字段片段数组，防止访问原型链保留字段 */
function splitSafeDotPath(dotPath: string): string[] {
  const trimmed = dotPath.trim();
  if (!trimmed) {
    throw new CliUsageError('配置路径不能为空');
  }
  const parts = trimmed.split('.');
  for (const part of parts) {
    if (!part || FORBIDDEN_PATH_SEGMENTS.has(part)) {
      throw new CliUsageError(`非法的配置路径片段: ${part || '<空>'}`);
    }
  }
  return parts;
}

/** 根据点号路径从全局配置对象中读取指定子项（不传路径时返回整份配置） */
export function getByDotPath(obj: unknown, dotPath?: string): unknown {
  if (!dotPath) {
    return obj;
  }
  const parts = splitSafeDotPath(dotPath);
  let cursor: unknown = obj;
  for (const key of parts) {
    if (Array.isArray(cursor)) {
      if (!/^(0|[1-9]\d*)$/.test(key)) {
        throw new CliUsageError(`非法的配置数组索引路径: ${dotPath}`);
      }
      const idx = Number.parseInt(key, 10);
      if (idx >= cursor.length) {
        throw new CliUsageError(`配置数组下标越界: ${dotPath}`);
      }
      cursor = cursor[idx];
      continue;
    }
    if (typeof cursor !== 'object' || cursor === null || !Object.hasOwn(cursor, key)) {
      throw new CliUsageError(`未找到配置路径: ${dotPath}`);
    }
    cursor = (cursor as Record<string, unknown>)[key];
  }
  return cursor;
}

/** 根据点号路径和目标值构造用于局部更新配置的嵌套对象 */
export function buildPatchFromDotPath(dotPath: string, value: unknown): DeepPartial<Settings> {
  const parts = splitSafeDotPath(dotPath);
  const root: Record<string, unknown> = {};
  let cursor = root;
  for (let i = 0; i < parts.length - 1; i++) {
    const segment = parts[i];
    if (!segment) {
      continue;
    }
    const nextObj: Record<string, unknown> = {};
    cursor[segment] = nextObj;
    cursor = nextObj;
  }
  const leaf = parts[parts.length - 1];
  if (!leaf) {
    throw new CliUsageError(`无效的配置路径: ${dotPath}`);
  }
  cursor[leaf] = value;
  return root as DeepPartial<Settings>;
}
