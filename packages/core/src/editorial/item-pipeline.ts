import path from 'node:path';
import type {
  ContentLimits,
  EventRecord,
  FactCheckResult,
  PolishedItem,
  RunItemRecord,
  Settings,
  SummaryDraft,
} from '@aidaily/contracts';
import pLimit from 'p-limit';
import type { CoreContext } from '../context.js';
import { PipelineError } from '../errors.js';
import { resolvePersonaBgmFile } from '../media/bgm.js';
import { readJsonOrNull, writeJsonAtomic } from '../storage/files.js';
import { normalizeStoredPolishedItem } from '../storage/repos/editorial-repo.js';
import {
  buildExtraTextByEventId,
  chooseHost,
  findPreviousHostId,
  getRunPersona,
  loadPersonas,
} from './personas.js';
import { type PrecheckResult, precheckPolishedItem } from './prechecks.js';
import { runRefillRound } from './refill.js';
import { loadEventArticles, summarizeEventItem } from './s3-summarize.js';
import { polishItemDraft, resolveContentLimits, revisePolishedItem } from './s4-polish.js';
import { factCheckPolishedItem } from './s5-factcheck.js';

/** 采编与核查阶段完成后的检查点产物 */
export interface EditCheckpoint {
  passedItemIds: string[];
  droppedItemIds: string[];
}

/** 单条新闻人工指定重试时的起始子步骤 */
export type EditSubStep = 'summarize' | 'polish' | 'factcheck';

/** 单条新闻从特定步骤重做时持久化的基线记录，保障中途崩溃后续跑不会退回旧版本 */
export interface PendingItemRetryState {
  fromStep: EditSubStep;
  baselineVersionId: number;
}

/** 采编阶段的版本起点记录与单条重试断点文件结构 */
export interface EditWatermarkData {
  versionFloorByItemId?: Record<string, number>;
  pendingRetryByItemId?: Record<string, PendingItemRetryState>;
}

const MAX_LOCAL_PRECHECK_FIXES_PER_ROUND = 2;

const watermarkWriteQueues = new Map<string, Promise<void>>();

/** 按运行目录串行安全更新 `edit-watermark.json`，避免多条新闻并发结束时互相覆盖 */
export async function updateEditWatermark(
  runDir: string,
  updater: (prev: EditWatermarkData) => EditWatermarkData,
): Promise<EditWatermarkData> {
  const filePath = path.join(runDir, 'edit-watermark.json');
  const prevChain = watermarkWriteQueues.get(runDir) ?? Promise.resolve();
  let result: EditWatermarkData = {};
  const nextChain = prevChain
    .catch(() => undefined)
    .then(async () => {
      const current = (await readJsonOrNull<EditWatermarkData>(filePath)) ?? {};
      result = updater(current);
      await writeJsonAtomic(filePath, result);
    });
  watermarkWriteQueues.set(runDir, nextChain);
  await nextChain;
  return result;
}

/** 从历史版本列表中提取最近一次润色或微调得到的稿件 */
function findLatestPolished(
  versions: ReturnType<CoreContext['repos']['runItems']['listVersions']>,
): PolishedItem | null {
  for (let i = versions.length - 1; i >= 0; i--) {
    const v = versions[i];
    if (v && (v.kind === 'polish' || v.kind === 'revise')) {
      return normalizeStoredPolishedItem(v.payload);
    }
  }
  return null;
}

/** 从历史版本列表中提取最近一次事实摘要草稿 */
function findLatestSummary(
  versions: ReturnType<CoreContext['repos']['runItems']['listVersions']>,
): SummaryDraft | null {
  for (let i = versions.length - 1; i >= 0; i--) {
    const v = versions[i];
    if (v && v.kind === 'summary') {
      return v.payload as SummaryDraft;
    }
  }
  return null;
}

/** 统计自最近一次独立事实核查以来累计的本地预检失败次数（与事实核查打回轮次解耦） */
function countFailedPrechecksSinceLastFactcheck(
  versions: ReturnType<CoreContext['repos']['runItems']['listVersions']>,
): number {
  let count = 0;
  for (let i = versions.length - 1; i >= 0; i--) {
    const v = versions[i];
    if (!v) {
      continue;
    }
    if (v.kind === 'factcheck') {
      break;
    }
    if (v.kind === 'precheck') {
      const payload = v.payload as PrecheckResult;
      if (!payload.passed) {
        count += 1;
      }
    }
  }
  return count;
}

/** 提取最近一轮未通过事实核查时给出的修改意见清单，供下一轮复核保持核查口径一致 */
function findLatestFactCheckNotes(
  versions: ReturnType<CoreContext['repos']['runItems']['listVersions']>,
): string[] | undefined {
  for (let i = versions.length - 1; i >= 0; i--) {
    const v = versions[i];
    if (v?.kind === 'factcheck') {
      const fc = v.payload as FactCheckResult;
      if (fc.verdict === 'revise' && fc.revisionNotes.length > 0) {
        return fc.revisionNotes;
      }
      return undefined;
    }
  }
  return undefined;
}

