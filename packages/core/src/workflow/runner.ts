import crypto from 'node:crypto';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  type ContentLimits,
  type ErrorCode,
  type HostMascotId,
  PIPELINE_STAGES,
  RETRYABLE_RUN_STATUSES,
  type RetryOptions,
  type Settings,
  SettingsSchema,
  type Stage,
  type Trigger,
} from '@aidaily/contracts';
import { TZDate } from '@date-fns/tz';
import { format } from 'date-fns';
import type { CoreContext } from '../context.js';
import {
  type EditSubStep,
  retryMultipleEditItems,
  updateEditWatermark,
} from '../editorial/item-pipeline.js';
import { PipelineError } from '../errors.js';
import { executeBilibiliUpload } from '../publish/bilibili.js';
import { ensurePublishDraftForRun } from '../publish/description.js';
import { cleanupStorage } from '../services/retention.js';
import { inTransaction } from '../storage/db.js';
import {
  archiveRunArtifacts,
  restoreArchivedArtifacts,
  writeJsonAtomic,
} from '../storage/files.js';
import { validateTemplateItemCount } from '../templates/registry.js';
import { createRunCancelMonitor } from './cancel.js';
import { emitRunEvent } from './events.js';
import { startRunHeartbeat } from './heartbeat.js';
import { acquirePipelineLock, LockBusyError, releasePipelineLock } from './lock.js';
import {
  DEFAULT_STAGE_EXECUTORS,
  type PipelineStage,
  STAGE_ARTIFACTS,
  STAGE_CHECKPOINT_REL_PATH,
  type StageExecutor,
} from './stages.js';

/** 判断某个步骤名称是否属于自动化生成阶段 */
function isPipelineStage(stage: Stage): stage is PipelineStage {
  return (PIPELINE_STAGES as readonly string[]).includes(stage);
}

/** 校验并收窄步骤名称为自动化阶段类型 */
function assertPipelineStage(stage: Stage): PipelineStage {
  if (!isPipelineStage(stage)) {
    throw new Error(`步骤 ${stage} 不属于可重跑的自动化生成阶段`);
  }
  return stage;
}

/** 根据当前时间与配置时区生成全小写的唯一任务 ID */
export function generateRunId(now: Date, timezone: string): string {
  const tzDate = new TZDate(now.getTime(), timezone);
  const stamp = format(tzDate, 'yyyyMMdd-HHmm');
  const suffix = crypto.randomBytes(2).toString('hex');
  return `${stamp}-${suffix}`;
}

/** 将捕获到的异常归类为标准任务错误码 */
export function toErrorCode(err: unknown, currentStage?: PipelineStage): ErrorCode {
  if (err instanceof PipelineError) {
    return err.code;
  }
  if (err instanceof Error && err.name === 'AbortError') {
    return 'cancelled';
  }
  switch (currentStage) {
    case 'collect':
      return 'collect_all_failed';
    case 'select':
    case 'edit':
      return 'editorial_failed';
    case 'package':
      return 'package_failed';
    case 'narrate':
      return 'tts_failed';
    case 'render':
      return 'render_failed';
    case 'qa':
      return 'qa_failed';
    default:
      return 'editorial_failed';
  }
}

/** 计算自当前时刻起的重试窗口截止时间（UTC ISO） */
function computeRetryDeadline(ctx: CoreContext, settings: Settings): string {
  return new Date(
    ctx.now().getTime() + settings.retry.reservationHoldHours * 3600_000,
  ).toISOString();
}

/** 检查指定步骤的本地检查点文件是否真实存在 */
async function checkpointExistsOnDisk(
  ctx: CoreContext,
  runId: string,
  relPath: string | null,
): Promise<boolean> {
  if (!relPath) {
    return false;
  }
  try {
    await fs.access(path.join(ctx.paths.runDir(runId), relPath));
    return true;
  } catch {
    return false;
  }
}

/** 从配置快照解析当年创建任务时锁定的配置对象 */
function parseRunSettingsSnapshot(rawJson: string): Settings {
  const parsed = SettingsSchema.safeParse(JSON.parse(rawJson));
  if (!parsed.success) {
    throw new Error(`任务配置快照校验失败: ${parsed.error.message}`);
  }
  return parsed.data;
}

/** 创建一条新的生产任务记录并初始化各步骤状态 */
export function createRun(
  ctx: CoreContext,
  opts: {
    itemCount: number;
    notBeforeAt?: string | null;
    hostId?: HostMascotId;
    bgmFile?: string;
    trigger?: Trigger;
    scheduleId?: string | null;
  },
): string {
  if (!Number.isInteger(opts.itemCount) || opts.itemCount <= 0) {
    throw new RangeError(
      `每期新闻条数 itemCount 必须为正整数，当前传入: ${String(opts.itemCount)}`,
    );
  }

  validateTemplateItemCount(ctx.settings, opts.itemCount);
  const now = ctx.now();
  const nowIso = now.toISOString();
  const runId = generateRunId(now, ctx.settings.timezone);
  const trigger = opts.trigger ?? 'manual-cli';
  const configSnapshotJson = JSON.stringify(ctx.settings);
  const notBeforeAt = opts.notBeforeAt ?? null;

  inTransaction(ctx.db, () => {
    ctx.repos.runs.create({
      id: runId,
      trigger,
      scheduleId: opts.scheduleId ?? null,
      itemCount: opts.itemCount,
      notBeforeAt,
      configSnapshotJson,
      createdAt: nowIso,
    });
    if (opts.hostId || opts.bgmFile)
      ctx.db
        .prepare('UPDATE runs SET host_id = ?, bgm_file = ?, host_manual = ? WHERE id = ?')
        .run(opts.hostId ?? null, opts.bgmFile ?? null, opts.hostId ? 1 : 0, runId);
    ctx.repos.runStages.initStages(runId);
    emitRunEvent(ctx, {
      runId,
      level: 'info',
      type: 'run_created',
      message: `已创建第 ${runId} 期任务（最多 ${opts.itemCount} 条新闻，触发方式：${trigger}${notBeforeAt ? `，最早新闻下限：${notBeforeAt}` : ''}）`,
      data: {
        itemCount: opts.itemCount,
        notBeforeAt,
        trigger,
        scheduleId: opts.scheduleId ?? null,
      },
    });
  });

  return runId;
}

