import { z } from 'zod';

/** 新闻信源分组：主力池（每次例行抓取都会拉取）或备用池（新闻条数不足时才启用补抓） */
export const SourcePoolSchema = z.enum(['primary', 'backup']);
/** 新闻信源分组类型 */
export type SourcePool = z.infer<typeof SourcePoolSchema>;

/** 信源抓取方式：RSS 订阅、网页新闻列表或 X 账号与列表时间线 */
export const SourceKindSchema = z.enum(['rss', 'html-list', 'x-timeline']);
/** 信源抓取方式类型 */
export type SourceKind = z.infer<typeof SourceKindSchema>;

/** 信源主要语言：中文或英文 */
export const SourceLangSchema = z.enum(['zh', 'en']);
/** 信源主要语言类型 */
export type SourceLang = z.infer<typeof SourceLangSchema>;

/** 官方网页新闻列表解析配置 */
export const HtmlListConfigSchema = z.object({
  itemSelector: z.string().min(1).optional(),
  linkSelector: z.string().min(1).optional(),
  titleSelector: z.string().min(1).optional(),
  dateSelector: z.string().min(1).optional(),
  summarySelector: z.string().min(1).optional(),
  urlPattern: z.string().min(1).optional(),
  renderJs: z.boolean().default(false),
});
/** 网页新闻列表解析配置类型 */
export type HtmlListConfig = z.infer<typeof HtmlListConfigSchema>;

/** X 账号或列表时间线采集配置 */
export const XTimelineConfigSchema = z.object({
  mode: z.enum(['user', 'list']).default('user'),
  handleOrListId: z.string().min(1),
  includeReplies: z.boolean().default(false),
  includeRetweets: z.boolean().default(false),
  minChars: z.number().int().nonnegative().default(20),
});
/** X 时间线采集配置类型 */
export type XTimelineConfig = z.infer<typeof XTimelineConfigSchema>;

/** 单条新闻信源配置校验规则 */
export const SourceDefSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    lang: SourceLangSchema,
    tier: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    kind: SourceKindSchema,
    pool: SourcePoolSchema,
    url: z.string().url(),
    enabled: z.boolean().default(true),
    listConfig: HtmlListConfigSchema.optional(),
    xConfig: XTimelineConfigSchema.optional(),
  })
  .superRefine((src, ctx) => {
    if (src.kind === 'x-timeline' && !src.xConfig) {
      ctx.addIssue({
        code: 'custom',
        path: ['xConfig'],
        message: 'x-timeline 信源必须提供 xConfig',
      });
    }
  });
/** 单条新闻信源配置 */
export type SourceDef = z.infer<typeof SourceDefSchema>;

/** 从文章或推文中提取出的候选视觉素材类别 */
export const ArticleMediaKindSchema = z.enum([
  'chart',
  'table_shot',
  'tweet_shot',
  'tweet_media',
  'github_card',
  'changelog_shot',
  'article_section',
  'screenshot',
  'cover',
]);
/** 候选视觉素材类别 */
export type ArticleMediaKind = z.infer<typeof ArticleMediaKindSchema>;

