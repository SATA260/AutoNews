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
import type { CoreContext } from '../context.js';
import { PipelineError } from '../errors.js';
import { readJsonOrNull, writeJsonAtomic } from '../storage/files.js';
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

/** 从历史版本列表中提取最近一次润色或微调得到的稿件 */
function findLatestPolished(
  versions: ReturnType<CoreContext['repos']['runItems']['listVersions']>,
): PolishedItem | null {
  for (let i = versions.length - 1; i >= 0; i--) {
    const v = versions[i];
    if (v && (v.kind === 'polish' || v.kind === 'revise')) {
      return v.payload as PolishedItem;
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

/** 计算当前修改轮次里是否已经使用过免费的规则预检修正机会 */
function hasUsedFreePrecheckInCurrentRound(
  versions: ReturnType<CoreContext['repos']['runItems']['listVersions']>,
): boolean {
  let failedPrechecks = 0;
  for (let i = versions.length - 1; i >= 0; i--) {
    const v = versions[i];
    if (!v || v.kind === 'factcheck' || v.kind === 'polish' || v.kind === 'summary') {
      break;
    }
    if (v.kind === 'precheck') {
      const payload = v.payload as PrecheckResult;
      if (!payload.passed) {
        failedPrechecks += 1;
      }
    }
  }
  return failedPrechecks >= 1;
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
  signal: AbortSignal;
  forceFromStep?: EditSubStep;
  claimPassSlot: () => boolean;
}): Promise<'passed' | 'dropped' | 'requeued'> {
  const { ctx, settings, limits, runId, item, event, signal, forceFromStep, claimPassSlot } = opts;

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

  const rawVersions = ctx.repos.runItems.listVersions(item.id);
  const watermarkData = await readJsonOrNull<{ versionFloorByItemId?: Record<string, number> }>(
    path.join(ctx.paths.runDir(runId), 'edit-watermark.json'),
  );
  const versionFloor = watermarkData?.versionFloorByItemId?.[item.id] ?? 0;
  const versions = rawVersions.filter((v) => v.id > versionFloor);
  let revision = forceFromStep ? 0 : item.revision;
  let summary: SummaryDraft | null =
    forceFromStep === 'summarize' ? null : findLatestSummary(versions);
  let polished: PolishedItem | null =
    forceFromStep === 'summarize' || forceFromStep === 'polish'
      ? null
      : findLatestPolished(versions);

  let skipPrecheckOnce = false;
  let freePrecheckRetryUsedInRound = false;

  if (!forceFromStep) {
    const lastVer = versions[versions.length - 1];
    if (lastVer?.kind === 'precheck' && polished) {
      const preRes = lastVer.payload as PrecheckResult;
      if (preRes.passed) {
        skipPrecheckOnce = true;
      } else {
        const usedFree = hasUsedFreePrecheckInCurrentRound(versions);
        if (!usedFree) {
          freePrecheckRetryUsedInRound = true;
          ctx.repos.runItems.updateItem(item.id, {
            status: 'revising',
            revision,
            updatedAt: ctx.now().toISOString(),
          });
          polished = await revisePolishedItem({
            ctx,
            settings,
            limits,
            runId,
            itemId: item.id,
            previous: polished,
            revisionNotes: preRes.errors,
            evidence: polished.evidence,
            articlesMap,
            round: revision,
            signal,
          });
        } else {
          revision += 1;
          if (revision > settings.editorial.maxRevisions) {
            markItemDropped({
              ctx,
              runId,
              item,
              event,
              revision,
              reason: 'exceeded_revisions',
            });
            return 'dropped';
          }
          freePrecheckRetryUsedInRound = false;
          ctx.repos.runItems.updateItem(item.id, {
            status: 'revising',
            revision,
            updatedAt: ctx.now().toISOString(),
          });
          polished = await revisePolishedItem({
            ctx,
            settings,
            limits,
            runId,
            itemId: item.id,
            previous: polished,
            revisionNotes: preRes.errors,
            evidence: polished.evidence,
            articlesMap,
            round: revision,
            signal,
          });
        }
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
          return 'requeued';
        }
        await markItemPassed({ ctx, runId, item, event, polished, revision });
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
        return 'dropped';
      }
      revision += 1;
      if (revision > settings.editorial.maxRevisions) {
        markItemDropped({
          ctx,
          runId,
          item,
          event,
          revision,
          reason: 'exceeded_revisions',
        });
        return 'dropped';
      }
      ctx.repos.runItems.updateItem(item.id, {
        status: 'revising',
        revision,
        updatedAt: ctx.now().toISOString(),
      });
      polished = await revisePolishedItem({
        ctx,
        settings,
        limits,
        runId,
        itemId: item.id,
        previous: polished,
        revisionNotes: fc.revisionNotes,
        evidence: polished.evidence,
        articlesMap,
        round: revision,
        signal,
      });
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

      const precheckRes = precheckPolishedItem({
        item: polished,
        articlesById: articlesForPrecheck,
        limits,
        metaTextBlacklist: settings.editorial.metaTextBlacklist,
      });

      ctx.repos.runItems.appendVersion({
        itemId: item.id,
        kind: 'precheck',
        round: revision,
        payload: precheckRes,
        createdAt: ctx.now().toISOString(),
      });

      if (!precheckRes.passed) {
        if (!freePrecheckRetryUsedInRound) {
          freePrecheckRetryUsedInRound = true;
        } else {
          revision += 1;
          freePrecheckRetryUsedInRound = false;
          if (revision > settings.editorial.maxRevisions) {
            markItemDropped({
              ctx,
              runId,
              item,
              event,
              revision,
              reason: 'exceeded_revisions',
            });
            return 'dropped';
          }
        }

        ctx.repos.runItems.updateItem(item.id, {
          status: 'revising',
          revision,
          updatedAt: ctx.now().toISOString(),
        });
        polished = await revisePolishedItem({
          ctx,
          settings,
          limits,
          runId,
          itemId: item.id,
          previous: polished,
          revisionNotes: precheckRes.errors,
          evidence: polished.evidence,
          articlesMap,
          round: revision,
          signal,
        });
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
      signal,
    });

    if (fcRes.verdict === 'pass') {
      if (!claimPassSlot()) {
        ctx.repos.runItems.updateItem(item.id, {
          status: 'queued',
          finalJson: null,
          updatedAt: ctx.now().toISOString(),
        });
        return 'requeued';
      }
      await markItemPassed({ ctx, runId, item, event, polished, revision });
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
      return 'dropped';
    }

    revision += 1;
    freePrecheckRetryUsedInRound = false;
    if (revision > settings.editorial.maxRevisions) {
      markItemDropped({
        ctx,
        runId,
        item,
        event,
        revision,
        reason: 'exceeded_revisions',
      });
      return 'dropped';
    }

    ctx.repos.runItems.updateItem(item.id, {
      status: 'revising',
      revision,
      updatedAt: ctx.now().toISOString(),
    });

    polished = await revisePolishedItem({
      ctx,
      settings,
      limits,
      runId,
      itemId: item.id,
      previous: polished,
      revisionNotes: fcRes.revisionNotes,
      evidence: polished.evidence,
      articlesMap,
      round: revision,
      signal,
    });
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
  const itemCount = run.itemCount;
  const limits = resolveContentLimits(settings, opts?.limitsOverride);
  const parentSignal = opts?.signal;

  const events = ctx.repos.events.listByRun(runId);
  const eventById = new Map(events.map((e) => [e.id, e]));
  const allItems = ctx.repos.runItems.listByRun(runId);

  const usedArticleIds = new Set<string>();
  for (const ev of events) {
    for (const artId of ev.articleIds) {
      usedArticleIds.add(artId);
    }
  }

  let passedCount = allItems.filter((i) => i.status === 'passed').length;
  if (passedCount >= itemCount) {
    return {
      passedItemIds: allItems
        .filter((i) => i.status === 'passed')
        .slice(0, itemCount)
        .map((i) => i.id),
      droppedItemIds: allItems.filter((i) => i.status === 'dropped').map((i) => i.id),
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
      if (nextRefillRound > settings.issue.refill.maxRounds) {
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

  const finalItems = ctx.repos.runItems.listByRun(runId);
  return {
    passedItemIds: finalItems.filter((i) => i.status === 'passed').map((i) => i.id),
    droppedItemIds: finalItems.filter((i) => i.status === 'dropped').map((i) => i.id),
  };
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
  const { ctx, settings, runId, itemId, fromStep = 'summarize', limitsOverride, signal } = opts;
  const run = ctx.repos.runs.getById(runId);
  if (!run) {
    throw new Error(`未找到任务记录: ${runId}`);
  }
  const targetItem = ctx.repos.runItems.getById(itemId);
  if (!targetItem || targetItem.runId !== runId) {
    throw new Error(`任务 ${runId} 中不存在新闻条目: ${itemId}`);
  }
  const events = ctx.repos.events.listByRun(runId);
  const eventById = new Map(events.map((e) => [e.id, e]));
  const targetEvent = eventById.get(targetItem.eventId);
  if (!targetEvent) {
    throw new Error(`未找到新闻条目关联的事件记录: ${targetItem.eventId}`);
  }

  const allItems = ctx.repos.runItems.listByRun(runId);
  const otherPassed = allItems
    .filter((i) => i.id !== itemId && i.status === 'passed')
    .sort((a, b) => {
      const rankA = eventById.get(a.eventId)?.rank ?? 9999;
      const rankB = eventById.get(b.eventId)?.rank ?? 9999;
      return rankA - rankB;
    });

  // 保证其它已过审条数严格不超过 N - 1，从而给当前重跑条目留出名额
  while (otherPassed.length >= run.itemCount) {
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

  const limits = resolveContentLimits(settings, limitsOverride);
  const localAc = new AbortController();
  const onAbort = () => localAc.abort();
  signal?.addEventListener('abort', onAbort, { once: true });

  ctx.repos.runItems.updateItem(targetItem.id, {
    status: 'queued',
    position: null,
    dropReason: null,
    finalJson: null,
    updatedAt: ctx.now().toISOString(),
  });

  try {
    let slotClaimed = false;
    await processSingleItem({
      ctx,
      settings,
      limits,
      runId,
      item: {
        ...targetItem,
        status: 'queued',
        position: null,
        dropReason: null,
        finalJson: null,
      },
      event: targetEvent,
      signal: localAc.signal,
      forceFromStep: fromStep,
      claimPassSlot: () => {
        if (slotClaimed) {
          return false;
        }
        slotClaimed = true;
        return true;
      },
    });
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }

  // 若重做这条后过审总数仍少于 N（例如被核查剔除），交由协调器自动从替补队列补位
  return runEditStage(ctx, runId, settings, { signal, limitsOverride });
}