/**
 * 查询某期任务当前允许的恢复与重跑选项，供命令行或网页界面展示交互入口。
 */
export function getRunRetryOptions(ctx: CoreContext, runId: string): RetryOptions {
  const run = ctx.repos.runs.getById(runId);
  if (!run) {
    throw new Error(`未找到任务记录: ${runId}`);
  }

  if (!RETRYABLE_RUN_STATUSES.includes(run.status)) {
    return {
      resumable: false,
      allowedFromStages: [],
      retryDeadlineAt: run.retryDeadlineAt ?? undefined,
    };
  }

  const runDir = ctx.paths.runDir(runId);
  const stageRecords = ctx.repos.runStages.listByRun(runId);
  const byStage = new Map(stageRecords.map((r) => [r.stage, r]));
  const firstIncompleteIdx = PIPELINE_STAGES.findIndex((s) => {
    const rec = byStage.get(s);
    if (rec?.status !== 'done' || !rec.checkpointPath) {
      return true;
    }
    return !fsSync.existsSync(path.join(runDir, rec.checkpointPath));
  });

  if (firstIncompleteIdx === -1) {
    return {
      resumable: true,
      allowedFromStages: [...PIPELINE_STAGES],
      retryDeadlineAt: run.retryDeadlineAt ?? undefined,
    };
  }

  return {
    resumable: true,
    resumeFrom: PIPELINE_STAGES[firstIncompleteIdx],
    allowedFromStages: PIPELINE_STAGES.slice(0, firstIncompleteIdx + 1),
    retryDeadlineAt: run.retryDeadlineAt ?? undefined,
  };
}

/**
 * 作废从指定阶段开始及其之后的全部检查点与产物目录，
 * 将旧文件归档保留至 `archive/` 目录下，并在数据库重置受影响的步骤与稿件进度。
 */
async function invalidateStagesAndArchive(
  ctx: CoreContext,
  runId: string,
  fromStage: PipelineStage,
  attempt: number,
): Promise<void> {
  const fromIdx = PIPELINE_STAGES.indexOf(fromStage);
  const stagesToInvalidate = PIPELINE_STAGES.slice(fromIdx);
  const runDir = ctx.paths.runDir(runId);
  const archiveName = `attempt-${attempt}-${fromStage}`;
  const relArtifacts = stagesToInvalidate.flatMap((s) => STAGE_ARTIFACTS[s]);

  const moved = await archiveRunArtifacts(runDir, archiveName, relArtifacts);

  try {
    if (stagesToInvalidate.includes('edit')) {
      const items = ctx.repos.runItems.listByRun(runId);
      await updateEditWatermark(runDir, (existingWatermark) => {
        const nextFloor: Record<string, number> = {
          ...(existingWatermark.versionFloorByItemId ?? {}),
        };
        for (const item of items) {
          const versions = ctx.repos.runItems.listVersions(item.id);
          const maxId = versions.reduce((acc, v) => Math.max(v.id, acc), 0);
          if (maxId > 0) {
            nextFloor[item.id] = maxId;
          }
        }
        return {
          versionFloorByItemId: nextFloor,
          pendingRetryByItemId: {},
        };
      });
    }

    const nowIso = ctx.now().toISOString();
    inTransaction(ctx.db, () => {
      ctx.repos.runStages.markStaleFrom(runId, stagesToInvalidate);

      if (fromStage === 'collect' || fromStage === 'select') {
        ctx.repos.articles.releaseByRun(runId);
        ctx.repos.events.deleteByRun(runId);
      } else if (stagesToInvalidate.includes('edit')) {
        for (const item of ctx.repos.runItems.listByRun(runId)) {
          ctx.repos.runItems.updateItem(item.id, {
            status: 'queued',
            position: null,
            revision: 0,
            dropReason: null,
            finalJson: null,
            updatedAt: nowIso,
          });
        }
      } else if (stagesToInvalidate.includes('package')) {
        for (const item of ctx.repos.runItems.listByRun(runId)) {
          if (item.position !== null) {
            ctx.repos.runItems.updateItem(item.id, {
              position: null,
              updatedAt: nowIso,
            });
          }
        }
      }
    });
  } catch (err) {
    // 若数据库重设失败，将已归档文件恢复回原目录以保证磁盘与数据库一致
    await restoreArchivedArtifacts(runDir, archiveName, moved);
    throw err;
  }
}

