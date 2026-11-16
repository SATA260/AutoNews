import { z } from 'zod';

/** 新闻信源分组：主力池（每次例行抓取都会拉取）或备用池（新闻条数不足时才启用补抓） */
export const SourcePoolSchema = z.enum(['primary', 'backup']);
/** 新闻信源分组类型 */
export type SourcePool = z.infer<typeof SourcePoolSchema>;

/** 信源抓取方式：RSS 订阅或预留的网页列表抓取 */
export const SourceKindSchema = z.enum(['rss', 'html-list']);
/** 信源抓取方式类型 */
export type SourceKind = z.infer<typeof SourceKindSchema>;

/** 信源主要语言：中文或英文 */
export const SourceLangSchema = z.enum(['zh', 'en']);
/** 信源主要语言类型 */
export type SourceLang = z.infer<typeof SourceLangSchema>;

/** 单条新闻信源配置校验规则 */
export const SourceDefSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  lang: SourceLangSchema,
  tier: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  kind: SourceKindSchema,
  pool: SourcePoolSchema,
  url: z.string().url(),
  enabled: z.boolean().default(true),
});
/** 单条新闻信源配置 */
export type SourceDef = z.infer<typeof SourceDefSchema>;

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
