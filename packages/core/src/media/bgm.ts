import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { type PersonaProfile, PersonasFileSchema } from '@aidaily/contracts';
import { parse } from 'yaml';
import type { CoreContext } from '../context.js';

const AUDIO_FILE_PATTERN = /\.(mp3|wav|flac|m4a)$/i;

/** 同步读取曲库目录中可供选择的音频文件名列表 */
function listBgmFilesSync(rootDir: string): string[] {
  try {
    return fsSync
      .readdirSync(path.join(rootDir, 'assets', 'bgm'), { withFileTypes: true })
      .filter((entry) => entry.isFile() && AUDIO_FILE_PATTERN.test(entry.name))
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

/** 同步读取人设配置用于确定形象专属背景音乐 */
function loadPersonasSync(rootDir: string): PersonaProfile[] {
  try {
    const text = fsSync.readFileSync(path.join(rootDir, 'config', 'personas.yaml'), 'utf8');
    return PersonasFileSchema.parse(parse(text)).personas;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

/** 异步读取人设配置用于确定形象专属背景音乐 */
async function loadPersonasForBgm(ctx: CoreContext): Promise<PersonaProfile[]> {
  try {
    const text = await fs.readFile(path.join(ctx.paths.rootDir, 'config', 'personas.yaml'), 'utf8');
    return PersonasFileSchema.parse(parse(text)).personas;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

/** 根据主播标识与人设配置推导其唯一对应的背景音乐文件名 */
function expectedBgmFilename(hostId: string, personas: readonly PersonaProfile[]): string {
  return personas.find((persona) => persona.id === hostId)?.bgmFile ?? `${hostId}-bgm.mp3`;
}

/** 判断曲库中是否包含按形象专属配置的背景音乐文件 */
function hasPersonaBoundLibrary(
  files: readonly string[],
  personas: readonly PersonaProfile[],
): boolean {
  const expectedNames = new Set(
    personas.map((persona) => persona.bgmFile ?? `${persona.id}-bgm.mp3`),
  );
  return files.some(
    (file) => expectedNames.has(file) || /-(?:bgm)\.(mp3|wav|flac|m4a)$/i.test(file),
  );
}

/** 列出曲库中可供选择的音频文件名。 */
export async function listBgmFiles(ctx: CoreContext): Promise<string[]> {
  try {
    return (
      await fs.readdir(path.join(ctx.paths.rootDir, 'assets', 'bgm'), { withFileTypes: true })
    )
      .filter((entry) => entry.isFile() && AUDIO_FILE_PATTERN.test(entry.name))
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

/** 同步解析指定主播对应的专属背景音乐文件名；曲库缺失该文件时返回空 */
export function resolvePersonaBgmFileSync(
  rootDir: string,
  hostId: string | null | undefined,
  customPersonas?: readonly PersonaProfile[],
): string | null {
  if (!hostId) return null;
  const personas = customPersonas ?? loadPersonasSync(rootDir);
  const candidate = expectedBgmFilename(hostId, personas);
  const files = listBgmFilesSync(rootDir);
  return files.includes(candidate) ? candidate : null;
}

/** 解析指定主播对应的专属背景音乐文件名；曲库缺失该文件时返回空 */
export async function resolvePersonaBgmFile(
  ctx: CoreContext,
  hostId: string | null | undefined,
  customPersonas?: readonly PersonaProfile[],
): Promise<string | null> {
  if (!hostId) return null;
  const personas = customPersonas ?? (await loadPersonasForBgm(ctx));
  const candidate = expectedBgmFilename(hostId, personas);
  const files = await listBgmFiles(ctx);
  return files.includes(candidate) ? candidate : null;
}

/** 校验指定的背景音乐是否严格匹配给定主播形象 */
export async function assertHostBgmMatch(
  ctx: CoreContext,
  hostId: string | null | undefined,
  bgmFile: string | null | undefined,
  customPersonas?: readonly PersonaProfile[],
): Promise<void> {
  if (!bgmFile) return;
  const files = await listBgmFiles(ctx);
  if (!files.includes(bgmFile)) {
    throw new Error('指定的背景音乐不在曲库中');
  }
  const personas = customPersonas ?? (await loadPersonasForBgm(ctx));
  if (!hostId) {
    if (hasPersonaBoundLibrary(files, personas)) {
      throw new Error('尚未确定主播形象，每个形象只能使用自己对应的背景音乐');
    }
    return;
  }
  const expected = await resolvePersonaBgmFile(ctx, hostId, personas);
  if (expected && bgmFile !== expected) {
    throw new Error(`背景音乐 ${bgmFile} 与主播 ${hostId} 不匹配，该形象只能使用 ${expected}`);
  }
}

/** 根据本期选定的主播形象锁定其唯一专属背景音乐；未确定形象或曲库无对应文件时保留空或既有值 */
export async function lockRunBgm(ctx: CoreContext, runId: string): Promise<string | null> {
  const current = ctx.db.prepare('SELECT host_id, bgm_file FROM runs WHERE id = ?').get(runId) as
    | { host_id: string | null; bgm_file: string | null }
    | undefined;
  if (!current) throw new Error(`未找到任务记录: ${runId}`);
  if (!current.host_id) return null;
  const expected = await resolvePersonaBgmFile(ctx, current.host_id);
  if (!expected) {
    return current.bgm_file;
  }
  if (current.bgm_file !== expected) {
    ctx.db.prepare('UPDATE runs SET bgm_file = ? WHERE id = ?').run(expected, runId);
  }
  return expected;
}
