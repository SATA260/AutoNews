import { z } from 'zod';
import { isAllowedUrlTarget } from './ssrf.js';
import { ContentLimitsSchema } from './template.js';

/** 支持在配置文件中单独指定调用方式与模型的五个 AI 处理环节 */
export const AiStageNameSchema = z.enum(['select', 'summarize', 'polish', 'factcheck', 'package']);
/** AI 处理环节名称类型 */
export type AiStageName = z.infer<typeof AiStageNameSchema>;

/** 视频合成使用的模板外观主题枚举（浅色或深色） */
export const RenderThemeSchema = z.enum(['light', 'dark']);
/** 视频模板外观主题类型 */
export type RenderTheme = z.infer<typeof RenderThemeSchema>;

/** 看板娘 Live2D 模型套组枚举（全身动作版或仅表情版） */
export const Live2dPackSchema = z.enum(['fullbody', 'expression']);
/** 看板娘 Live2D 模型套组类型 */
export type Live2dPack = z.infer<typeof Live2dPackSchema>;

/** 单个 AI 调用渠道配置与重试策略 */
export const AiChannelSchema = z.object({
  cli: z.string().min(1),
  model: z.string().min(1),
  retries: z.number().int().min(0).max(10).default(2),
  timeoutSec: z.number().int().positive().optional(),
  enabled: z.boolean().default(true),
});
/** 单个 AI 调用渠道配置类型 */
export type AiChannel = z.infer<typeof AiChannelSchema>;

/** 单个 AI 处理环节的渠道选择模式 */
export const AiStageModeSchema = z.enum(['pool', 'custom']);
/** 单个 AI 处理环节的渠道选择模式类型 */
export type AiStageMode = z.infer<typeof AiStageModeSchema>;

/** 单个 AI 处理环节使用的调用名称、模型名与超时重试配置 */
export const StageAiConfigSchema = z.object({
  mode: AiStageModeSchema.optional(),
  cli: z.string().min(1),
  model: z.string().min(1),
  timeoutSec: z.number().int().positive(),
  retries: z.number().int().nonnegative(),
});
/** 环节模型配置类型 */
export type StageAiConfig = z.infer<typeof StageAiConfigSchema>;

/** 外部命令行工具的适配器种类、可执行文件路径与默认参数配置 */
export const CliConfigSchema = z.object({
  adapter: z.enum(['agy', 'codex', 'generic']),
  bin: z.string().min(1),
  extraArgs: z.array(z.string()).default([]),
  argsTemplate: z.array(z.string()).optional(),
  parse: z.enum(['json', 'text']).or(z.string().startsWith('json-field:')).optional(),
});
/** 命令行工具配置类型 */
export type CliConfig = z.infer<typeof CliConfigSchema>;

/** 判断当前运行环境是否显式允许模型接口连接本机回环地址 */
export function isLocalModelApiAllowed(): boolean {
  return typeof process !== 'undefined' && process.env?.AIDAILY_ALLOW_LOCAL_MODEL_API === '1';
}

/** 校验模型 API 的地址前缀，拒绝内网、元数据与非法地址格式 */
export function isModelApiBaseUrl(value: string): boolean {
  if (!URL.canParse(value)) {
    return false;
  }
  const url = new URL(value);
  if (
    (url.protocol !== 'https:' && url.protocol !== 'http:') ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    return false;
  }
  return isAllowedUrlTarget(url, { allowLoopback: isLocalModelApiAllowed() });
}

const ModelApiBaseUrlSchema = z
  .string()
  .trim()
  .refine(
    isModelApiBaseUrl,
    '请填写公网可访问的 HTTP(S) API 地址前缀，禁止包含用户名、密码、查询参数或指向内网与元数据地址',
  );
const ModelApiProtocolSchema = z.enum(['chat-completions', 'responses']);
const ModelApiJsonModeSchema = z.enum(['json-object', 'prompt']);