/** 收集这一期选题和成稿里关联过的文章编号 */
function collectAssociatedArticleIds(ctx: CoreContext, runId: string): string[] {
  const ids = new Set<string>();
  for (const event of ctx.repos.events.listByRun(runId)) {
    for (const articleId of event.articleIds) {
      ids.add(articleId);
    }
  }
  for (const item of ctx.repos.runItems.listByRun(runId)) {
    for (const evidence of item.finalJson?.evidence ?? []) {
      if (evidence.articleId) {
        ids.add(evidence.articleId);
      }
    }
  }
  return Array.from(ids);
}

/**
 * 已发布的任务要重新制作时，先记下原投稿编号，把投稿改回草稿，
 * 清掉这一期的已播记录，并按重跑起点退回文章占用。
 * 从抓取或选题重跑时文章回到待选；从后面的步骤重跑时重新标成本期占用。
 */
function revivePublishedRunIfNeeded(
  ctx: CoreContext,
  runId: string,
  startStage: PipelineStage,
): { revived: boolean; hadBvid: boolean } {
  const run = ctx.repos.runs.getById(runId);
  if (!run) {
    return { revived: false, hadBvid: false };
  }
  const publish = ctx.repos.publish.getByRun(runId);
  const publishStatus = publish?.status ?? null;
  const shouldRevive =
    run.status === 'published' ||
    publishStatus === 'published' ||
    publishStatus === 'consumed_only';
  if (!shouldRevive) {
    return { revived: false, hadBvid: false };
  }
  if (publishStatus === 'publishing' || publishStatus === 'uncertain') {
    throw new Error('投稿正在上传或结果尚未确认，请先处理投稿状态后再重新制作');
  }

  const bvid = publish?.bvid?.trim() ? publish.bvid.trim() : null;
  const articleIds = collectAssociatedArticleIds(ctx, runId);
  const mode = startStage === 'collect' || startStage === 'select' ? 'release_to_new' : 'rereserve';
  const nowIso = ctx.now().toISOString();
  inTransaction(ctx.db, () => {
    emitRunEvent(ctx, {
      runId,
      level: 'info',
      stage: startStage,
      type: 'run_revived',
      message: bvid
        ? `已重新打开本期任务。原投稿编号 ${bvid} 已记入日志，投稿改回可编辑草稿`
        : '已重新打开本期任务，投稿改回可编辑草稿',
      data: {
        previousStatus: run.status,
        previousPublishStatus: publishStatus,
        bvid,
        startStage,
      },
    });
    ctx.repos.publish.resetForRevive(runId, nowIso);
    ctx.repos.history.deleteByRun(runId);
    ctx.repos.articles.reviveArticlesForRun(articleIds, runId, mode);
  });
  return { revived: true, hadBvid: Boolean(bvid) };
}

/** 这次重跑是否从一份已经在 B 站发布过的稿件重新开始。有编号时不能再静默投稿 */
function revivedRunHasBvid(ctx: CoreContext, runId: string): boolean {
  const event = ctx.repos.runEvents.latestByType(runId, 'run_revived');
  if (!event?.data || typeof event.data !== 'object') {
    return false;
  }
  const bvid = (event.data as { bvid?: unknown }).bvid;
  return typeof bvid === 'string' && bvid.trim().length > 0;
}

