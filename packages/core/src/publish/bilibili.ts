import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Settings } from '@aidaily/contracts';
import type { CoreContext } from '../context.js';
import { PipelineError } from '../errors.js';
import { inTransaction } from '../storage/db.js';
import { emitRunEvent } from '../workflow/events.js';
import { startRunHeartbeat } from '../workflow/heartbeat.js';
import { acquirePipelineLock, releasePipelineLock } from '../workflow/lock.js';
import { commitRunConsumption } from './consumption.js';
import { ensurePublishDraftForRun } from './description.js';

const DEFAULT_UPLOAD_RETRY_DELAYS_MS = [10_000, 60_000, 180_000] as const;
const MAX_UPLOAD_RETRIES = 3;
const BVID_EXTRACT_PATTERN = /\b(BV[0-9A-Za-z]{10})\b/;

/** 强制开启的 B 站 AI 生成内容声明扩展提交字段（透传至平台投稿接口） */
export const BILIBILI_AI_DECLARATION_EXTRA_FIELDS = JSON.stringify({ is_ai: 1 });

/** 验证并清洗传入的 BV 号格式 */
export function normalizeBvid(raw: string): string {
  const trimmed = raw.trim();
  const match = BVID_EXTRACT_PATTERN.exec(trimmed);
  if (!match?.[1]) {
    throw new Error(`无效的 B 站视频 BV 号: ${raw}`);
  }
  return match[1];
}

/** 从投稿命令行输出中解析平台分配的 BV 号 */
export function parseBvidFromOutput(stdout: string, stderr: string): string | null {
  const combined = `${stdout}\n${stderr}`;
  const match = BVID_EXTRACT_PATTERN.exec(combined);
  return match?.[1] ?? null;
}

