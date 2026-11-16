import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  type Article,
  type ItemVersion,
  type LlmCallRecord,
  PIPELINE_STAGES,
  RETRYABLE_RUN_STATUSES,
  type RetryOptions,
  type RunDetail,
  RunDetailSchema,
  type RunEvent,
  type RunStatus,
  type RunSummary,
  SettingsSchema,
  type Stage,
  type Trigger,
} from '@aidaily/contracts';
import type { CoreContext } from '../context.js';
import type { EditSubStep } from '../editorial/item-pipeline.js';
import { resolveSafeArtifactPath } from '../paths.js';
import { inTransaction } from '../storage/db.js';
import { readJsonOrNull } from '../storage/files.js';
import { spawnDetachedWorker } from '../worker/spawn.js';
import { emitRunEvent } from '../workflow/events.js';
import {
  assertPipelineLockAvailable,
  LockBusyError,
  reservePipelineLockForChild,
} from '../workflow/lock.js';
import {
  abandonRun,
  cancelRun,
  createRun,
  executeRun,
  getRunRetryOptions,
  resumeRun,
  retryRunItem,
} from '../workflow/runner.js';

/** 带有正文原文内容的新闻文章详情，用于管理后台核对出处与原稿 */
export interface RunArticleWithContent extends Article {
  contentText: string | null;
}

/** 启动单期生成任务的可选参数 */
export interface TaskStartOptions {
  itemCount: number;
  trigger?: Trigger;
  scheduleId?: string;
  detach?: boolean;
  onCreated?: (runId: string) => void;
}

/** 恢复或从指定步骤重跑任务的可选参数 */
export interface TaskResumeOptions {
  fromStage?: Stage;
  useLatestConfig?: boolean;
  detach?: boolean;
}

/** 单条新闻独立重跑的可选参数 */
export interface TaskRetryItemOptions {
  fromStep?: EditSubStep;
  useLatestConfig?: boolean;
  detach?: boolean;
}

/** 监听任务事件流的可选控制参数 */
export interface TaskWatchOptions {
  afterId?: number;
  pollMs?: number;
}

/** 任务管理服务接口（供命令行工具与网页后台共同调用） */
export interface TaskService {
  /** 创建并启动新一期视频生产任务（新闻条数必须显式指定为正整数） */
  start(opts: TaskStartOptions): Promise<{ runId: string }>;
  /** 恢复中断或失败的任务，或指定从某个历史步骤重新向后运行 */
  resume(runId: string, opts?: TaskResumeOptions): Promise<void>;
  /** 对指定期次中的某一条新闻单独重新生成或重新核查，并自动重新编排合成 */
  retryItem(runId: string, itemId: string, opts?: TaskRetryItemOptions): Promise<void>;
  /** 查询某期任务当前允许的恢复入口及重试截止时间 */
  getRetryOptions(runId: string): Promise<RetryOptions>;
  /** 主动放弃未完结的任务，释放它占用的新闻文章回到待选库 */
  abandon(runId: string): Promise<void>;
  /** 发出取消请求以安全停止正在执行中的任务 */
  cancel(runId: string): Promise<void>;
  /** 分页或按状态筛选查询历史任务摘要列表 */
  list(q?: { status?: RunStatus[]; limit?: number; before?: string }): Promise<RunSummary[]>;
  /** 读取单期任务的完整执行详情、阶段进度、新闻条目、投稿记录及产物清单 */
  get(runId: string): Promise<RunDetail>;
  /** 查询单条新闻在写作、预检与核查过程中的全部历史版本快照 */
  getItemHistory(itemId: string): Promise<ItemVersion[]>;
  /** 查询指定任务期间产生的全部外部模型调用耗时、用量及日志索引 */
  getLlmCalls(runId: string): Promise<LlmCallRecord[]>;
  /** 按自增事件编号增量拉取任务日志事件 */
  events(runId: string, afterId?: number, limit?: number): Promise<RunEvent[]>;
  /** 持续订阅任务实时事件流，直到外部取消信号触发或任务到达稳定终止状态 */
  watch(
    runId: string,
    onEvent: (e: RunEvent) => void,
    signal: AbortSignal,
    opts?: TaskWatchOptions,
  ): Promise<void>;
  /** 校验并解析任务产物目录内的安全绝对路径，禁止越界读取外部文件 */
  resolveArtifact(runId: string, relPath: string): string;
  /** 读取指定任务关联的全部新闻原文内容 */
  getRunArticles(runId: string): Promise<RunArticleWithContent[]>;
  /** 安全读取指定任务目录下的 JSON 产物文件，不存在时返回 null */
  readArtifactJson<T = unknown>(runId: string, relPath: string): Promise<T | null>;
  /** 安全读取某次外部模型调用落盘保存的完整请求提示词与原始输出 */
  getLlmCallLog(runId: string, callId: number): Promise<unknown | null>;
}