/** 内部持锁后的主流程顺序执行器 */
async function executePipelineStagesLocked(opts: {
  ctx: CoreContext;
  runId: string;
  settings: Settings;
  startStage: PipelineStage;
  stopAfterStage?: PipelineStage;
  stageOverrides?: Partial<Record<PipelineStage, StageExecutor>>;
  limitsOverride?: Partial<ContentLimits>;
  onStarted?: () => void;
  onAwaitingReview?: (opts: {
    ctx: CoreContext;
    runId: string;
    settings: Settings;
  }) => Promise<void>;
}): Promise<void> {
  const { ctx, runId, settings, startStage, stopAfterStage, stageOverrides, limitsOverride } = opts;

  const startIdx = PIPELINE_STAGES.indexOf(startStage);
  const narrateIdx = PIPELINE_STAGES.indexOf('narrate');
  // 配音后停下试听：没指定停止步骤，或明确停在配音步骤时，都进入试听而不是中断
  const pauseAfterNarrate =
    settings.tts.pauseAfterNarrate === true &&
    startIdx <= narrateIdx &&
    (stopAfterStage === undefined || stopAfterStage === 'narrate');
  const stopIdx = stopAfterStage
    ? PIPELINE_STAGES.indexOf(stopAfterStage)
    : pauseAfterNarrate
      ? narrateIdx
      : PIPELINE_STAGES.length - 1;
  if (stopIdx < startIdx) {
    throw new Error(`非法的步骤范围：起始 ${startStage} 晚于终止 ${stopAfterStage}`);
  }

  const stagesToRun = PIPELINE_STAGES.slice(startIdx, stopIdx + 1);
  const lockAbort = new AbortController();
  let lostLock = false;
  const hb = startRunHeartbeat(ctx, runId, {
    onLockLost: () => {
      lostLock = true;
      lockAbort.abort();
    },
  });
  const cancelMonitor = createRunCancelMonitor(ctx, runId);
  const stageSignal = AbortSignal.any([cancelMonitor.signal, lockAbort.signal]);

  const runRow = ctx.repos.runs.getById(runId);
  const nowStartIso = ctx.now().toISOString();
  ctx.repos.runs.updateStatus(runId, 'running', {
    currentStage: startStage,
    pid: process.pid,
    startedAt: runRow?.startedAt ?? nowStartIso,
    finishedAt: null,
    errorCode: null,
    error: null,
    retryDeadlineAt: null,
    cancelRequested: 0,
    heartbeatAt: nowStartIso,
  });

  let activeStage: PipelineStage = startStage;
  let inPublishPhase = false;
  let onStarted = opts.onStarted;

  try {
    for (const stage of stagesToRun) {
      activeStage = stage;
      if (lostLock) {
        throw new PipelineError('interrupted', '运行锁已被其他进程接管，当前任务已安全停止');
      }
      if (cancelMonitor.checkNow()) {
        throw new DOMException('任务已取消', 'AbortError');
      }

      const stageRecs = ctx.repos.runStages.listByRun(runId);
      const existingRec = stageRecs.find((s) => s.stage === stage);
      if (
        existingRec?.status === 'done' &&
        (await checkpointExistsOnDisk(ctx, runId, existingRec.checkpointPath))
      ) {
        continue;
      }

      const stageStartIso = ctx.now().toISOString();
      ctx.repos.runs.updateStatus(runId, 'running', { currentStage: stage });
      ctx.repos.runStages.markStage(runId, stage, 'running', {
        incrementAttempt: true,
        startedAt: stageStartIso,
        finishedAt: null,
        error: null,
      });

      emitRunEvent(ctx, {
        runId,
        level: 'info',
        stage,
        type: 'stage_started',
        message: `开始执行阶段：${stage}`,
      });
      if (onStarted) {
        onStarted();
        onStarted = undefined;
      }

      let stageOut: unknown;
      try {
        const executor = stageOverrides?.[stage] ?? DEFAULT_STAGE_EXECUTORS[stage];
        stageOut = await executor({
          ctx,
          runId,
          settings,
          signal: stageSignal,
          limitsOverride,
        });
      } catch (stageErr) {
        const errIso = ctx.now().toISOString();
        const isAbort = stageErr instanceof Error && stageErr.name === 'AbortError';
        ctx.repos.runStages.markStage(runId, stage, isAbort ? 'interrupted' : 'failed', {
          finishedAt: errIso,
          error: stageErr instanceof Error ? stageErr.message : String(stageErr),
        });
        throw stageErr;
      }

      const relCheckpoint = STAGE_CHECKPOINT_REL_PATH[stage];
      const absCheckpoint = path.join(ctx.paths.runDir(runId), relCheckpoint);
      await writeJsonAtomic(absCheckpoint, stageOut);

      const stageDoneIso = ctx.now().toISOString();
      ctx.repos.runStages.markStage(runId, stage, 'done', {
        finishedAt: stageDoneIso,
        checkpointPath: relCheckpoint,
        error: null,
      });
      if (stage === 'render') {
        ctx.db.prepare('UPDATE runs SET media_dirty = 0 WHERE id = ?').run(runId);
      }

      emitRunEvent(ctx, {
        runId,
        level: 'info',
        stage,
        type: 'stage_done',
        message: `阶段执行完成：${stage}`,
      });
      if (
        settings.issue.allowPartial &&
        !stageOverrides?.[stage] &&
        stageOut &&
        typeof stageOut === 'object' &&
        ((stage === 'select' && 'selectedCount' in stageOut && stageOut.selectedCount === 0) ||
          (stage === 'edit' &&
            'passedItemIds' in stageOut &&
            Array.isArray(stageOut.passedItemIds) &&
            stageOut.passedItemIds.length === 0))
      ) {
        const finished = ctx.now().toISOString();
        inTransaction(ctx.db, () => {
          ctx.repos.articles.releaseByRun(runId);
          for (const later of PIPELINE_STAGES.slice(PIPELINE_STAGES.indexOf(stage) + 1)) {
            ctx.repos.runStages.markStage(runId, later, 'skipped', { finishedAt: finished });
          }
          ctx.repos.runs.updateStatus(runId, 'skipped', {
            currentStage: stage,
            pid: null,
            finishedAt: finished,
            retryDeadlineAt: null,
          });
          emitRunEvent(ctx, {
            runId,
            level: 'info',
            stage,
            type: 'run_skipped',
            message: '没有符合条件的新闻，本期已跳过',
          });
        });
        return;
      }
    }

    const finishedIso = ctx.now().toISOString();
    const lastStage = stagesToRun[stagesToRun.length - 1];
    if (lastStage === 'qa') {
      await ensurePublishDraftForRun(ctx, runId, settings, { regenerate: true });
      inTransaction(ctx.db, () => {
        ctx.db.prepare('UPDATE runs SET media_dirty = 0 WHERE id = ?').run(runId);
        ctx.repos.runs.updateStatus(runId, 'awaiting_review', {
          currentStage: 'review',
          pid: null,
          finishedAt: finishedIso,
          retryDeadlineAt: null,
        });
        emitRunEvent(ctx, {
          runId,
          level: 'info',
          stage: 'review',
          type: 'awaiting_review',
          message: '成片制作与质检已全部完成，等待人工审核发布',
        });
      });
      await ctx.notifier.notify({
        type: 'awaiting_review',
        runId,
        message: `第 ${runId} 期成片已完成，等待人工审核发布`,
      });
      if (settings.publish.mode === 'auto' && !revivedRunHasBvid(ctx, runId)) {
        inPublishPhase = true;
        if (opts.onAwaitingReview) {
          await opts.onAwaitingReview({ ctx, runId, settings });
        } else {
          hb.stop();
          cancelMonitor.stop();
          await executeBilibiliUpload({
            ctx,
            runId,
            settings,
            allowedRunStatuses: ['awaiting_review'],
            alreadyLocked: true,
            signal: stageSignal,
          });
        }
      }
    } else if (pauseAfterNarrate && lastStage === 'narrate') {
      ctx.repos.runs.updateStatus(runId, 'awaiting_audio_review', {
        currentStage: 'narrate',
        pid: null,
        finishedAt: finishedIso,
        retryDeadlineAt: null,
      });
      emitRunEvent(ctx, {
        runId,
        level: 'info',
        stage: 'narrate',
        type: 'awaiting_audio_review',
        message: '配音已完成，请试听。满意后再继续合成视频',
      });
      await ctx.notifier.notify({
        type: 'awaiting_audio_review',
        runId,
        message: `第 ${runId} 期配音已完成，等待试听确认`,
      });
    } else {
      ctx.repos.runs.updateStatus(runId, 'interrupted', {
        currentStage: lastStage ?? null,
        pid: null,
        finishedAt: finishedIso,
        retryDeadlineAt: computeRetryDeadline(ctx, settings),
      });
    }
  } catch (err) {
    if (lostLock) {
      // 运行锁已被接管时，接管方已更新任务状态，当前失联进程不再覆盖数据库记录
      throw new PipelineError('interrupted', '运行锁已被其他进程接管，当前任务已安全停止', {
        cause: err,
      });
    }
    if (inPublishPhase) {
      // 发布阶段内部已经完成 publish_failed 或 publish_uncertain 的落盘与通知，直接向上抛出
      throw err;
    }
    const errIso = ctx.now().toISOString();
    const code = toErrorCode(err, activeStage);
    const deadlineIso = computeRetryDeadline(ctx, settings);
    const errMsg = err instanceof Error ? err.message : String(err);

    if (code === 'cancelled') {
      inTransaction(ctx.db, () => {
        ctx.repos.runs.updateStatus(runId, 'cancelled', {
          errorCode: 'cancelled',
          error: '任务已被用户取消',
          cancelRequested: 0,
          pid: null,
          finishedAt: errIso,
          retryDeadlineAt: deadlineIso,
        });
        emitRunEvent(ctx, {
          runId,
          level: 'warn',
          stage: activeStage,
          type: 'run_cancelled',
          message: '任务已按要求取消，已完成工作与选材已保留以便随时继续',
        });
      });
    } else {
      inTransaction(ctx.db, () => {
        ctx.repos.runs.updateStatus(runId, 'failed', {
          errorCode: code,
          error: errMsg,
          pid: null,
          finishedAt: errIso,
          retryDeadlineAt: deadlineIso,
        });
        emitRunEvent(ctx, {
          runId,
          level: 'error',
          stage: activeStage,
          type: 'run_failed',
          message: `任务执行失败（${code}）：${errMsg}`,
          data: { errorCode: code },
        });
      });
      await ctx.notifier.notify({
        type: 'failed',
        runId,
        message: `第 ${runId} 期任务失败（${code}）：${errMsg}`,
        data: { errorCode: code, stage: activeStage },
      });
    }
    throw err;
  } finally {
    cancelMonitor.stop();
    hb.stop();
  }
}

