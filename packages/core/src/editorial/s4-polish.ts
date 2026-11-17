import {
  type ContentLimits,
  createPolishedItemSchema,
  type EventRecord,
  type Evidence,
  type PolishedItem,
  type Settings,
  type SummaryDraft,
} from '@aidaily/contracts';
import type { CoreContext } from '../context.js';
import { invokeStageLlm } from './llm.js';
import { describePersonaRelation, getRunPersona } from './personas.js';
import { renderPromptTemplate } from './prompts.js';
import { type LoadedEventArticle, serializeLoadedArticlesXml } from './s3-summarize.js';

/** 解析融合模板覆写上限后的实际文案字数约束 */
export function resolveContentLimits(
  settings: Settings,
  override?: Partial<ContentLimits>,
): ContentLimits {
  return {
    ...settings.contentLimits,
    ...override,
  };
}

/** 将事实摘要草稿润色成符合中文口播习惯和字数约束的展示定稿初版 */
export async function polishItemDraft(opts: {
  ctx: CoreContext;
  settings: Settings;
  limits: ContentLimits;
  runId: string;
  itemId: string;
  event: EventRecord;
  summary: SummaryDraft;
  round: number;
  signal?: AbortSignal;
}): Promise<PolishedItem> {
  const { ctx, settings, limits, runId, itemId, event, summary, round, signal } = opts;

  const persona = await getRunPersona(ctx, runId);
  const prompt = await renderPromptTemplate('s4-polish.md', {
    personaJson: persona ? JSON.stringify(persona, null, 2) : '无特定角色',
    personaRelation: await describePersonaRelation(ctx, runId, itemId),
    narrationRules:
      settings.issue.minScore !== undefined
        ? '严格要求：4～7句，总字数110～180字，每句14～30字；标题不超过22字，短标题不超过16字，highlight不超过18字，keyPoints为2～3条且每条不超过15字。百分比和货币应写成中文读法，不要使用括号、波浪号或多余空格。'
        : '',
    eventTitle: event.title,
    category: event.category ?? 'AI 资讯',
    entity: event.entity ?? 'AI',
    summaryDraftJson: JSON.stringify(summary, null, 2),
    contentLimitsJson: JSON.stringify(limits, null, 2),
  });

  const schema = createPolishedItemSchema(limits.keyPointsMax);
  const res = await invokeStageLlm({
    ctx,
    settings,
    stage: 'polish',
    runId,
    itemId,
    prompt,
    schema,
    signal,
  });

  // 强制保留前序总结提取的原文引文依据，避免润色改写引入未核实的引文
  const normalized: PolishedItem =
    summary.evidence.length > 0 ? { ...res.data, evidence: summary.evidence } : res.data;

  ctx.repos.runItems.appendVersion({
    itemId,
    kind: 'polish',
    round,
    payload: normalized,
    createdAt: ctx.now().toISOString(),
  });

  return normalized;
}

/** 根据规则预检或事实核查批注，只针对问题点对润色稿执行局部微调 */
export async function revisePolishedItem(opts: {
  ctx: CoreContext;
  settings: Settings;
  limits: ContentLimits;
  runId: string;
  itemId: string;
  previous: PolishedItem;
  revisionNotes: string[];
  evidence: Evidence[];
  articlesMap: ReadonlyMap<string, LoadedEventArticle>;
  round: number;
  signal?: AbortSignal;
}): Promise<PolishedItem> {
  const {
    ctx,
    settings,
    limits,
    runId,
    itemId,
    previous,
    revisionNotes,
    evidence,
    articlesMap,
    round,
    signal,
  } = opts;

  const articlesXml = serializeLoadedArticlesXml(articlesMap, settings.editorial.sourceMaxChars);
  const persona = await getRunPersona(ctx, runId);
  const prompt = await renderPromptTemplate('s4-revise.md', {
    personaJson: persona ? JSON.stringify(persona, null, 2) : '无特定角色',
    personaRelation: await describePersonaRelation(ctx, runId, itemId),
    narrationRules:
      settings.issue.minScore !== undefined
        ? '严格要求：4～7句，总字数110～180字，每句14～30字；标题不超过22字，短标题不超过16字，highlight不超过18字，keyPoints为2～3条且每条不超过15字。百分比和货币应写成中文读法，不要使用括号、波浪号或多余空格。'
        : '',
    previousItemJson: JSON.stringify(previous, null, 2),
    revisionNotesJson: JSON.stringify(revisionNotes, null, 2),
    evidenceJson: JSON.stringify(evidence, null, 2),
    articlesXml,
    contentLimitsJson: JSON.stringify(limits, null, 2),
  });

  const schema = createPolishedItemSchema(limits.keyPointsMax);
  const res = await invokeStageLlm({
    ctx,
    settings,
    stage: 'polish',
    runId,
    itemId,
    prompt,
    schema,
    signal,
  });

  // 强制保留已核验的原文引文依据，微调只改表达不改引文依据
  const normalized: PolishedItem = evidence.length > 0 ? { ...res.data, evidence } : res.data;

  ctx.repos.runItems.appendVersion({
    itemId,
    kind: 'revise',
    round,
    payload: normalized,
    createdAt: ctx.now().toISOString(),
  });

  return normalized;
}
