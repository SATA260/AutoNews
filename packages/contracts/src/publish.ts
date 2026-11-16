import { z } from 'zod';

export const PublishStatusSchema = z.enum([
  'draft',
  'publishing',
  'published',
  'failed',
  'uncertain',
  'consumed_only',
]);
export type PublishStatus = z.infer<typeof PublishStatusSchema>;

export const PublishDraftSchema = z.object({
  runId: z.string().min(1),
  title: z.string().min(1),
  description: z.string().min(1),
  tags: z.array(z.string().min(1)),
  videoPath: z.string().min(1),
  coverPath: z.string().min(1),
  aiDeclaration: z.literal(true),
  status: PublishStatusSchema,
});
export type PublishDraft = z.infer<typeof PublishDraftSchema>;

export const PublishRecordSchema = z.object({
  runId: z.string().min(1),
  platform: z.literal('bilibili'),
  title: z.string().nullable(),
  description: z.string().nullable(),
  tags: z.array(z.string()),
  status: PublishStatusSchema,
  bvid: z.string().nullable(),
  attempts: z.number().int().nonnegative(),
  error: z.string().nullable(),
  updatedAt: z.string(),
});
export type PublishRecord = z.infer<typeof PublishRecordSchema>;
