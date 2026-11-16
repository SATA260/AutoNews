import fs from 'node:fs/promises';
import {
  type DeepPartial,
  type Settings,
  SettingsSchema,
  type SourceDef,
  SourcesFileSchema,
} from '@aidaily/contracts';
import { type Document, parseDocument } from 'yaml';
import { writeFileAtomic } from '../storage/files.js';

/** 判断值是否为普通键值对象（非 null 且非数组） */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 递归将局部更新内容写入 YAML 语法树节点，从而完整保留原文件中的注释 */
function applyPatchToDocument(
  doc: Document,
  patch: Record<string, unknown>,
  prefix: string[],
): void {
  for (const [key, val] of Object.entries(patch)) {
    if (val === undefined) {
      continue;
    }
    const pathParts = [...prefix, key];
    const existing = doc.getIn(pathParts, true);
    if (
      isPlainObject(val) &&
      existing !== undefined &&
      existing !== null &&
      typeof existing === 'object' &&
      !Array.isArray(val)
    ) {
      applyPatchToDocument(doc, val, pathParts);
    } else {
      doc.setIn(pathParts, val);
    }
  }
}

/** 更新全局配置文件：先用语法树局部修改保留注释，校验全部字段通过后再原子写入磁盘 */
export async function updateSettingsFile(
  filePath: string,
  patch: DeepPartial<Settings>,
): Promise<Settings> {
  const raw = await fs.readFile(filePath, 'utf8');
  const doc = parseDocument(raw);
  applyPatchToDocument(doc, patch as Record<string, unknown>, []);

  const candidate = doc.toJS();
  const parsed = SettingsSchema.safeParse(candidate);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
      .join('; ');
    throw new Error(`更新配置校验失败 (${filePath}): ${details}`);
  }

  await writeFileAtomic(filePath, doc.toString());
  return parsed.data;
}

/** 校验并原子覆盖写入新闻信源清单配置文件 */
export async function updateSourcesFile(filePath: string, sources: SourceDef[]): Promise<void> {
  const parsed = SourcesFileSchema.safeParse({ sources });
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
      .join('; ');
    throw new Error(`更新信源配置校验失败 (${filePath}): ${details}`);
  }

  let raw = 'sources: []\n';
  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch {
    // 若目标文件尚不存在则使用空模板创建
  }
  const doc = parseDocument(raw);
  doc.set('sources', parsed.data.sources);
  await writeFileAtomic(filePath, doc.toString());
}
