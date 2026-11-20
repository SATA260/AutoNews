import crypto from 'node:crypto';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  type Article,
  type ArticleMediaAsset,
  type HostMascotId,
  HostMascotIdSchema,
  type ItemVersion,
  type LlmCallRecord,
  MEDIA_ADJUSTABLE_RUN_STATUSES,
  type NarrationSectionView,
  PIPELINE_STAGES,
  RETRYABLE_RUN_STATUSES,
  type RetryOptions,
  type RunDetail,
  RunDetailSchema,
  type RunEvent,
  type RunStatus,
  type RunSummary,
  RunSummarySchema,
  type SelectedMediaOverride,
  SettingsSchema,
  type Stage,
  type Trigger,
} from '@aidaily/contracts';
import { TZDate } from '@date-fns/tz';
import type { CoreContext } from '../context.js';
import type { EditSubStep } from '../editorial/item-pipeline.js';
import { collectEventMediaPool, loadEventArticles } from '../editorial/s3-summarize.js';
import { NotFoundError } from '../errors.js';
import { listBgmFiles } from '../media/bgm.js';
import {
  listNarrationSectionViews,
  resetSingleSectionNarration,
  updateSingleSectionNarration,
} from '../media/narration.js';
import { resolveSafeArtifactPath } from '../paths.js';
import { inTransaction } from '../storage/db.js';
import { readJsonOrNull, writeFileAtomic } from '../storage/files.js';
import { spawnDetachedWorker } from '../worker/spawn.js';
import { emitRunEvent } from '../workflow/events.js';
import {
  assertPipelineLockAvailable,
  LockBusyError,
  PIPELINE_LOCK_NAME,
  reservePipelineLockForChild,
} from '../workflow/lock.js';
import {
  abandonRun,
  cancelRun,
  createRun,
  executeRun,
  getRunRetryOptions,
  resumeRun,
  retryRunItems,
} from '../workflow/runner.js';

/** 带有正文原文内容的新闻文章详情，用于管理后台核对出处与原稿 */
export interface RunArticleWithContent extends Article {
  contentText: string | null;
}

/** 任务候选视觉素材及其在当期任务目录中的安全访问相对路径 */
export interface RunItemMediaCandidate extends ArticleMediaAsset {
  artifactRelPath: string;
}

/** 修改单条新闻配图或候选图槽位的输入参数（每条新闻固定最多展示 1 张配图） */
export interface SetItemImageInput {
  mode: 'auto' | 'none' | 'custom';
  data?: Uint8Array;
  secondaryData?: Uint8Array;
  selectedPrimaryMediaId?: string;
  selectedSecondaryMediaId?: string;
  clearSecondary?: boolean;
  caption?: string;
}

