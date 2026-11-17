import crypto from 'node:crypto';
import type { EventRecord, RunItemRecord, Settings } from '@aidaily/contracts';
import { collectSources } from '../collector/index.js';
import type { CoreContext } from '../context.js';
import { PipelineError } from '../errors.js';
import { inTransaction } from '../storage/db.js';
import { chooseHost, loadPersonas } from './personas.js';
import { runRefillRound } from './refill.js';
import { selectCandidateEvents } from './selection-core.js';

/** 选题阶段完成后的检查点产物 */
export interface SelectCheckpoint {
  selectedCount: number;
  primaryCount: number;
  reserveCount: number;
  eventIds: string[];
  refillRoundsUsed: number;
}

/**
 * 执行新闻聚类选题与占用阶段：
 * 先幂等清理本期既往选题与占用的文章，从默认时效候选池筛选主选与替补事件并锁定文章；
 * 若候选事件不足目标条数，自动触发多轮备用源与放宽时间窗补充，仍不足时以 `insufficient_items` 失败退出。
 */
export async function runSelectStage(
  ctx: CoreContext,
  runId: string,
  settings: Settings,
  signal?: AbortSignal,
): Promise<SelectCheckpoint> {
  const run = ctx.repos.runs.getById(runId);
  if (!run) {
    throw new Error(`未找到任务记录: ${runId}`);
  }
  const itemCount = run.itemCount;

  // 幂等重跑前置清理：先释放本期旧的文章占用并清空旧事件与条目
  inTransaction(ctx.db, () => {
    ctx.repos.articles.releaseByRun(runId);
    ctx.repos.events.deleteByRun(runId);
  });

  const sinceIso = new Date(
    ctx.now().getTime() - settings.issue.freshnessHours * 3600_000,
  ).toISOString();
  const targetCount = itemCount * settings.issue.reserveFactor;

  let initialSelection = await selectCandidateEvents({
    ctx,
    runId,
    settings,
    sinceIso,
    includeExpired: false,
    targetCount,
    itemCount,
    signal,
  });

  let modernBackupUsed = false;
  if (
    settings.issue.minScore !== undefined &&
    initialSelection.selected.length === 0 &&
    settings.issue.refill.useBackupSources
  ) {
    modernBackupUsed = true;
    try {
      await collectSources(ctx, { pool: 'backup', runId, signal, settings });
    } catch (error) {
      if (!(error instanceof PipelineError && error.code === 'collect_all_failed')) throw error;
    }
    initialSelection = await selectCandidateEvents({
      ctx,
      runId,
      settings,
      sinceIso,
      includeExpired: false,
      targetCount,
      itemCount,
      signal,
    });
  }

  const nowIso = ctx.now().toISOString();
  const allEvents: EventRecord[] = [];
  const allItems: RunItemRecord[] = [];
  const usedArticleIds = new Set<string>();
  const initialReserveIds: string[] = [];

  initialSelection.selected.forEach((entry, idx) => {
    const rank = idx + 1;
    const role = idx < itemCount ? 'primary' : 'reserve';
    const suffix = crypto.randomBytes(3).toString('hex');
    const eventId = `ev-${runId}-${String(rank).padStart(2, '0')}-${suffix}`;
    const itemId = `item-${runId}-${String(rank).padStart(2, '0')}-${suffix}`;

    for (const artId of entry.allArticleIds) {
      usedArticleIds.add(artId);
      initialReserveIds.push(artId);
    }

    allEvents.push({
      id: eventId,
      runId,
      rank,
      role,
      title: entry.candidate.title,
      articleIds: entry.allArticleIds,
      category: entry.candidate.category,
      entity: entry.candidate.entity,
      score: entry.candidate.score,
      publicAppeal: entry.candidate.publicAppeal,
      reason: entry.candidate.reason,
      refillRound: 0,
    });

    allItems.push({
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

  const personas = await loadPersonas(ctx);
  const previous = ctx.db
    .prepare(
      'SELECT host_id FROM runs WHERE id != ? AND host_id IS NOT NULL ORDER BY created_at DESC LIMIT 1',
    )
    .get(runId) as { host_id: string } | undefined;
  const current = ctx.db
    .prepare('SELECT host_id, host_manual FROM runs WHERE id = ?')
    .get(runId) as {
    host_id: string | null;
    host_manual: number;
  };
  const host =
    (current.host_manual ? current.host_id : null) ??
    chooseHost(
      allEvents.filter((event) => event.role === 'primary'),
      personas,
      previous?.host_id ?? null,
    );

  inTransaction(ctx.db, () => {
    if (initialReserveIds.length > 0) {
      ctx.repos.articles.markReserved(initialReserveIds, runId);
    }
    if (allEvents.length > 0) {
      ctx.repos.events.insertMany(allEvents);
      ctx.repos.runItems.createMany(allItems);
    }
    ctx.db.prepare('UPDATE runs SET host_id = ? WHERE id = ?').run(host, runId);
  });

  let refillRoundsUsed = 0;
  for (
    let round = 1;
    settings.issue.minScore === undefined &&
    round <= settings.issue.refill.maxRounds &&
    allEvents.length < itemCount;
    round++
  ) {
    if (signal?.aborted) {
      throw new DOMException('已取消', 'AbortError');
    }
    refillRoundsUsed = round;
    const refillRes = await runRefillRound({
      ctx,
      runId,
      round,
      neededCount: itemCount - allEvents.length,
      itemCount,
      settings,
      usedArticleIds,
      existingEventCount: allEvents.length,
      signal,
    });
    allEvents.push(...refillRes.addedEvents);
    allItems.push(...refillRes.addedItems);
  }

  if (settings.issue.minScore === undefined && allEvents.length < itemCount) {
    throw new PipelineError(
      'insufficient_items',
      `候选新闻事件不足：目标 ${itemCount} 条，经 ${refillRoundsUsed} 轮补充后仍仅有 ${allEvents.length} 条`,
    );
  }

  const primaryCount = allEvents.filter((e) => e.role === 'primary').length;
  const reserveCount = allEvents.length - primaryCount;

  return {
    selectedCount: allEvents.length,
    primaryCount,
    reserveCount,
    eventIds: allEvents.map((e) => e.id),
    refillRoundsUsed: modernBackupUsed ? 1 : refillRoundsUsed,
  };
}
