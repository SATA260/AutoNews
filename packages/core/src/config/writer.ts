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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

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

/**
 * Update `config/settings.yaml` using yaml's AST Document API to preserve all comments,
 * validate against `SettingsSchema`, and write atomically.
 */
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
    // 若文件不存在则使用空模板新建
  }
  const doc = parseDocument(raw);
  doc.set('sources', parsed.data.sources);
  await writeFileAtomic(filePath, doc.toString());
}
