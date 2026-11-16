import type { CoreContext } from '../context.js';

/**
 * 将发布时间早于最久回溯时效窗口的未选用文章标记为已过期，避免过期旧闻长期停留在默认候选池中。
 */
export function expireOldArticles(ctx: CoreContext, maxLookbackHours?: number): number {
  const hours = maxLookbackHours ?? ctx.settings.issue.refill.maxLookbackHours;
  const cutoffIso = new Date(ctx.now().getTime() - hours * 3600_000).toISOString();
  return ctx.repos.articles.expireOlderThan(cutoffIso);
}
