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

  const prompt = await renderPromptTemplate('s4-polish.md', {
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

  ctx.repos.runItems.appendVersion({
    itemId,
    kind: 'polish',
    round,
    payload: res.data,
    createdAt: ctx.now().toISOString(),
  });

  return res.data;
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
  const prompt = await renderPromptTemplate('s4-revise.md', {
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

  ctx.repos.runItems.appendVersion({
    itemId,
    kind: 'revise',
    round,
    payload: res.data,
    createdAt: ctx.now().toISOString(),
  });

  return res.data;
}
