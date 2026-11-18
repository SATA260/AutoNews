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
import { selectGroundedEvidence } from './prechecks.js';
import { renderPromptTemplate } from './prompts.js';
import { type LoadedEventArticle, serializeLoadedArticlesXml } from './s3-summarize.js';

const COMPACT_NARRATION_RULES =
  '严格要求：口播narration为2～5句，总字数40～140字，每句4～46字（简讯45～85字即可收尾，重磅发布最多140字，严禁注水凑字数）；首句开门见山直接说谁发布了什么或据报道发生了什么，严禁“今天先来看一条…”“接下来关注…”“原因很直接”等铺垫套话，结尾把事实与限制交代清楚即止，严禁“值得持续关注”“标志新阶段”等拔高套话；标题不超过36字，短标题不超过16字，progressLabel必填且为4～10字顶部进度条极简总结，highlight不超过18字，keyPoints为2～3条且每条不超过15字，cards必填且为2～8张信息卡片（常规3～6张、简讯2～3张，每张title为2～12字小标题，body为12～48字精炼事实细节，严禁编造原文之外的信息）。口播按单句拆入narration数组，语言精炼克制且像真人在说话，结合当期主播性格与立场自然流露真实反应（但不用生硬说自己是哪个公司的，且情绪只能建立在原文已核实事实上）；百分比和货币写成自然中文读法，不要使用括号或波浪号；单句内严禁在中文字符间加空格或用空格代替标点断句；全文主语、宾语和指代清晰无歧义。';

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
  articlesMap?: ReadonlyMap<string, LoadedEventArticle>;
  round: number;
  signal?: AbortSignal;
}): Promise<PolishedItem> {
  const { ctx, settings, limits, runId, itemId, event, summary, articlesMap, round, signal } = opts;

  const persona = await getRunPersona(ctx, runId);
  const prompt = await renderPromptTemplate('s4-polish.md', {
    personaJson: persona ? JSON.stringify(persona, null, 2) : '无特定角色',
    personaRelation: await describePersonaRelation(ctx, runId, itemId, summary.facts.join(' ')),
    narrationRules: settings.issue.minScore !== undefined ? COMPACT_NARRATION_RULES : '',
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

  // 优先保留通过原文核验的引文依据，既避免润色引入未核实引文，也防止损坏的次要引文拖累整条新闻
  const resolvedEvidence = articlesMap
    ? selectGroundedEvidence(summary.evidence, res.data.evidence, articlesMap)
    : summary.evidence.length > 0
      ? summary.evidence
      : res.data.evidence;
  const normalized: PolishedItem =
    resolvedEvidence.length > 0 ? { ...res.data, evidence: resolvedEvidence } : res.data;

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
    personaRelation: await describePersonaRelation(ctx, runId, itemId, previous.summary),
    narrationRules: settings.issue.minScore !== undefined ? COMPACT_NARRATION_RULES : '',
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
    auditStage: 'revise',
    runId,
    itemId,
    prompt,
    schema,
    signal,
  });

  // 保留已核验通过的原有引文依据；若原有引文损坏而模型在微调中修正了引文，则采用通过核验的新引文，消除死循环
  const resolvedEvidence = selectGroundedEvidence(evidence, res.data.evidence, articlesMap);
  const normalized: PolishedItem =
    resolvedEvidence.length > 0 ? { ...res.data, evidence: resolvedEvidence } : res.data;

  ctx.repos.runItems.appendVersion({
    itemId,
    kind: 'revise',
    round,
    payload: normalized,
    createdAt: ctx.now().toISOString(),
  });

  return normalized;
}
