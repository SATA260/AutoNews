import {
  type ArticleMediaAsset,
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
import { describePersonaRelation, formatPersonaForPrompt, getRunPersona } from './personas.js';
import { selectGroundedEvidence } from './prechecks.js';
import { renderPromptTemplate } from './prompts.js';
import {
  collectEventMediaPool,
  type LoadedEventArticle,
  serializeLoadedArticlesXml,
} from './s3-summarize.js';

const COMPACT_NARRATION_RULES =
  '严格要求：口播narration为2～5句，总字数40～140字，每句4～46字（普通简讯50～95字，重磅发布或适合点评吐槽的新闻可用95～140字，严禁空洞凑字数）；首句可直接切入主体动作或先来半句紧扣本条新闻具体事实现写的鲜活情绪/吐槽再切入主体，严禁照抄提示词或人设说明里的示例原句，严禁反复套用“又站起来了”“哈哈”“好家伙”“这波”等万金油口头禅，严禁“今天先来看一条…”“接下来关注…”“原因很直接”等AI铺垫套话，结尾说完事实与态度即止，严禁“值得持续关注”“标志新阶段”等拔高套话；标题不超过36字，短标题不超过16字，progressLabel必填且为4～10字顶部进度条极简总结，highlight不超过18字，keyPoints为2～3条且每条不超过15字，cards必填且为2～4张信息卡片（常规3张、简讯2张，一张卡只讲一个事实并按口播先后排列，每张title为2～8字小标题，body为10～28字精炼事实短语且优先写进关键数字、结尾不加句号，icon按卡片事实类型选择，严禁编造原文之外的信息）。口播按单句拆入narration数组，要像鲜活的真人在聊天播报一样自然有情绪，可适时穿插少量客观合理正义的吐槽、反问或开心接梗；主播仅为玩家根据各模型二创的独立虚拟主持人、不能代表任何公司发言（播报原型关联公司或模型时必须直呼具体公司或产品名，严禁使用“我们”“我们团队”“我司”“自家”等代指公司或代表官方发声的措辞，不用生硬说自己是哪个公司的，且所有事实与吐槽都必须建立在原文已核实内容之上）；百分比和货币写成自然中文读法，不要使用括号或波浪号；单句内严禁在中文字符间加空格或用空格代替标点断句；全文主语、宾语和指代清晰无歧义。';

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

/** 构造注入润色与微调提示词的候选配图及截图列表说明 */
function buildAvailableMediaSection(mediaPool: readonly ArticleMediaAsset[]): string {
  if (mediaPool.length === 0) {
    return '';
  }
  const summaryRows = mediaPool.map((asset) => ({
    id: asset.id,
    kind: asset.kind,
    score: asset.score,
    captionHint: asset.captionHint,
    contextSnippet: asset.contextSnippet,
  }));
  return [
    '## 本条新闻可用配图与截图候选列表（JSON）',
    '请优先选用真实高信息密度素材（`tweet_shot` 发言原帖截图、`tweet_media` 推文附图、`chart` 跑分对比图、`table_shot` 评测或定价表格截图、`screenshot` 实机界面或架构图）：',
    '- 每条新闻最多只能展示 1 张配图：请将最核心、最有信息量的一张填入 `primaryMediaId`，并将 `preferArticleImage` 设为 `true`，不要填写 `secondaryMediaId`；',
    '- 若候选列表中仅有普通的 `cover` 网页品牌封面图且无实质信息，请留空不填 `primaryMediaId`，并将 `preferArticleImage` 设为 `false`；',
    '- 若选用了图片，请在 `imageCaption` 中填写不超过 44 字的客观准确图注。',
    JSON.stringify(summaryRows, null, 2),
  ].join('\n');
}

/**
 * 校验并规范化模型选出的主配图编号（每条新闻最多展示 1 张图片）：
 * 剔除不存在的素材编号，模型漏选时自动挂载高分图表或推文截图，过滤低价值纯品牌封面并清空副图字段。
 */
export function normalizePolishedMediaSelection(
  polished: PolishedItem,
  mediaPool: readonly ArticleMediaAsset[],
  settings: Settings,
): PolishedItem {
  if (mediaPool.length === 0) {
    const cleanCaption = polished.imageCaption
      ? Array.from(polished.imageCaption.trim()).slice(0, 44).join('') || undefined
      : undefined;
    return {
      ...polished,
      primaryMediaId: undefined,
      secondaryMediaId: undefined,
      imageCaption: cleanCaption,
    };
  }

  const byId = new Map(mediaPool.map((asset) => [asset.id, asset]));
  let primaryId = polished.primaryMediaId?.trim() || undefined;
  if (primaryId && !byId.has(primaryId)) {
    primaryId = undefined;
  }

  let preferArticleImage = polished.preferArticleImage;
  if (preferArticleImage === false) {
    primaryId = undefined;
  } else {
    if (primaryId) {
      const chosen = byId.get(primaryId);
      if (
        chosen &&
        chosen.kind === 'cover' &&
        chosen.score < 50 &&
        preferArticleImage !== true &&
        settings.issue.minScore !== undefined
      ) {
        primaryId = undefined;
      }
    }

    if (!primaryId) {
      const highValueAssets = mediaPool.filter(
        (asset) => asset.kind !== 'cover' && asset.score >= 80,
      );
      if (highValueAssets[0]) {
        primaryId = highValueAssets[0].id;
        preferArticleImage = true;
      }
    }

    if (primaryId) {
      preferArticleImage = true;
    }
  }

  const rawCaption = polished.imageCaption?.trim();
  const autoCaption =
    !rawCaption && primaryId ? byId.get(primaryId)?.captionHint.trim() : rawCaption;
  const normalizedCaption = autoCaption
    ? Array.from(autoCaption).slice(0, 44).join('') || undefined
    : undefined;

  return {
    ...polished,
    preferArticleImage,
    primaryMediaId: primaryId,
    secondaryMediaId: undefined,
    imageCaption: normalizedCaption,
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

  const mediaPool = articlesMap ? collectEventMediaPool(articlesMap) : [];
  const persona = await getRunPersona(ctx, runId);
  const prompt = await renderPromptTemplate('s4-polish.md', {
    personaJson: formatPersonaForPrompt(persona, '无特定角色', { includeReactions: false }),
    personaRelation: await describePersonaRelation(ctx, runId, itemId, summary.facts.join(' ')),
    narrationRules: settings.issue.minScore !== undefined ? COMPACT_NARRATION_RULES : '',
    availableMediaSection: buildAvailableMediaSection(mediaPool),
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
  const withEvidence: PolishedItem =
    resolvedEvidence.length > 0 ? { ...res.data, evidence: resolvedEvidence } : res.data;
  const normalized = normalizePolishedMediaSelection(withEvidence, mediaPool, settings);

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

  const mediaPool = collectEventMediaPool(articlesMap);
  const articlesXml = serializeLoadedArticlesXml(articlesMap, settings.editorial.sourceMaxChars);
  const persona = await getRunPersona(ctx, runId);
  const prompt = await renderPromptTemplate('s4-revise.md', {
    personaJson: formatPersonaForPrompt(persona, '无特定角色', { includeReactions: false }),
    personaRelation: await describePersonaRelation(ctx, runId, itemId, previous.summary),
    narrationRules: settings.issue.minScore !== undefined ? COMPACT_NARRATION_RULES : '',
    availableMediaSection: buildAvailableMediaSection(mediaPool),
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
  const withEvidence: PolishedItem =
    resolvedEvidence.length > 0 ? { ...res.data, evidence: resolvedEvidence } : res.data;
  const normalized = normalizePolishedMediaSelection(
    {
      ...withEvidence,
      primaryMediaId: withEvidence.primaryMediaId ?? previous.primaryMediaId,
      secondaryMediaId: undefined,
    },
    mediaPool,
    settings,
  );

  ctx.repos.runItems.appendVersion({
    itemId,
    kind: 'revise',
    round,
    payload: normalized,
    createdAt: ctx.now().toISOString(),
  });

  return normalized;
}