/** 将某条新闻标记为通过核查并保存成品单条文件 */
async function markItemPassed(opts: {
  ctx: CoreContext;
  runId: string;
  item: RunItemRecord;
  event: EventRecord;
  polished: PolishedItem;
  revision: number;
}): Promise<void> {
  const { ctx, runId, item, event, polished, revision } = opts;
  const nowIso = ctx.now().toISOString();
  const itemFile = path.join(ctx.paths.runDir(runId), 'items', `${item.id}.json`);
  await writeJsonAtomic(itemFile, polished);

  ctx.repos.runItems.updateItem(item.id, {
    status: 'passed',
    revision,
    dropReason: null,
    finalJson: polished,
    updatedAt: nowIso,
  });

  ctx.repos.runEvents.append({
    runId,
    ts: nowIso,
    level: 'info',
    stage: 'edit',
    itemId: item.id,
    type: 'item_passed',
    message: `新闻「${polished.shortTitle}」通过事实核查（修改 ${revision} 轮）`,
    data: { eventId: event.id, revision },
  });
}

/** 将某条新闻标记为已剔除并记录详细原因 */
function markItemDropped(opts: {
  ctx: CoreContext;
  runId: string;
  item: RunItemRecord;
  event: EventRecord;
  revision: number;
  reason: string;
}): void {
  const { ctx, runId, item, event, revision, reason } = opts;
  const nowIso = ctx.now().toISOString();
  ctx.repos.runItems.updateItem(item.id, {
    status: 'dropped',
    revision,
    dropReason: reason,
    finalJson: null,
    updatedAt: nowIso,
  });

  ctx.repos.runEvents.append({
    runId,
    ts: nowIso,
    level: 'warn',
    stage: 'edit',
    itemId: item.id,
    type: 'item_dropped',
    message: `新闻「${event.title}」被剔除，原因：${reason}`,
    data: { eventId: event.id, reason, revision },
  });
}

/**
 * 判断摘要中提取的事件实际发生日期是否明显早于任务设定的最早时间下限。
 * 对于仅写出公历日期（YYYY-MM-DD）的情形，按全球最晚时区当日结束时刻计算（预留跨时区缓冲），避免海外隔夜新闻被误杀。
 */
export function isEventOlderThanCutoff(
  eventOccurredAt: string | undefined,
  notBeforeAt: string | null | undefined,
): boolean {
  if (!eventOccurredAt || !notBeforeAt) {
    return false;
  }
  const trimmed = eventOccurredAt.trim();
  const cutoffMs = Date.parse(notBeforeAt);
  if (!trimmed || Number.isNaN(cutoffMs)) {
    return false;
  }

  const dateOnlyMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  if (dateOnlyMatch) {
    const year = Number(dateOnlyMatch[1]);
    const month = Number(dateOnlyMatch[2]);
    const day = Number(dateOnlyMatch[3]);
    // 全球最晚时区为 UTC-12，该日最晚可能延续至 UTC 次日 12:00
    const latestPossibleMs = Date.UTC(year, month - 1, day, 23, 59, 59, 999) + 12 * 3600_000;
    return latestPossibleMs < cutoffMs;
  }

  const parsedMs = Date.parse(trimmed);
  if (Number.isNaN(parsedMs)) {
    return false;
  }
  return parsedMs < cutoffMs;
}

/**
 * 处理单条新闻从总结、中文润色、确定性预检到独立事实核查（含打回微调闭环）的完整流程，
 * 支持按历史版本续跑未完成的子步骤以及从指定步骤单条重做。
 */