/**
 * 执行指定任务：申请全局锁、按阶段依次运行流水线并实时保存检查点，支持从指定起始阶段进入。
 */
export async function executeRun(
  ctx: CoreContext,
  runId: string,
  opts?: {
    startStage?: Stage;
    stopAfterStage?: PipelineStage;
    stageOverrides?: Partial<Record<PipelineStage, StageExecutor>>;
    limitsOverride?: Partial<ContentLimits>;
    onAwaitingReview?: (opts: {
      ctx: CoreContext;
      runId: string;
      settings: Settings;
    }) => Promise<void>;
  },
): Promise<void> {
  const run = ctx.repos.runs.getById(runId);
  if (!run) {
    throw new Error(`未找到任务记录: ${runId}`);
  }
  if (run.status === 'running' || run.status === 'publishing') {
    const holder = ctx.repos.locks.get('pipeline');
    if (holder) {
      throw new LockBusyError(holder);
    }
    throw new Error(`任务 ${runId} 正在执行中（状态：${run.status}），无法重复启动`);
  }
  if (
    run.status === 'published' ||
    run.status === 'abandoned' ||
    run.status === 'cancelled' ||
    run.status === 'rejected'
  ) {
    throw new Error(`任务 ${runId} 状态为 ${run.status}，不允许直接重新开始，请使用恢复指令`);
  }

  const settings = parseRunSettingsSnapshot(run.configSnapshotJson);
  const startStage = assertPipelineStage(opts?.startStage ?? 'collect');

  acquirePipelineLock(ctx, runId, settings);
  try {
    await executePipelineStagesLocked({
      ctx,
      runId,
      settings,
      startStage,
      stopAfterStage: opts?.stopAfterStage,
      stageOverrides: opts?.stageOverrides,
      limitsOverride: opts?.limitsOverride,
      onAwaitingReview: opts?.onAwaitingReview,
    });
  } finally {
    releasePipelineLock(ctx, runId);
  }
  if (settings.retention.autoCleanup) {
    await cleanupStorage(ctx, { settings }).catch((err: unknown) => {
      ctx.logger.warn({ err, runId }, '任务结束后自动清理过期存储时出错');
    });
  }
}

