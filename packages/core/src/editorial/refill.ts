import crypto from 'node:crypto';
import type { EventRecord, RunItemRecord, Settings } from '@aidaily/contracts';
import { collectSources } from '../collector/index.js';
import type { CoreContext } from '../context.js';
import { PipelineError } from '../errors.js';
import { inTransaction } from '../storage/db.js';
import { selectCandidateEvents } from './selection-core.js';

/** 单轮备选补充抓取的结果摘要 */
export interface RefillRoundResult {
  round: number;
  lookbackHours: number;
  addedEvents: EventRecord[];
  addedItems: RunItemRecord[];
}

/**
 * 执行单轮新闻条数不足补足流程：
 * 首轮且允许启用备用信源时先抓一次备用池，随后按步长逐步放宽时效窗口并重新入选备选事件，
 * 将新增事件以替补身份写入数据库并记录中文运行日志。
 */
export async function runRefillRound(opts: {
  ctx: CoreContext;
  runId: string;
  round: number;
  neededCount: number;
  itemCount: number;
  settings: Settings;
  usedArticleIds: Set<string>;
  existingEventCount: number;
  signal?: AbortSignal;
}): Promise<RefillRoundResult> {
  const { ctx, runId, round, neededCount, itemCount, settings, usedArticleIds, signal } = opts;

  if (round === 1 && settings.issue.refill.useBackupSources) {
    try {
      await collectSources(ctx, {
        pool: 'backup',
        runId,
        signal,
        settings,
      });
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw err;
      }
      if (!(err instanceof PipelineError && err.code === 'collect_all_failed')) {
        throw err;
      }
    }
  }

  const lookbackHours = Math.min(
    settings.issue.refill.maxLookbackHours,
    settings.issue.freshnessHours + round * settings.issue.refill.lookbackStepHours,
  );
  const sinceIso = new Date(ctx.now().getTime() - lookbackHours * 3600_000).toISOString();
  const targetCount = Math.max(neededCount * settings.issue.reserveFactor, neededCount);

  const selection = await selectCandidateEvents({
    ctx,
    runId,
    settings,
    sinceIso,
    includeExpired: true,
    targetCount,
    itemCount,
    excludeArticleIds: usedArticleIds,
    signal,
  });

  const nowIso = ctx.now().toISOString();
  const addedEvents: EventRecord[] = [];
  const addedItems: RunItemRecord[] = [];
  const toReserveIds: string[] = [];

  selection.selected.forEach((entry, idx) => {
    const rank = opts.existingEventCount + idx + 1;
    const suffix = crypto.randomBytes(3).toString('hex');
    const eventId = `ev-${runId}-${String(rank).padStart(2, '0')}-${suffix}`;
    const itemId = `item-${runId}-${String(rank).padStart(2, '0')}-${suffix}`;

    for (const artId of entry.allArticleIds) {
      usedArticleIds.add(artId);
      toReserveIds.push(artId);
    }

    addedEvents.push({
      id: eventId,
      runId,
      rank,
      role: 'reserve',
      title: entry.candidate.title,
      articleIds: entry.allArticleIds,
      category: entry.candidate.category,
      entity: entry.candidate.entity,
      score: entry.candidate.score,
      publicAppeal: entry.candidate.publicAppeal,
      reason: entry.candidate.reason,
      refillRound: round,
    });

    addedItems.push({
      id: itemId,
      runId,
      eventId,
      position: null,
      status: 'queued',
      revision: 0,
      dropReason: null,
      finalJson: null,
      updatedAt: nowIso,
    });
  });

  inTransaction(ctx.db, () => {
    if (toReserveIds.length > 0) {
      ctx.repos.articles.markReserved(toReserveIds, runId);
    }
    if (addedEvents.length > 0) {
      ctx.repos.events.insertMany(addedEvents);
      ctx.repos.runItems.createMany(addedItems);
    }
    ctx.repos.runEvents.append({
      runId,
      ts: nowIso,
      level: addedEvents.length > 0 ? 'info' : 'warn',
      stage: 'select',
      type: 'refill',
      message: `第 ${round} 轮补充选材（回溯 ${lookbackHours} 小时）完成，新增 ${addedEvents.length} 条备选事件`,
      data: {
        round,
        lookbackHours,
        addedEventIds: addedEvents.map((e) => e.id),
      },
    });
  });

  return {
    round,
    lookbackHours,
    addedEvents,
    addedItems,
  };
}
