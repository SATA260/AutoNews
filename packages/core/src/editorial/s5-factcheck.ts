import {
  type FactCheckResult,
  FactCheckResultSchema,
  type PolishedItem,
  type Settings,
} from '@aidaily/contracts';
import type { CoreContext } from '../context.js';
import { invokeStageLlm } from './llm.js';
import { describePersonaRelation, formatPersonaForPrompt, getRunPersona } from './personas.js';
import { renderPromptTemplate } from './prompts.js';
import { type LoadedEventArticle, serializeLoadedArticlesXml } from './s3-summarize.js';

/** 强制校正核查结果与逐条陈述判定之间的一致性：存在实质性硬伤时不准直接放行，仅剩轻微措辞微瑕时自动收敛通过 */
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
  if (result.verdict === 'drop') {
    return result;
  }

  const flawedClaims = result.claims.filter((c) => c.status !== 'supported');
  // 未标注严重程度的异常陈述默认按阻断级事实硬伤处理，兼容历史或从严判定输出
  const majorFlawedClaims = flawedClaims.filter((c) => c.severity !== 'minor');

  if (majorFlawedClaims.length > 0) {
    if (result.verdict === 'pass') {
      return {
        ...result,
        verdict: 'revise',
        revisionNotes:
          result.revisionNotes.length > 0
            ? result.revisionNotes
            : majorFlawedClaims.map((c) => `${c.text}: ${c.note || c.status}`),
      };
    }
    if (result.verdict === 'revise' && result.revisionNotes.length === 0) {
      return {
        ...result,
        revisionNotes: majorFlawedClaims.map((c) => `${c.text}: ${c.note || c.status}`),
      };
    }
    return result;
  }

  // 所有核心陈述均已核实或仅存在轻微措辞微瑕时，不再因细枝末节打回重写
  if (result.verdict === 'revise' && result.claims.length > 0) {
    return {
      ...result,
      verdict: 'pass',
      revisionNotes: [],
    };
  }
  if (result.verdict === 'revise' && result.revisionNotes.length === 0) {
    return {
      ...result,
      revisionNotes: ['请重新核对原文数字、可用范围与因果表述，去掉未经证实的内容'],
    };
  }
  return result;
}

/**
 * 执行独立事实核查：
 * 只把原始文章全文与待播稿件文本送入独立核查模型，彻底隔离写稿过程草稿与引文推测，
 * 若发现部分实质性陈述有误则打回修改，若核心事实失真则剔除；复核轮次附带核查员自身上轮批注以防标准漂移。
 */
export async function factCheckPolishedItem(opts: {
  ctx: CoreContext;
  settings: Settings;
  runId: string;
  itemId: string;
  candidate: PolishedItem;
  articlesMap: ReadonlyMap<string, LoadedEventArticle>;
  round: number;
  previousRevisionNotes?: readonly string[];
  signal?: AbortSignal;
}): Promise<FactCheckResult> {
  const {
    ctx,
    settings,
    runId,
    itemId,
    candidate,
    articlesMap,
    round,
    previousRevisionNotes,
    signal,
  } = opts;

  const articlesXml = serializeLoadedArticlesXml(articlesMap, settings.editorial.sourceMaxChars);
  // 严格剥离写稿摘要与引文结构，仅向核查员提供成品稿件各文本字段
  const isolatedDraftPayload = {
    title: candidate.title,
    shortTitle: candidate.shortTitle,
    category: candidate.category,
    entity: candidate.entity,
    summary: candidate.summary,
    highlight: candidate.highlight,
    cards: candidate.cards,
    keyPoints: candidate.keyPoints,
    detail: candidate.detail,
    hostComment: candidate.hostComment,
    narration: candidate.narration,
    officialQuote: candidate.officialQuote,
    metrics: candidate.metrics,
  };

  const priorRoundContext =
    round > 0 && previousRevisionNotes && previousRevisionNotes.length > 0
      ? [
          `## 上一轮复核关注清单（第 ${round} 轮复核）`,
          ...previousRevisionNotes.map((note, idx) => `${idx + 1}. ${note}`),
          '复核纪律：重点确认上述问题是否已改妥、改动处是否引入新的严重事实错误；凡作者已按上一轮要求修改的表述，不得推翻上轮意见或新增细枝末节的措辞挑剔。',
        ].join('\n')
      : '';

  const prompt = await renderPromptTemplate('s5-factcheck.md', {
    articlesXml,
    personaJson: formatPersonaForPrompt(await getRunPersona(ctx, runId), 'null', {
      includeReactions: false,
    }),
    personaRelation: await describePersonaRelation(
      ctx,
      runId,
      itemId,
      `${candidate.title} ${candidate.summary}`,
    ),
    candidateDraftJson: JSON.stringify(isolatedDraftPayload, null, 2),
    priorRoundContext,
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
