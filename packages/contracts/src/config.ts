import { z } from 'zod';
import { ContentLimitsSchema } from './template.js';

export const AiStageNameSchema = z.enum(['select', 'summarize', 'polish', 'factcheck', 'package']);
export type AiStageName = z.infer<typeof AiStageNameSchema>;

export const StageAiConfigSchema = z.object({
  cli: z.string().min(1),
  model: z.string().min(1),
  timeoutSec: z.number().int().positive(),
  retries: z.number().int().nonnegative(),
});
export type StageAiConfig = z.infer<typeof StageAiConfigSchema>;

export const CliConfigSchema = z.object({
  adapter: z.enum(['agy', 'generic']),
  bin: z.string().min(1),
  extraArgs: z.array(z.string()).default([]),
  argsTemplate: z.array(z.string()).optional(),
  parse: z.enum(['json', 'text']).or(z.string().startsWith('json-field:')).optional(),
});
export type CliConfig = z.infer<typeof CliConfigSchema>;

export const TtsSettingsSchema = z.object({
  provider: z.string().min(1),
  providers: z.record(z.string(), z.record(z.string(), z.unknown())).default({}),
  postprocess: z.object({
    sampleRate: z.number().int().positive(),
    loudnessLUFS: z.number().negative(),
    trimSilence: z.boolean(),
    sentenceGapMs: z.number().int().nonnegative(),
    sectionGapMs: z.number().int().nonnegative(),
  }),
});
export type TtsSettings = z.infer<typeof TtsSettingsSchema>;

export const TemplateEntrySchema = z.object({
  dir: z.string(),
  adapter: z.string().min(1),
});
export type TemplateEntry = z.infer<typeof TemplateEntrySchema>;

export const SettingsSchema = z.object({
  version: z.literal(1),
  timezone: z.string().min(1),
  issue: z.object({
    reserveFactor: z.number().int().min(1).max(5),
    freshnessHours: z.number().int().positive(),
    itemConcurrency: z.number().int().min(1).max(10),
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
    titleSimilarityThreshold: z.number().min(0).max(1),
    metaTextBlacklist: z.array(z.string()),
  }),
  contentLimits: ContentLimitsSchema,
  ai: z.object({
    maxConcurrentCalls: z.number().int().min(1).max(10),
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
  }),
  render: z.object({
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    fps: z.number().int().positive(),
    pagePaddingSec: z.number().nonnegative(),
    bgm: z.object({
      file: z.string(),
      volumeDb: z.number(),
      duckDb: z.number(),
    }),
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
export type Settings = z.infer<typeof SettingsSchema>;

export type DeepPartial<T> = {
  [P in keyof T]?: T[P] extends Array<infer U>
    ? Array<U>
    : T[P] extends object
      ? DeepPartial<T[P]>
      : T[P];
};
