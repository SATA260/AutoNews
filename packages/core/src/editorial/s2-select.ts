import crypto from 'node:crypto';
import type {
  EventRecord,
  HostMascotId,
  PersonaProfile,
  RunItemRecord,
  Settings,
} from '@aidaily/contracts';
import { collectSources } from '../collector/index.js';
import type { CoreContext } from '../context.js';
import { PipelineError } from '../errors.js';
import { resolvePersonaBgmFile } from '../media/bgm.js';
import { inTransaction } from '../storage/db.js';
import { emitRunEvent } from '../workflow/events.js';
import {
  chooseHost,
  findPreviousHostId,
  formatEligibleHostCandidatesForPrompt,
  loadPersonas,
} from './personas.js';
import { runRefillRound } from './refill.js';
import { selectCandidateEvents } from './selection-core.js';

/** 为本期最终选定的事件列表确定主播形象与唯一对应的背景音乐，自动选择时避开上一期 */
async function finalizeRunHostAndBgm(opts: {
  ctx: CoreContext;
  runId: string;
  personas: readonly PersonaProfile[];
  events: readonly EventRecord[];
  manualHostId: string | null;
  previousHostId: HostMascotId | null;
  aiRecommendedHostId?: HostMascotId;
  aiRecommendedHostReason?: string;
  allowAiRecommendation: boolean;
}): Promise<void> {
  const {
    ctx,
    runId,
    personas,
    events,
    manualHostId,
    previousHostId,
    aiRecommendedHostId,
    aiRecommendedHostReason,
    allowAiRecommendation,
  } = opts;
  const primary = events.filter((event) => event.role === 'primary');
  const scoringEvents = primary.length > 0 ? primary : events;

  const extraTextByEventId = new Map<string, string>();
  const allArticleIds = Array.from(new Set(scoringEvents.flatMap((event) => event.articleIds)));
  if (allArticleIds.length > 0) {
    const articles = ctx.repos.articles.getByIds(allArticleIds);
    const articleMap = new Map(articles.map((article) => [article.id, article]));
    for (const event of scoringEvents) {
      const joined = event.articleIds
        .map((id) => articleMap.get(id))
        .filter((article): article is NonNullable<typeof article> => Boolean(article))
        .map((article) => `${article.title} ${article.excerpt ?? ''}`)
        .join(' ');
      if (joined) {
        extraTextByEventId.set(event.id, joined);
      }
    }
  }

  let host: string | null = null;
  let source: 'manual' | 'ai_select' | 'rule_fallback' | 'none' = 'none';
  let reason = '';

  if (manualHostId) {
    host = manualHostId;
    source = 'manual';
    reason = '沿用人工指定主播形象';
  } else if (personas.length > 0) {
    const aiValid =
      allowAiRecommendation &&
      aiRecommendedHostId !== undefined &&
      personas.some((persona) => persona.id === aiRecommendedHostId) &&
      (personas.length <= 1 || aiRecommendedHostId !== previousHostId);
    if (aiValid && aiRecommendedHostId) {
      host = aiRecommendedHostId;
      source = 'ai_select';
      reason = aiRecommendedHostReason ?? '按本期新闻内容由选题模型自动匹配';
    } else {
      host = chooseHost(scoringEvents, personas, previousHostId, extraTextByEventId);
      source = host ? 'rule_fallback' : 'none';
      reason =
        aiRecommendedHostId && aiRecommendedHostId === previousHostId
          ? `选题模型推荐的 ${aiRecommendedHostId} 与上一期相同，已按避重规则改选 ${host ?? '无'}`
          : '按事件阵营、话题与正文字段匹配主播形象';
    }
  }

  const boundBgm = host ? await resolvePersonaBgmFile(ctx, host, personas) : null;
  if (boundBgm) {
    ctx.db
      .prepare('UPDATE runs SET host_id = ?, bgm_file = ? WHERE id = ?')
      .run(host, boundBgm, runId);
  } else {
    ctx.db.prepare('UPDATE runs SET host_id = ? WHERE id = ?').run(host, runId);
  }

  if (host) {
    emitRunEvent(ctx, {
      runId,
      level: 'info',
      stage: 'select',
      type: 'host_selected',
      message: `已确定本期主播形象为 ${host}${boundBgm ? `，并绑定专属背景音乐 ${boundBgm}` : ''}（${reason}）`,
      data: {
        hostId: host,
        bgmFile: boundBgm,
        previousHostId,
        source,
        reason,
      },
    });
  }
}

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
 * 先幂等清理本期既往选题与占用的文章，在默认时效或设定的最早时间限制内筛选主选与替补事件并锁定文章；
 * 若候选事件不足目标条数，在严守最早时间限制的前提下触发备用信源补充，设定硬性时间下限时宁少勿滥绝不越界回溯。
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
  const notBeforeAt = run.notBeforeAt ?? null;
  const notBeforeMs = notBeforeAt ? Date.parse(notBeforeAt) : Number.NaN;
  const hasCutoff = !Number.isNaN(notBeforeMs);

  // 幂等重跑前置清理：先释放本期旧的文章占用并清空旧事件与条目
  inTransaction(ctx.db, () => {
    ctx.repos.articles.releaseByRun(runId);
    ctx.repos.events.deleteByRun(runId);
  });

  const defaultSinceMs = ctx.now().getTime() - settings.issue.freshnessHours * 3600_000;
  const maxLookbackMs = ctx.now().getTime() - settings.issue.refill.maxLookbackHours * 3600_000;
  const sinceIso = hasCutoff
    ? new Date(notBeforeMs).toISOString()
    : new Date(defaultSinceMs).toISOString();
  const initialIncludeExpired = hasCutoff && notBeforeMs < maxLookbackMs;
  const targetCount = itemCount * settings.issue.reserveFactor;

  const personas = await loadPersonas(ctx);
  const currentHostRow = ctx.db
    .prepare('SELECT host_id, host_manual FROM runs WHERE id = ?')
    .get(runId) as { host_id: string | null; host_manual: number } | undefined;
  const manualHostId = currentHostRow?.host_manual ? currentHostRow.host_id : null;
  const previousHostId = findPreviousHostId(ctx, runId, run.createdAt);
  const hostSelectionRule =
    !manualHostId && personas.length > 0
      ? formatEligibleHostCandidatesForPrompt(personas, previousHostId)
      : '';

  let initialSelection = await selectCandidateEvents({
    ctx,
    runId,
    settings,
    sinceIso,
    notBeforeAt,
    includeExpired: initialIncludeExpired,
    targetCount,
    itemCount,
    hostSelectionRule,
    signal,
  });

  let modernBackupUsed = false;
  if (
    settings.issue.allowPartial &&
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
      notBeforeAt,
      includeExpired: initialIncludeExpired,
      targetCount,
      itemCount,
      hostSelectionRule,
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

  inTransaction(ctx.db, () => {
    if (initialReserveIds.length > 0) {
      ctx.repos.articles.markReserved(initialReserveIds, runId);
    }
    if (allEvents.length > 0) {
      ctx.repos.events.insertMany(allEvents);
      ctx.repos.runItems.createMany(allItems);
    }
    if (manualHostId) {
      ctx.db.prepare('UPDATE runs SET host_id = ? WHERE id = ?').run(manualHostId, runId);
    }
  });

  let refillRoundsUsed = 0;
  for (
    let round = 1;
    !settings.issue.allowPartial &&
    round <= settings.issue.refill.maxRounds &&
    allEvents.length < itemCount;
    round++
  ) {
    if (signal?.aborted) {
      throw new DOMException('已取消', 'AbortError');
    }
    // 已设定的最早时间已卡死或比默认时效更紧时，仅首轮允许启用备用信源抓取，后续轮次不再向更早时间扩窗
    if (
      hasCutoff &&
      notBeforeMs >= defaultSinceMs &&
      (round > 1 || !settings.issue.refill.useBackupSources)
    ) {
      break;
    }
    refillRoundsUsed = round;
    const refillRes = await runRefillRound({
      ctx,
      runId,
      round,
      neededCount: itemCount - allEvents.length,
      itemCount,
      settings,
      notBeforeAt,
      usedArticleIds,
      existingEventCount: allEvents.length,
      signal,
    });
    allEvents.push(...refillRes.addedEvents);
    allItems.push(...refillRes.addedItems);
  }

  if (hasCutoff) {
    if (allEvents.length === 0) {
      throw new PipelineError(
        'insufficient_items',
        `在设定的最早新闻时间（${notBeforeAt}）之后未找到符合条件的新闻事件，请适当放宽最早时间后再试`,
      );
    }
    if (allEvents.length < itemCount) {
      emitRunEvent(ctx, {
        runId,
        level: 'info',
        stage: 'select',
        type: 'cutoff_partial_selection',
        message: `在设定的最早时间之后共选出 ${allEvents.length} 条可用事件（少于上限 ${itemCount} 条），坚持宁缺毋滥原则不回溯更早旧闻`,
        data: { notBeforeAt, selectedCount: allEvents.length, itemCount },
      });
    }
  } else if (!settings.issue.allowPartial && allEvents.length < itemCount) {
    throw new PipelineError(
      'insufficient_items',
      `候选新闻事件不足：目标 ${itemCount} 条，经 ${refillRoundsUsed} 轮补充后仍仅有 ${allEvents.length} 条`,
    );
  }

  const primaryCount = allEvents.filter((e) => e.role === 'primary').length;
  const reserveCount = allEvents.length - primaryCount;

  await finalizeRunHostAndBgm({
    ctx,
    runId,
    personas,
    events: allEvents,
    manualHostId,
    previousHostId,
    aiRecommendedHostId: initialSelection.recommendedHostId,
    aiRecommendedHostReason: initialSelection.recommendedHostReason,
    allowAiRecommendation: initialSelection.selected.length > 0,
  });

  return {
    selectedCount: allEvents.length,
    primaryCount,
    reserveCount,
    eventIds: allEvents.map((e) => e.id),
    refillRoundsUsed: modernBackupUsed ? 1 : refillRoundsUsed,
  };
}