/** 递归收集任务产物目录内的全部相对路径（统一使用 `/` 分隔并排序） */
async function collectRelativeArtifactPaths(runDir: string): Promise<string[]> {
  const results: string[] = [];

  async function walk(currentDir: string, prefixRel: string): Promise<void> {
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(currentDir, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return;
      }
      throw err;
    }

    for (const entry of entries) {
      const nextRel = prefixRel ? `${prefixRel}/${entry.name}` : entry.name;
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath, nextRel);
      } else if (entry.isFile()) {
        results.push(nextRel);
      }
    }
  }

  await walk(runDir, '');
  return results.sort();
}

/** 在指定时间间隔后返回，若外部取消信号触发则立即结束等待 */
async function sleepUntilAbort(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted || ms <= 0) {
    return;
  }
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** 判断某期任务是否已进入稳定停顿状态（监听事件流可以安全收尾退出） */
function isWatchingTerminalStatus(status: RunStatus, configSnapshotJson: string): boolean {
  switch (status) {
    case 'queued':
    case 'running':
    case 'publishing':
      return false;
    case 'awaiting_review': {
      // 自动发布模式在审阅点会紧接着直接发起上传，因此继续观察直到发布落定
      try {
        const parsed = SettingsSchema.safeParse(JSON.parse(configSnapshotJson));
        if (parsed.success && parsed.data.publish.mode === 'auto') {
          return false;
        }
      } catch {
        // 无法解析快照时按需人工审核的停止状态处理
      }
      return true;
    }
    default:
      return true;
  }
}

/** 校验相对于根目录的路径在解析真实物理路径后是否仍严格位于指定安全目录内部 */
function resolveRealPathInsideDir(
  rootDir: string,
  allowedDir: string,
  relFromRoot: string,
): string | null {
  if (!relFromRoot || relFromRoot.includes('\0')) {
    return null;
  }
  const baseAllowed = path.resolve(allowedDir);
  const absCandidate = path.resolve(rootDir, relFromRoot);
  if (!absCandidate.startsWith(`${baseAllowed}${path.sep}`)) {
    return null;
  }
  try {
    const realAllowed = fsSync.realpathSync(baseAllowed);
    const realCandidate = fsSync.realpathSync(absCandidate);
    if (!realCandidate.startsWith(`${realAllowed}${path.sep}`)) {
      return null;
    }
    return realCandidate;
  } catch {
    return null;
  }
}

/**
 * 创建任务管理服务实例，统一向命令行和网页后台提供任务生命周期操作、实时事件监听与产物安全访问。
 */