/** 配置第三方模型服务使用的 HTTP 协议、地址和密钥引用 */
export const ModelApiProviderSchema = z
  .strictObject({
    adapter: z.literal('openai-compatible'),
    protocol: ModelApiProtocolSchema,
    baseUrl: ModelApiBaseUrlSchema,
    apiKeyEnv: z
      .string()
      .regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
      .optional(),
    apiKeyFile: z
      .string()
      .regex(/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/)
      .optional(),
    jsonMode: ModelApiJsonModeSchema.optional(),
  })
  .refine((config) => config.protocol === 'chat-completions' || config.jsonMode === undefined, {
    path: ['jsonMode'],
    error: 'jsonMode 仅用于 Chat Completions',
  });
/** 第三方模型 HTTP 服务的配置 */
export type ModelApiProvider = z.infer<typeof ModelApiProviderSchema>;

/** 校验从设置页提交的连接名称、请求协议以及可选的新密钥 */
export const ModelApiConnectionInputSchema = z
  .strictObject({
    name: z
      .string()
      .trim()
      .min(1, '请填写连接名称')
      .max(80, '连接名称最多 80 个字符')
      .refine(
        (name) => !['__proto__', 'constructor', 'prototype'].includes(name.toLowerCase()),
        '请使用其他连接名称',
      ),
    previousName: z.string().min(1).optional(),
    baseUrl: ModelApiBaseUrlSchema,
    protocol: ModelApiProtocolSchema,
    jsonMode: ModelApiJsonModeSchema.optional(),
    apiKey: z
      .string()
      .trim()
      .max(16 * 1024, 'API 密钥过长')
      .regex(/^[!-~]+$/, 'API 密钥应为一行有效字符')
      .optional(),
    clearApiKey: z.boolean().optional(),
  })
  .refine((input) => !(input.apiKey && input.clearApiKey), '请在更换和移除密钥中选择一项');

/** 语音合成调度配置（支持随时切换不同的合成引擎与后处理响度参数） */
export const TtsSettingsSchema = z.object({
  provider: z.string().min(1),
  /** 跨阵营嘉宾插嘴吐槽专用语音引擎（留空或未填时跟随主讲 provider） */
  guestProvider: z.string().trim().optional(),
  providers: z.record(z.string(), z.record(z.string(), z.unknown())).default({}),
  /** 配音全部完成后是否先停下来，等人试听满意再合成视频。默认不停，直接继续做视频 */
  pauseAfterNarrate: z.boolean().default(false),
  postprocess: z.object({
    sampleRate: z.number().int().positive(),
    loudnessLUFS: z.number().min(-70).max(-5),
    trimSilence: z.boolean(),
    denoise: z.boolean().default(true),
    sentenceGapMs: z.number().int().nonnegative(),
    sectionGapMs: z.number().int().nonnegative(),
  }),
});
/** 语音合成配置类型 */
export type TtsSettings = z.infer<typeof TtsSettingsSchema>;

/** 单个前端视频模板的目录路径与适配器名称配置 */
export const TemplateEntrySchema = z.object({
  dir: z.string(),
  adapter: z.string().min(1),
});
/** 视频模板配置项类型 */
export type TemplateEntry = z.infer<typeof TemplateEntrySchema>;

/** 新闻采集与视觉素材提取运行参数配置 */
export const CollectorSettingsSchema = z.object({
  xCookieFile: z.string().min(1).default('storage/secrets/x-cookies.json'),
  maxImagesPerArticle: z.number().int().min(1).max(8).default(4),
  captureWebTables: z.boolean().default(true),
  captureTweetScreenshots: z.boolean().default(true),
  /** 无高分原图/图表时，是否自动打开原文页面去弹窗截取核心段落高清图（默认 true） */
  captureArticleSections: z.boolean().optional(),
  /** 遇到 GitHub 仓库或 Release 页面时，是否自动截取干净的卡片/更新日志高清图（默认 true） */
  captureGithubCards: z.boolean().optional(),
  /** 采集自动截图设备缩放倍率（1 或 2，默认 2 倍高清截图） */
  screenshotScale: z.union([z.literal(1), z.literal(2)]).optional(),
});
/** 采集配置类型 */
export type CollectorSettings = z.infer<typeof CollectorSettingsSchema>;

