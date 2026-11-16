import { z } from 'zod';

export const EvidenceSchema = z.object({
  claim: z.string().min(1),
  articleId: z.string().min(1),
  quote: z.string().min(1),
});
export type Evidence = z.infer<typeof EvidenceSchema>;

export const SelectedEventCandidateSchema = z.object({
  title: z.string().min(1),
  articleIds: z.array(z.string().min(1)).min(1),
  category: z.string().min(1),
  entity: z.string().min(1),
  score: z.number().min(1).max(10),
  publicAppeal: z.number().min(1).max(10),
  reason: z.string().min(1),
  duplicateOfHistory: z.boolean(),
});
export type SelectedEventCandidate = z.infer<typeof SelectedEventCandidateSchema>;

export const SelectionResultSchema = z.object({
  events: z.array(SelectedEventCandidateSchema),
});
export type SelectionResult = z.infer<typeof SelectionResultSchema>;

export const AvailabilitySchema = z.enum([
  'available_now',
  'paid_only',
  'limited_preview',
  'announced_only',
  'open_source',
  'research',
  'unknown',
]);
export type Availability = z.infer<typeof AvailabilitySchema>;

export const SummaryDraftSchema = z.object({
  facts: z.array(z.string().min(1)).min(1).max(6),
  relevance: z.string().min(1),
  availability: AvailabilitySchema,
  availabilityNote: z.string().min(1),
  evidence: z.array(EvidenceSchema).min(1),
});
export type SummaryDraft = z.infer<typeof SummaryDraftSchema>;

export const MetricPairSchema = z.object({
  label: z.string().min(1),
  value: z.string().min(1),
});
export type MetricPair = z.infer<typeof MetricPairSchema>;

export const PolishedItemSchema = z.object({
  title: z.string().min(1),
  shortTitle: z.string().min(1),
  category: z.string().min(1),
  entity: z.string().min(1),
  summary: z.string().min(1),
  keyPoints: z.array(z.string().min(1)).max(3),
  detail: z.string().min(1),
  hostComment: z.string().min(1),
  narration: z.array(z.string().min(1)).min(1),
  evidence: z.array(EvidenceSchema).min(1),
  officialQuote: z.string().optional(),
  metrics: z.array(MetricPairSchema).max(4).optional(),
});
export type PolishedItem = z.infer<typeof PolishedItemSchema>;

export const ClaimStatusSchema = z.enum([
  'supported',
  'unsupported',
  'distorted',
  'exaggerated',
  'outdated',
]);
export type ClaimStatus = z.infer<typeof ClaimStatusSchema>;

export const FactCheckClaimSchema = z.object({
  text: z.string().min(1),
  status: ClaimStatusSchema,
  note: z.string(),
});
export type FactCheckClaim = z.infer<typeof FactCheckClaimSchema>;

export const FactCheckResultSchema = z.object({
  verdict: z.enum(['pass', 'revise', 'drop']),
  claims: z.array(FactCheckClaimSchema),
  revisionNotes: z.array(z.string()),
  dropReason: z.string().optional(),
});
export type FactCheckResult = z.infer<typeof FactCheckResultSchema>;

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
});
export type IssuePackage = z.infer<typeof IssuePackageSchema>;

export const EventRoleSchema = z.enum(['primary', 'reserve']);
export type EventRole = z.infer<typeof EventRoleSchema>;

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
export type EventRecord = z.infer<typeof EventRecordSchema>;

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
export type RunItemStatus = z.infer<typeof RunItemStatusSchema>;

export const RunItemRecordSchema = z.object({
  id: z.string().min(1),
  runId: z.string().min(1),
  eventId: z.string().min(1),
  position: z.number().int().positive().nullable(),
  status: RunItemStatusSchema,
  revision: z.number().int().nonnegative(),
  dropReason: z.string().nullable(),
  finalJson: PolishedItemSchema.nullable(),
  updatedAt: z.string(),
});
export type RunItemRecord = z.infer<typeof RunItemRecordSchema>;

export const ItemVersionKindSchema = z.enum([
  'summary',
  'polish',
  'revise',
  'precheck',
  'factcheck',
]);
export type ItemVersionKind = z.infer<typeof ItemVersionKindSchema>;

export const ItemVersionSchema = z.object({
  id: z.number().int().positive(),
  itemId: z.string().min(1),
  kind: ItemVersionKindSchema,
  round: z.number().int().nonnegative(),
  payload: z.unknown(),
  createdAt: z.string(),
});
export type ItemVersion = z.infer<typeof ItemVersionSchema>;
