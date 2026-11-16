import fs from 'node:fs/promises';
import {
  type Settings,
  SettingsSchema,
  type SourceDef,
  SourcesFileSchema,
} from '@aidaily/contracts';
import { parse } from 'yaml';
import type { ZodError } from 'zod';

/** 将 Zod 校验错误整理成包含具体字段路径的中文错误提示 */
function formatZodError(filePath: string, err: ZodError): Error {
  const details = err.issues
    .map((issue) => `${issue.path.length > 0 ? issue.path.join('.') : '<root>'}: ${issue.message}`)
    .join('; ');
  return new Error(`配置校验失败 (${filePath}): ${details}`);
}

/** 读取并校验全局运行配置文件（`config/settings.yaml`） */
export async function loadSettings(filePath: string): Promise<Settings> {
  const raw = await fs.readFile(filePath, 'utf8');
  const parsedYaml = parse(raw);
  const result = SettingsSchema.safeParse(parsedYaml);
  if (!result.success) {
    throw formatZodError(filePath, result.error);
  }
  return result.data;
}

/** 读取并校验新闻信源清单配置文件（`config/sources.yaml`） */
export async function loadSources(filePath: string): Promise<SourceDef[]> {
  const raw = await fs.readFile(filePath, 'utf8');
  const parsedYaml = parse(raw);
  const result = SourcesFileSchema.safeParse(parsedYaml);
  if (!result.success) {
    throw formatZodError(filePath, result.error);
  }
  return result.data.sources;
}