/**
 * 恢复或从指定阶段重跑既有任务：
 * 不传 `fromStage` 时自动定位首个未完成阶段续跑已完成之外的余下工作；
 * 传入 `fromStage` 时将该阶段及之后的所有阶段作废归档并从头重新执行；
 * 支持通过 `useLatestConfig` 刷新当前最新全局配置快照。
 */
export async function resumeRun(
  ctx: CoreContext,
  runId: string,
  opts?: {
    fromStage?: Stage;
    useLatestConfig?: boolean;
    stopAfterStage?: PipelineStage;
    stageOverrides?: Partial<Record<PipelineStage, StageExecutor>>;
    limitsOverride?: Partial<ContentLimits>;
    onStarted?: () => void;
    onAwaitingReview?: (opts: {
      ctx: CoreContext;
      runId: string;
      settings: Settings;
    }) => Promise<void>;
  },
): Promise<void> {
  const run = ctx.repos.runs.getById(runId);
  if (!run) {
    throw new Error(`未找到任务记录: ${runId}`);
  }
  if (run.status === 'running' || run.status === 'publishing') {
    const holder = ctx.repos.locks.get('pipeline');
    if (holder) {
      throw new LockBusyError(holder);
    }
    throw new Error(`任务 ${runId} 正在执行中（状态：${run.status}），无法同时重跑`);
  }

  const retryOpts = getRunRetryOptions(ctx, runId);
  if (!retryOpts.resumable) {
    throw new Error(`任务 ${runId} 当前状态为 ${run.status}，不允许继续或重跑`);
  }

  let startStage: PipelineStage;
  if (opts?.fromStage) {
    const candidate = assertPipelineStage(opts.fromStage);
    if (!retryOpts.allowedFromStages.includes(candidate)) {
      throw new Error(
        `当前任务仅允许从 [${retryOpts.allowedFromStages.join(', ')}] 重跑，不能直接从 ${candidate} 开始`,
      );
    }
    startStage = candidate;
  } else {
    if (!retryOpts.resumeFrom) {
      throw new Error(`任务 ${runId} 的全部自动阶段已完成，请显式指定要重跑的阶段（fromStage）`);
    }
    startStage = assertPipelineStage(retryOpts.resumeFrom);
  }

  let settings = parseRunSettingsSnapshot(run.configSnapshotJson);
  acquirePipelineLock(ctx, runId, settings);

  try {
    if (opts?.useLatestConfig) {
      await ctx.reloadConfig();
      const nextJson = JSON.stringify(ctx.settings);
      ctx.repos.runs.updateStatus(runId, run.status, { configSnapshotJson: nextJson });
      settings = ctx.settings;
      emitRunEvent(ctx, {
        runId,
        level: 'info',
        type: 'config_snapshot_refreshed',
        message: '已按要求使用最新系统配置刷新本期运行快照',
      });
    }

    const revival = revivePublishedRunIfNeeded(ctx, runId, startStage);
    const attempt = ctx.repos.runs.incrementAttempt(runId);
    const archivePreviousOutput = Boolean(opts?.fromStage) || revival.revived;
    if (archivePreviousOutput) {
      await invalidateStagesAndArchive(ctx, runId, startStage, attempt);
    }

    emitRunEvent(ctx, {
      runId,
      level: 'info',
      stage: startStage,
      type: 'retry_started',
      message: archivePreviousOutput
        ? `开始第 ${attempt} 次尝试：从阶段 ${startStage} 重新执行（旧产物已归档）`
        : `开始第 ${attempt} 次尝试：从断点阶段 ${startStage} 继续执行`,
      data: {
        granularity: opts?.fromStage ? 'stage' : 'resume',
        startStage,
        attempt,
        useLatestConfig: Boolean(opts?.useLatestConfig),
        revived: revival.revived,
      },
    });

    await executePipelineStagesLocked({
      ctx,
      runId,
      settings,
      startStage,
      stopAfterStage: opts?.stopAfterStage,
      stageOverrides: opts?.stageOverrides,
      limitsOverride: opts?.limitsOverride,
      onAwaitingReview: opts?.onAwaitingReview,
      onStarted: opts?.onStarted,
    });
  } finally {
    releasePipelineLock(ctx, runId);
  }
}

/**
 * 批量并发重做某期任务中的一条或多条新闻（可指定从总结、润色或核查步骤开始），
 * 全部目标条目并发完成后统一作废整期编排及之后的阶段并重新向后生成成片。
 */
