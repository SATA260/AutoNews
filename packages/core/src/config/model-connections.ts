import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  ModelApiConnectionInputSchema,
  type ModelApiProvider,
  type Settings,
  SettingsSchema,
} from '@aidaily/contracts';
import type { RepoPaths } from '../paths.js';
import { writeFileAtomic } from '../storage/files.js';
import { editSettingsFile } from './writer.js';

/** 列出可供模型阶段选择的本机命令和已保存的 API 连接 */
export function getModelRouteNames(settings: Settings): string[] {
  return [
    ...Object.keys(settings.clis).filter((name) => name !== settings.publish.bilibili.cli),
    ...Object.keys(settings.ai.providers ?? {}),
  ];
}

/** 对比名称时忽略首尾空格、大小写和等价的 Unicode 写法 */
function comparableName(name: string): string {
  return name.trim().normalize('NFC').toLowerCase();
}

/** 新增或修改 API 连接，密钥单独落盘，改名时一起更新正在使用该连接的阶段 */
export async function saveModelApiConnection(paths: RepoPaths, input: unknown): Promise<void> {
  const parsed = ModelApiConnectionInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new Error(parsed.error.issues[0]?.message ?? 'API 连接配置无效');
  }
  const { name, previousName, baseUrl, protocol, jsonMode, apiKey, clearApiKey } = parsed.data;
  let newKeyPath: string | undefined;
  try {
    await editSettingsFile(paths.settingsFile, async (doc) => {
      const settings = SettingsSchema.parse(doc.toJS());
      const providers = settings.ai.providers ?? {};
      const previous =
        previousName && Object.hasOwn(providers, previousName)
          ? providers[previousName]
          : undefined;
      if (previousName && !previous) {
        throw new Error('要编辑的 API 连接已不存在，请刷新设置页');
      }
      const names = [
        ...Object.keys(settings.clis),
        ...Object.keys(providers).filter((entry) => entry !== previousName),
      ];
      if (names.some((entry) => comparableName(entry) === comparableName(name))) {
        throw new Error(`调用名称「${name}」已存在，请换一个名称`);
      }

      const next: ModelApiProvider = {
        adapter: 'openai-compatible',
        baseUrl,
        protocol,
        ...(protocol === 'chat-completions' && jsonMode === 'prompt' ? { jsonMode } : {}),
      };
      if (apiKey) {
        next.apiKeyFile = `model-api-${randomUUID()}`;
        newKeyPath = path.join(paths.secretsDir, next.apiKeyFile);
        await writeFileAtomic(newKeyPath, apiKey, { mode: 0o600 });
      } else if (!clearApiKey && previous && (previous.apiKeyFile || previous.apiKeyEnv)) {
        if (new URL(previous.baseUrl).origin !== new URL(baseUrl).origin) {
          throw new Error('更换 API 地址的域名、端口或协议时，请填写新密钥或移除当前密钥');
        }
        if (previous.apiKeyFile) next.apiKeyFile = previous.apiKeyFile;
        if (previous.apiKeyEnv) next.apiKeyEnv = previous.apiKeyEnv;
      }

      if (previousName && previousName !== name) {
        doc.deleteIn(['ai', 'providers', previousName]);
        for (const [stage, config] of Object.entries(settings.ai.stages)) {
          if (config.cli === previousName) {
            doc.setIn(['ai', 'stages', stage, 'cli'], name);
          }
        }
      }
      doc.setIn(['ai', 'providers', name], next);
    });
  } catch (err) {
    if (newKeyPath) await fs.rm(newKeyPath, { force: true }).catch(() => undefined);
    throw err;
  }
}

/** 删除当前设置中未被阶段使用的连接，已保存的任务仍可读取原密钥引用 */
export async function removeModelApiConnection(paths: RepoPaths, name: string): Promise<void> {
  await editSettingsFile(paths.settingsFile, (doc) => {
    const { ai } = SettingsSchema.parse(doc.toJS());
    if (!ai.providers || !Object.hasOwn(ai.providers, name)) {
      throw new Error('要删除的 API 连接已不存在，请刷新设置页');
    }
    if (Object.values(ai.stages).some((stage) => stage.cli === name)) {
      throw new Error('有阶段正在使用此连接，请先保存其他调用方式');
    }
    doc.deleteIn(['ai', 'providers', name]);
  });
}
