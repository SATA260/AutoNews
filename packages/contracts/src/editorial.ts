import { z } from 'zod';
import { HostMascotIdSchema } from './persona.js';

/** 原文依据条目：把总结中的某句事实陈述对应到原始文章和原文逐字摘录 */
export const EvidenceSchema = z.object({
  claim: z.string().min(1),
  articleId: z.string().min(1),
  quote: z.string().min(1),
});
/** 原文依据条目类型 */
export type Evidence = z.infer<typeof EvidenceSchema>;

/** 把模型给出的分数收成 1 到 10。略微超出时压到 10；明显按百分制打分时再除以 10 */
function normalizeTenPointScore(value: number): number {
  let score = value;
  if (score > 10 && score <= 100) {
    score = score >= 20 ? score / 10 : 10;
  }
  if (score > 10) {
    score = 10;
  }
  if (score < 1) {
    score = 1;
  }
  return Math.round(score * 10) / 10;
}

/** 选题分数：允许模型偶尔按百分制打分，保存前统一折成 1 到 10 */
const TenPointScoreSchema = z.number().transform((value) => normalizeTenPointScore(value));

/** 将多篇报道同一事件的文章合并后得到的新闻候选事件 */
export const SelectedEventCandidateSchema = z.object({
  title: z.string().min(1),
  articleIds: z.preprocess(
    (value) => (typeof value === 'string' && value.trim() ? [value.trim()] : value),
    z.array(z.string().min(1)).min(1),
  ),
  category: z.string().min(1),
  entity: z.string().min(1),
  score: TenPointScoreSchema,
  publicAppeal: TenPointScoreSchema,
  reason: z.string().min(1),
  duplicateOfHistory: z.boolean(),
});
/** 新闻候选事件类型 */
export type SelectedEventCandidate = z.infer<typeof SelectedEventCandidateSchema>;

/** 新闻选题与合并阶段的完整输出结构 */
export const SelectionResultSchema = z.object({
  events: z.array(SelectedEventCandidateSchema),
  hostId: HostMascotIdSchema.optional(),
  hostReason: z.string().min(1).optional(),
});
/** 新闻选题输出结果类型 */
export type SelectionResult = z.infer<typeof SelectionResultSchema>;

/** 产品或技术的可用范围标记，用于区分现在能否直接用、还是仅有预览或预告 */
export const AvailabilitySchema = z.enum([
  'available_now',
  'paid_only',
  'limited_preview',
  'announced_only',
  'open_source',
  'research',
  'unknown',
]);
/** 可用范围标记类型 */
export type Availability = z.infer<typeof AvailabilitySchema>;

/** 对同一新闻事件提炼出的客观事实摘要草稿 */
export const SummaryDraftSchema = z.object({
  facts: z.array(z.string().min(1)).min(1).max(10),
  relevance: z.string().min(1),
  availability: AvailabilitySchema,
  availabilityNote: z.string().min(1),
  evidence: z.array(EvidenceSchema).min(1),
  eventOccurredAt: z.string().optional(),
});
/** 事实摘要草稿类型 */
export type SummaryDraft = z.infer<typeof SummaryDraftSchema>;

/** 画面展示用的关键数据指标键值对 */
export const MetricPairSchema = z.object({
  label: z.string().min(1),
  value: z.string().min(1),
});
/** 关键数据指标类型 */
export type MetricPair = z.infer<typeof MetricPairSchema>;

/**
 * 新闻信息卡片语义图标标识（与视频模板的预置图标清单一致）。
 * 最后两项 grid、clipboard-check 是旧版名称，只为兼容历史数据保留，新内容不再使用。
 */
export const InfoCardIconSchema = z.enum([
  'rocket',
  'smartphone',
  'cloud',
  'gift',
  'brain',
  'cpu',
  'gauge',
  'zap',
  'database',
  'code',
  'unlock',
  'flask',
  'trophy',
  'banknote',
  'coins',
  'candlestick',
  'trending-up',
  'trending-down',
  'building',
  'users',
  'user-minus',
  'handshake',
  'quote',
  'shield',
  'gavel',
  'landmark',
  'alert',
  'globe',
  'calendar',
  'sparkles',
  'grid',
  'clipboard-check',
]);
/** 新闻信息卡片语义图标类型 */
export type InfoCardIcon = z.infer<typeof InfoCardIconSchema>;