export async function retryRunItems(
  ctx: CoreContext,
  runId: string,
  itemIds: readonly string[],
  opts?: {
    fromStep?: EditSubStep;
    useLatestConfig?: boolean;
    stopAfterStage?: PipelineStage;
    stageOverrides?: Partial<Record<PipelineStage, StageExecutor>>;
    limitsOverride?: Partial<ContentLimits>;
    onStarted?: () => void;
    onAwaitingReview?: (opts: {
      ctx: CoreContext;
      runId: string;
      settings: Settings;
    }) => Promise<void>;
  },
): Promise<void> {
  const uniqueItemIds = Array.from(new Set(itemIds.map((id) => id.trim()).filter(Boolean)));
  if (uniqueItemIds.length === 0) {
    throw new Error('请至少指定一条需要重做的新闻条目 ID');
  }

  const run = ctx.repos.runs.getById(runId);
  if (!run) {
    throw new Error(`未找到任务记录: ${runId}`);
  }
  if (run.status === 'running' || run.status === 'publishing') {
    const holder = ctx.repos.locks.get('pipeline');
    if (holder) {
      throw new LockBusyError(holder);
    }
    throw new Error(`任务 ${runId} 正在运行中，无法重做新闻条目`);
  }
  if (!RETRYABLE_RUN_STATUSES.includes(run.status)) {
    throw new Error(`任务 ${runId} 状态为 ${run.status}，不允许重做新闻条目`);
  }

  const stageRecs = ctx.repos.runStages.listByRun(runId);
  const selectRec = stageRecs.find((s) => s.stage === 'select');
  if (selectRec?.status !== 'done') {
    throw new Error(`任务 ${runId} 的选题阶段尚未完成，无法重做新闻条目`);
  }

  for (const itemId of uniqueItemIds) {
    const item = ctx.repos.runItems.getById(itemId);
    if (!item || item.runId !== runId) {
      throw new Error(`任务 ${runId} 中未找到新闻条目: ${itemId}`);
    }
  }

  const singleItemId = uniqueItemIds.length === 1 ? uniqueItemIds[0] : undefined;

  let settings = parseRunSettingsSnapshot(run.configSnapshotJson);
  acquirePipelineLock(ctx, runId, settings);

  const lockAbort = new AbortController();
  let lostLock = false;
  const hb = startRunHeartbeat(ctx, runId, {
    onLockLost: () => {
      lostLock = true;
      lockAbort.abort();
    },
  });
  const cancelMonitor = createRunCancelMonitor(ctx, runId);
  const itemSignal = AbortSignal.any([cancelMonitor.signal, lockAbort.signal]);

  try {
    if (opts?.useLatestConfig) {
      await ctx.reloadConfig();
      const nextJson = JSON.stringify(ctx.settings);
      ctx.repos.runs.updateStatus(runId, run.status, { configSnapshotJson: nextJson });
      settings = ctx.settings;
      emitRunEvent(ctx, {
        runId,
        level: 'info',
        type: 'config_snapshot_refreshed',
        message: '已按要求使用最新系统配置刷新本期运行快照',
      });
    }

    const fromStep = opts?.fromStep ?? 'summarize';
    revivePublishedRunIfNeeded(ctx, runId, 'edit');
    const attempt = ctx.repos.runs.incrementAttempt(runId);
    await invalidateStagesAndArchive(ctx, runId, 'package', attempt);

    const nowIso = ctx.now().toISOString();
    ctx.repos.runs.updateStatus(runId, 'running', {
      currentStage: 'edit',
      pid: process.pid,
      finishedAt: null,
      errorCode: null,
      error: null,
      retryDeadlineAt: null,
      cancelRequested: 0,
      heartbeatAt: nowIso,
    });
    ctx.repos.runStages.markStage(runId, 'edit', 'running', {
      incrementAttempt: true,
      startedAt: nowIso,
      finishedAt: null,
      error: null,
    });

    emitRunEvent(ctx, {
      runId,
      level: 'info',
      stage: 'edit',
      itemId: singleItemId,
      type: 'retry_started',
      message:
        singleItemId !== undefined
          ? `开始单独重试新闻条目 ${singleItemId}（起始步骤：${fromStep}）`
          : `开始并发重试 ${uniqueItemIds.length} 条新闻（${uniqueItemIds.join(', ')}，起始步骤：${fromStep}）`,
      data: {
        granularity: singleItemId !== undefined ? 'item' : 'items',
        ...(singleItemId !== undefined ? { itemId: singleItemId } : {}),
        itemIds: uniqueItemIds,
        fromStep,
        attempt,
      },
    });
    opts?.onStarted?.();

    let editOut: unknown;
    try {
      editOut = await retryMultipleEditItems({
        ctx,
        settings,
        runId,
        itemIds: uniqueItemIds,
        fromStep,
        limitsOverride: opts?.limitsOverride,
        signal: itemSignal,
      });
    } catch (itemErr) {
      if (lostLock) {
        throw new PipelineError('interrupted', '运行锁已被其他进程接管，当前条目重试已停止', {
          cause: itemErr,
        });
      }
      const errIso = ctx.now().toISOString();
      const code = toErrorCode(itemErr, 'edit');
      const deadlineIso = computeRetryDeadline(ctx, settings);
      const isAbort = code === 'cancelled';

      ctx.repos.runStages.markStage(runId, 'edit', isAbort ? 'interrupted' : 'failed', {
        finishedAt: errIso,
        error: itemErr instanceof Error ? itemErr.message : String(itemErr),
      });
      ctx.repos.runs.updateStatus(runId, isAbort ? 'cancelled' : 'failed', {
        errorCode: code,
        error: isAbort
          ? '任务已被用户取消'
          : itemErr instanceof Error
            ? itemErr.message
            : String(itemErr),
        cancelRequested: 0,
        pid: null,
        finishedAt: errIso,
        retryDeadlineAt: deadlineIso,
      });
      if (isAbort) {
        emitRunEvent(ctx, {
          runId,
          level: 'warn',
          stage: 'edit',
          itemId: singleItemId,
          type: 'run_cancelled',
          message: singleItemId !== undefined ? '单条新闻重试已被取消' : '批量新闻重试已被取消',
        });
      } else {
        const msg = itemErr instanceof Error ? itemErr.message : String(itemErr);
        emitRunEvent(ctx, {
          runId,
          level: 'error',
          stage: 'edit',
          itemId: singleItemId,
          type: 'run_failed',
          message: `${singleItemId !== undefined ? '单条' : '批量'}新闻重试失败（${code}）：${msg}`,
          data: { errorCode: code },
        });
        await ctx.notifier.notify({
          type: 'failed',
          runId,
          message: `第 ${runId} 期${singleItemId !== undefined ? '单条' : '批量'}重试失败（${code}）：${msg}`,
          data: {
            errorCode: code,
            stage: 'edit',
            ...(singleItemId !== undefined ? { itemId: singleItemId } : {}),
            itemIds: uniqueItemIds,
          },
        });
      }
      throw itemErr;
    }

    await writeJsonAtomic(
      path.join(ctx.paths.runDir(runId), STAGE_CHECKPOINT_REL_PATH.edit),
      editOut,
    );
    ctx.repos.runStages.markStage(runId, 'edit', 'done', {
      finishedAt: ctx.now().toISOString(),
      checkpointPath: STAGE_CHECKPOINT_REL_PATH.edit,
      error: null,
    });

    hb.stop();
    cancelMonitor.stop();

    await executePipelineStagesLocked({
      ctx,
      runId,
      settings,
      startStage: 'package',
      stopAfterStage: opts?.stopAfterStage,
      stageOverrides: opts?.stageOverrides,
      limitsOverride: opts?.limitsOverride,
      onAwaitingReview: opts?.onAwaitingReview,
    });
  } finally {
    cancelMonitor.stop();
    hb.stop();
    releasePipelineLock(ctx, runId);
  }
}

