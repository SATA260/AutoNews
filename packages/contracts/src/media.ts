import { z } from 'zod';

export const NarrationSectionKindSchema = z.enum(['intro', 'item', 'outro']);
export type NarrationSectionKind = z.infer<typeof NarrationSectionKindSchema>;

export const NarrationSectionSchema = z.object({
  key: z.string().min(1),
  kind: NarrationSectionKindSchema,
  itemId: z.string().optional(),
  sentences: z.array(z.string().min(1)).min(1),
});
export type NarrationSection = z.infer<typeof NarrationSectionSchema>;

export const SentenceTimingSchema = z.object({
  text: z.string(),
  offsetMs: z.number().nonnegative(),
  durationMs: z.number().nonnegative(),
});
export type SentenceTiming = z.infer<typeof SentenceTimingSchema>;

export const SectionAudioSchema = z.object({
  key: z.string().min(1),
  file: z.string().min(1),
  speechMs: z.number().nonnegative(),
  sentences: z.array(SentenceTimingSchema),
});
export type SectionAudio = z.infer<typeof SectionAudioSchema>;

export const TimelineSentenceSchema = z.object({
  text: z.string(),
  startMs: z.number().nonnegative(),
  durationMs: z.number().nonnegative(),
});
export type TimelineSentence = z.infer<typeof TimelineSentenceSchema>;

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
export type TimelineSection = z.infer<typeof TimelineSectionSchema>;

export const TimelineSchema = z.object({
  totalMs: z.number().positive(),
  sections: z.array(TimelineSectionSchema).min(1),
});
export type Timeline = z.infer<typeof TimelineSchema>;

export const QaCheckItemSchema = z.object({
  name: z.string().min(1),
  passed: z.boolean(),
  detail: z.string(),
});
export type QaCheckItem = z.infer<typeof QaCheckItemSchema>;

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
export type QaReport = z.infer<typeof QaReportSchema>;