/** 单张本地缓存视觉素材的结构化元信息 */
export const ArticleMediaAssetSchema = z.object({
  id: z.string().min(1),
  articleId: z.string().min(1),
  kind: ArticleMediaKindSchema,
  imagePath: z.string().min(1),
  sourceUrl: z.string().nullable(),
  captionHint: z.string(),
  contextSnippet: z.string(),
  score: z.number(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
});
/** 候选视觉素材元信息类型 */
export type ArticleMediaAsset = z.infer<typeof ArticleMediaAssetSchema>;

/** 信源清单配置文件（`config/sources.yaml`）顶层校验规则 */
export const SourcesFileSchema = z.object({
  sources: z.array(SourceDefSchema).min(1),
});
/** 信源清单配置文件结构 */
export type SourcesFile = z.infer<typeof SourcesFileSchema>;

/** 文章流转状态：待处理、已被某期任务占用、已播出消费、已过期或已拒绝 */
export const ArticleStatusSchema = z.enum(['new', 'reserved', 'consumed', 'expired', 'rejected']);
/** 文章流转状态类型 */
export type ArticleStatus = z.infer<typeof ArticleStatusSchema>;

/** 网页正文提取结果状态：等待提取、正文完整、仅保留订阅摘要、提取失败 */
export const ExtractStatusSchema = z.enum(['pending', 'ok', 'feed_only', 'failed']);
/** 正文提取状态类型 */
export type ExtractStatus = z.infer<typeof ExtractStatusSchema>;

/** 数据库中保存的标准化新闻文章信息 */
export const ArticleSchema = z.object({
  id: z.string().min(1),
  sourceId: z.string().min(1),
  canonicalUrl: z.string().url(),
  title: z.string().min(1),
  titleNorm: z.string(),
  lang: SourceLangSchema,
  publishedAt: z.string().nullable(),
  firstSeenAt: z.string(),
  excerpt: z.string().nullable(),
  contentPath: z.string().nullable(),
  contentChars: z.number().int().nonnegative().nullable(),
  imagePath: z.string().nullable(),
  extractStatus: ExtractStatusSchema,
  status: ArticleStatusSchema,
  reservedByRun: z.string().nullable(),
});
/** 标准化文章数据类型 */
export type Article = z.infer<typeof ArticleSchema>;

/** 单个信源的历史抓取进度与连续失败统计 */
export const SourceStateSchema = z.object({
  sourceId: z.string().min(1),
  lastFetchedAt: z.string().nullable(),
  lastItemPublishedAt: z.string().nullable(),
  etag: z.string().nullable(),
  lastModified: z.string().nullable(),
  consecutiveFailures: z.number().int().nonnegative(),
  lastError: z.string().nullable(),
});
/** 信源抓取状态类型 */
export type SourceState = z.infer<typeof SourceStateSchema>;

/** 展示在后台界面的信源配置及健康情况 */
export const SourceHealthSchema = z.object({
  source: SourceDefSchema,
  state: SourceStateSchema.nullable(),
  healthy: z.boolean(),
});
/** 信源健康视图类型 */
export type SourceHealth = z.infer<typeof SourceHealthSchema>;

/** 对单个信源执行一次测试抓取后的诊断结果 */
export const SourceTestResultSchema = z.object({
  sourceId: z.string(),
  ok: z.boolean(),
  statusCode: z.number().int().optional(),
  itemCount: z.number().int().nonnegative(),
  sampleTitles: z.array(z.string()),
  durationMs: z.number().nonnegative(),
  error: z.string().optional(),
});
/** 信源试抓结果类型 */
export type SourceTestResult = z.infer<typeof SourceTestResultSchema>;

/** 文章列表与批量删除按时间筛选时的时间基准口径 */
export const ArticleTimeFieldSchema = z.enum(['effective', 'first_seen']);
/** 文章时间筛选口径类型：effective 优先取发布时间、缺失时取入库时间；first_seen 固定按抓取入库时间 */
export type ArticleTimeField = z.infer<typeof ArticleTimeFieldSchema>;

/** 分页查询已抓取文章列表的筛选参数 */
export const ArticleListQuerySchema = z.object({
  sourceId: z.string().trim().min(1).optional(),
  status: z.array(ArticleStatusSchema).min(1).optional(),
  extractStatus: z.array(ExtractStatusSchema).min(1).optional(),
  lang: SourceLangSchema.optional(),
  query: z.string().trim().min(1).optional(),
  timeField: ArticleTimeFieldSchema.optional(),
  from: z.string().trim().min(1).optional(),
  to: z.string().trim().min(1).optional(),
  page: z.number().int().positive().default(1),
  pageSize: z.number().int().positive().max(200).default(50),
});
/** 分页查询已抓取文章列表的筛选参数类型 */
export type ArticleListQuery = z.input<typeof ArticleListQuerySchema>;

/** 附带信源显示名称的单篇文章列表项 */
export const ArticleListItemSchema = ArticleSchema.extend({
  sourceName: z.string().min(1),
});
/** 附带信源显示名称的单篇文章列表项类型 */
export type ArticleListItem = z.infer<typeof ArticleListItemSchema>;

/** 按文章流转状态统计的数量汇总 */
export const ArticleStatusCountsSchema = z.object({
  new: z.number().int().nonnegative(),
  reserved: z.number().int().nonnegative(),
  consumed: z.number().int().nonnegative(),
  expired: z.number().int().nonnegative(),
  rejected: z.number().int().nonnegative(),
});
/** 按文章流转状态统计的数量汇总类型 */
export type ArticleStatusCounts = z.infer<typeof ArticleStatusCountsSchema>;

/** 已抓取文章分页查询结果 */
export const ArticleListResultSchema = z.object({
  items: z.array(ArticleListItemSchema),
  total: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  pageSize: z.number().int().positive(),
  statusCounts: ArticleStatusCountsSchema,
});
/** 已抓取文章分页查询结果类型 */
export type ArticleListResult = z.infer<typeof ArticleListResultSchema>;

/** 单篇已抓取文章的完整正文、订阅片段与本地配图素材详情 */
export const ArticleDetailSchema = z.object({
  article: ArticleListItemSchema,
  contentText: z.string().nullable(),
  feedContent: z.string().nullable(),
  mediaAssets: z.array(ArticleMediaAssetSchema),
  contentFileExists: z.boolean(),
});
/** 单篇已抓取文章完整详情类型 */
export type ArticleDetail = z.infer<typeof ArticleDetailSchema>;

/** 选择性或按条件批量删除已抓取文章的请求参数 */
export const DeleteArticlesInputSchema = z.object({
  ids: z.array(z.string().trim().min(1)).optional(),
  sourceId: z.string().trim().min(1).optional(),
  status: z.array(ArticleStatusSchema).min(1).optional(),
  extractStatus: z.array(ExtractStatusSchema).min(1).optional(),
  lang: SourceLangSchema.optional(),
  query: z.string().trim().min(1).optional(),
  timeField: ArticleTimeFieldSchema.optional(),
  from: z.string().trim().min(1).optional(),
  to: z.string().trim().min(1).optional(),
  dryRun: z.boolean().optional(),
});
/** 选择性或按条件批量删除已抓取文章的请求参数类型 */
export type DeleteArticlesInput = z.input<typeof DeleteArticlesInputSchema>;

/** 预演或执行删除已抓取文章后的统计结果 */
export const DeleteArticlesResultSchema = z.object({
  dryRun: z.boolean(),
  matchedCount: z.number().int().nonnegative(),
  deletableCount: z.number().int().nonnegative(),
  deletedCount: z.number().int().nonnegative(),
  skippedReservedCount: z.number().int().nonnegative(),
  deletedIds: z.array(z.string()),
  skippedReservedIds: z.array(z.string()),
  deletedFileCount: z.number().int().nonnegative(),
  reclaimedBytes: z.number().int().nonnegative(),
});
/** 预演或执行删除已抓取文章后的统计结果类型 */
export type DeleteArticlesResult = z.infer<typeof DeleteArticlesResultSchema>;
