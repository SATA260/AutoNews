import { z } from 'zod';
import { AiStageNameSchema } from './config.js';
import { EventRecordSchema, RunItemRecordSchema } from './editorial.js';
import { PublishRecordSchema } from './publish.js';

export const PIPELINE_STAGES = [
  'collect',
  'select',
  'edit',
  'package',
  'narrate',
  'render',
  'qa',
] as const;

export const StageSchema = z.enum([
  'collect',
  'select',
  'edit',
  'package',
  'narrate',
  'render',
  'qa',
  'review',
  'publish',
]);
export type Stage = z.infer<typeof StageSchema>;

export const StageStatusSchema = z.enum([
  'pending',
  'running',
  'done',
  'failed',
  'interrupted',
  'stale',
  'skipped',
]);
export type StageStatus = z.infer<typeof StageStatusSchema>;

export const RunStatusSchema = z.enum([
  'queued',
  'running',
  'failed',
  'cancelled',
  'interrupted',
  'awaiting_review',
  'rejected',
  'publishing',
  'publish_failed',
  'publish_uncertain',
  'published',
  'abandoned',
]);
export type RunStatus = z.infer<typeof RunStatusSchema>;

export const RETRYABLE_RUN_STATUSES: readonly RunStatus[] = [
  'failed',
  'cancelled',
  'interrupted',
  'rejected',
  'awaiting_review',
] as const;

export const TriggerSchema = z.enum(['manual-cli', 'manual-web', 'schedule']);
export type Trigger = z.infer<typeof TriggerSchema>;

export const ErrorCodeSchema = z.enum([
  'collect_all_failed',
  'insufficient_items',
  'llm_unavailable',
  'tts_failed',
  'render_failed',
  'qa_failed',
  'interrupted',
  'cancelled',
  'publish_failed',
  'publish_uncertain',
]);
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

export const RunEventLevelSchema = z.enum(['debug', 'info', 'warn', 'error']);
export type RunEventLevel = z.infer<typeof RunEventLevelSchema>;

export const RunEventSchema = z.object({
  id: z.number().int().positive(),
  runId: z.string().min(1),
  ts: z.string(),
  level: RunEventLevelSchema,
  stage: StageSchema.nullable(),
  itemId: z.string().nullable(),
  type: z.string().min(1),
  message: z.string(),
  data: z.unknown().nullable(),
});
export type RunEvent = z.infer<typeof RunEventSchema>;

export const RunStageRecordSchema = z.object({
  runId: z.string().min(1),
  stage: StageSchema,
  status: StageStatusSchema,
  attempt: z.number().int().nonnegative(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  error: z.string().nullable(),
  checkpointPath: z.string().nullable(),
});
export type RunStageRecord = z.infer<typeof RunStageRecordSchema>;

export const RunSummarySchema = z.object({
  id: z.string().min(1),
  trigger: TriggerSchema,
  scheduleId: z.string().nullable(),
  status: RunStatusSchema,
  currentStage: StageSchema.nullable(),
  itemCount: z.number().int().positive(),
  attempt: z.number().int().positive(),
  errorCode: ErrorCodeSchema.nullable(),
  error: z.string().nullable(),
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  retryDeadlineAt: z.string().nullable(),
});
export type RunSummary = z.infer<typeof RunSummarySchema>;

export const LlmCallStatusSchema = z.enum([
  'ok',
  'timeout',
  'bad_output',
  'exit_error',
  'auth_error',
]);
export type LlmCallStatus = z.infer<typeof LlmCallStatusSchema>;

export const LlmStageSchema = z.union([StageSchema, AiStageNameSchema]);
export type LlmStage = z.infer<typeof LlmStageSchema>;

export const LlmCallRecordSchema = z.object({
  id: z.number().int().positive(),
  runId: z.string().nullable(),
  stage: LlmStageSchema.nullable(),
  itemId: z.string().nullable(),
  cli: z.string().min(1),
  model: z.string().nullable(),
  attempt: z.number().int().positive(),
  status: LlmCallStatusSchema,
  durationMs: z.number().int().nonnegative().nullable(),
  inputTokens: z.number().int().nonnegative().nullable(),
  outputTokens: z.number().int().nonnegative().nullable(),
  conversationId: z.string().nullable(),
  logPath: z.string().nullable(),
  createdAt: z.string(),
});
export type LlmCallRecord = z.infer<typeof LlmCallRecordSchema>;

export const RunDetailSchema = RunSummarySchema.extend({
  cancelRequested: z.boolean(),
  pid: z.number().int().nullable(),
  heartbeatAt: z.string().nullable(),
  stages: z.array(RunStageRecordSchema),
  events: z.array(EventRecordSchema),
  items: z.array(RunItemRecordSchema),
  publishRecord: PublishRecordSchema.nullable(),
  artifacts: z.array(z.string()),
});
export type RunDetail = z.infer<typeof RunDetailSchema>;

export const RetryOptionsSchema = z.object({
  resumable: z.boolean(),
  resumeFrom: StageSchema.optional(),
  allowedFromStages: z.array(StageSchema),
  retryDeadlineAt: z.string().optional(),
});
export type RetryOptions = z.infer<typeof RetryOptionsSchema>;

export const ScheduleTimeSchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):([0-5]\d)$/, '定时时间必须为 HH:mm 格式（00:00–23:59）');

export const ScheduleJobSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  time: ScheduleTimeSchema,
  itemCount: z.number().int().positive(),
  enabled: z.boolean(),
  installed: z.boolean(),
  lastRunId: z.string().nullable(),
  lastTriggeredAt: z.string().nullable(),
  nextRunAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ScheduleJob = z.infer<typeof ScheduleJobSchema>;