export async function processSingleItem(opts: {
  ctx: CoreContext;
  settings: Settings;
  limits: ContentLimits;
  runId: string;
  item: RunItemRecord;
  event: EventRecord;
  notBeforeAt?: string | null;
  signal: AbortSignal;
  forceFromStep?: EditSubStep;
  claimPassSlot: () => boolean;
}): Promise<'passed' | 'dropped' | 'requeued'> {
  const {
    ctx,
    settings,
    limits,
    runId,
    item,
    event,
    notBeforeAt,
    signal,
    forceFromStep,
    claimPassSlot,
  } = opts;

  if (signal.aborted) {
    throw new DOMException('已取消', 'AbortError');
  }

  const articlesMap = await loadEventArticles(ctx, event);
  if (articlesMap.size === 0) {
    markItemDropped({
      ctx,
      runId,
      item,
      event,
      revision: item.revision,
      reason: 'missing_source_content',
    });
    return 'dropped';
  }

  const articlesForPrecheck = new Map<string, { text: string; publishedAt?: string | null }>();
  for (const [id, loaded] of articlesMap) {
    articlesForPrecheck.set(id, { text: loaded.text, publishedAt: loaded.publishedAt });
  }

  const runDir = ctx.paths.runDir(runId);
  const rawVersions = ctx.repos.runItems.listVersions(item.id);
  const watermarkData = await readJsonOrNull<EditWatermarkData>(
    path.join(runDir, 'edit-watermark.json'),
  );
  const versionFloor = watermarkData?.versionFloorByItemId?.[item.id] ?? 0;
  const versionsAfterFloor = rawVersions.filter((v) => v.id > versionFloor);
  const pendingRetry = watermarkData?.pendingRetryByItemId?.[item.id];
  const effectiveFromStep = forceFromStep ?? pendingRetry?.fromStep;

  let versions = versionsAfterFloor;
  let revision = item.revision;
  let skipPrecheckOnce = false;
  let hasPostRetryWork = true;

  if (effectiveFromStep === 'summarize') {
    versions = [];
    revision = 0;
    hasPostRetryWork = false;
  } else if (effectiveFromStep === 'polish' || effectiveFromStep === 'factcheck') {
    const baselineVersionId =
      pendingRetry?.fromStep === effectiveFromStep
        ? pendingRetry.baselineVersionId
        : (versionsAfterFloor[versionsAfterFloor.length - 1]?.id ?? 0);
    hasPostRetryWork = versionsAfterFloor.some((v) => v.id > baselineVersionId);

    if (effectiveFromStep === 'polish') {
      versions = versionsAfterFloor.filter((v) => v.kind === 'summary' || v.id > baselineVersionId);
      if (!hasPostRetryWork) {
        revision = 0;
      }
    } else {
      versions = versionsAfterFloor.filter(
        (v) =>
          v.kind === 'summary' ||
          v.kind === 'polish' ||
          v.kind === 'revise' ||
          v.id > baselineVersionId,
      );
      if (!hasPostRetryWork) {
        revision = 0;
        skipPrecheckOnce = true;
      }
    }
  }

  let summary: SummaryDraft | null =
    effectiveFromStep === 'summarize' ? null : findLatestSummary(versions);
  let polished: PolishedItem | null =
    effectiveFromStep === 'summarize' || (effectiveFromStep === 'polish' && !hasPostRetryWork)
      ? null
      : findLatestPolished(versions);

  let localPrecheckFixCount = countFailedPrechecksSinceLastFactcheck(versions);
  let lastFactCheckNotes = findLatestFactCheckNotes(versions);

  const clearPendingRetry = async () => {
    if (pendingRetry) {
      await updateEditWatermark(runDir, (prev) => {
        if (!prev.pendingRetryByItemId?.[item.id]) {
          return prev;
        }
        const nextPending = { ...prev.pendingRetryByItemId };
        delete nextPending[item.id];
        return {
          ...prev,
          pendingRetryByItemId: nextPending,
        };
      });
    }
  };

  /** 执行单次微调或因超过允许轮数而标记剔除，并推送实时微调事件日志，避免续跑与主循环重复逻辑 */
  const applyReviseOrDrop = async (optsRev: {
    nextRevision: number;
    reasonSource: 'precheck' | 'factcheck';
    notes: string[];
    currentPolished: PolishedItem;
  }): Promise<{ dropped: true } | { dropped: false; updated: PolishedItem }> => {
    if (optsRev.nextRevision > settings.editorial.maxRevisions) {
      markItemDropped({
        ctx,
        runId,
        item,
        event,
        revision: optsRev.nextRevision,
        reason: 'exceeded_revisions',
      });
      await clearPendingRetry();
      return { dropped: true };
    }
    const reviseTs = ctx.now().toISOString();
    ctx.repos.runItems.updateItem(item.id, {
      status: 'revising',
      revision: optsRev.nextRevision,
      updatedAt: reviseTs,
    });
    const displayTitle = optsRev.currentPolished.shortTitle || event.title;
    const sourceLabel = optsRev.reasonSource === 'precheck' ? '本地规则预检' : '独立事实核查';
    ctx.repos.runEvents.append({
      runId,
      ts: reviseTs,
      level: 'info',
      stage: 'edit',
      itemId: item.id,
      type: 'item_revising',
      message: `新闻「${displayTitle}」进入并发微调（来源：${sourceLabel}，第 ${optsRev.nextRevision} 轮）`,
      data: {
        eventId: event.id,
        revision: optsRev.nextRevision,
        source: optsRev.reasonSource,
      },
    });
    const updated = await revisePolishedItem({
      ctx,
      settings,
      limits,
      runId,
      itemId: item.id,
      previous: optsRev.currentPolished,
      revisionNotes: optsRev.notes,
      evidence: optsRev.currentPolished.evidence,
      articlesMap,
      round: optsRev.nextRevision,
      signal,
    });
    return { dropped: false, updated };
  };

  const canResumeFromLastVer =
    !effectiveFromStep || (effectiveFromStep !== 'summarize' && hasPostRetryWork);

  if (canResumeFromLastVer) {
    const lastVer = versions[versions.length - 1];
    if (lastVer?.kind === 'precheck' && polished) {
      const preRes = lastVer.payload as PrecheckResult;
      if (preRes.passed) {
        skipPrecheckOnce = true;
      } else {
        const nextRevision =
          localPrecheckFixCount <= MAX_LOCAL_PRECHECK_FIXES_PER_ROUND
            ? revision
            : Math.max(revision, lastVer.round + 1);
        revision = nextRevision;
        const stepRes = await applyReviseOrDrop({
          nextRevision,
          reasonSource: 'precheck',
          notes: preRes.errors,
          currentPolished: polished,
        });
        if (stepRes.dropped) {
          return 'dropped';
        }
        polished = stepRes.updated;
      }
    } else if (lastVer?.kind === 'factcheck' && polished) {
      const fc = lastVer.payload as FactCheckResult;
      if (fc.verdict === 'pass') {
        if (!claimPassSlot()) {
          ctx.repos.runItems.updateItem(item.id, {
            status: 'queued',
            finalJson: null,
            updatedAt: ctx.now().toISOString(),
          });
          await clearPendingRetry();
          return 'requeued';
        }
        await markItemPassed({ ctx, runId, item, event, polished, revision });
        await clearPendingRetry();
        return 'passed';
      }
      if (fc.verdict === 'drop') {
        markItemDropped({
          ctx,
          runId,
          item,
          event,
          revision,
          reason: fc.dropReason || 'factcheck_rejected',
        });
        await clearPendingRetry();
        return 'dropped';
      }
      lastFactCheckNotes = fc.revisionNotes;
      localPrecheckFixCount = 0;
      revision = Math.max(revision, lastVer.round + 1);
      const stepRes = await applyReviseOrDrop({
        nextRevision: revision,
        reasonSource: 'factcheck',
        notes: fc.revisionNotes,
        currentPolished: polished,
      });
      if (stepRes.dropped) {
        return 'dropped';
      }
      polished = stepRes.updated;
    }
  }

  // 步骤 1：事实总结
  if (!summary) {
    ctx.repos.runItems.updateItem(item.id, {
      status: 'summarizing',
      revision,
      dropReason: null,
      finalJson: null,
      updatedAt: ctx.now().toISOString(),
    });
    summary = await summarizeEventItem({
      ctx,
      settings,
      runId,
      itemId: item.id,
      event,
      articlesMap,
      signal,
    });
  }

  if (isEventOlderThanCutoff(summary.eventOccurredAt, notBeforeAt)) {
    markItemDropped({
      ctx,
      runId,
      item,
      event,
      revision,
      reason: 'outdated_before_cutoff',
    });
    await clearPendingRetry();
    return 'dropped';
  }

  // 步骤 2：中文口播润色
  if (!polished) {
    ctx.repos.runItems.updateItem(item.id, {
      status: 'polishing',
      revision,
      dropReason: null,
      finalJson: null,
      updatedAt: ctx.now().toISOString(),
    });
    polished = await polishItemDraft({
      ctx,
      settings,
      limits,
      runId,
      itemId: item.id,
      event,
      summary,
      articlesMap,
      round: revision,
      signal,
    });
  }

  // 步骤 3：确定性规则预检与独立核查循环
  while (true) {
    if (signal.aborted) {
      throw new DOMException('已取消', 'AbortError');
    }

    if (!skipPrecheckOnce) {
      ctx.repos.runItems.updateItem(item.id, {
        status: 'prechecking',
        revision,
        updatedAt: ctx.now().toISOString(),
      });

      const persona = await getRunPersona(ctx, runId);
      const precheckRes = precheckPolishedItem({
        item: polished,
        articlesById: articlesForPrecheck,
        limits,
        metaTextBlacklist: settings.editorial.metaTextBlacklist,
        compact: settings.editorial.compactStyle,
        forbiddenTokens: persona?.forbiddenTokens,
        hostSelfName: persona?.selfName,
      });

      ctx.repos.runItems.appendVersion({
        itemId: item.id,
        kind: 'precheck',
        round: revision,
        payload: precheckRes,
        createdAt: ctx.now().toISOString(),
      });

      if (!precheckRes.passed) {
        localPrecheckFixCount += 1;
        if (localPrecheckFixCount > MAX_LOCAL_PRECHECK_FIXES_PER_ROUND) {
          revision += 1;
        }
        const stepRes = await applyReviseOrDrop({
          nextRevision: revision,
          reasonSource: 'precheck',
          notes: precheckRes.errors,
          currentPolished: polished,
        });
        if (stepRes.dropped) {
          return 'dropped';
        }
        polished = stepRes.updated;
        continue;
      }
    }
    skipPrecheckOnce = false;

    if (signal.aborted) {
      throw new DOMException('已取消', 'AbortError');
    }

    ctx.repos.runItems.updateItem(item.id, {
      status: 'checking',
      revision,
      updatedAt: ctx.now().toISOString(),
    });

    const fcRes = await factCheckPolishedItem({
      ctx,
      settings,
      runId,
      itemId: item.id,
      candidate: polished,
      articlesMap,
      round: revision,
      previousRevisionNotes: lastFactCheckNotes,
      signal,
    });
    localPrecheckFixCount = 0;

    if (fcRes.verdict === 'pass') {
      if (!claimPassSlot()) {
        ctx.repos.runItems.updateItem(item.id, {
          status: 'queued',
          finalJson: null,
          updatedAt: ctx.now().toISOString(),
        });
        await clearPendingRetry();
        return 'requeued';
      }
      await markItemPassed({ ctx, runId, item, event, polished, revision });
      await clearPendingRetry();
      return 'passed';
    }

    if (fcRes.verdict === 'drop') {
      markItemDropped({
        ctx,
        runId,
        item,
        event,
        revision,
        reason: fcRes.dropReason || 'factcheck_rejected',
      });
      await clearPendingRetry();
      return 'dropped';
    }

    lastFactCheckNotes = fcRes.revisionNotes;
    revision += 1;
    const stepRes = await applyReviseOrDrop({
      nextRevision: revision,
      reasonSource: 'factcheck',
      notes: fcRes.revisionNotes,
      currentPolished: polished,
    });
    if (stepRes.dropped) {
      return 'dropped';
    }
    polished = stepRes.updated;
  }
}

