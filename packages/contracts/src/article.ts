import { z } from 'zod';

export const SourcePoolSchema = z.enum(['primary', 'backup']);
export type SourcePool = z.infer<typeof SourcePoolSchema>;

export const SourceKindSchema = z.enum(['rss', 'html-list']);
export type SourceKind = z.infer<typeof SourceKindSchema>;

export const SourceLangSchema = z.enum(['zh', 'en']);
export type SourceLang = z.infer<typeof SourceLangSchema>;

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
export type SourceDef = z.infer<typeof SourceDefSchema>;

export const SourcesFileSchema = z.object({
  sources: z.array(SourceDefSchema).min(1),
});
export type SourcesFile = z.infer<typeof SourcesFileSchema>;

export const ArticleStatusSchema = z.enum(['new', 'reserved', 'consumed', 'expired', 'rejected']);
export type ArticleStatus = z.infer<typeof ArticleStatusSchema>;

export const ExtractStatusSchema = z.enum(['pending', 'ok', 'feed_only', 'failed']);
export type ExtractStatus = z.infer<typeof ExtractStatusSchema>;

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
export type Article = z.infer<typeof ArticleSchema>;

export const SourceStateSchema = z.object({
  sourceId: z.string().min(1),
  lastFetchedAt: z.string().nullable(),
  lastItemPublishedAt: z.string().nullable(),
  etag: z.string().nullable(),
  lastModified: z.string().nullable(),
  consecutiveFailures: z.number().int().nonnegative(),
  lastError: z.string().nullable(),
});
export type SourceState = z.infer<typeof SourceStateSchema>;

export const SourceHealthSchema = z.object({
  source: SourceDefSchema,
  state: SourceStateSchema.nullable(),
  healthy: z.boolean(),
});
export type SourceHealth = z.infer<typeof SourceHealthSchema>;

export const SourceTestResultSchema = z.object({
  sourceId: z.string(),
  ok: z.boolean(),
  statusCode: z.number().int().optional(),
  itemCount: z.number().int().nonnegative(),
  sampleTitles: z.array(z.string()),
  durationMs: z.number().nonnegative(),
  error: z.string().optional(),
});
export type SourceTestResult = z.infer<typeof SourceTestResultSchema>;
