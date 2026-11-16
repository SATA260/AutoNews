import {
  type FactCheckResult,
  FactCheckResultSchema,
  type PolishedItem,
  type Settings,
} from '@aidaily/contracts';
import type { CoreContext } from '../context.js';
import { invokeStageLlm } from './llm.js';
import { renderPromptTemplate } from './prompts.js';
import { type LoadedEventArticle, serializeLoadedArticlesXml } from './s3-summarize.js';

/** 强制校正核查结果与逐条陈述判定之间的一致性，不允许存在问题陈述或空核查清单却直接放行 */
export function enforceFactCheckConsistency(result: FactCheckResult): FactCheckResult {
  if (result.verdict === 'pass' && result.claims.length === 0) {
    return {
      ...result,
      verdict: 'revise',
      revisionNotes:
        result.revisionNotes.length > 0
          ? result.revisionNotes
          : ['核查结果未包含任何具体陈述核验条目，请补全逐条核查'],
    };
  }
  const flawedClaims = result.claims.filter((c) => c.status !== 'supported');
  if (result.verdict === 'pass' && flawedClaims.length > 0) {
    return {
      ...result,
      verdict: 'revise',
      revisionNotes:
        result.revisionNotes.length > 0
          ? result.revisionNotes
          : flawedClaims.map((c) => `${c.text}: ${c.note || c.status}`),
    };
  }
  if (result.verdict === 'revise' && result.revisionNotes.length === 0) {
    return {
      ...result,
      revisionNotes:
        flawedClaims.length > 0
          ? flawedClaims.map((c) => `${c.text}: ${c.note || c.status}`)
          : ['请重新核对原文数字、可用范围与因果表述，去掉未经证实的内容'],
    };
  }
  return result;
}

/**
 * 执行独立事实核查：
 * 只把原始文章全文与待播稿件文本送入独立核查模型，彻底隔离写稿过程草稿与引文推测，
 * 若发现部分陈述有误则打回修改，若核心事实失真则剔除。
 */
export async function factCheckPolishedItem(opts: {
  ctx: CoreContext;
  settings: Settings;
  runId: string;
  itemId: string;
  candidate: PolishedItem;
  articlesMap: ReadonlyMap<string, LoadedEventArticle>;
  round: number;
  signal?: AbortSignal;
}): Promise<FactCheckResult> {
  const { ctx, settings, runId, itemId, candidate, articlesMap, round, signal } = opts;

  const articlesXml = serializeLoadedArticlesXml(articlesMap, settings.editorial.sourceMaxChars);
  // 严格剥离写稿摘要与引文结构，仅向核查员提供成品稿件各文本字段
  const isolatedDraftPayload = {
    title: candidate.title,
    shortTitle: candidate.shortTitle,
    category: candidate.category,
    entity: candidate.entity,
    summary: candidate.summary,
    keyPoints: candidate.keyPoints,
    detail: candidate.detail,
    hostComment: candidate.hostComment,
    narration: candidate.narration,
    officialQuote: candidate.officialQuote,
    metrics: candidate.metrics,
  };

  const prompt = await renderPromptTemplate('s5-factcheck.md', {
    articlesXml,
    candidateDraftJson: JSON.stringify(isolatedDraftPayload, null, 2),
  });

  const res = await invokeStageLlm({
    ctx,
    settings,
    stage: 'factcheck',
    runId,
    itemId,
    prompt,
    schema: FactCheckResultSchema,
    signal,
  });

  const normalized = enforceFactCheckConsistency(res.data);

  ctx.repos.runItems.appendVersion({
    itemId,
    kind: 'factcheck',
    round,
    payload: normalized,
    createdAt: ctx.now().toISOString(),
  });

  return normalized;
}