/** 对待处理的条目队列排定执行顺序（未写完的中断条目最优先，其余按事件重要度排序） */
function sortPendingItems(
  items: RunItemRecord[],
  eventById: ReadonlyMap<string, EventRecord>,
): RunItemRecord[] {
  return items
    .filter((item) => item.status !== 'passed' && item.status !== 'dropped')
    .sort((a, b) => {
      const aResuming = a.status !== 'queued' ? 0 : 1;
      const bResuming = b.status !== 'queued' ? 0 : 1;
      if (aResuming !== bResuming) {
        return aResuming - bResuming;
      }
      const rankA = eventById.get(a.eventId)?.rank ?? 9999;
      const rankB = eventById.get(b.eventId)?.rank ?? 9999;
      return rankA - rankB;
    });
}

/** 开写前检查本期主播形象与专属背景音乐，非人工指定时确保不缺失且不与上一期连续重复 */
async function ensureRunHostAndBgmBeforeEdit(
  ctx: CoreContext,
  runId: string,
  runCreatedAt: string,
  events: readonly EventRecord[],
  allItems: readonly RunItemRecord[],
): Promise<void> {
  const personas = await loadPersonas(ctx);
  if (personas.length === 0) return;
  const hostRow = ctx.db
    .prepare('SELECT host_id, host_manual, bgm_file FROM runs WHERE id = ?')
    .get(runId) as
    | { host_id: string | null; host_manual: number; bgm_file: string | null }
    | undefined;
  const previousHostId = findPreviousHostId(ctx, runId, runCreatedAt);
  const hasStartedAnyItem = allItems.some((item) => item.status !== 'queued');
  let nextHostId = hostRow?.host_id ?? null;
  const needsHostFallback =
    !hostRow?.host_manual &&
    (!nextHostId || (personas.length > 1 && nextHostId === previousHostId && !hasStartedAnyItem));
  if (needsHostFallback) {
    const primary = events.filter((ev) => ev.role === 'primary');
    const scoringEvents = primary.length > 0 ? primary : events;
    const extraTextByEventId = buildExtraTextByEventId(ctx, scoringEvents);
    const reselected = chooseHost(scoringEvents, personas, previousHostId, extraTextByEventId);
    if (reselected) {
      nextHostId = reselected;
      ctx.repos.runs.updateHostAndBgm(runId, { hostId: nextHostId });
    }
  }
  if (nextHostId) {
    const boundBgm = await resolvePersonaBgmFile(ctx, nextHostId, personas);
    if (boundBgm && hostRow?.bgm_file !== boundBgm) {
      ctx.repos.runs.updateHostAndBgm(runId, { bgmFile: boundBgm });
    }
  }
}

