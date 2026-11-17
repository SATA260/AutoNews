import type { DeepPartial, Settings, SourceDef } from '@aidaily/contracts';
import {
  getModelRouteNames,
  removeModelApiConnection,
  saveModelApiConnection,
} from '../config/model-connections.js';
import { updateSettingsFile, updateSourcesFile } from '../config/writer.js';
import type { CoreContext } from '../context.js';

/** 系统配置与信源清单读写服务接口（支持随时切换模型与更新订阅源） */
export interface ConfigService {
  /** 获取当前生效的全局系统配置 */
  getSettings(): Settings;
  /** 局部更新全局配置并校验、原子写回配置文件后即时刷新内存快照 */
  updateSettings(patch: DeepPartial<Settings>): Promise<Settings>;
  /** 保存各模型阶段配置，确保选择的调用方式仍然存在 */
  updateStageRouting(ai: Pick<Settings['ai'], 'stages' | 'maxConcurrentCalls'>): Promise<void>;
  /** 新增或编辑网页提交的模型 API 连接及密钥 */
  saveModelApiConnection(input: unknown): Promise<void>;
  /** 从当前配置移除未被阶段选用的模型 API 连接 */
  removeModelApiConnection(name: string): Promise<void>;
  /** 获取当前生效的订阅信源配置清单 */
  getSources(): SourceDef[];
  /** 校验并全量更新订阅信源列表，保留原有注释后即时刷新内存配置 */
  updateSources(next: SourceDef[]): Promise<void>;
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
        return ctx.settings;
      });
    },

    /** 在保存阶段设置时检查最新的调用方式，避免与删除连接的请求冲突 */
    async updateStageRouting(ai) {
      await serializeConfigUpdate(async () => {
        await updateSettingsFile(ctx.paths.settingsFile, { ai }, (settings) => {
          const routes = getModelRouteNames(settings);
          for (const stage of Object.values(settings.ai.stages)) {
            if (!routes.includes(stage.cli)) {
              throw new Error(`未在配置中定义调用方式：${stage.cli}`);
            }
          }
        });
        await ctx.reloadConfig();
      });
    },

    /** 保存自定义 API 连接后立即更新运行时设置 */
    async saveModelApiConnection(input) {
      await serializeConfigUpdate(async () => {
        await saveModelApiConnection(ctx.paths, input);
        await ctx.reloadConfig();
      });
    },

    /** 删除 API 连接后立即更新运行时设置 */
    async removeModelApiConnection(name) {
      await serializeConfigUpdate(async () => {
        await removeModelApiConnection(ctx.paths, name);
        await ctx.reloadConfig();
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
      });
    },
  };
}