/** 启动单期生成任务的可选参数 */
export interface TaskStartOptions {
  itemCount: number;
  notBeforeAt?: string | null;
  hostId?: HostMascotId;
  bgmFile?: string;
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
  /** 列出可用于新任务的背景音乐。 */
  listBgm(): Promise<string[]>;
  /** 查询最近一次成功投稿或本地完结发版的时间戳（无历史记录时返回 null） */
  getLatestPublishedAt(): Promise<string | null>;
  /** 读取某期任务各条新闻可用的多模态候选素材列表，并将文件暂存到任务目录以供页面安全预览 */
  getRunMediaCandidates(runId: string): Promise<Record<string, RunItemMediaCandidate[]>>;
  /** 修改配图或主副候选图选择。待试听、待审核、已驳回、发布失败和已完成的任务都可以改 */
  setItemImage(runId: string, itemId: string, input: SetItemImageInput): Promise<void>;
  /** 修改背景音乐。待试听、待审核、已驳回、发布失败和已完成的任务都可以改 */
  setBgm(runId: string, bgmFile: string): Promise<void>;
  /** 读取每一段当前的语音文本、字幕文本和音频，供页面编辑 */
  getNarrationSections(runId: string): Promise<NarrationSectionView[]>;
  /** 保存某一段的语音文本和字幕，并按需要只重做这一段音频 */
  updateSectionNarration(
    runId: string,
    sectionKey: string,
    input: unknown,
  ): Promise<NarrationSectionView>;
  /** 取消某一段的人工修改，按原稿重新生成这一段音频 */
  resetSectionNarration(runId: string, sectionKey: string): Promise<NarrationSectionView>;
  /** 创建并启动新一期视频生产任务（新闻条数必须显式指定为正整数） */
  start(opts: TaskStartOptions): Promise<{ runId: string }>;
  /** 恢复中断或失败的任务，或指定从某个历史步骤重新向后运行 */
  resume(runId: string, opts?: TaskResumeOptions): Promise<void>;
  /** 对指定期次中的某一条新闻单独重新生成或重新核查，并自动重新编排合成 */
  retryItem(runId: string, itemId: string, opts?: TaskRetryItemOptions): Promise<void>;
  /** 对指定期次中的一条或多条新闻批量并发重做或重审，全部完成后统一重新编排合成 */
  retryItems(runId: string, itemIds: string[], opts?: TaskRetryItemOptions): Promise<void>;
  /** 查询某期任务当前允许的恢复入口及重试截止时间 */
  getRetryOptions(runId: string): Promise<RetryOptions>;
  /** 主动放弃未完结的任务，释放它占用的新闻文章回到待选库 */
  abandon(runId: string): Promise<void>;
  /** 发出取消请求以安全停止正在执行中的任务 */
  cancel(runId: string): Promise<void>;
  /** 分页或按状态筛选查询历史任务摘要列表 */
  list(q?: { status?: RunStatus[]; limit?: number; before?: string }): Promise<RunSummary[]>;
  /** 仅读取单期任务的核心状态摘要，不加载明细条目和扫描磁盘产物目录 */
  getSummary(runId: string): Promise<RunSummary>;
  /** 读取单期任务的完整执行详情、阶段进度、新闻条目、投稿记录及可选产物清单 */
  get(runId: string, opts?: { includeArtifacts?: boolean }): Promise<RunDetail>;
  /** 查询单条新闻在写作、预检与核查过程中的全部历史版本快照 */
  getItemHistory(itemId: string): Promise<ItemVersion[]>;
  /** 查询指定任务期间产生的全部外部模型调用耗时、用量及日志索引 */
  getLlmCalls(runId: string): Promise<LlmCallRecord[]>;
  /** 按自增事件编号增量拉取任务日志事件 */
  events(runId: string, afterId?: number, limit?: number): Promise<RunEvent[]>;
  /** 仅获取某期任务最近 N 条运行日志（按正序返回），避免全量拉取 */
  recentEvents(runId: string, limit?: number): Promise<RunEvent[]>;
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

  /** 递归遍历当前目录及子目录并将文件相对路径写入结果列表 */
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
    case 'awaiting_audio_review':
      return true;
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

/** 启动后台重试，在任务状态和轮次仍匹配时把锁交给子进程 */
async function startDetachedRetry(
  ctx: CoreContext,
  runId: string,
  args: string[],
  expectedRun: { status: RunStatus; attempt: number },
): Promise<void> {
  await spawnDetachedWorker(args, {
    rootDir: ctx.paths.rootDir,
    logFile: path.join(ctx.paths.runDir(runId), 'worker.log'),
    retryReservation: {
      /** 核对提交时的任务状态与轮次后锁定本次启动 */
      reserve(pid) {
        reservePipelineLockForChild(
          ctx,
          runId,
          pid,
          (current) =>
            current?.status === expectedRun.status && current.attempt === expectedRun.attempt,
          { required: true },
        );
      },
      /** 启动失败时仅释放对应子进程的锁 */
      release(pid) {
        ctx.repos.locks.releaseLock(PIPELINE_LOCK_NAME, runId, pid);
      },
    },
  });
}

/** 查询最近一次成功发版或投稿提交的 UTC 时间戳 */
export function getLatestPublishedAt(ctx: CoreContext): string | null {
  const histRow = ctx.db.prepare('SELECT MAX(published_at) AS ts FROM published_history').get() as
    | { ts: string | null }
    | undefined;
  if (histRow?.ts) {
    return histRow.ts;
  }
  const runRow = ctx.db
    .prepare(
      "SELECT COALESCE(finished_at, created_at) AS ts FROM runs WHERE status = 'published' ORDER BY COALESCE(finished_at, created_at) DESC LIMIT 1",
    )
    .get() as { ts: string | null } | undefined;
  return runRow?.ts ?? null;
}

/** 解析在指定时区下的 YYYY-MM-DD HH:mm(:ss) 本地时间并转换为毫秒时间戳，校验日历有效性 */
function parseLocalDateTimeInTz(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  timezone: string,
  rawLabel: string,
): number {
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) {
    throw new RangeError(`最早新闻时间「${rawLabel}」日期或时刻超出合法范围`);
  }
  const tzDate = new TZDate(year, month - 1, day, hour, minute, second, 0, timezone);
  if (
    tzDate.getFullYear() !== year ||
    tzDate.getMonth() !== month - 1 ||
    tzDate.getDate() !== day ||
    tzDate.getHours() !== hour ||
    tzDate.getMinutes() !== minute
  ) {
    throw new RangeError(`最早新闻时间「${rawLabel}」不是有效的日历时间`);
  }
  return tzDate.getTime();
}