/** 解析 B 站投稿命令行工具实际可执行路径（配置优先，若为裸命令名则自动补查常见安装目录） */
export function resolveBiliupExecutable(configuredBin: string): string {
  const trimmed = configuredBin.trim();
  if (trimmed.includes('/') || trimmed.includes('\\')) {
    return trimmed;
  }
  const searchDirs = [
    ...(process.env.PATH ? process.env.PATH.split(path.delimiter) : []),
    path.join(os.homedir(), '.local', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
  ];
  for (const dir of searchDirs) {
    if (!dir) {
      continue;
    }
    const candidate = path.join(dir, trimmed);
    if (fsSync.existsSync(candidate)) {
      return candidate;
    }
  }
  return trimmed;
}

/** 构造用于后台进程继承标准输入输出的 B 站扫码登录命令 */
export function buildBiliLoginCommand(
  ctx: CoreContext,
  settings: Settings = ctx.settings,
): { bin: string; args: string[] } {
  const bilibili = settings.publish.bilibili;
  const cliCfg = settings.clis[bilibili.cli];
  const bin = resolveBiliupExecutable(cliCfg?.bin ?? bilibili.cli);
  const cookieFile = path.resolve(ctx.paths.rootDir, bilibili.cookieFile);
  return {
    bin,
    args: [...(cliCfg?.extraArgs ?? []), '-u', cookieFile, 'login'],
  };
}

/** 构造执行 B 站视频投稿的 `biliup` 完整命令参数（强制携带 AI 生成内容声明标识） */
export function buildBiliupUploadArgs(opts: {
  cookieFile: string;
  copyright: 1 | 2;
  tid: number;
  title: string;
  description: string;
  tags: string[];
  coverFile: string;
  videoFile: string;
  dtimeUnixSec?: number;
}): string[] {
  const args = [
    '-u',
    opts.cookieFile,
    'upload',
    '--copyright',
    String(opts.copyright),
    '--tid',
    String(opts.tid),
    '--cover',
    opts.coverFile,
    '--title',
    opts.title,
    '--desc',
    opts.description,
    '--tag',
    opts.tags.join(','),
    '--extra-fields',
    BILIBILI_AI_DECLARATION_EXTRA_FIELDS,
  ];
  if (opts.dtimeUnixSec !== undefined) {
    args.push('--dtime', String(Math.floor(opts.dtimeUnixSec)));
  }
  args.push(opts.videoFile);
  return args;
}

/** 等待指定毫秒数，若收到外部取消信号则立即唤醒并抛出取消异常 */
async function sleepAbortable(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) {
    return;
  }
  if (signal?.aborted) {
    throw new DOMException('已取消', 'AbortError');
  }
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException('已取消', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** 校验执行发布动作所需的目标状态与本地成片及封面文件存在性 */
export async function assertReadyToUpload(opts: {
  ctx: CoreContext;
  runId: string;
  settings: Settings;
  allowedRunStatuses: readonly string[];
}): Promise<{
  title: string;
  description: string;
  tags: string[];
  videoFile: string;
  coverFile: string;
  cookieFile: string;
}> {
  const { ctx, runId, settings, allowedRunStatuses } = opts;
  const run = ctx.repos.runs.getById(runId);
  if (!run) {
    throw new Error(`未找到任务记录: ${runId}`);
  }
  if (run.status === 'publish_uncertain') {
    throw new PipelineError(
      'publish_uncertain',
      `任务 ${runId} 处于投稿状态不明保护，禁止自动重传，请先人工核对平台投稿结果后再确认`,
    );
  }
  if (!allowedRunStatuses.includes(run.status)) {
    throw new Error(`任务 ${runId} 当前状态为 ${run.status}，不允许发起本次投稿上传`);
  }

  const draft = await ensurePublishDraftForRun(ctx, runId, settings);
  if (!draft) {
    throw new PipelineError('publish_failed', `任务 ${runId} 缺少可发布的草稿或时间轴信息`);
  }
  if (draft.aiDeclaration !== true) {
    throw new Error('所有自动投稿必须强制开启 AI 生成内容声明');
  }

  const videoFile = path.resolve(ctx.paths.rootDir, draft.videoPath);
  const coverFile = path.resolve(ctx.paths.rootDir, draft.coverPath);
  const cookieFile = path.resolve(ctx.paths.rootDir, settings.publish.bilibili.cookieFile);

  await fs.access(videoFile);
  await fs.access(coverFile);

  return {
    title: draft.title,
    description: draft.description,
    tags: draft.tags,
    videoFile,
    coverFile,
    cookieFile,
  };
}

/** 将未完成或收到不明结果信号的投稿记录及任务状态原子切至状态不明保护，禁止自动重传 */
function markPublishUncertainAtomic(
  ctx: CoreContext,
  runId: string,
  errorDetail: string,
  eventMessage: string,
): void {
  const nowIso = ctx.now().toISOString();
  inTransaction(ctx.db, () => {
    const pub = ctx.repos.publish.getByRun(runId);
    if (pub) {
      ctx.repos.publish.updateStatus(runId, 'uncertain', {
        error: errorDetail,
        updatedAt: nowIso,
      });
    }
    ctx.repos.runs.updateStatus(runId, 'publish_uncertain', {
      currentStage: 'publish',
      errorCode: 'publish_uncertain',
      error: errorDetail,
      pid: null,
      finishedAt: nowIso,
    });
    emitRunEvent(ctx, {
      runId,
      level: 'warn',
      stage: 'publish',
      type: 'publish_uncertain',
      message: eventMessage,
    });
  });
}

/** 将明确确认未提交成功的投稿任务原子落盘为失败状态，保留草稿供后续人工重试 */
async function markPublishFailedAtomic(
  ctx: CoreContext,
  runId: string,
  settings: Settings,
  failMsg: string,
): Promise<void> {
  const failIso = ctx.now().toISOString();
  const deadlineIso = new Date(
    ctx.now().getTime() + settings.retry.reservationHoldHours * 3600_000,
  ).toISOString();

  inTransaction(ctx.db, () => {
    const pub = ctx.repos.publish.getByRun(runId);
    if (pub) {
      ctx.repos.publish.updateStatus(runId, 'failed', {
        error: failMsg,
        updatedAt: failIso,
      });
    }
    ctx.repos.runs.updateStatus(runId, 'publish_failed', {
      currentStage: 'publish',
      errorCode: 'publish_failed',
      error: failMsg,
      pid: null,
      finishedAt: failIso,
      retryDeadlineAt: deadlineIso,
    });
    emitRunEvent(ctx, {
      runId,
      level: 'error',
      stage: 'publish',
      type: 'publish_failed',
      message: `B 站投稿未完成：${failMsg}`,
    });
  });

  try {
    await ctx.notifier.notify({
      type: 'publish_failed',
      runId,
      message: `第 ${runId} 期 B 站发布失败：${failMsg}`,
      data: { error: failMsg },
    });
  } catch (notifyErr) {
    ctx.logger.warn({ err: notifyErr, runId }, '发送发布失败通知时出错');
  }
}

/**
 * 执行一期的 B 站投稿上传流程：
 * - 先持有全局互斥锁并在单事务内校验草稿、文件并切换 `runs` 与 `publish_records` 为投稿中状态，防止状态撕裂与并发竞争；
 * - 强制在投稿参数中开启 B 站平台 AI 生成内容声明；
 * - 仅对明确退出的失败执行最多 3 次退避重试；若命令超时、退出码为 0 却未解析出 BV 号或上传过程中被中止，
 *   均直接转入状态不明保护并禁止自动重传；
 * - 投稿成功后在单个事务内提交新闻消费记录、释放未入选预留文章并记录 BV 号；失败则转为明确可重传失败状态。
 */
export async function executeBilibiliUpload(opts: {
  ctx: CoreContext;
  runId: string;
  settings: Settings;
  allowedRunStatuses: readonly string[];
  alreadyLocked?: boolean;
  retryDelaysMs?: readonly number[];
  dtimeUnixSec?: number;
  signal?: AbortSignal;
}): Promise<{ bvid: string }> {
  const { ctx, runId, settings, allowedRunStatuses, alreadyLocked, dtimeUnixSec, signal } = opts;
  const retryDelaysMs = opts.retryDelaysMs ?? DEFAULT_UPLOAD_RETRY_DELAYS_MS;

  if (!alreadyLocked) {
    acquirePipelineLock(ctx, runId, settings);
  }

  const lockAbort = new AbortController();
  let lostLock = false;
  let hb: ReturnType<typeof startRunHeartbeat> | null = null;
  let enteredPublishingState = false;
  let committed = false;

  try {
    const payload = await assertReadyToUpload({
      ctx,
      runId,
      settings,
      allowedRunStatuses,
    });

    if (signal?.aborted) {
      throw new DOMException('已取消', 'AbortError');
    }

    await fs.mkdir(path.dirname(payload.cookieFile), { recursive: true });

    hb = startRunHeartbeat(ctx, runId, {
      onLockLost: () => {
        lostLock = true;
        lockAbort.abort();
      },
    });
    const combinedSignal = signal ? AbortSignal.any([signal, lockAbort.signal]) : lockAbort.signal;

    const bilibiliCfg = settings.publish.bilibili;
    const uploadArgs = buildBiliupUploadArgs({
      cookieFile: payload.cookieFile,
      copyright: bilibiliCfg.copyright,
      tid: bilibiliCfg.tid,
      title: payload.title,
      description: payload.description,
      tags: payload.tags,
      coverFile: payload.coverFile,
      videoFile: payload.videoFile,
      dtimeUnixSec,
    });

    const startIso = ctx.now().toISOString();
    inTransaction(ctx.db, () => {
      const current = ctx.repos.runs.getById(runId);
      if (!current) {
        throw new Error(`未找到任务记录: ${runId}`);
      }
      if (current.status === 'publish_uncertain') {
        throw new PipelineError(
          'publish_uncertain',
          `任务 ${runId} 处于投稿状态不明保护，禁止自动重传`,
        );
      }
      if (!allowedRunStatuses.includes(current.status)) {
        throw new Error(`任务 ${runId} 当前状态已变为 ${current.status}，中止本次上传`);
      }

      ctx.repos.runs.updateStatus(runId, 'publishing', {
        currentStage: 'publish',
        pid: process.pid,
        errorCode: null,
        error: null,
        heartbeatAt: startIso,
      });
      ctx.repos.publish.updateStatus(runId, 'publishing', {
        error: null,
        updatedAt: startIso,
      });
    });
    enteredPublishingState = true;

    emitRunEvent(ctx, {
      runId,
      level: 'info',
      stage: 'publish',
      type: 'publish_started',
      message: `开始向 B 站投稿《${payload.title}》（已强制开启 AI 生成内容声明）`,
      data: { aiDeclaration: true, tid: bilibiliCfg.tid },
    });

    let lastErr: Error | null = null;
    let lastAttemptFailedCleanly = false;
    let uploadedBvid: string | null = null;
    const totalAttempts = MAX_UPLOAD_RETRIES + 1;

    for (let attempt = 1; attempt <= totalAttempts; attempt++) {
      if (lostLock) {
        throw new PipelineError('interrupted', '运行锁已被其他进程接管，停止投稿上传');
      }
      if (combinedSignal.aborted) {
        if (lastAttemptFailedCleanly) {
          throw new PipelineError('publish_failed', '重试等待期间收到取消信号，已停止继续上传');
        }
        throw new DOMException('已取消', 'AbortError');
      }

      ctx.repos.publish.updateStatus(runId, 'publishing', {
        incrementAttempts: true,
        updatedAt: ctx.now().toISOString(),
      });

      const resolvedBin = resolveBiliupExecutable(
        settings.clis[bilibiliCfg.cli]?.bin ?? bilibiliCfg.cli,
      );
      const pathEntries = [
        path.dirname(resolvedBin),
        path.join(os.homedir(), '.local', 'bin'),
        '/opt/homebrew/bin',
        process.env.PATH ?? '',
      ].filter(Boolean);

      try {
        const res = await ctx.bridge.exec(bilibiliCfg.cli, uploadArgs, {
          cwd: ctx.paths.rootDir,
          env: { PATH: Array.from(new Set(pathEntries)).join(path.delimiter) },
          timeoutMs: 600_000,
          signal: combinedSignal,
        });

        if (res.exitCode !== 0) {
          lastAttemptFailedCleanly = true;
          throw new Error(
            `biliup 上传退出码 ${res.exitCode}: ${(res.stderr || res.stdout).trim().slice(0, 500)}`,
          );
        }

        const parsedBvid = parseBvidFromOutput(res.stdout, res.stderr);
        if (!parsedBvid) {
          lastAttemptFailedCleanly = false;
          throw new PipelineError(
            'publish_uncertain',
            `biliup 返回成功退出码 0 但未能解析出有效 BV 号，请先到 B 站核对是否已收稿（输出: ${(res.stdout || res.stderr).trim().slice(0, 300)}）`,
          );
        }

        uploadedBvid = parsedBvid;
        break;
      } catch (err) {
        if (lostLock) {
          throw new PipelineError('interrupted', '运行锁已被其他进程接管，停止投稿上传', {
            cause: err,
          });
        }
        if (err instanceof PipelineError && err.code === 'publish_uncertain') {
          lastAttemptFailedCleanly = false;
          throw err;
        }
        if (err instanceof Error && err.name === 'CliTimeoutError') {
          lastAttemptFailedCleanly = false;
          throw new PipelineError(
            'publish_uncertain',
            'biliup 上传等待超时，无法确认平台是否已收到稿件，禁止自动重传',
            { cause: err },
          );
        }
        if (err instanceof Error && err.name === 'AbortError') {
          lastAttemptFailedCleanly = false;
          throw err;
        }

        lastAttemptFailedCleanly = true;
        lastErr = err instanceof Error ? err : new Error(String(err));
        if (attempt < totalAttempts) {
          const delayMs = retryDelaysMs[Math.min(attempt - 1, retryDelaysMs.length - 1)] ?? 10_000;
          emitRunEvent(ctx, {
            runId,
            level: 'warn',
            stage: 'publish',
            type: 'publish_retrying',
            message: `B 站上传第 ${attempt} 次尝试失败（${lastErr.message}），将在 ${Math.round(delayMs / 1000)} 秒后重试`,
          });
          try {
            await sleepAbortable(delayMs, combinedSignal);
          } catch (sleepErr) {
            if (lostLock) {
              throw new PipelineError('interrupted', '运行锁已被其他进程接管，停止投稿上传', {
                cause: sleepErr,
              });
            }
            if (sleepErr instanceof Error && sleepErr.name === 'AbortError') {
              throw new PipelineError('publish_failed', '重试等待期间收到取消信号，已停止重传', {
                cause: sleepErr,
              });
            }
            throw sleepErr;
          }
        }
      }
    }

    if (!uploadedBvid) {
      const failMsg = lastErr?.message ?? 'B 站视频上传失败';
      await markPublishFailedAtomic(ctx, runId, settings, failMsg);
      throw new PipelineError('publish_failed', failMsg, { cause: lastErr });
    }

    if (lostLock) {
      throw new PipelineError('interrupted', '运行锁已被其他进程接管，禁止提交发布结果');
    }

    const doneIso = ctx.now().toISOString();
    const stats = commitRunConsumption(
      ctx,
      runId,
      doneIso,
      () => {
        ctx.repos.publish.updateStatus(runId, 'published', {
          bvid: uploadedBvid,
          error: null,
          updatedAt: doneIso,
        });
        ctx.repos.runs.updateStatus(runId, 'published', {
          currentStage: 'publish',
          pid: null,
          finishedAt: doneIso,
          errorCode: null,
          error: null,
          retryDeadlineAt: null,
        });
      },
      { expectedRunStatuses: ['publishing'] },
    );
    committed = true;

    emitRunEvent(ctx, {
      runId,
      level: 'info',
      stage: 'publish',
      type: 'run_published',
      message: `B 站投稿成功（BV 号：${uploadedBvid}），已消耗 ${stats.consumedArticleCount} 篇文章并释放 ${stats.releasedUnusedCount} 篇未用文章`,
      data: { bvid: uploadedBvid, ...stats, aiDeclaration: true },
    });

    try {
      await ctx.notifier.notify({
        type: 'published',
        runId,
        message: `第 ${runId} 期已成功发布至 B 站（${uploadedBvid}）`,
        data: { bvid: uploadedBvid },
      });
    } catch (notifyErr) {
      ctx.logger.warn({ err: notifyErr, runId, bvid: uploadedBvid }, '发送发布成功通知时出错');
    }

    return { bvid: uploadedBvid };
  } catch (err) {
    if (committed) {
      return { bvid: ctx.repos.publish.getByRun(runId)?.bvid ?? '' };
    }
    if (lostLock) {
      throw new PipelineError('interrupted', '运行锁已被其他进程接管，停止投稿上传', {
        cause: err,
      });
    }
    if (enteredPublishingState) {
      const isUncertain =
        (err instanceof PipelineError && err.code === 'publish_uncertain') ||
        (err instanceof Error && err.name === 'AbortError');
      if (isUncertain) {
        const msg =
          err instanceof Error
            ? err.message
            : '投稿过程无法确认平台是否已收稿，已进入状态不明保护，禁止自动重传';
        markPublishUncertainAtomic(
          ctx,
          runId,
          msg,
          `投稿过程无法确认平台结果（${msg}），已转为状态不明等待人工核对`,
        );
        if (err instanceof PipelineError) {
          throw err;
        }
        throw new PipelineError('publish_uncertain', '投稿过程中止，请人工核对是否已收稿', {
          cause: err,
        });
      }

      if (!(err instanceof PipelineError && err.code === 'publish_failed')) {
        const errMsg = err instanceof Error ? err.message : String(err);
        await markPublishFailedAtomic(ctx, runId, settings, errMsg);
        throw new PipelineError('publish_failed', errMsg, { cause: err });
      }
    }
    throw err;
  } finally {
    hb?.stop();
    if (!alreadyLocked && !lostLock) {
      releasePipelineLock(ctx, runId);
    }
  }
}