/** 画面网格中展示的单张结构化事实信息卡片 */
export const InfoCardSchema = z.object({
  title: z.string().min(1).max(16),
  body: z.string().min(1).max(80),
  icon: InfoCardIconSchema.optional(),
});
/** 结构化事实信息卡片类型 */
export type InfoCard = z.infer<typeof InfoCardSchema>;

/** 看板娘随新闻内容呈现的表情状态 */
export const MascotMoodSchema = z.enum(['neutral', 'proud', 'surprised', 'thinking']);
/** 看板娘表情状态类型 */
export type MascotMood = z.infer<typeof MascotMoodSchema>;

/** 按指定核心要点数量上限构建单条新闻润色定稿校验规则 */
export function createPolishedItemSchema(keyPointsMax = 3) {
  return z.object({
    title: z.string().min(1),
    shortTitle: z.string().min(1),
    progressLabel: z.string().min(1).max(12),
    category: z.string().min(1),
    entity: z.string().min(1),
    summary: z.string().min(1),
    highlight: z.string().max(18).optional(),
    preferArticleImage: z.boolean().optional(),
    primaryMediaId: z.string().optional(),
    secondaryMediaId: z.string().optional(),
    imageCaption: z.string().max(44).optional(),
    cards: z.array(InfoCardSchema).max(8).optional(),
    keyPoints: z.array(z.string().min(1)).max(Math.max(1, keyPointsMax)),
    detail: z.string().min(1),
    hostComment: z.string().min(1),
    narration: z.array(z.string().min(1)).min(1),
    evidence: z.array(EvidenceSchema).min(1),
    officialQuote: z.string().optional(),
    metrics: z.array(MetricPairSchema).max(4).optional(),
  });
}

/** 经过中文口播润色后的单条新闻定稿（包含屏幕展示文案和语音播报分句） */
export const PolishedItemSchema = createPolishedItemSchema(3);
/** 中文润色定稿类型 */
export type PolishedItem = z.infer<typeof PolishedItemSchema>;

/** 事实审核员对单句陈述给出的核验状态（有依据、无依据、曲解、夸大或过时） */
export const ClaimStatusSchema = z.enum([
  'supported',
  'unsupported',
  'distorted',
  'exaggerated',
  'outdated',
]);
/** 事实核验状态类型 */
export type ClaimStatus = z.infer<typeof ClaimStatusSchema>;

/** 事实核验问题严重程度：major 表示阻断过审的客观事实错误，minor 表示不阻断过审的轻微措辞微瑕 */
export const ClaimSeveritySchema = z.enum(['major', 'minor']);
/** 事实核验问题严重程度类型 */
export type ClaimSeverity = z.infer<typeof ClaimSeveritySchema>;

/** 事实审核中对单条陈述的具体检查结果与说明 */
export const FactCheckClaimSchema = z.object({
  text: z.string().min(1),
  status: ClaimStatusSchema,
  severity: ClaimSeveritySchema.optional(),
  note: z.string(),
});
/** 单条事实检查结果类型 */
export type FactCheckClaim = z.infer<typeof FactCheckClaimSchema>;

/** 独立事实审核员返回的最终处理意见（通过、打回修改措辞或剔除） */
export const FactCheckResultSchema = z.object({
  verdict: z.enum(['pass', 'revise', 'drop']),
  claims: z.array(FactCheckClaimSchema),
  revisionNotes: z.array(z.string()),
  dropReason: z.string().optional(),
});
/** 事实审核结果类型 */
export type FactCheckResult = z.infer<typeof FactCheckResultSchema>;

/** 视频封面上的文字：主标题（大字，可用 *星号* 包住要高亮的词）与副标题（一句话钩子，可留空） */
export const CoverTextSchema = z.object({
  title: z.string().trim().min(1),
  subtitle: z.string().trim(),
});
/** 视频封面文字类型 */
export type CoverText = z.infer<typeof CoverTextSchema>;

/** 封面文字的字数上限（按字符计，不含用于高亮的星号），保证在信息流小图里也能看清 */
export const COVER_TEXT_LIMITS = {
  titleMax: 14,
  subtitleMax: 22,
} as const;