/**
 * 执行新闻编辑、润色、预检与核查并发协调器：
 * 按配置并发度推进新闻条目；若某条被剔除自动拉取替补事件；若备选池耗尽仍不够目标条数则触发补充抓稿；
 * 一旦凑足目标条数，立即停止剩余在途替补条目并将其退回排队状态，同时保留已完成工作支持随时断点续跑。
 */
export async function runEditStage(
  ctx: CoreContext,
  runId: string,
  settings: Settings,
  opts?: {
    signal?: AbortSignal;
    limitsOverride?: Partial<ContentLimits>;
  },
): Promise<EditCheckpoint> {
  const run = ctx.repos.runs.getById(runId);
  if (!run) {
    throw new Error(`未找到任务记录: ${runId}`);
  }
  const notBeforeAt = run.notBeforeAt ?? null;
  const notBeforeMs = notBeforeAt ? Date.parse(notBeforeAt) : Number.NaN;
  const hasCutoff = !Number.isNaN(notBeforeMs);
  const defaultSinceMs = ctx.now().getTime() - settings.issue.freshnessHours * 3600_000;

  const itemCount = !settings.issue.allowPartial
    ? run.itemCount
    : ctx.repos.events.listByRun(runId).filter((event) => event.role === 'primary').length;
  const limits = resolveContentLimits(settings, opts?.limitsOverride);
  const parentSignal = opts?.signal;

  const events = ctx.repos.events.listByRun(runId);
  const eventById = new Map(events.map((e) => [e.id, e]));
  const allItems = ctx.repos.runItems.listByRun(runId);

  await ensureRunHostAndBgmBeforeEdit(ctx, runId, run.createdAt, events, allItems);

  const usedArticleIds = new Set<string>();
  for (const ev of events) {
    for (const artId of ev.articleIds) {
      usedArticleIds.add(artId);
    }
  }

  let passedCount = allItems.filter((i) => i.status === 'passed').length;
  const resetLingeringActiveItems = () => {
    const resetTs = ctx.now().toISOString();
    for (const item of ctx.repos.runItems.listByRun(runId)) {
      if (item.status !== 'passed' && item.status !== 'dropped' && item.status !== 'queued') {
        ctx.repos.runItems.updateItem(item.id, {
          status: 'queued',
          finalJson: null,
          updatedAt: resetTs,
        });
      }
    }
  };

  if (passedCount >= itemCount) {
    resetLingeringActiveItems();
    const refreshed = ctx.repos.runItems.listByRun(runId);
    return {
      passedItemIds: refreshed
        .filter((i) => i.status === 'passed')
        .slice(0, itemCount)
        .map((i) => i.id),
      droppedItemIds: refreshed.filter((i) => i.status === 'dropped').map((i) => i.id),
    };
  }

  let pendingQueue = sortPendingItems(allItems, eventById);
  let nextRefillRound = events.reduce((max, ev) => Math.max(ev.refillRound, max), 0) + 1;
  let totalEventCount = events.length;

  const maxConcurrency = Math.max(1, settings.issue.itemConcurrency);

  while (passedCount < itemCount) {
    if (parentSignal?.aborted) {
      throw new DOMException('已取消', 'AbortError');
    }

    if (pendingQueue.length === 0) {
      if (settings.issue.allowPartial) break;
      const cutoffPreventsWindowExpand =
        hasCutoff &&
        notBeforeMs >= defaultSinceMs &&
        (nextRefillRound > 1 || !settings.issue.refill.useBackupSources);
      if (nextRefillRound > settings.issue.refill.maxRounds || cutoffPreventsWindowExpand) {
        if (hasCutoff && passedCount >= 1) {
          ctx.repos.runEvents.append({
            runId,
            ts: ctx.now().toISOString(),
            level: 'info',
            stage: 'edit',
            type: 'cutoff_partial_edit',
            message: `在设定的最早时间之后共通过核查 ${passedCount} 条新闻（少于目标上限 ${itemCount} 条），将按实际合格条数制作视频`,
            data: { notBeforeAt, passedCount, itemCount },
          });
          break;
        }
        throw new PipelineError(
          'insufficient_items',
          `合格新闻条目不足：需要 ${itemCount} 条，当前通过 ${passedCount} 条，备用候选池与补充轮次已全部耗尽`,
        );
      }

      const refillRes = await runRefillRound({
        ctx,
        runId,
        round: nextRefillRound,
        neededCount: itemCount - passedCount,
        itemCount,
        settings,
        notBeforeAt,
        usedArticleIds,
        existingEventCount: totalEventCount,
        signal: parentSignal,
      });
      nextRefillRound += 1;
      for (const ev of refillRes.addedEvents) {
        eventById.set(ev.id, ev);
      }
      totalEventCount += refillRes.addedEvents.length;
      pendingQueue = sortPendingItems(refillRes.addedItems, eventById);

      if (pendingQueue.length === 0) {
        continue;
      }
    }

    // 执行并发队列，直至达到目标过审数或当前队列全部清空需要进入下一轮补充
    const excessAbort = new AbortController();
    const onParentAbort = () => excessAbort.abort();
    parentSignal?.addEventListener('abort', onParentAbort, { once: true });

    let activeCount = 0;
    let fatalError: unknown = null;

    const claimPassSlot = () => {
      if (passedCount >= itemCount) {
        return false;
      }
      passedCount += 1;
      if (passedCount >= itemCount) {
        excessAbort.abort();
      }
      return true;
    };

    try {
      await new Promise<void>((resolve, reject) => {
        const launchNext = () => {
          if (parentSignal?.aborted) {
            if (activeCount === 0) {
              reject(new DOMException('已取消', 'AbortError'));
            }
            return;
          }
          if (fatalError !== null) {
            if (activeCount === 0) {
              reject(fatalError);
            }
            return;
          }

          if (passedCount >= itemCount || (pendingQueue.length === 0 && activeCount === 0)) {
            if (activeCount === 0) {
              resolve();
            }
            return;
          }

          while (
            passedCount + activeCount < itemCount &&
            activeCount < maxConcurrency &&
            pendingQueue.length > 0 &&
            fatalError === null &&
            !parentSignal?.aborted
          ) {
            const nextItem = pendingQueue.shift();
            if (!nextItem) {
              break;
            }
            const ev = eventById.get(nextItem.eventId);
            if (!ev) {
              continue;
            }
            activeCount += 1;

            void processSingleItem({
              ctx,
              settings,
              limits,
              runId,
              item: nextItem,
              event: ev,
              notBeforeAt,
              signal: excessAbort.signal,
              claimPassSlot,
            })
              .catch((err) => {
                if (err instanceof Error && err.name === 'AbortError') {
                  if (!parentSignal?.aborted) {
                    // 仅因其余条目已凑足数量而停止的在途替补条目，安全退回排队态
                    ctx.repos.runItems.updateItem(nextItem.id, {
                      status: 'queued',
                      updatedAt: ctx.now().toISOString(),
                    });
                    return;
                  }
                }
                if (fatalError === null) {
                  fatalError = err;
                  excessAbort.abort();
                }
              })
              .finally(() => {
                activeCount -= 1;
                launchNext();
              });
          }
        };

        launchNext();
      });
    } finally {
      parentSignal?.removeEventListener('abort', onParentAbort);
    }
  }

  resetLingeringActiveItems();
  const finalItems = ctx.repos.runItems.listByRun(runId);
  const passedItemIds = finalItems.filter((i) => i.status === 'passed').map((i) => i.id);
  if (passedItemIds.length === 0) {
    throw new PipelineError(
      'insufficient_items',
      hasCutoff
        ? `在设定的最早时间（${notBeforeAt}）之后没有新闻通过事实核查，请放宽时间后再试`
        : '本期没有新闻通过事实核查，无法生成成片',
    );
  }
  return {
    passedItemIds,
    droppedItemIds: finalItems.filter((i) => i.status === 'dropped').map((i) => i.id),
  };
}