export function createTaskService(ctx: CoreContext): TaskService {
  return {
    /** 启动新一期生产任务：校验条数必填、查锁排重，并支持前台直跑或分离至后台工作进程 */
    async start(opts: TaskStartOptions): Promise<{ runId: string }> {
      if (!Number.isInteger(opts?.itemCount) || opts.itemCount <= 0) {
        throw new RangeError(
          `每期新闻条数 itemCount 必须显式指定为正整数，当前传入: ${String(opts?.itemCount)}`,
        );
      }

      const trigger: Trigger = opts.trigger ?? 'manual-cli';

      try {
        assertPipelineLockAvailable(ctx);
      } catch (err) {
        if (err instanceof LockBusyError && trigger === 'schedule') {
          const skipMsg = `定时触发跳过：当前已有任务 ${err.holder.ownerRun ?? '未知'} 正在执行（进程 ${String(err.holder.pid ?? '未知')}）`;
          ctx.logger.warn({ holder: err.holder, scheduleId: opts.scheduleId }, skipMsg);
          if (err.holder.ownerRun) {
            emitRunEvent(ctx, {
              runId: err.holder.ownerRun,
              level: 'warn',
              type: 'schedule_skipped',
              message: skipMsg,
              data: { scheduleId: opts.scheduleId ?? null, holder: err.holder },
            });
          }
          await ctx.notifier
            .notify({
              type: 'schedule_skipped',
              runId: err.holder.ownerRun ?? undefined,
              message: skipMsg,
              data: { scheduleId: opts.scheduleId ?? null },
            })
            .catch(() => undefined);
          (err as LockBusyError & { scheduleSkipNotified?: boolean }).scheduleSkipNotified = true;
        }
        throw err;
      }

      const runId = inTransaction(ctx.db, () => {
        const createdId = createRun(ctx, {
          itemCount: opts.itemCount,
          trigger,
          scheduleId: opts.scheduleId ?? null,
        });

        if (opts.scheduleId) {
          const nowIso = ctx.now().toISOString();
          ctx.repos.schedules.update(opts.scheduleId, {
            lastRunId: createdId,
            lastTriggeredAt: nowIso,
            now: nowIso,
          });
        }
        return createdId;
      });

      opts.onCreated?.(runId);

      if (opts.detach) {
        const args = [
          '--root',
          ctx.paths.rootDir,
          '--action',
          'execute-run',
          '--run-id',
          runId,
          '--trigger',
          trigger,
        ];
        if (opts.scheduleId) {
          args.push('--schedule-id', opts.scheduleId);
        }

        const logFile = path.join(ctx.paths.runDir(runId), 'worker.log');
        try {
          const { pid } = await spawnDetachedWorker(args, {
            rootDir: ctx.paths.rootDir,
            logFile,
          });
          reservePipelineLockForChild(ctx, runId, pid, (current) => current?.status === 'queued');
          return { runId };
        } catch (spawnErr) {
          const errIso = ctx.now().toISOString();
          const msg = spawnErr instanceof Error ? spawnErr.message : String(spawnErr);
          inTransaction(ctx.db, () => {
            ctx.repos.runs.updateStatus(runId, 'failed', {
              errorCode: 'interrupted',
              error: `启动后台工作进程失败: ${msg}`,
              finishedAt: errIso,
              pid: null,
            });
            emitRunEvent(ctx, {
              runId,
              level: 'error',
              type: 'run_failed',
              message: `启动后台工作进程失败: ${msg}`,
            });
          });
          throw spawnErr;
        }
      }

      await executeRun(ctx, runId);
      return { runId };
    },

    /** 恢复或从指定历史阶段重跑既有任务，支持分离至后台工作进程异步执行 */
    async resume(runId: string, opts?: TaskResumeOptions): Promise<void> {
      const retryOpts = getRunRetryOptions(ctx, runId);
      if (!retryOpts.resumable) {
        const current = ctx.repos.runs.getById(runId);
        throw new Error(`任务 ${runId} 当前状态为 ${current?.status ?? '未知'}，不允许继续或重跑`);
      }

      if (opts?.fromStage) {
        if (!(PIPELINE_STAGES as readonly string[]).includes(opts.fromStage)) {
          throw new Error(`步骤 ${opts.fromStage} 不属于可重跑的自动化生成阶段`);
        }
        if (!retryOpts.allowedFromStages.includes(opts.fromStage)) {
          throw new Error(
            `当前任务仅允许从 [${retryOpts.allowedFromStages.join(', ')}] 重跑，不能直接从 ${opts.fromStage} 开始`,
          );
        }
      } else if (!retryOpts.resumeFrom) {
        throw new Error(`任务 ${runId} 全部阶段已完成，请显式指定重跑起点`);
      }

      assertPipelineLockAvailable(ctx);

      if (opts?.detach) {
        const beforeAttempt = ctx.repos.runs.getById(runId)?.attempt;
        const args = ['--root', ctx.paths.rootDir, '--action', 'resume', '--run-id', runId];
        if (opts.fromStage) {
          args.push('--from', opts.fromStage);
        }
        if (opts.useLatestConfig) {
          args.push('--latest-config');
        }
        const { pid } = await spawnDetachedWorker(args, {
          rootDir: ctx.paths.rootDir,
          logFile: path.join(ctx.paths.runDir(runId), 'worker.log'),
        });
        reservePipelineLockForChild(
          ctx,
          runId,
          pid,
          (current) =>
            current !== null &&
            RETRYABLE_RUN_STATUSES.includes(current.status) &&
            current.attempt === beforeAttempt,
        );
        return;
      }

      await resumeRun(ctx, runId, {
        fromStage: opts?.fromStage,
        useLatestConfig: opts?.useLatestConfig,
      });
    },

    /** 单独重跑某期任务中的一条新闻并自动向后重新编排与合成成片 */
    async retryItem(runId: string, itemId: string, opts?: TaskRetryItemOptions): Promise<void> {
      const run = ctx.repos.runs.getById(runId);
      if (!run) {
        throw new Error(`未找到任务记录: ${runId}`);
      }
      if (!RETRYABLE_RUN_STATUSES.includes(run.status)) {
        throw new Error(`任务 ${runId} 当前状态为 ${run.status}，不允许单独重试新闻条目`);
      }

      const stageRecs = ctx.repos.runStages.listByRun(runId);
      const selectRec = stageRecs.find((s) => s.stage === 'select');
      if (selectRec?.status !== 'done') {
        throw new Error(`任务 ${runId} 尚未完成选题阶段，无法单独重试新闻条目`);
      }

      const item = ctx.repos.runItems.getById(itemId);
      if (!item || item.runId !== runId) {
        throw new Error(`任务 ${runId} 中未找到新闻条目: ${itemId}`);
      }

      assertPipelineLockAvailable(ctx);

      if (opts?.detach) {
        const beforeAttempt = run.attempt;
        const args = [
          '--root',
          ctx.paths.rootDir,
          '--action',
          'retry-item',
          '--run-id',
          runId,
          '--item-id',
          itemId,
        ];
        if (opts.fromStep) {
          args.push('--from', opts.fromStep);
        }
        if (opts.useLatestConfig) {
          args.push('--latest-config');
        }
        const { pid } = await spawnDetachedWorker(args, {
          rootDir: ctx.paths.rootDir,
          logFile: path.join(ctx.paths.runDir(runId), 'worker.log'),
        });
        reservePipelineLockForChild(
          ctx,
          runId,
          pid,
          (current) =>
            current !== null &&
            RETRYABLE_RUN_STATUSES.includes(current.status) &&
            current.attempt === beforeAttempt,
        );
        return;
      }

      await retryRunItem(ctx, runId, itemId, {
        fromStep: opts?.fromStep,
        useLatestConfig: opts?.useLatestConfig,
      });
    },

    /** 查询指定任务当前可用的继续与重跑入口 */
    async getRetryOptions(runId: string): Promise<RetryOptions> {
      return getRunRetryOptions(ctx, runId);
    },

    /** 主动放弃中断或未发布任务并释放预留新闻 */
    async abandon(runId: string): Promise<void> {
      abandonRun(ctx, runId);
    },

    /** 标记取消正在运行或排队中的任务 */
    async cancel(runId: string): Promise<void> {
      cancelRun(ctx, runId);
    },

    /** 查询任务历史摘要列表 */
    async list(q?: {
      status?: RunStatus[];
      limit?: number;
      before?: string;
    }): Promise<RunSummary[]> {
      return ctx.repos.runs.list(q);
    },

    /** 组装并返回单期任务的完整详情及产物路径列表 */
    async get(runId: string): Promise<RunDetail> {
      const run = ctx.repos.runs.getById(runId);
      if (!run) {
        throw new Error(`未找到任务记录: ${runId}`);
      }

      const stages = ctx.repos.runStages.listByRun(runId);
      const events = ctx.repos.events.listByRun(runId);
      const items = ctx.repos.runItems.listByRun(runId);
      const publishRecord = ctx.repos.publish.getByRun(runId);
      const artifacts = await collectRelativeArtifactPaths(ctx.paths.runDir(runId));

      return RunDetailSchema.parse({
        id: run.id,
        trigger: run.trigger,
        scheduleId: run.scheduleId,
        status: run.status,
        currentStage: run.currentStage,
        itemCount: run.itemCount,
        attempt: run.attempt,
        errorCode: run.errorCode,
        error: run.error,
        createdAt: run.createdAt,
        startedAt: run.startedAt,
        finishedAt: run.finishedAt,
        retryDeadlineAt: run.retryDeadlineAt,
        cancelRequested: run.cancelRequested,
        pid: run.pid,
        heartbeatAt: run.heartbeatAt,
        stages,
        events,
        items,
        publishRecord,
        artifacts,
      });
    },

    /** 获取单条新闻在各轮写作及核查过程中的历史快照 */
    async getItemHistory(itemId: string): Promise<ItemVersion[]> {
      return ctx.repos.runItems.listVersions(itemId);
    },

    /** 查询某期任务期间全部模型调用记录 */
    async getLlmCalls(runId: string): Promise<LlmCallRecord[]> {
      return ctx.repos.llmCalls.listByRun(runId);
    },

    /** 按自增事件编号增量获取某期任务的日志事件 */
    async events(runId: string, afterId = 0, limit = 200): Promise<RunEvent[]> {
      return ctx.repos.runEvents.listAfter(runId, afterId, limit);
    },

    /** 持续轮询并推送某期任务的增量事件流，直至收到中止信号或任务到达停顿终态 */
    async watch(
      runId: string,
      onEvent: (e: RunEvent) => void,
      signal: AbortSignal,
      opts?: TaskWatchOptions,
    ): Promise<void> {
      const runExists = ctx.repos.runs.getById(runId);
      if (!runExists) {
        throw new Error(`未找到任务记录: ${runId}`);
      }

      let cursor = opts?.afterId ?? 0;
      const pollMs = opts?.pollMs ?? 200;

      const drainEvents = (): void => {
        while (!signal.aborted) {
          const batch = ctx.repos.runEvents.listAfter(runId, cursor, 200);
          if (batch.length === 0) {
            break;
          }
          for (const ev of batch) {
            cursor = Math.max(cursor, ev.id);
            onEvent(ev);
            if (signal.aborted) {
              break;
            }
          }
          if (batch.length < 200) {
            break;
          }
        }
      };

      while (!signal.aborted) {
        drainEvents();
        if (signal.aborted) {
          break;
        }
        const currentRun = ctx.repos.runs.getById(runId);
        if (!currentRun) {
          break;
        }
        if (isWatchingTerminalStatus(currentRun.status, currentRun.configSnapshotJson)) {
          // 稍作等待后再执行两次补刷，避免跨进程状态更新与尾随日志事件之间出现瞬时错位
          await sleepUntilAbort(Math.min(pollMs, 50), signal);
          drainEvents();
          break;
        }
        await sleepUntilAbort(pollMs, signal);
      }
    },

    /** 安全解析并校验某期任务目录内的产物文件绝对路径 */
    resolveArtifact(runId: string, relPath: string): string {
      return resolveSafeArtifactPath(ctx.paths.runsDir, runId, relPath);
    },

    /** 读取指定任务关联事件的全部原文章记录及本地提取的正文内容（仅限文章存储目录内） */
    async getRunArticles(runId: string): Promise<RunArticleWithContent[]> {
      const events = ctx.repos.events.listByRun(runId);
      const items = ctx.repos.runItems.listByRun(runId);
      const articleIdSet = new Set<string>();
      for (const ev of events) {
        for (const artId of ev.articleIds) {
          articleIdSet.add(artId);
        }
      }
      for (const item of items) {
        for (const evidence of item.finalJson?.evidence ?? []) {
          articleIdSet.add(evidence.articleId);
        }
      }
      const articles = ctx.repos.articles.getByIds(Array.from(articleIdSet));
      return Promise.all(
        articles.map(async (article) => {
          if (!article.contentPath) {
            return { ...article, contentText: null };
          }
          const safePath = resolveRealPathInsideDir(
            ctx.paths.rootDir,
            ctx.paths.articlesDir,
            article.contentPath,
          );
          if (!safePath) {
            return { ...article, contentText: null };
          }
          const contentText = await fs.readFile(safePath, 'utf8').catch(() => null);
          return { ...article, contentText };
        }),
      );
    },

    /** 安全读取某期任务目录内的 JSON 产物文件内容 */
    async readArtifactJson<T = unknown>(runId: string, relPath: string): Promise<T | null> {
      const absPath = resolveSafeArtifactPath(ctx.paths.runsDir, runId, relPath);
      return readJsonOrNull<T>(absPath);
    },

    /** 读取某次外部模型调用落盘保存的完整请求提示词与原始输出（严格限定在本期模型日志目录内） */
    async getLlmCallLog(runId: string, callId: number): Promise<unknown | null> {
      const calls = ctx.repos.llmCalls.listByRun(runId);
      const target = calls.find((c) => c.id === callId);
      if (!target?.logPath) {
        return null;
      }
      const allowedLlmDir = path.join(ctx.paths.runDir(runId), 'llm');
      const safeLogPath = resolveRealPathInsideDir(
        ctx.paths.rootDir,
        allowedLlmDir,
        target.logPath,
      );
      if (!safeLogPath) {
        throw new Error(`非法的模型调用日志路径: ${target.logPath}`);
      }
      return readJsonOrNull<unknown>(safeLogPath);
    },
  };
}
