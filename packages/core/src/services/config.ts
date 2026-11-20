import type { DeepPartial, Settings, SourceDef } from '@aidaily/contracts';
import {
  getModelRouteNames,
  removeModelApiConnection,
  saveModelApiConnection,
} from '../config/model-connections.js';
import { editSourcesFile, updateSettingsFile, updateSourcesFile } from '../config/writer.js';
import type { CoreContext } from '../context.js';
import { notifyDaemonReload } from '../daemon/runtime-state.js';

/** 系统配置与信源清单读写服务接口（支持随时切换模型与更新订阅源） */
export interface ConfigService {
  /** 获取当前生效的全局系统配置 */
  getSettings(): Settings;
  /** 局部更新全局配置并校验、原子写回配置文件后即时刷新内存快照 */
  updateSettings(patch: DeepPartial<Settings>): Promise<Settings>;
  /** 保存各模型阶段配置与全局渠道池，确保选择的调用方式仍然存在 */
  updateStageRouting(
    ai: Pick<Settings['ai'], 'stages' | 'maxConcurrentCalls'> & {
      channels?: Settings['ai']['channels'];
    },
  ): Promise<void>;
  /** 新增或编辑网页提交的模型 API 连接及密钥 */
  saveModelApiConnection(input: unknown): Promise<void>;
  /** 从当前配置移除未被阶段选用的模型 API 连接 */
  removeModelApiConnection(name: string): Promise<void>;
  /** 获取当前生效的订阅信源配置清单 */
  getSources(): SourceDef[];
  /** 校验并全量更新订阅信源列表，保留原有注释后即时刷新内存配置 */
  updateSources(next: SourceDef[]): Promise<void>;
  /** 在写锁内基于最新磁盘配置切换单个信源的启停状态，防止并发修改互相覆盖 */
  toggleSource(sourceId: string, enabled: boolean): Promise<SourceDef[]>;
}

/** 创建系统配置服务实例 */
export function createConfigService(ctx: CoreContext): ConfigService {
  let reloadQueue = Promise.resolve();

  const serializeConfigUpdate = async <T>(fn: () => Promise<T>): Promise<T> => {
    const run = reloadQueue.catch(() => undefined).then(fn);
    reloadQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  return {
    /** 读取当前运行时全局配置对象 */
    getSettings(): Settings {
      return ctx.settings;
    },

    /** 局部修订配置文件并在通过格式与规则校验后同步重载上下文 */
    async updateSettings(patch: DeepPartial<Settings>): Promise<Settings> {
      return serializeConfigUpdate(async () => {
        await updateSettingsFile(ctx.paths.settingsFile, patch);
        await ctx.reloadConfig();
        await notifyDaemonReload(ctx.paths);
        return ctx.settings;
      });
    },

    /** 在保存阶段与渠道池设置时校验全部调用方式是否有效，并同步跟随渠道池阶段的主渠道标识 */
    async updateStageRouting(ai) {
      await serializeConfigUpdate(async () => {
        const hasChannelsPatch = ai.channels !== undefined;
        const effectiveChannels = ai.channels ?? ctx.settings.ai.channels;
        const primaryEnabled = effectiveChannels.find((ch) => ch.enabled !== false);
        const normalizedStages = { ...ai.stages };
        if (primaryEnabled) {
          for (const key of Object.keys(normalizedStages) as Array<keyof typeof normalizedStages>) {
            const cfg = normalizedStages[key];
            if (cfg.mode === 'pool') {
              normalizedStages[key] = {
                ...cfg,
                cli: primaryEnabled.cli,
                model: primaryEnabled.model,
                retries: primaryEnabled.retries,
              };
            }
          }
        }
        const normalizedAi = {
          ...ai,
          stages: normalizedStages,
        };
        await updateSettingsFile(ctx.paths.settingsFile, { ai: normalizedAi }, (settings) => {
          const routes = getModelRouteNames(settings);
          if (hasChannelsPatch) {
            for (const channel of settings.ai.channels) {
              if (!routes.includes(channel.cli)) {
                throw new Error(`AI 渠道池中存在未在配置中定义的调用方式：${channel.cli}`);
              }
            }
          }
          const hasPoolStage = Object.values(settings.ai.stages).some((s) => s.mode === 'pool');
          if (hasPoolStage && !settings.ai.channels.some((ch) => ch.enabled !== false)) {
            throw new Error('存在使用全局渠道池的处理环节，请至少保留一个已启用的 AI 渠道');
          }
          for (const stage of Object.values(settings.ai.stages)) {
            if (!routes.includes(stage.cli)) {
              throw new Error(`未在配置中定义调用方式：${stage.cli}`);
            }
          }
        });
        await ctx.reloadConfig();
        await notifyDaemonReload(ctx.paths);
      });
    },

    /** 保存自定义 API 连接后立即更新运行时设置 */
    async saveModelApiConnection(input) {
      await serializeConfigUpdate(async () => {
        await saveModelApiConnection(ctx.paths, input);
        await ctx.reloadConfig();
        await notifyDaemonReload(ctx.paths);
      });
    },

    /** 删除 API 连接后立即更新运行时设置 */
    async removeModelApiConnection(name) {
      await serializeConfigUpdate(async () => {
        await removeModelApiConnection(ctx.paths, name);
        await ctx.reloadConfig();
        await notifyDaemonReload(ctx.paths);
      });
    },

    /** 读取当前配置的新闻信源清单 */
    getSources(): SourceDef[] {
      return ctx.sources;
    },

    /** 保存新的新闻信源清单并在原子落盘后重载上下文 */
    async updateSources(next: SourceDef[]): Promise<void> {
      await serializeConfigUpdate(async () => {
        await updateSourcesFile(ctx.paths.sourcesFile, next);
        await ctx.reloadConfig();
        await notifyDaemonReload(ctx.paths);
      });
    },

    /** 在配置写锁内读取磁盘最新信源列表并切换指定信源启用状态 */
    async toggleSource(sourceId: string, enabled: boolean): Promise<SourceDef[]> {
      return serializeConfigUpdate(async () => {
        const updated = await editSourcesFile(ctx.paths.sourcesFile, (current) => {
          const found = current.some((s) => s.id === sourceId);
          if (!found) {
            throw new Error(`未找到信源: ${sourceId}`);
          }
          return current.map((s) => (s.id === sourceId ? { ...s, enabled } : s));
        });
        await ctx.reloadConfig();
        await notifyDaemonReload(ctx.paths);
        return updated;
      });
    },
  };
}