/**
 * 将网页、命令行或定时任务传入的最早新闻时间表达式统一解析为 UTC ISO 字符串：
 * 支持 `last-published`、`today`、`12h`/`24h`/`48h`、`YYYY-MM-DD`、`YYYY-MM-DD HH:mm` 及带时区 ISO 字符串。
 */
export function resolveNotBeforeInput(
  ctx: CoreContext,
  raw: string | null | undefined,
  opts?: { trigger?: Trigger; scheduleId?: string },
): string | null {
  const trimmed = raw?.trim() ?? '';
  const nowMs = ctx.now().getTime();
  const tz = ctx.settings.timezone;

  if (!trimmed || trimmed === 'none') {
    if (opts?.trigger === 'schedule' && opts.scheduleId) {
      const schedule = ctx.repos.schedules.getById(opts.scheduleId);
      if (!schedule) {
        return null;
      }
      if (schedule.cutoffMode === 'since_last_published') {
        return getLatestPublishedAt(ctx);
      }
      if (
        schedule.cutoffMode === 'hours' &&
        typeof schedule.maxAgeHours === 'number' &&
        schedule.maxAgeHours > 0
      ) {
        return new Date(nowMs - schedule.maxAgeHours * 3600_000).toISOString();
      }
    }
    return null;
  }

  let parsedMs: number;
  const lower = trimmed.toLowerCase();

  if (lower === 'last-published' || lower === 'since_last_published') {
    const latest = getLatestPublishedAt(ctx);
    if (!latest) {
      throw new RangeError(
        '尚无历史已发布记录，无法使用「上次发布后」作为最早时间，请改选具体时间或近 24 小时',
      );
    }
    parsedMs = Date.parse(latest);
  } else if (lower === 'today') {
    const tzNow = new TZDate(nowMs, tz);
    parsedMs = new TZDate(
      tzNow.getFullYear(),
      tzNow.getMonth(),
      tzNow.getDate(),
      0,
      0,
      0,
      0,
      tz,
    ).getTime();
  } else if (/^([1-9]\d*)h$/i.test(trimmed)) {
    const hours = Number.parseInt(trimmed.slice(0, -1), 10);
    if (!Number.isSafeInteger(hours) || hours <= 0 || hours > 24 * 365) {
      throw new RangeError(`相对小时参数超出有效范围: ${trimmed}`);
    }
    parsedMs = nowMs - hours * 3600_000;
  } else {
    const dateOnlyMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
    const localDtMatch =
      /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?$/.exec(trimmed);
    if (dateOnlyMatch) {
      parsedMs = parseLocalDateTimeInTz(
        Number(dateOnlyMatch[1]),
        Number(dateOnlyMatch[2]),
        Number(dateOnlyMatch[3]),
        0,
        0,
        0,
        tz,
        trimmed,
      );
    } else if (localDtMatch) {
      parsedMs = parseLocalDateTimeInTz(
        Number(localDtMatch[1]),
        Number(localDtMatch[2]),
        Number(localDtMatch[3]),
        Number(localDtMatch[4]),
        Number(localDtMatch[5]),
        Number(localDtMatch[6] ?? 0),
        tz,
        trimmed,
      );
    } else if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(trimmed)) {
      parsedMs = Date.parse(trimmed);
    } else {
      throw new RangeError(
        `无法识别的最早时间格式「${trimmed}」，支持 12h / 24h / 48h / today / last-published / YYYY-MM-DD / YYYY-MM-DD HH:mm 或 ISO 时间`,
      );
    }
  }

  if (!Number.isFinite(parsedMs)) {
    throw new RangeError(`最早新闻时间无效: ${trimmed}`);
  }
  if (parsedMs > nowMs + 60_000) {
    throw new RangeError('最早新闻时间不能晚于当前时间');
  }
  return new Date(parsedMs).toISOString();
}