/**
 * 单独重做某期任务中的一条新闻（可指定从总结、润色或核查步骤开始），
 * 完成后自动作废整期编排及之后的阶段并重新向后生成成片。
 */
export async function retryRunItem(
  ctx: CoreContext,
  runId: string,
  itemId: string,
  opts?: {
    fromStep?: EditSubStep;
    useLatestConfig?: boolean;
    stopAfterStage?: PipelineStage;
    stageOverrides?: Partial<Record<PipelineStage, StageExecutor>>;
    limitsOverride?: Partial<ContentLimits>;
    onStarted?: () => void;
    onAwaitingReview?: (opts: {
      ctx: CoreContext;
      runId: string;
      settings: Settings;
    }) => Promise<void>;
  },
): Promise<void> {
  return retryRunItems(ctx, runId, [itemId], opts);
}

/**
 * 主动放弃某期中断或未发布的任务，释放它锁定的全部文章回到待选池。
 */
export function abandonRun(ctx: CoreContext, runId: string): void {
  const run = ctx.repos.runs.getById(runId);
  if (!run) {
    throw new Error(`未找到任务记录: ${runId}`);
  }
  if (
    run.status === 'running' ||
    run.status === 'publishing' ||
    run.status === 'published' ||
    run.status === 'abandoned'
  ) {
    throw new Error(`任务 ${runId} 状态为 ${run.status}，不允许执行放弃操作`);
  }

  const nowIso = ctx.now().toISOString();
  inTransaction(ctx.db, () => {
    const released = ctx.repos.articles.releaseByRun(runId);
    ctx.repos.runs.updateStatus(runId, 'abandoned', {
      finishedAt: nowIso,
      pid: null,
    });
    emitRunEvent(ctx, {
      runId,
      level: 'info',
      type: 'run_abandoned',
      message: `已放弃本期任务并释放 ${released} 篇占用新闻回到候选池`,
      data: { releasedArticles: released, autoExpired: false },
    });
  });
}

/**
 * 请求取消正在执行的任务：对排队中的任务直接标记取消，对运行中的任务写入取消标志由执行器中止子进程。
 */
export function cancelRun(ctx: CoreContext, runId: string): void {
  const run = ctx.repos.runs.getById(runId);
  if (!run) {
    throw new Error(`未找到任务记录: ${runId}`);
  }

  if (run.status === 'queued') {
    const settings = parseRunSettingsSnapshot(run.configSnapshotJson);
    const nowIso = ctx.now().toISOString();
    inTransaction(ctx.db, () => {
      ctx.repos.runs.updateStatus(runId, 'cancelled', {
        errorCode: 'cancelled',
        error: '任务尚未启动即被取消',
        cancelRequested: 0,
        finishedAt: nowIso,
        retryDeadlineAt: computeRetryDeadline(ctx, settings),
      });
      emitRunEvent(ctx, {
        runId,
        level: 'warn',
        type: 'run_cancelled',
        message: '排队中的任务已被取消',
      });
    });
    return;
  }

  if (run.status !== 'running') {
    throw new Error(`任务 ${runId} 当前状态为 ${run.status}，无法取消`);
  }

  ctx.repos.runs.requestCancel(runId);
  emitRunEvent(ctx, {
    runId,
    level: 'warn',
    stage: run.currentStage,
    type: 'cancel_requested',
    message: '已发出任务取消请求，正在安全停止当前步骤',
  });
}