/** 整期节目编排产出：包括新闻顺序、开场白、动态片尾、投稿标题简介及封面文字 */
export const IssuePackageSchema = z.object({
  order: z.array(z.string().min(1)).min(1),
  headlineItemId: z.string().min(1),
  headline: z.string().min(1),
  leadSummary: z.string().min(1),
  intro: z.object({
    narration: z.array(z.string().min(1)).min(1).max(4),
    hostComment: z.string().min(1),
  }),
  outro: z.object({
    narration: z.array(z.string().min(1)).min(1),
    hostComment: z.string().min(1),
    cta: z.string().min(1),
  }),
  publish: z.object({
    title: z.string().min(1),
    descriptionIntro: z.string().min(1),
    tags: z.array(z.string().min(1)),
  }),
  /** 封面文字；旧数据或模型漏填时为空，届时由头条导语自动生成 */
  cover: CoverTextSchema.optional(),
});
/** 整期节目编排结果类型 */
export type IssuePackage = z.infer<typeof IssuePackageSchema>;

/** 候选新闻事件在队列中的分工：主选（优先制作）或替补（主选被剔除时顶上） */
export const EventRoleSchema = z.enum(['primary', 'reserve']);
/** 候选事件分工类型 */
export type EventRole = z.infer<typeof EventRoleSchema>;

/** 存入数据库的新闻事件聚类记录 */
export const EventRecordSchema = z.object({
  id: z.string().min(1),
  runId: z.string().min(1),
  rank: z.number().int().positive(),
  role: EventRoleSchema,
  title: z.string().min(1),
  articleIds: z.array(z.string().min(1)).min(1),
  category: z.string().nullable(),
  entity: z.string().nullable(),
  score: z.number(),
  publicAppeal: z.number().nullable(),
  reason: z.string().nullable(),
  refillRound: z.number().int().nonnegative(),
});
/** 数据库事件聚类记录类型 */
export type EventRecord = z.infer<typeof EventRecordSchema>;

/** 单条新闻在写稿与审核过程中的当前状态 */
export const RunItemStatusSchema = z.enum([
  'queued',
  'summarizing',
  'polishing',
  'prechecking',
  'checking',
  'revising',
  'passed',
  'dropped',
]);
/** 单条新闻处理状态类型 */
export type RunItemStatus = z.infer<typeof RunItemStatusSchema>;

/** 单条新闻人工从候选图池中选定的主图与副图编号 */
export const SelectedMediaOverrideSchema = z.object({
  primary: z.string().nullable().optional(),
  secondary: z.string().nullable().optional(),
});
/** 人工选定的候选图配置类型 */
export type SelectedMediaOverride = z.infer<typeof SelectedMediaOverrideSchema>;

/** 某期任务中单条新闻的完整处理记录 */
export const RunItemRecordSchema = z.object({
  id: z.string().min(1),
  runId: z.string().min(1),
  eventId: z.string().min(1),
  position: z.number().int().positive().nullable(),
  status: RunItemStatusSchema,
  revision: z.number().int().nonnegative(),
  dropReason: z.string().nullable(),
  finalJson: PolishedItemSchema.nullable(),
  imageMode: z.enum(['auto', 'custom', 'none']).optional(),
  customImagePath: z.string().nullable().optional(),
  secondaryCustomImagePath: z.string().nullable().optional(),
  selectedMediaIds: SelectedMediaOverrideSchema.nullable().optional(),
  customImageCaption: z.string().nullable().optional(),
  updatedAt: z.string(),
});
/** 单条新闻处理记录类型 */
export type RunItemRecord = z.infer<typeof RunItemRecordSchema>;

/** 单条新闻历史上保存过的稿件与核查记录种类 */
export const ItemVersionKindSchema = z.enum([
  'summary',
  'polish',
  'revise',
  'precheck',
  'factcheck',
]);
/** 条目历史版本种类 */
export type ItemVersionKind = z.infer<typeof ItemVersionKindSchema>;

/** 单条新闻某一轮次生成的草稿或核查历史快照 */
export const ItemVersionSchema = z.object({
  id: z.number().int().positive(),
  itemId: z.string().min(1),
  kind: ItemVersionKindSchema,
  round: z.number().int().nonnegative(),
  payload: z.unknown(),
  createdAt: z.string(),
});
/** 条目历史版本记录类型 */
export type ItemVersion = z.infer<typeof ItemVersionSchema>;