/** 校验上传图片字节流并原子写入任务自定义素材目录，返回相对任务目录的路径 */
async function saveCustomUploadedImage(runDir: string, bytes: Uint8Array): Promise<string> {
  if (bytes.length < 12) {
    throw new Error('图片内容过小或格式无效');
  }
  if (bytes.length > 10 * 1024 * 1024) {
    throw new Error('图片大小须在 10 MB 以内');
  }
  const data = Buffer.from(bytes);
  const extension = data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    ? 'png'
    : data[0] === 255 && data[1] === 216 && data[2] === 255
      ? 'jpg'
      : data.subarray(0, 4).toString('ascii') === 'RIFF' &&
          data.subarray(8, 12).toString('ascii') === 'WEBP'
        ? 'webp'
        : null;
  if (!extension) {
    throw new Error('图片必须是 PNG、JPEG 或 WebP');
  }
  const relative = path.posix.join('custom-assets', `${crypto.randomUUID()}.${extension}`);
  await writeFileAtomic(path.join(runDir, relative), data);
  return relative;
}

/** 创建任务管理服务，供命令行和网页后台管理任务、监听事件和读取产物 */
export function createTaskService(ctx: CoreContext): TaskService {
  return {
    /** 列出背景音乐文件。 */
    async listBgm() {
      return listBgmFiles(ctx);
    },
    /** 查询最近一次成功发版或投稿的时间戳 */
    async getLatestPublishedAt() {
      return getLatestPublishedAt(ctx);
    },
    /** 读取各条新闻的多模态候选配图与截图列表，并复制到当期任务安全访问目录 */
    async getRunMediaCandidates(runId) {
      if (!ctx.repos.runs.getById(runId)) {
        throw new Error(`未找到任务记录: ${runId}`);
      }
      const events = ctx.repos.events.listByRun(runId);
      const eventById = new Map(events.map((ev) => [ev.id, ev]));
      const items = ctx.repos.runItems.listByRun(runId);
      const runDir = ctx.paths.runDir(runId);
      const result: Record<string, RunItemMediaCandidate[]> = {};

      for (const item of items) {
        const ev = eventById.get(item.eventId);
        if (!ev) {
          result[item.id] = [];
          continue;
        }
        const articles = await loadEventArticles(ctx, ev).catch(() => new Map());
        const pool = collectEventMediaPool(articles);
        const candidates: RunItemMediaCandidate[] = [];
        for (const asset of pool) {
          const safeSrc = resolveRealPathInsideDir(
            ctx.paths.rootDir,
            ctx.paths.imagesDir,
            asset.imagePath,
          );
          if (!safeSrc) {
            continue;
          }
          const ext = path.extname(safeSrc).toLowerCase() || '.png';
          const safeId = asset.id.replace(/[^a-zA-Z0-9._-]/g, '_');
          const relDest = path.posix.join('candidates', `${safeId}${ext}`);
          const absDest = path.join(runDir, relDest);
          const alreadyStaged = await fs
            .stat(absDest)
            .then((st) => st.isFile() && st.size > 0)
            .catch(() => false);
          if (!alreadyStaged) {
            const buf = await fs.readFile(safeSrc);
            await writeFileAtomic(absDest, buf);
          }
          candidates.push({ ...asset, artifactRelPath: relDest });
        }
        result[item.id] = candidates;
      }

      return result;
    },
    /** 保存唯一配图选择或本地上传图片并更新条目设置（每条新闻仅展示 1 张图片）。 */
    async setItemImage(runId, itemId, input) {
      const runStatus = ctx.repos.runs.getById(runId)?.status;
      if (!runStatus || !MEDIA_ADJUSTABLE_RUN_STATUSES.includes(runStatus))
        throw new Error('当前任务状态不允许修改配图');
      const item = ctx.repos.runItems.getById(itemId);
      if (!item || item.runId !== runId || item.status !== 'passed')
        throw new Error('未找到本期已通过的新闻条目');
      if (!['auto', 'none', 'custom'].includes(input.mode)) throw new Error('图片模式无效');

      const nextCaption =
        input.caption !== undefined
          ? input.caption.trim() || null
          : (item.customImageCaption ?? null);
      if (nextCaption && Array.from(nextCaption).length > 44) {
        throw new Error('图片说明最多 44 字');
      }

      const runDir = ctx.paths.runDir(runId);
      const writtenCustomFiles: string[] = [];
      let nextCustomPrimary: string | null = null;
      let nextSelectedIds: SelectedMediaOverride | null = null;

      if (input.mode === 'custom') {
        const events = ctx.repos.events.listByRun(runId);
        const ev = events.find((e) => e.id === item.eventId);
        const loadedArticles = ev
          ? await loadEventArticles(ctx, ev).catch(() => new Map())
          : new Map();
        const validMediaIds = new Set(collectEventMediaPool(loadedArticles).map((m) => m.id));

        nextCustomPrimary = item.customImagePath ?? null;
        const baseSelectedPrimary =
          item.selectedMediaIds?.primary ??
          (item.imageMode === 'auto' &&
          item.finalJson?.primaryMediaId &&
          validMediaIds.has(item.finalJson.primaryMediaId)
            ? item.finalJson.primaryMediaId
            : undefined);

        let selectedPrimary = nextCustomPrimary ? undefined : baseSelectedPrimary;

        // 每条新闻仅保留单张配图；若旧调用方未传主图只传了副图参数则将其视为唯一主图
        const uploadedData =
          input.data ?? (!input.selectedPrimaryMediaId ? input.secondaryData : undefined);
        const candidateMediaId =
          input.selectedPrimaryMediaId !== undefined
            ? input.selectedPrimaryMediaId
            : !input.data &&
                input.selectedSecondaryMediaId !== undefined &&
                input.selectedSecondaryMediaId.trim()
              ? input.selectedSecondaryMediaId
              : undefined;

        if (uploadedData) {
          const uploadedPrimary = await saveCustomUploadedImage(runDir, uploadedData);
          writtenCustomFiles.push(uploadedPrimary);
          nextCustomPrimary = uploadedPrimary;
          selectedPrimary = undefined;
        } else if (candidateMediaId !== undefined) {
          const trimmedId = candidateMediaId.trim();
          if (!trimmedId || !validMediaIds.has(trimmedId)) {
            throw new Error(`未找到该新闻对应的候选配图: ${candidateMediaId}`);
          }
          selectedPrimary = trimmedId;
          nextCustomPrimary = null;
        }

        if (!nextCustomPrimary && !selectedPrimary) {
          throw new Error('请选择或上传至少一张配图');
        }

        nextSelectedIds = selectedPrimary ? { primary: selectedPrimary } : null;
      }

      try {
        inTransaction(ctx.db, () => {
          const result = ctx.db
            .prepare(
              `UPDATE run_items
               SET image_mode = ?,
                   custom_image_path = ?,
                   secondary_custom_image_path = NULL,
                   selected_media_ids = ?,
                   custom_image_caption = ?,
                   updated_at = ?
               WHERE id = ? AND run_id = ?
                 AND EXISTS (SELECT 1 FROM runs WHERE id = ? AND status IN (${MEDIA_ADJUSTABLE_RUN_STATUSES.map(() => '?').join(', ')}))`,
            )
            .run(
              input.mode,
              nextCustomPrimary,
              nextSelectedIds ? JSON.stringify(nextSelectedIds) : null,
              nextCaption,
              ctx.now().toISOString(),
              itemId,
              runId,
              runId,
              ...MEDIA_ADJUSTABLE_RUN_STATUSES,
            );
          if (Number(result.changes) !== 1) throw new Error('任务状态已改变，请刷新后重试');
          ctx.db.prepare('UPDATE runs SET media_dirty = 1 WHERE id = ?').run(runId);
          ctx.repos.runStages.markStaleFrom(runId, ['render', 'qa']);
        });
      } catch (error) {
        for (const rel of writtenCustomFiles) {
          await fs.rm(path.join(runDir, rel), { force: true }).catch(() => undefined);
        }
        throw error;
      }
    },
    /** 锁定新的背景音乐。 */
    async setBgm(runId, bgmFile) {
      if (!(await listBgmFiles(ctx)).includes(bgmFile)) throw new Error('指定的背景音乐不在曲库中');
      inTransaction(ctx.db, () => {
        const result = ctx.db
          .prepare(
            `UPDATE runs SET bgm_file = ?, media_dirty = 1 WHERE id = ? AND status IN (${MEDIA_ADJUSTABLE_RUN_STATUSES.map(() => '?').join(', ')})`,
          )
          .run(bgmFile, runId, ...MEDIA_ADJUSTABLE_RUN_STATUSES);
        if (Number(result.changes) !== 1) throw new Error('当前任务状态不允许修改背景音乐');
        ctx.repos.runStages.markStaleFrom(runId, ['render', 'qa']);
      });
    },
    /** 启动新一期生产任务：校验条数必填、查锁排重，并支持前台直跑或分离至后台工作进程 */
    async start(opts: TaskStartOptions): Promise<{ runId: string }> {
      if (!Number.isInteger(opts?.itemCount) || opts.itemCount <= 0) {
        throw new RangeError(
          `每期新闻条数 itemCount 必须显式指定为正整数，当前传入: ${String(opts?.itemCount)}`,
        );
      }

      if (opts.hostId !== undefined) HostMascotIdSchema.parse(opts.hostId);
      if (opts.bgmFile !== undefined && !(await listBgmFiles(ctx)).includes(opts.bgmFile))
        throw new Error('指定的背景音乐不在曲库中');
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

      // 每次启动新任务前重新读取磁盘配置与信源清单，防止常驻服务持有旧内存配置生成过期快照
      await ctx.reloadConfig();

      const resolvedNotBeforeAt = resolveNotBeforeInput(ctx, opts.notBeforeAt, {
        trigger,
        scheduleId: opts.scheduleId,
      });

      const runId = inTransaction(ctx.db, () => {
        const createdId = createRun(ctx, {
          itemCount: opts.itemCount,
          notBeforeAt: resolvedNotBeforeAt,
          hostId: opts.hostId,
          bgmFile: opts.bgmFile,
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
      const run = ctx.repos.runs.getById(runId);
      if (!run) {
        throw new Error(`未找到任务记录: ${runId}`);
      }
      const retryOpts = getRunRetryOptions(ctx, runId);
      if (!retryOpts.resumable) {
        throw new Error(`任务 ${runId} 当前状态为 ${run.status}，不允许继续或重跑`);
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
        const args = ['--root', ctx.paths.rootDir, '--action', 'resume', '--run-id', runId];
        if (opts.fromStage) {
          args.push('--from', opts.fromStage);
        }
        if (opts.useLatestConfig) {
          args.push('--latest-config');
        }
        await startDetachedRetry(ctx, runId, args, run);
        return;
      }

      await resumeRun(ctx, runId, {
        fromStage: opts?.fromStage,
        useLatestConfig: opts?.useLatestConfig,
      });
    },

    /** 单独重跑某期任务中的一条新闻并自动向后重新编排与合成成片 */
    async retryItem(runId: string, itemId: string, opts?: TaskRetryItemOptions): Promise<void> {
      return this.retryItems(runId, [itemId], opts);
    },

    /** 批量并发重跑某期任务中的一条或多条新闻，完成后统一向后重新编排与合成成片 */
    async retryItems(runId: string, itemIds: string[], opts?: TaskRetryItemOptions): Promise<void> {
      const uniqueItemIds = Array.from(new Set(itemIds.map((id) => id.trim()).filter(Boolean)));
      if (uniqueItemIds.length === 0) {
        throw new Error('请至少指定一条需要重做的新闻条目');
      }

      const run = ctx.repos.runs.getById(runId);
      if (!run) {
        throw new Error(`未找到任务记录: ${runId}`);
      }
      if (!RETRYABLE_RUN_STATUSES.includes(run.status)) {
        throw new Error(`任务 ${runId} 当前状态为 ${run.status}，不允许重试新闻条目`);
      }

      const stageRecs = ctx.repos.runStages.listByRun(runId);
      const selectRec = stageRecs.find((s) => s.stage === 'select');
      if (selectRec?.status !== 'done') {
        throw new Error(`任务 ${runId} 尚未完成选题阶段，无法重试新闻条目`);
      }

      for (const itemId of uniqueItemIds) {
        const item = ctx.repos.runItems.getById(itemId);
        if (!item || item.runId !== runId) {
          throw new Error(`任务 ${runId} 中未找到新闻条目: ${itemId}`);
        }
      }

      assertPipelineLockAvailable(ctx);

      if (opts?.detach) {
        const args = ['--root', ctx.paths.rootDir, '--action', 'retry-item', '--run-id', runId];
        for (const itemId of uniqueItemIds) {
          args.push('--item-id', itemId);
        }
        if (opts.fromStep) {
          args.push('--from', opts.fromStep);
        }
        if (opts.useLatestConfig) {
          args.push('--latest-config');
        }
        await startDetachedRetry(ctx, runId, args, run);
        return;
      }

      await retryRunItems(ctx, runId, uniqueItemIds, {
        fromStep: opts?.fromStep,
        useLatestConfig: opts?.useLatestConfig,
      });
    },

    /** 读取每一段当前的语音文本、字幕文本和音频 */
    async getNarrationSections(runId) {
      if (!ctx.repos.runs.getById(runId)) {
        throw new NotFoundError(`未找到任务记录: ${runId}`);
      }
      return listNarrationSectionViews(ctx, runId);
    },

    /** 保存某一段配音或字幕修改 */
    async updateSectionNarration(runId, sectionKey, input) {
      return updateSingleSectionNarration(ctx, runId, sectionKey, input);
    },

    /** 恢复某一段原稿并重新配音 */
    async resetSectionNarration(runId, sectionKey) {
      return resetSingleSectionNarration(ctx, runId, sectionKey);
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

    /** 仅查询单期任务摘要，避免走全量详情与磁盘目录递归 */
    async getSummary(runId: string): Promise<RunSummary> {
      const run = ctx.repos.runs.getById(runId);
      if (!run) {
        throw new NotFoundError(`未找到任务记录: ${runId}`);
      }
      return RunSummarySchema.parse(run);
    },

    /** 组装并返回单期任务的完整详情及可选磁盘产物路径列表 */
    async get(runId: string, getOpts?: { includeArtifacts?: boolean }): Promise<RunDetail> {
      const run = ctx.repos.runs.getById(runId);
      if (!run) {
        throw new NotFoundError(`未找到任务记录: ${runId}`);
      }

      const stages = ctx.repos.runStages.listByRun(runId);
      const events = ctx.repos.events.listByRun(runId);
      const items = ctx.repos.runItems.listByRun(runId);
      const publishRecord = ctx.repos.publish.getByRun(runId);
      const artifacts =
        getOpts?.includeArtifacts === false
          ? []
          : await collectRelativeArtifactPaths(ctx.paths.runDir(runId));

      return RunDetailSchema.parse({
        id: run.id,
        trigger: run.trigger,
        scheduleId: run.scheduleId,
        status: run.status,
        currentStage: run.currentStage,
        itemCount: run.itemCount,
        notBeforeAt: run.notBeforeAt ?? null,
        hostId: run.hostId,
        bgmFile: run.bgmFile,
        mediaDirty: run.mediaDirty,
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

    /** 仅查询某期任务末尾最近 N 条运行日志（按时间正序） */
    async recentEvents(runId: string, limit = 500): Promise<RunEvent[]> {
      if (!ctx.repos.runs.getById(runId)) {
        throw new NotFoundError(`未找到任务记录: ${runId}`);
      }
      return ctx.repos.runEvents.listRecent(runId, limit);
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
        throw new NotFoundError(`未找到任务记录: ${runId}`);
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
