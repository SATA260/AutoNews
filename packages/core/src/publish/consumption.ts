import type { RunStatus } from '@aidaily/contracts';
import { normalizeTitle } from '../collector/canonical-url.js';
import type { CoreContext } from '../context.js';
import { inTransaction } from '../storage/db.js';

/** 单期新闻消费提交完成后返回的统计结果 */
export interface ConsumptionCommitResult {
  consumedArticleCount: number;
  historyInsertedCount: number;
  releasedUnusedCount: number;
}

/**
 * 在单一数据库事务内提交本期新闻消费状态：
 * 1) 可选核验任务当前仍处于预期允许提交的状态，防止并发修改或已驳回任务误提交；
 * 2) 把最终播出条目涉及的原文章正式标记为已消费，避免以后重复挑选；
 * 3) 把每条已播事件写入历史已播库供跨天相似度排重；
 * 4) 释放本期仅预留但最终未入选或被剔除的其余文章回到待选池；
 * 5) 同步执行调用方传入的任务与投稿终态更新，保证全部修改要么同时成功、要么完整回滚。
 */
export function commitRunConsumption(
  ctx: CoreContext,
  runId: string,
  nowIso: string,
  onCommittedInsideTx?: (stats: ConsumptionCommitResult) => void,
  opts?: { expectedRunStatuses?: readonly RunStatus[] },
): ConsumptionCommitResult {
  return inTransaction(ctx.db, () => {
    const run = ctx.repos.runs.getById(runId);
    if (!run) {
      throw new Error(`提交消费失败：未找到任务记录 ${runId}`);
    }
    if (opts?.expectedRunStatuses && !opts.expectedRunStatuses.includes(run.status)) {
      throw new Error(`提交消费失败：任务 ${runId} 当前状态为 ${run.status}，不允许提交已播消费`);
    }

    const events = ctx.repos.events.listByRun(runId);
    const eventById = new Map(events.map((e) => [e.id, e]));

    const passedItems = ctx.repos.runItems
      .listByRun(runId)
      .filter((item) => item.status === 'passed')
      .sort((a, b) => (a.position ?? 9999) - (b.position ?? 9999));

    const usedArticleIdSet = new Set<string>();
    const historyTargets: Array<{
      eventId: string;
      title: string;
      entity: string | null;
      articleIds: string[];
    }> = [];

    for (const item of passedItems) {
      const ev = eventById.get(item.eventId);
      if (!ev) {
        throw new Error(`提交消费失败：未找到已通过条目 ${item.id} 对应的事件记录 ${item.eventId}`);
      }
      const evidenceIds = (item.finalJson?.evidence ?? []).map((e) => e.articleId);
      const itemArticleIds = Array.from(new Set([...ev.articleIds, ...evidenceIds]));
      for (const artId of itemArticleIds) {
        usedArticleIdSet.add(artId);
      }
      historyTargets.push({
        eventId: ev.id,
        title: ev.title,
        entity: ev.entity,
        articleIds: itemArticleIds,
      });
    }

    const usedArticleIds = Array.from(usedArticleIdSet);
    const updatedConsumedCount = ctx.repos.articles.markConsumed(usedArticleIds, runId);

    const allArticles = ctx.repos.articles.getByIds(usedArticleIds);
    const articleById = new Map(allArticles.map((a) => [a.id, a]));
    for (const artId of usedArticleIds) {
      const art = articleById.get(artId);
      if (art?.status !== 'consumed') {
        throw new Error(`提交消费失败：文章 ${artId} 当前未处于本任务有效占用或已消费状态`);
      }
    }

    for (const target of historyTargets) {
      const articleUrls = target.articleIds
        .map((id) => articleById.get(id)?.canonicalUrl)
        .filter((url): url is string => Boolean(url));
      ctx.repos.history.insert({
        eventId: target.eventId,
        runId,
        title: target.title,
        titleNorm: normalizeTitle(target.title),
        entity: target.entity,
        articleUrls,
        publishedAt: nowIso,
      });
    }

    const releasedUnusedCount = ctx.repos.articles.releaseByRun(runId);
    const stats: ConsumptionCommitResult = {
      consumedArticleCount: updatedConsumedCount > 0 ? updatedConsumedCount : usedArticleIds.length,
      historyInsertedCount: historyTargets.length,
      releasedUnusedCount,
    };

    onCommittedInsideTx?.(stats);
    return stats;
  });
}
