import {
  type ArticleMediaAsset,
  type ContentLimits,
  createPolishedItemSchema,
  type EventNature,
  type EventRecord,
  type Evidence,
  type IssueMode,
  type PolishedItem,
  type Settings,
  type SummaryDraft,
} from '@aidaily/contracts';
import { TZDate } from '@date-fns/tz';
import { format } from 'date-fns';
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

/** 按头条/专场/短讯档位生成简洁的口播节奏与格式要求，避免超长禁令墙引发机器腔 */
export function buildNarrationRules(opts: {
  isHeadline: boolean;
  issueMode: IssueMode;
  settings: Settings;
}): string {
  const headlineMax = opts.settings.editorial.headlineNarrationMaxChars ?? 180;
  const briefMax = opts.settings.editorial.briefNarrationMaxChars ?? 95;
  const rangeText =
    opts.isHeadline && opts.issueMode === 'spotlight'
      ? '4～8 句，总长 140～260 字（重磅专场头条，讲透变化、实测影响与限制）'
      : opts.isHeadline
        ? `3～6 句，总长 100～${headlineMax} 字（本期头条，讲清用途、关键数字与限制）`
        : `2～4 句，总长 45～${briefMax} 字（次要短讯，干脆利落讲完就停）`;
  return `口播档位要求：narration 为 ${rangeText}，每句 4～46 字；标题 ≤ 36 字，短标题 ≤ 16 字，progressLabel 为 4～10 字，highlight ≤ 18 字，keyPoints 为 2～3 条（每条 ≤ 15 字），cards 为 2～4 张（每张 title 2～8 字、body 10～28 字且不加句号）。保持像真人微信语音聊天一样自然流畅，遇到明显高门槛/翻车/反差再按主播性格自然吐槽一句，普通进展说完即止；单句内不在中文字符间加空格，不含 URL 或 Markdown 符号。`;
}

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
    '请优先选用真实高信息密度素材（`tweet_shot` 发言原帖截图、`tweet_media` 推文附图、`chart` 跑分对比图、`table_shot` 评测或定价表格截图、`github_card` GitHub 开源项目卡片、`changelog_shot` 官方更新日志截图、`article_section` 去弹窗原文核心截图、`screenshot` 实机界面或架构图）：',
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
        settings.editorial.requireImageOptIn
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

/** 构造注入润色与微调提示词的时间与来源背景说明，防止误将旧闻或第三方盘点写成最新首发 */
function buildArticleTimeContext(opts: {
  ctx: CoreContext;
  settings: Settings;
  articlesMap?: ReadonlyMap<string, LoadedEventArticle>;
  eventNature?: EventNature;
}): string {
  const { ctx, settings, articlesMap, eventNature } = opts;
  const nowDate = ctx.now();
  const nowMs = nowDate.getTime();
  const tzNow = new TZDate(nowMs, settings.timezone);
  const lines = [
    '## 当前任务时间与原文来源时效背景',
    `- 当前时间：${format(tzNow, 'yyyy-MM-dd HH:mm')}（${settings.timezone}，UTC: ${nowDate.toISOString()}）`,
  ];
  if (eventNature) {
    lines.push(`- 事件性质判定：${eventNature}`);
  }
  if (articlesMap && articlesMap.size > 0) {
    for (const art of articlesMap.values()) {
      const pubMs = art.publishedAt ? Date.parse(art.publishedAt) : Number.NaN;
      const pubLabel = !Number.isNaN(pubMs)
        ? `${format(new TZDate(pubMs, settings.timezone), 'yyyy-MM-dd HH:mm')}（距今约 ${Math.max(0, Math.round(((nowMs - pubMs) / 3600_000) * 10) / 10)} 小时）`
        : '未知发布时间';
      lines.push(`- 原文 [${art.sourceName}]（${art.title}）：发布于 ${pubLabel}`);
    }
  }
  if (eventNature === 'benchmark_or_recap') {
    lines.push(
      '- **重要提醒**：本条属于第三方评测/盘点回顾，严禁使用“刚发布/刚披露/刚曝光/首次公布/亮相”等首发措辞，必须写明具体机构盘点或实测视角。',
    );
  }
  return lines.join('\n');
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
  isHeadline?: boolean;
  issueMode?: IssueMode;
  signal?: AbortSignal;
}): Promise<PolishedItem> {
  const {
    ctx,
    settings,
    limits,
    runId,
    itemId,
    event,
    summary,
    articlesMap,
    round,
    isHeadline = event.rank === 1,
    issueMode = 'digest',
    signal,
  } = opts;

  const mediaPool = articlesMap ? collectEventMediaPool(articlesMap) : [];
  const persona = await getRunPersona(ctx, runId);
  const tierHint =
    isHeadline && issueMode === 'spotlight'
      ? '重磅专场头条（可充分展开讲透背景、实测、价格与边界）'
      : isHeadline
        ? '本期头条（35～45 秒，重点讲清影响与上手方式）'
        : '常规/次要短讯（10～15 秒，短平快讲清事实即止）';
  const prompt = await renderPromptTemplate('s4-polish.md', {
    personaJson: formatPersonaForPrompt(persona, '无特定角色', { includeReactions: true }),
    personaRelation: await describePersonaRelation(ctx, runId, itemId, summary.facts.join(' ')),
    narrationRules: settings.editorial.compactStyle
      ? buildNarrationRules({ isHeadline, issueMode, settings })
      : '',
    tierHint,
    timeContext: buildArticleTimeContext({
      ctx,
      settings,
      articlesMap,
      eventNature: summary.eventNature,
    }),
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
  isHeadline?: boolean;
  issueMode?: IssueMode;
  eventNature?: EventNature;
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
    isHeadline = previous.isHeadlineTier === true,
    issueMode = 'digest',
    eventNature,
    signal,
  } = opts;

  const mediaPool = collectEventMediaPool(articlesMap);
  const articlesXml = serializeLoadedArticlesXml(articlesMap, settings.editorial.sourceMaxChars);
  const persona = await getRunPersona(ctx, runId);
  const prompt = await renderPromptTemplate('s4-revise.md', {
    personaJson: formatPersonaForPrompt(persona, '无特定角色', { includeReactions: true }),
    personaRelation: await describePersonaRelation(ctx, runId, itemId, previous.summary),
    narrationRules: settings.editorial.compactStyle
      ? buildNarrationRules({ isHeadline, issueMode, settings })
      : '',
    timeContext: buildArticleTimeContext({
      ctx,
      settings,
      articlesMap,
      eventNature,
    }),
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
