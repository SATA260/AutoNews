import type { DeepPartial, Settings, SourceDef } from '@aidaily/contracts';
import { updateSettingsFile, updateSourcesFile } from '../config/writer.js';
import type { CoreContext } from '../context.js';

/** 系统配置与信源清单读写服务接口（支持随时切换模型与更新订阅源） */
export interface ConfigService {
  /** 获取当前生效的全局系统配置 */
  getSettings(): Settings;
  /** 局部更新全局配置并校验、原子写回配置文件后即时刷新内存快照 */
  updateSettings(patch: DeepPartial<Settings>): Promise<Settings>;
  /** 获取当前生效的订阅信源配置清单 */
  getSources(): SourceDef[];
  /** 校验并全量更新订阅信源列表，保留原有注释后即时刷新内存配置 */
  updateSources(next: SourceDef[]): Promise<void>;
}

/** 创建系统配置服务实例 */
export function createConfigService(ctx: CoreContext): ConfigService {
  return {
    /** 读取当前运行时全局配置对象 */
    getSettings(): Settings {
      return ctx.settings;
    },

    /** 局部修订配置文件并在通过格式与规则校验后同步重载上下文 */
    async updateSettings(patch: DeepPartial<Settings>): Promise<Settings> {
      await updateSettingsFile(ctx.paths.settingsFile, patch);
      await ctx.reloadConfig();
      return ctx.settings;
    },

    /** 读取当前配置的新闻信源清单 */
    getSources(): SourceDef[] {
      return ctx.sources;
    },

    /** 保存新的新闻信源清单并在原子落盘后重载上下文 */
    async updateSources(next: SourceDef[]): Promise<void> {
      await updateSourcesFile(ctx.paths.sourcesFile, next);
      await ctx.reloadConfig();
    },
  };
}
