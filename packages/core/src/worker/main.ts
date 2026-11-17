import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { StageSchema, type Trigger, TriggerSchema } from '@aidaily/contracts';
import type { EditSubStep } from '../editorial/item-pipeline.js';
import { createCore } from '../index.js';
import { inTransaction } from '../storage/db.js';
import { emitRunEvent } from '../workflow/events.js';
import { LockBusyError, PIPELINE_LOCK_NAME, releasePipelineLock } from '../workflow/lock.js';
import { executeRun, resumeRun, retryRunItem } from '../workflow/runner.js';
import { reportRetryStartup, waitForRetryGrant } from './retry-startup.js';

const VALID_WORKER_ACTIONS = new Set([
  'execute-run',
  'start',
  'resume',
  'retry-item',
  'publish-approve',
  'publish-retry',
]);

/** 后台独立工作进程支持的操作指令 */
export type WorkerAction =
  | 'execute-run'
  | 'start'
  | 'resume'
  | 'retry-item'
  | 'publish-approve'
  | 'publish-retry';

/** 解析命令行传递的后台工作进程参数 */
interface ParsedWorkerArgs {
  rootDir?: string;
  action: WorkerAction;
  runId?: string;
  itemId?: string;
  from?: string;
  latestConfig: boolean;
  requiresRetryGrant: boolean;
  trigger?: Trigger;
  scheduleId?: string;
  itemCount?: number;
  dtimeUnixSec?: number;
}

/** 读取参数值，并在缺少参数值时给出清晰错误提示 */
function requireFlagValue(argv: readonly string[], idx: number, flag: string): string {
  const val = argv[idx + 1];
  if (!val || val.startsWith('--')) {
    throw new Error(`后台进程参数 ${flag} 缺少取值`);
  }
  return val;
}

/** 解析并校验后台进程入参列表 */
export function parseWorkerArgs(argv: readonly string[]): ParsedWorkerArgs {
  let rootDir: string | undefined;
  let action: WorkerAction | undefined;
  let runId: string | undefined;
  let itemId: string | undefined;
  let from: string | undefined;
  let latestConfig = false;
  let requiresRetryGrant = false;
  let trigger: Trigger | undefined;
  let scheduleId: string | undefined;
  let itemCount: number | undefined;
  let dtimeUnixSec: number | undefined;

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    switch (token) {
      case '--root':
        rootDir = requireFlagValue(argv, i, '--root');
        i += 1;
        break;
      case '--action': {
        const rawAction = requireFlagValue(argv, i, '--action');
        if (!VALID_WORKER_ACTIONS.has(rawAction)) {
          throw new Error(`不支持的后台工作进程操作 --action: ${rawAction}`);
        }
        action = rawAction as WorkerAction;
        i += 1;
        break;
      }
      case '--run-id':
        runId = requireFlagValue(argv, i, '--run-id');
        i += 1;
        break;
      case '--item-id':
        itemId = requireFlagValue(argv, i, '--item-id');
        i += 1;
        break;
      case '--from':
        from = requireFlagValue(argv, i, '--from');
        i += 1;
        break;
      case '--latest-config':
        latestConfig = true;
        break;
      case '--wait-for-retry-grant':
        requiresRetryGrant = true;
        break;
      case '--trigger':
        trigger = TriggerSchema.parse(requireFlagValue(argv, i, '--trigger'));
        i += 1;
        break;
      case '--schedule-id':
        scheduleId = requireFlagValue(argv, i, '--schedule-id');
        i += 1;
        break;
      case '-n':
      case '--items': {
        const parsed = Number(requireFlagValue(argv, i, token));
        if (!Number.isInteger(parsed) || parsed <= 0) {
          throw new RangeError(`每期条数必须为正整数，当前传入: ${argv[i + 1] ?? ''}`);
        }
        itemCount = parsed;
        i += 1;
        break;
      }
      case '--dtime': {
        const parsed = Number(requireFlagValue(argv, i, '--dtime'));
        if (!Number.isFinite(parsed) || parsed <= 0) {
          throw new RangeError(`定时发布时间戳必须为正数: ${argv[i + 1] ?? ''}`);
        }
        dtimeUnixSec = parsed;
        i += 1;
        break;
      }
      default:
        throw new Error(`未知的后台工作进程参数: ${token}`);
    }
  }

  if (!action) {
    throw new Error('缺少必需的后台工作进程参数 --action');
  }
  if (requiresRetryGrant && action !== 'resume' && action !== 'retry-item') {
    throw new Error('只有重试操作支持等待父进程许可');
  }

  return {
    rootDir,
    action,
    runId,
    itemId,
    from,
    latestConfig,
    requiresRetryGrant,
    trigger,
    scheduleId,
    itemCount,
    dtimeUnixSec,
  };
}

