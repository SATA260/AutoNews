import { z } from 'zod';

/** 视频投稿状态（包含上传中途断开、需要人工去平台核对是否已发出的 uncertain 状态） */
export const PublishStatusSchema = z.enum([
  'draft',
  'publishing',
  'published',
  'failed',
  'uncertain',
  'consumed_only',
]);
/** 视频投稿状态类型 */
export type PublishStatus = z.infer<typeof PublishStatusSchema>;

/** 等待人工确认和微调的视频投稿草稿信息 */
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
/** 投稿草稿类型 */
export type PublishDraft = z.infer<typeof PublishDraftSchema>;

/** 写入数据库的 B 站投稿历史记录 */
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
/** 投稿记录类型 */
export type PublishRecord = z.infer<typeof PublishRecordSchema>;
