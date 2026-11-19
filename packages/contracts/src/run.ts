import { z } from 'zod';
import { AiStageNameSchema } from './config.js';
import { EventRecordSchema, RunItemRecordSchema } from './editorial.js';
import { HostMascotIdSchema } from './persona.js';
import { PublishRecordSchema } from './publish.js';

/** 视频生成任务按先后顺序执行的七个自动处理步骤 */
export const PIPELINE_STAGES = [
  'collect',
  'select',
  'edit',
  'package',
  'narrate',
  'render',
  'qa',
] as const;

/** 全流程各个步骤名称（包含自动处理步骤以及人工审核与发布） */
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
/** 流程步骤名称类型 */
export type Stage = z.infer<typeof StageSchema>;

/** 单个步骤的执行状态（stale 表示因从更早步骤重新运行而作废） */
export const StageStatusSchema = z.enum([
  'pending',
  'running',
  'done',
  'failed',
  'interrupted',
  'stale',
  'skipped',
]);
/** 步骤状态类型 */
export type StageStatus = z.infer<typeof StageStatusSchema>;

/** 单期视频任务的整体运行状态 */
export const RunStatusSchema = z.enum([
  'queued',
  'running',
  'skipped',
  'failed',
  'cancelled',
  'interrupted',
  'awaiting_audio_review',
  'awaiting_review',
  'rejected',
  'publishing',
  'publish_failed',
  'publish_uncertain',
  'published',
  'abandoned',
]);
/** 单期任务运行状态类型 */
export type RunStatus = z.infer<typeof RunStatusSchema>;

/** 允许继续执行或从指定步骤重跑的任务状态列表 */
export const RETRYABLE_RUN_STATUSES: readonly RunStatus[] = [
  'failed',
  'cancelled',
  'interrupted',
  'awaiting_audio_review',
  'awaiting_review',
  'rejected',
  'publish_failed',
  'published',
] as const;

/** 允许在页面上改配音、字幕、配图或背景音乐的任务状态 */
export const MEDIA_ADJUSTABLE_RUN_STATUSES: readonly RunStatus[] = [
  'awaiting_audio_review',
  'awaiting_review',
  'rejected',
  'publish_failed',
  'published',
] as const;

/** 任务是如何启动的：命令行手动启动、网页后台手动启动或定时任务自动启动 */
export const TriggerSchema = z.enum(['manual-cli', 'manual-web', 'schedule']);
/** 触发方式类型 */
export type Trigger = z.infer<typeof TriggerSchema>;

/** 统一错误码，用于精确定位任务中断原因 */
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
/** 错误码类型 */
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

/** 任务运行事件日志的严重程度级别 */
export const RunEventLevelSchema = z.enum(['debug', 'info', 'warn', 'error']);
/** 事件日志级别类型 */
export type RunEventLevel = z.infer<typeof RunEventLevelSchema>;

/** 实时写入数据库的任务进度事件，用于命令行跟踪日志和网页实时推送 */
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
/** 任务事件类型 */
export type RunEvent = z.infer<typeof RunEventSchema>;

/** 某期任务里单一处理步骤的详细状态与产出检查点 */
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
/** 步骤记录类型 */
export type RunStageRecord = z.infer<typeof RunStageRecordSchema>;

/** 用于任务列表页快速展示的单期任务摘要信息 */
export const RunSummarySchema = z.object({
  id: z.string().min(1),
  trigger: TriggerSchema,
  scheduleId: z.string().nullable(),
  status: RunStatusSchema,
  currentStage: StageSchema.nullable(),
  itemCount: z.number().int().positive(),
  notBeforeAt: z.string().nullable().optional(),
  hostId: HostMascotIdSchema.nullable().optional(),
  bgmFile: z.string().nullable().optional(),
  mediaDirty: z.boolean().optional(),
  attempt: z.number().int().positive(),
  errorCode: ErrorCodeSchema.nullable(),
  error: z.string().nullable(),
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  retryDeadlineAt: z.string().nullable(),
});
/** 任务摘要类型 */
export type RunSummary = z.infer<typeof RunSummarySchema>;

/** 模型调用记录所属阶段（支持主流程步骤名称、AI 配置环节及独立的打回微调子步骤） */
export const LlmStageSchema = z.union([StageSchema, AiStageNameSchema, z.literal('revise')]);
/** 模型调用所属阶段类型 */
export type LlmStage = z.infer<typeof LlmStageSchema>;

/** 外部大模型命令行工具单次调用的完成状态 */
export const LlmCallStatusSchema = z.enum([
  'ok',
  'timeout',
  'bad_output',
  'exit_error',
  'auth_error',
]);
/** 模型调用状态类型 */
export type LlmCallStatus = z.infer<typeof LlmCallStatusSchema>;

/** 每次调用大模型命令行工具的耗时、Token 消耗及完整日志路径记录 */
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
/** 模型调用记录类型 */
export type LlmCallRecord = z.infer<typeof LlmCallRecordSchema>;

/** 单期任务的完整详情（包含各步骤状态、聚类事件、逐条稿件、投稿状态和产出文件清单） */
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
/** 任务完整详情类型 */
export type RunDetail = z.infer<typeof RunDetailSchema>;

/** 查询某期中断任务时返回的可选恢复方式与截止时间 */
export const RetryOptionsSchema = z.object({
  resumable: z.boolean(),
  resumeFrom: StageSchema.optional(),
  allowedFromStages: z.array(StageSchema),
  retryDeadlineAt: z.string().optional(),
});
/** 重试选项类型 */
export type RetryOptions = z.infer<typeof RetryOptionsSchema>;

/** 定时任务每天执行的 24 小时制时间校验规则（格式 HH:mm） */
export const ScheduleTimeSchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):([0-5]\d)$/, '定时时间必须为 HH:mm 格式（00:00–23:59）');

/** 定时任务新闻最早时间限制策略：不额外收紧、仅限上次成功发布后、或严格限定最近若干小时 */
export const ScheduleCutoffModeSchema = z.enum(['none', 'since_last_published', 'hours']);
/** 定时任务新闻最早时间策略类型 */
export type ScheduleCutoffMode = z.infer<typeof ScheduleCutoffModeSchema>;

/** 用户手动创建的定时任务记录（新建时必须显式填写执行时间和新闻条数） */
export const ScheduleJobSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  time: ScheduleTimeSchema,
  itemCount: z.number().int().positive(),
  cutoffMode: ScheduleCutoffModeSchema.default('none'),
  maxAgeHours: z.number().int().positive().nullable().optional(),
  bgmFile: z.string().nullable().optional(),
  enabled: z.boolean(),
  installed: z.boolean(),
  lastRunId: z.string().nullable(),
  lastTriggeredAt: z.string().nullable(),
  nextRunAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
/** 定时任务类型 */
export type ScheduleJob = z.infer<typeof ScheduleJobSchema>;

/** 运行环境自检中单一检查项的诊断结果 */
export const DoctorCheckItemSchema = z.object({
  name: z.string().min(1),
  ok: z.boolean(),
  detail: z.string(),
  required: z.boolean(),
});
/** 单项环境自检结果类型 */
export type DoctorCheckItem = z.infer<typeof DoctorCheckItemSchema>;

/** 系统运行环境整体自检报告 */
export const DoctorReportSchema = z.object({
  ok: z.boolean(),
  checkedAt: z.string(),
  checks: z.array(DoctorCheckItemSchema),
});
/** 系统环境自检报告类型 */
export type DoctorReport = z.infer<typeof DoctorReportSchema>;