/** 获取必需的 `--run-id` 参数值 */
function requireRunId(parsed: ParsedWorkerArgs): string {
  if (!parsed.runId) {
    throw new Error(`操作 ${parsed.action} 必须提供 --run-id 参数`);
  }
  return parsed.runId;
}

/** 独立后台子进程主入口，用于在网页后台或命令行以分离模式触发任务后在后台完整运行 */
export async function runWorkerMain(
  argv: readonly string[] = process.argv.slice(2),
): Promise<void> {
  const parsed = parseWorkerArgs(argv);
  if (!parsed.requiresRetryGrant) {
    return executeWorkerAction(parsed);
  }

  await waitForRetryGrant();
  let started = false;
  try {
    await executeWorkerAction(parsed, () => {
      started = true;
      reportRetryStartup({ type: 'retry_started' });
    });
  } catch (err) {
    if (!started) {
      reportRetryStartup({
        type: 'retry_start_failed',
        message: `后台重试启动失败：${err instanceof Error ? err.message : String(err)}`,
      });
    }
    throw err;
  }
}

/** 初始化工作进程并执行所选操作，结尾释放本进程的资源 */
async function executeWorkerAction(
  parsed: ParsedWorkerArgs,
  onStarted?: () => void,
): Promise<void> {
  const core = await createCore({ rootDir: parsed.rootDir });
  const retryRunId = parsed.requiresRetryGrant ? parsed.runId : undefined;

  try {
    if (parsed.requiresRetryGrant) {
      const runId = requireRunId(parsed);
      const ownsReservation = core.context.repos.locks.updateHeartbeat(
        PIPELINE_LOCK_NAME,
        runId,
        core.context.now().toISOString(),
        process.pid,
      );
      if (!ownsReservation) {
        throw new Error(`任务 ${runId} 的重试启动资格已失效，请刷新后重试`);
      }
    }
    switch (parsed.action) {
      case 'execute-run': {
        const runId = requireRunId(parsed);
        await executeRun(core.context, runId);
        break;
      }
      case 'start': {
        if (!parsed.itemCount) {
          throw new RangeError('start 操作必须显式传入正整数条数 -n');
        }
        await core.tasks.start({
          itemCount: parsed.itemCount,
          trigger: parsed.trigger,
          scheduleId: parsed.scheduleId,
          detach: false,
        });
        break;
      }
      case 'resume': {
        const runId = requireRunId(parsed);
        const fromStage = parsed.from ? StageSchema.parse(parsed.from) : undefined;
        await resumeRun(core.context, runId, {
          fromStage,
          useLatestConfig: parsed.latestConfig,
          onStarted,
        });
        break;
      }
      case 'retry-item': {
        const runId = requireRunId(parsed);
        if (!parsed.itemId) {
          throw new Error('retry-item 操作必须提供 --item-id 参数');
        }
        let fromStep: EditSubStep | undefined;
        if (parsed.from) {
          if (
            parsed.from !== 'summarize' &&
            parsed.from !== 'polish' &&
            parsed.from !== 'factcheck'
          ) {
            throw new Error(
              `retry-item 的 --from 参数仅支持 summarize、polish 或 factcheck，当前传入: ${parsed.from}`,
            );
          }
          fromStep = parsed.from;
        }
        await retryRunItem(core.context, runId, parsed.itemId, {
          fromStep,
          useLatestConfig: parsed.latestConfig,
          onStarted,
        });
        break;
      }
      case 'publish-approve': {
        const runId = requireRunId(parsed);
        await core.publish.approve(runId, {
          detach: false,
          dtimeUnixSec: parsed.dtimeUnixSec,
        });
        break;
      }
      case 'publish-retry': {
        const runId = requireRunId(parsed);
        await core.publish.retry(runId, {
          detach: false,
          dtimeUnixSec: parsed.dtimeUnixSec,
        });
        break;
      }
    }
  } catch (err) {
    // 若预定任务尚未走出 queued 即遇并发冲突或异常失败，妥善收敛其状态避免永久悬停在排队态
    if (parsed.runId) {
      const currentRun = core.context.repos.runs.getById(parsed.runId);
      if (currentRun?.status === 'queued') {
        const nowIso = core.context.now().toISOString();
        const isScheduleSkip = err instanceof LockBusyError && parsed.trigger === 'schedule';
        inTransaction(core.context.db, () => {
          core.context.repos.runs.updateStatus(
            currentRun.id,
            isScheduleSkip ? 'abandoned' : 'failed',
            {
              errorCode: isScheduleSkip ? undefined : 'interrupted',
              error: err instanceof Error ? err.message : String(err),
              finishedAt: nowIso,
              pid: null,
            },
          );
          emitRunEvent(core.context, {
            runId: currentRun.id,
            level: isScheduleSkip ? 'warn' : 'error',
            type: isScheduleSkip ? 'schedule_skipped' : 'run_failed',
            message: isScheduleSkip
              ? `定时触发检测到已有任务运行，本排队占位已自动取消`
              : `后台工作进程启动阶段失败: ${err instanceof Error ? err.message : String(err)}`,
          });
        });
      }
    }

    if (err instanceof LockBusyError && parsed.trigger === 'schedule') {
      if (!(err as { scheduleSkipNotified?: boolean }).scheduleSkipNotified) {
        const msg = `定时触发跳过：当前已有任务 ${err.holder.ownerRun ?? '未知'} 正在运行（进程 ${String(err.holder.pid ?? '未知')}）`;
        core.context.logger.warn({ holder: err.holder, scheduleId: parsed.scheduleId }, msg);
        if (err.holder.ownerRun) {
          emitRunEvent(core.context, {
            runId: err.holder.ownerRun,
            level: 'warn',
            type: 'schedule_skipped',
            message: msg,
            data: { scheduleId: parsed.scheduleId ?? null, holder: err.holder },
          });
        }
        await core.context.notifier
          .notify({
            type: 'schedule_skipped',
            runId: err.holder.ownerRun ?? undefined,
            message: msg,
            data: { scheduleId: parsed.scheduleId ?? null },
          })
          .catch(() => undefined);
      }
      process.exitCode = 0;
      return;
    }

    core.context.logger.error(
      { err, action: parsed.action, runId: parsed.runId },
      '后台工作进程执行失败',
    );
    throw err;
  } finally {
    if (retryRunId) {
      releasePipelineLock(core.context, retryRunId);
    }
    await core.close();
  }
}

/** 判断当前文件是否作为独立 Node 脚本直接启动（兼容中文路径） */
function isMainModule(metaUrl: string): boolean {
  const arg = process.argv[1];
  if (!arg) {
    return false;
  }
  try {
    return fs.realpathSync(fileURLToPath(metaUrl)) === fs.realpathSync(arg);
  } catch {
    return false;
  }
}

if (isMainModule(import.meta.url)) {
  try {
    await runWorkerMain();
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}