/**
 * 批量并发重试指定的一条或多条新闻条目：
 * 保持其他未参与重做的已过审条目名额后，按并发配置同时重跑全部选中条目的总结、润色、核查与微调；
 * 全部目标条目并发结束后，若仍有被剔除的缺口则自动从替补队列补位。
 */
export async function retryMultipleEditItems(opts: {
  ctx: CoreContext;
  settings: Settings;
  runId: string;
  itemIds: readonly string[];
  fromStep?: EditSubStep;
  limitsOverride?: Partial<ContentLimits>;
  signal?: AbortSignal;
}): Promise<EditCheckpoint> {
  const { ctx, settings, runId, itemIds, fromStep = 'summarize', limitsOverride, signal } = opts;
  const uniqueItemIds = Array.from(new Set(itemIds.map((id) => id.trim()).filter(Boolean)));
  if (uniqueItemIds.length === 0) {
    throw new Error('请至少指定一条需要重做的新闻条目 ID');
  }

  const run = ctx.repos.runs.getById(runId);
  if (!run) {
    throw new Error(`未找到任务记录: ${runId}`);
  }
  const events = ctx.repos.events.listByRun(runId);
  const eventById = new Map(events.map((e) => [e.id, e]));
  const allItems = ctx.repos.runItems.listByRun(runId);

  await ensureRunHostAndBgmBeforeEdit(ctx, runId, run.createdAt, events, allItems);
  const itemById = new Map(allItems.map((i) => [i.id, i]));

  const targets: Array<{ item: RunItemRecord; event: EventRecord; maxVersionId: number }> = [];
  for (const itemId of uniqueItemIds) {
    const targetItem = itemById.get(itemId);
    if (!targetItem || targetItem.runId !== runId) {
      throw new Error(`任务 ${runId} 中不存在新闻条目: ${itemId}`);
    }
    const targetEvent = eventById.get(targetItem.eventId);
    if (!targetEvent) {
      throw new Error(`未找到新闻条目关联的事件记录: ${targetItem.eventId}`);
    }
    const versions = ctx.repos.runItems.listVersions(itemId);
    const maxVersionId = versions.reduce((acc, v) => Math.max(v.id, acc), 0);
    targets.push({ item: targetItem, event: targetEvent, maxVersionId });
  }

  const targetIdSet = new Set(uniqueItemIds);
  const targetPassCount = !settings.issue.allowPartial
    ? run.itemCount
    : Math.max(uniqueItemIds.length, events.filter((event) => event.role === 'primary').length);

  const otherPassed = allItems
    .filter((i) => !targetIdSet.has(i.id) && i.status === 'passed')
    .sort((a, b) => {
      const rankA = eventById.get(a.eventId)?.rank ?? 9999;
      const rankB = eventById.get(b.eventId)?.rank ?? 9999;
      return rankA - rankB;
    });

  // 退回多出的末位已过审条目，确保重做条目全部通过后整期总数严格不超过上限
  while (otherPassed.length > 0 && otherPassed.length + uniqueItemIds.length > targetPassCount) {
    const demoted = otherPassed.pop();
    if (!demoted) {
      break;
    }
    ctx.repos.runItems.updateItem(demoted.id, {
      status: 'queued',
      position: null,
      updatedAt: ctx.now().toISOString(),
    });
  }

  let remainingPassSlots = Math.max(0, targetPassCount - otherPassed.length);
  const limits = resolveContentLimits(settings, limitsOverride);
  const nowIso = ctx.now().toISOString();
  for (const target of targets) {
    ctx.repos.runItems.updateItem(target.item.id, {
      status: 'queued',
      position: null,
      revision: 0,
      dropReason: null,
      finalJson: null,
      updatedAt: nowIso,
    });
  }

  const runDir = ctx.paths.runDir(runId);
  await updateEditWatermark(runDir, (prev) => {
    const nextFloor = { ...(prev.versionFloorByItemId ?? {}) };
    const nextPending = { ...(prev.pendingRetryByItemId ?? {}) };
    for (const target of targets) {
      if (fromStep === 'summarize') {
        if (target.maxVersionId > 0) {
          nextFloor[target.item.id] = target.maxVersionId;
        }
        delete nextPending[target.item.id];
      } else {
        nextPending[target.item.id] = { fromStep, baselineVersionId: target.maxVersionId };
      }
    }
    return {
      versionFloorByItemId: nextFloor,
      pendingRetryByItemId: nextPending,
    };
  });

  const localAc = new AbortController();
  const onAbort = () => localAc.abort();
  signal?.addEventListener('abort', onAbort, { once: true });

  const claimPassSlot = () => {
    if (remainingPassSlots <= 0) {
      return false;
    }
    remainingPassSlots -= 1;
    return true;
  };

  try {
    const concurrency = Math.max(1, settings.issue.itemConcurrency);
    const limit = pLimit(concurrency);
    await Promise.all(
      targets.map((target) =>
        limit(async () => {
          try {
            await processSingleItem({
              ctx,
              settings,
              limits,
              runId,
              item: {
                ...target.item,
                status: 'queued',
                position: null,
                revision: 0,
                dropReason: null,
                finalJson: null,
              },
              event: target.event,
              notBeforeAt: run.notBeforeAt ?? null,
              signal: localAc.signal,
              forceFromStep: fromStep,
              claimPassSlot,
            });
          } catch (err) {
            localAc.abort();
            throw err;
          }
        }),
      ),
    );
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }

  // 若批量重做后仍有条目被核查剔除导致过审总数不足，交由协调器自动从替补队列补位
  return runEditStage(ctx, runId, settings, { signal, limitsOverride });
}

/**
 * 单条重试指定新闻条目：
 * 若目标条目曾被剔除且当前已有足够过审条目，则先将末位过审条目退回排队以保持整期总数不变；
 * 若重跑后本条被剔除，则自动继续从替补队列补位凑足整期条数。
 */
export async function retrySingleEditItem(opts: {
  ctx: CoreContext;
  settings: Settings;
  runId: string;
  itemId: string;
  fromStep?: EditSubStep;
  limitsOverride?: Partial<ContentLimits>;
  signal?: AbortSignal;
}): Promise<EditCheckpoint> {
  return retryMultipleEditItems({
    ctx: opts.ctx,
    settings: opts.settings,
    runId: opts.runId,
    itemIds: [opts.itemId],
    fromStep: opts.fromStep,
    limitsOverride: opts.limitsOverride,
    signal: opts.signal,
  });
}