/** 历史产物、运行日志与临时文件自动清理保留策略 */
export const RetentionSettingsSchema = z.object({
  keepRuns: z.number().int().min(1).max(1000).default(30),
  maxAgeDays: z.number().int().min(1).max(3650).default(30),
  maxLogAgeDays: z.number().int().min(1).max(3650).default(30),
  autoCleanup: z.boolean().default(false),
});
/** 数据保留与清理配置类型 */
export type RetentionSettings = z.infer<typeof RetentionSettingsSchema>;

/** 系统全局配置字段 */
const SettingsFieldsSchema = z.object({
  version: z.literal(1),
  timezone: z.string().min(1),
  collector: CollectorSettingsSchema.default({
    xCookieFile: 'storage/secrets/x-cookies.json',
    maxImagesPerArticle: 4,
    captureWebTables: true,
    captureTweetScreenshots: true,
  }),
  retention: RetentionSettingsSchema.default({
    keepRuns: 30,
    maxAgeDays: 30,
    maxLogAgeDays: 30,
    autoCleanup: false,
  }),
  issue: z.object({
    reserveFactor: z.number().int().min(1).max(5),
    minScore: z.number().min(1).max(10).optional(),
    /** 是否允许少于目标条数直接出片或 0 条时自动跳过本期，默认关闭 */
    allowPartial: z.boolean().default(false),
    freshnessHours: z.number().int().positive(),
    itemConcurrency: z.number().int().min(1).max(20),
    refill: z.object({
      maxRounds: z.number().int().min(0).max(10),
      useBackupSources: z.boolean(),
      lookbackStepHours: z.number().int().positive(),
      maxLookbackHours: z.number().int().positive(),
    }),
  }),
  retry: z.object({
    reservationHoldHours: z.number().int().positive(),
  }),
  editorial: z.object({
    maxRevisions: z.number().int().min(0).max(5),
    sourceMaxChars: z.number().int().positive(),
    historyDedupDays: z.number().int().nonnegative(),
    /** 兼容旧配置快照保留的可选字段，当前选题不再按标题字符相似度直接删除候选 */
    titleSimilarityThreshold: z.number().min(0).max(1).optional(),
    metaTextBlacklist: z.array(z.string()),
    /** 是否启用紧凑型口播提示词与精简文风约束，默认关闭 */
    compactStyle: z.boolean().default(false),
    /** 是否仅在高价值或显式指定配图时展示文章插图，默认关闭 */
    requireImageOptIn: z.boolean().default(false),
    /** 兼容旧配置快照保留的可选字段，当前投稿标题规范已直接内置于整期编排提示词 */
    titleSkillFile: z.string().optional(),
    /** 触发大事件主推（spotlight）模式的头条分值阈值（未填时默认 9.2） */
    spotlightScoreThreshold: z.number().min(1).max(10).optional(),
    /** 常规档头条口播总字数上限（未填时默认 180） */
    headlineNarrationMaxChars: z.number().int().positive().optional(),
    /** 次要短讯口播总字数上限（未填时默认 95） */
    briefNarrationMaxChars: z.number().int().positive().optional(),
  }),
  contentLimits: ContentLimitsSchema,
  ai: z.object({
    maxConcurrentCalls: z.number().int().min(1).max(20),
    providers: z.record(z.string().min(1), ModelApiProviderSchema).optional(),
    channels: z.array(AiChannelSchema).default([]),
    stages: z.object({
      select: StageAiConfigSchema,
      summarize: StageAiConfigSchema,
      polish: StageAiConfigSchema,
      factcheck: StageAiConfigSchema,
      package: StageAiConfigSchema,
    }),
  }),
  clis: z.record(z.string(), CliConfigSchema),
  tts: TtsSettingsSchema,
  template: z.object({
    active: z.string().min(1),
    registry: z.record(z.string(), TemplateEntrySchema),
    /** 视频封面模板所在目录（相对项目根目录）；不填时直接截取视频第一帧作为封面 */
    cover: z
      .object({
        dir: z.string().min(1),
      })
      .optional(),
  }),
  render: z.object({
    /** 视频模板外观主题（light 浅色 / dark 深色），未配置时默认使用深色模式 */
    theme: RenderThemeSchema.optional(),
    /** 看板娘 Live2D 模型套组（fullbody 全身动作版 / expression 仅表情版），未配置时默认使用全身动作版 */
    live2dPack: Live2dPackSchema.optional(),
    /** 浏览器渲染与截图设备像素倍率（1 为默认，1.5 或 2 启用 2K/4K 超清矢量文字与截图渲染） */
    deviceScaleFactor: z.union([z.literal(1), z.literal(1.5), z.literal(2)]).optional(),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    fps: z.number().int().positive(),
    pagePaddingSec: z.number().nonnegative(),
    bgm: z.object({
      file: z.string(),
      volumeDb: z.number(),
      duckDb: z.number(),
    }),
    /** 切换页面音效：file 为空字符串时不加音效；leadMs 表示比翻页起点提前多少毫秒发声；postDelayMs 表示播放完切换音效后等待多少毫秒再开始下一段口播 */
    pageTurnSfx: z
      .object({
        file: z.string(),
        volumeDb: z.number().min(-40).max(0),
        leadMs: z.number().int().min(0).max(500),
        /** 播放切换音效后等待多少毫秒再开始下一段口播，不填默认 1000 毫秒 */
        postDelayMs: z.number().int().min(0).max(5000).optional(),
      })
      .optional(),
  }),
  publish: z.object({
    mode: z.enum(['manual-review', 'auto']),
    bilibili: z.object({
      cli: z.string().min(1),
      cookieFile: z.string().min(1),
      tid: z.number().int().nonnegative(),
      copyright: z.union([z.literal(1), z.literal(2)]),
      titleMax: z.number().int().positive(),
      descMax: z.number().int().positive(),
      tagsMax: z.number().int().positive(),
      defaultTags: z.array(z.string()),
      aiDeclaration: z.literal(true),
      aiDisclaimerText: z.string().min(1),
      /** 单日（按系统时区自然日）允许上传 B 站的最大视频数，未填时默认 2（早晚双更防限流） */
      maxDailyUploads: z.number().int().positive().optional(),
      /** 上传视频单次命令执行的超时秒数，省略时默认 600 秒 */
      uploadTimeoutSec: z.number().int().min(30).max(7200).optional(),
    }),
  }),
  notify: z.object({
    provider: z.string().min(1),
    config: z.record(z.string(), z.unknown()).default({}),
  }),
  web: z.object({
    host: z.string().min(1),
    port: z.number().int().min(1).max(65535),
  }),
});

/** 校验全局配置及调用名称，保留已有任务的配置格式 */
export const SettingsSchema = SettingsFieldsSchema.superRefine((settings, context) => {
  for (const name of Object.keys(settings.ai.providers ?? {})) {
    if (Object.hasOwn(settings.clis, name)) {
      context.addIssue({
        code: 'custom',
        path: ['ai', 'providers', name],
        message: '调用名称已经用于本机命令',
      });
    }
  }
});
/** 全局运行时配置类型 */
export type Settings = z.infer<typeof SettingsSchema>;

/** 用于局部更新嵌套配置对象的递归可选类型 */
export type DeepPartial<T> = T extends readonly unknown[]
  ? T
  : T extends object
    ? { [P in keyof T]?: DeepPartial<T[P]> }
    : T;
