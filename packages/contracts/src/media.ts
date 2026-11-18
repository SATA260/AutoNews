import { z } from 'zod';

/** 口播语音段落分类：开场导语、单条新闻正文或结束语 */
export const NarrationSectionKindSchema = z.enum(['intro', 'item', 'outro']);
/** 口播段落分类类型 */
export type NarrationSectionKind = z.infer<typeof NarrationSectionKindSchema>;

/** 送给语音合成服务的单个播报段落文本 */
export const NarrationSectionSchema = z.object({
  key: z.string().min(1),
  kind: NarrationSectionKindSchema,
  itemId: z.string().optional(),
  /** 实际送进语音引擎的分句。画面字幕可以和这些句子不同 */
  sentences: z.array(z.string().min(1)).min(1),
  /** 只显示在画面上的字幕分句。不填时画面字幕与语音分句相同 */
  displaySentences: z.array(z.string().min(1)).optional(),
  /** 这一段单独使用的语音引擎。不填时用全局当前引擎 */
  provider: z.string().min(1).optional(),
});
/** 语音合成段落输入类型 */
export type NarrationSection = z.infer<typeof NarrationSectionSchema>;

/** 人工保存的某一段配音：语音分句、画面字幕分句，以及可选的单独引擎 */
export const SectionNarrationOverrideSchema = z.object({
  ttsSentences: z.array(z.string().min(1)).min(1),
  displaySentences: z.array(z.string().min(1)).min(1),
  provider: z.string().min(1).optional(),
});
/** 单段配音人工修改记录 */
export type SectionNarrationOverride = z.infer<typeof SectionNarrationOverrideSchema>;

/** 按段落标识保存的整期配音修改 */
export const NarrationOverrideMapSchema = z.record(
  z.string().min(1),
  SectionNarrationOverrideSchema,
);
/** 整期配音修改表 */
export type NarrationOverrideMap = z.infer<typeof NarrationOverrideMapSchema>;

/** 页面上编辑某一段配音时看到的当前文案、引擎和音频 */
export const NarrationSectionViewSchema = z.object({
  key: z.string().min(1),
  kind: NarrationSectionKindSchema,
  itemId: z.string().optional(),
  label: z.string().min(1),
  ttsText: z.string().min(1),
  subtitleText: z.string().min(1),
  provider: z.string().min(1),
  audioFile: z.string().nullable(),
  speechMs: z.number().nonnegative().nullable(),
  hasOverride: z.boolean(),
});
/** 单段配音的页面展示数据 */
export type NarrationSectionView = z.infer<typeof NarrationSectionViewSchema>;

/** 保存某一段配音修改时提交的文本、引擎，以及是否重新生成音频 */
export const UpdateSectionNarrationInputSchema = z.object({
  ttsText: z.string().trim().min(1, '请填写语音用的文本'),
  subtitleText: z.string().trim().min(1, '请填写字幕展示的文本'),
  provider: z.string().trim().min(1).optional(),
  regenerateAudio: z.boolean().default(false),
});
/** 保存单段配音修改的输入 */
export type UpdateSectionNarrationInput = z.infer<typeof UpdateSectionNarrationInputSchema>;

/** 段落内部每一句话的音频起始位置与时长（毫秒） */
export const SentenceTimingSchema = z.object({
  text: z.string(),
  offsetMs: z.number().nonnegative(),
  durationMs: z.number().nonnegative(),
});
/** 单句音频时长信息类型 */
export type SentenceTiming = z.infer<typeof SentenceTimingSchema>;

/** 合成后的整段音频文件路径及其包含的逐句时间信息 */
export const SectionAudioSchema = z.object({
  key: z.string().min(1),
  file: z.string().min(1),
  speechMs: z.number().nonnegative(),
  sentences: z.array(SentenceTimingSchema),
});
/** 段落音频输出类型 */
export type SectionAudio = z.infer<typeof SectionAudioSchema>;

/** 在整部视频时间轴中的单个字幕时间点 */
export const TimelineSentenceSchema = z.object({
  text: z.string(),
  startMs: z.number().nonnegative(),
  durationMs: z.number().nonnegative(),
});
/** 视频字幕时间点类型 */
export type TimelineSentence = z.infer<typeof TimelineSentenceSchema>;

/** 整部视频中某一页画面对应的音画时间段 */
export const TimelineSectionSchema = z.object({
  key: z.string().min(1),
  kind: NarrationSectionKindSchema,
  itemId: z.string().optional(),
  audioFile: z.string().min(1),
  startMs: z.number().nonnegative(),
  speechMs: z.number().nonnegative(),
  pageMs: z.number().positive(),
  sentences: z.array(TimelineSentenceSchema),
});
/** 视频页时间轴段落类型 */
export type TimelineSection = z.infer<typeof TimelineSectionSchema>;

/** 整期视频的时间轴总表，用于将音频与模板翻页严格对齐 */
export const TimelineSchema = z.object({
  totalMs: z.number().positive(),
  sections: z.array(TimelineSectionSchema).min(1),
});
/** 整期视频时间轴类型 */
export type Timeline = z.infer<typeof TimelineSchema>;

/** 成片自动检查中的单个校验项结果 */
export const QaCheckItemSchema = z.object({
  name: z.string().min(1),
  passed: z.boolean(),
  detail: z.string(),
});
/** 单项视频检查结果类型 */
export type QaCheckItem = z.infer<typeof QaCheckItemSchema>;

/** 视频合成完成后的质量检查报告（检查画面尺寸、音画时长是否一致、音量是否正常、是否黑屏） */
export const QaReportSchema = z.object({
  passed: z.boolean(),
  videoPath: z.string().min(1),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  fps: z.number().positive(),
  videoDurationSec: z.number().nonnegative(),
  audioDurationSec: z.number().nonnegative(),
  meanVolumeDb: z.number().nullable(),
  blackRatio: z.number().min(0).max(1),
  checks: z.array(QaCheckItemSchema),
  checkedAt: z.string(),
});
/** 成片质量检查报告类型 */
export type QaReport = z.infer<typeof QaReportSchema>;
