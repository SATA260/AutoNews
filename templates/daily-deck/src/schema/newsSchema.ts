import { z } from 'zod';

export type PresetMascotId = 'deepseek' | 'gpt' | 'claude' | 'gemini' | 'grok' | 'none';
export type MascotMode = 'per-item' | 'fixed-host';

export interface ValidationWarning {
  path: string;
  code: 'truncated' | 'fallback' | 'clamped' | 'invalid_url';
  message: string;
}

export interface SanitizedMetric {
  label: string;
  value: string;
}

export interface NewsItemInput {
  id?: string;
  category?: string;
  shortTitle?: string;
  title: string;
  summary: string;
  keyPoints?: string[];
  imageUrl?: string | null;
  secondaryImageUrl?: string | null;
  imageCaption?: string | null;
  officialQuote?: string | null;
  metrics?: Array<{
    label: string;
    value: string;
  }>;
  source?: string | null;
  sourceUrl?: string | null;
  publishedAt?: string | null;
  mascotId?: PresetMascotId | string;
  customMascotUrl?: string | null;
  durationSec?: number;
}

export interface DailyIssueInput {
  issueTitle?: string;
  issueNumber?: string;
  date?: string;
  headline?: string;
  footerCta?: string;
  hostMascotId?: PresetMascotId | string;
  mascotMode?: MascotMode | string;
  coverDurationSec?: number;
  outroDurationSec?: number;
  items: NewsItemInput[];
}

export interface SanitizedNewsItem {
  id: string;
  indexLabel: string;
  category: string;
  shortTitle: string;
  title: string;
  summary: string;
  keyPoints: string[];
  imageUrl: string | null;
  secondaryImageUrl: string | null;
  imageCaption: string;
  officialQuote: string;
  metrics: SanitizedMetric[];
  source: string;
  sourceUrl: string;
  publishedAt: string;
  mascotId: PresetMascotId;
  customMascotUrl: string | null;
  durationSec: number;
}

export interface SanitizedDailyIssue {
  issueTitle: string;
  issueNumber: string;
  date: string;
  headline: string;
  footerCta: string;
  hostMascotId: PresetMascotId;
  mascotMode: MascotMode;
  coverDurationSec: number;
  outroDurationSec: number;
  items: SanitizedNewsItem[];
}

export interface SanitizedIssueResult {
  issue: SanitizedDailyIssue;
  warnings: ValidationWarning[];
  isClean: boolean;
}

export const HARD_LIMITS = {
  maxItems: 12,
  minItems: 1,
  issueTitle: 14,
  issueNumber: 20,
  date: 20,
  headline: 48,
  footerCta: 56,
  category: 10,
  shortTitle: 30,
  title: 48,
  summary: 100,
  keyPointsCount: 3,
  keyPoint: 32,
  imageCaption: 44,
  officialQuote: 120,
  metricsCount: 4,
  metricLabel: 12,
  metricValue: 18,
  source: 24,
  sourceUrl: 42,
  publishedAt: 16,
  minDurationSec: 1,
  maxCoverOutroDurationSec: 120,
  maxItemDurationSec: 180,
  defaultItemDurationSec: 8,
  defaultCoverDurationSec: 5,
  defaultOutroDurationSec: 6,
} as const;

const PRESET_MASCOTS: readonly PresetMascotId[] = [
  'deepseek',
  'gpt',
  'claude',
  'gemini',
  'grok',
  'none',
] as const;

const MASCOT_MODES: readonly MascotMode[] = ['per-item', 'fixed-host'] as const;

const LooseRecordSchema = z.record(z.unknown());

/** Strip ASCII control chars and collapse repeated whitespace cleanly. */
function normalizeText(value: unknown): string {
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (typeof value !== 'string') {
    return '';
  }
  return value
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Truncate using Unicode codepoints so emoji/surrogate pairs are never split. */
export function truncateCodepoints(str: string, maxLen: number): { text: string; truncated: boolean } {
  const chars = Array.from(str);
  if (chars.length <= maxLen) {
    return { text: str, truncated: false };
  }
  if (maxLen <= 1) {
    return { text: chars.slice(0, Math.max(0, maxLen)).join(''), truncated: true };
  }
  return {
    text: `${chars.slice(0, maxLen - 1).join('').trimEnd()}…`,
    truncated: true,
  };
}

/** Normalize, fallback on empty, and enforce codepoint limit without ever throwing. */
export function cleanAndTruncate(
  val: unknown,
  maxLen: number,
  fallback: string,
  path: string,
  warnings: ValidationWarning[],
  recordFallbackWarning = false,
): string {
  const normalized = normalizeText(val);
  if (!normalized) {
    if (recordFallbackWarning) {
      warnings.push({
        path,
        code: 'fallback',
        message: `${path} 缺失或为空，已自动使用安全默认文案`,
      });
    }
    return truncateCodepoints(fallback, maxLen).text;
  }

  const { text, truncated } = truncateCodepoints(normalized, maxLen);
  if (truncated) {
    warnings.push({
      path,
      code: 'truncated',
      message: `${path} 超出上限 ${maxLen} 字，已自动语义截断`,
    });
  }
  return text;
}

/** Validate URLs strictly to safe http(s), local relative paths, or safe data:image payloads. */
export function sanitizeMediaUrl(
  rawUrl: unknown,
  path: string,
  warnings: ValidationWarning[],
): string | null {
  const cleaned = normalizeText(rawUrl);
  if (!cleaned) {
    return null;
  }

  const lower = cleaned.toLowerCase();
  if (
    lower.startsWith('http://') ||
    lower.startsWith('https://') ||
    cleaned.startsWith('/') ||
    cleaned.startsWith('./') ||
    /^data:image\/(png|jpeg|jpg|webp|gif|svg\+xml);/i.test(cleaned)
  ) {
    return cleaned;
  }

  warnings.push({
    path,
    code: 'invalid_url',
    message: `${path} 不是受支持的媒体链接，已安全忽略`,
  });
  return null;
}

function clampDuration(
  raw: unknown,
  fallback: number,
  maxSec: number,
  path: string,
  warnings: ValidationWarning[],
): number {
  if (raw === undefined || raw === null || raw === '') {
    return fallback;
  }
  const num = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(num)) {
    warnings.push({
      path,
      code: 'fallback',
      message: `${path} 时长数值无效，已回退默认值 ${fallback}s`,
    });
    return fallback;
  }
  // Preserve 0.1s precision for exact TTS audio alignment
  const rounded = Math.round(num * 10) / 10;
  if (rounded < HARD_LIMITS.minDurationSec || rounded > maxSec) {
    const clamped = Math.min(maxSec, Math.max(HARD_LIMITS.minDurationSec, rounded));
    warnings.push({
      path,
      code: 'clamped',
      message: `${path} 停留时长已钳制到安全区间 ${clamped}s`,
    });
    return clamped;
  }
  return rounded;
}

function sanitizeMascotId(
  raw: unknown,
  defaultId: PresetMascotId,
  path: string,
  warnings: ValidationWarning[],
): PresetMascotId {
  const normalized = normalizeText(raw).toLowerCase();
  if (!normalized) {
    return defaultId;
  }
  if ((PRESET_MASCOTS as readonly string[]).includes(normalized)) {
    return normalized as PresetMascotId;
  }
  warnings.push({
    path,
    code: 'fallback',
    message: `${path} 未识别角色 "${normalized}"，已自动回退 ${defaultId}`,
  });
  return defaultId;
}

function sanitizeMascotMode(raw: unknown, path: string, warnings: ValidationWarning[]): MascotMode {
  const normalized = normalizeText(raw).toLowerCase();
  if (!normalized) {
    return 'per-item';
  }
  if ((MASCOT_MODES as readonly string[]).includes(normalized)) {
    return normalized as MascotMode;
  }
  warnings.push({
    path,
    code: 'fallback',
    message: `${path} 模式 "${normalized}" 无效，已回退 per-item`,
  });
  return 'per-item';
}

function sanitizeSingleNewsItem(
  rawItem: unknown,
  index: number,
  hostMascotId: PresetMascotId,
  warnings: ValidationWarning[],
): SanitizedNewsItem {
  const basePath = `items[${index}]`;
  const parsed = LooseRecordSchema.safeParse(rawItem);
  const obj: Record<string, unknown> = parsed.success ? parsed.data : {};
  if (!parsed.success) {
    warnings.push({
      path: basePath,
      code: 'fallback',
      message: `${basePath} 不是有效对象，已用安全示范模板填充`,
    });
  }

  const indexLabel = String(index + 1).padStart(2, '0');
  const category = cleanAndTruncate(obj.category, HARD_LIMITS.category, 'AI 动向', `${basePath}.category`, warnings);
  const title = cleanAndTruncate(
    obj.title,
    HARD_LIMITS.title,
    `今日 AI 核心动态 #${indexLabel}`,
    `${basePath}.title`,
    warnings,
    true,
  );

  // Derive shortTitle cleanly from title when omitted without generating a warning
  const rawShortTitle = normalizeText(obj.shortTitle);
  const shortTitle = rawShortTitle
    ? cleanAndTruncate(rawShortTitle, HARD_LIMITS.shortTitle, title, `${basePath}.shortTitle`, warnings)
    : truncateCodepoints(title, HARD_LIMITS.shortTitle).text;

  const rawSummary = normalizeText(obj.summary);
  const summary = cleanAndTruncate(
    rawSummary || title,
    HARD_LIMITS.summary,
    title,
    `${basePath}.summary`,
    warnings,
    !rawSummary,
  );

  const rawKeyPoints = Array.isArray(obj.keyPoints) ? obj.keyPoints : [];
  if (rawKeyPoints.length > HARD_LIMITS.keyPointsCount) {
    warnings.push({
      path: `${basePath}.keyPoints`,
      code: 'clamped',
      message: `${basePath}.keyPoints 超过 ${HARD_LIMITS.keyPointsCount} 条，已保留前 ${HARD_LIMITS.keyPointsCount} 条`,
    });
  }
  const keyPoints = rawKeyPoints
    .slice(0, HARD_LIMITS.keyPointsCount)
    .map((kp, kpIdx) =>
      cleanAndTruncate(kp, HARD_LIMITS.keyPoint, '', `${basePath}.keyPoints[${kpIdx}]`, warnings),
    )
    .filter((kp) => kp.length > 0);

  const rawMetrics = Array.isArray(obj.metrics) ? obj.metrics : [];
  if (rawMetrics.length > HARD_LIMITS.metricsCount) {
    warnings.push({
      path: `${basePath}.metrics`,
      code: 'clamped',
      message: `${basePath}.metrics 超过 ${HARD_LIMITS.metricsCount} 组，已保留前 ${HARD_LIMITS.metricsCount} 组`,
    });
  }
  const metrics: SanitizedMetric[] = rawMetrics
    .slice(0, HARD_LIMITS.metricsCount)
    .map((m, mIdx) => {
      const rec = LooseRecordSchema.safeParse(m);
      if (!rec.success) {
        return null;
      }
      const label = cleanAndTruncate(
        rec.data.label,
        HARD_LIMITS.metricLabel,
        '',
        `${basePath}.metrics[${mIdx}].label`,
        warnings,
      );
      const value = cleanAndTruncate(
        rec.data.value,
        HARD_LIMITS.metricValue,
        '',
        `${basePath}.metrics[${mIdx}].value`,
        warnings,
      );
      if (!label || !value) {
        return null;
      }
      return { label, value };
    })
    .filter((m): m is SanitizedMetric => m !== null);

  const imageUrl = sanitizeMediaUrl(obj.imageUrl, `${basePath}.imageUrl`, warnings);
  const secondaryImageUrl = sanitizeMediaUrl(
    obj.secondaryImageUrl,
    `${basePath}.secondaryImageUrl`,
    warnings,
  );
  const imageCaption = cleanAndTruncate(
    obj.imageCaption,
    HARD_LIMITS.imageCaption,
    '',
    `${basePath}.imageCaption`,
    warnings,
  );
  const officialQuote = cleanAndTruncate(
    obj.officialQuote,
    HARD_LIMITS.officialQuote,
    '',
    `${basePath}.officialQuote`,
    warnings,
  );
  const source = cleanAndTruncate(obj.source, HARD_LIMITS.source, '官方发布', `${basePath}.source`, warnings);
  const sourceUrl = cleanAndTruncate(obj.sourceUrl, HARD_LIMITS.sourceUrl, '', `${basePath}.sourceUrl`, warnings);
  const publishedAt = cleanAndTruncate(
    obj.publishedAt,
    HARD_LIMITS.publishedAt,
    '今日',
    `${basePath}.publishedAt`,
    warnings,
  );

  const mascotId = sanitizeMascotId(obj.mascotId, hostMascotId, `${basePath}.mascotId`, warnings);
  const customMascotUrl = sanitizeMediaUrl(
    obj.customMascotUrl,
    `${basePath}.customMascotUrl`,
    warnings,
  );

  const durationSec = clampDuration(
    obj.durationSec,
    HARD_LIMITS.defaultItemDurationSec,
    HARD_LIMITS.maxItemDurationSec,
    `${basePath}.durationSec`,
    warnings,
  );

  const id = normalizeText(obj.id) || `news-${indexLabel}`;

  return {
    id,
    indexLabel,
    category,
    shortTitle,
    title,
    summary,
    keyPoints,
    imageUrl,
    secondaryImageUrl,
    imageCaption,
    officialQuote,
    metrics,
    source,
    sourceUrl,
    publishedAt,
    mascotId,
    customMascotUrl,
    durationSec,
  };
}

function createEmergencyFallbackIssue(): SanitizedDailyIssue {
  const item = sanitizeSingleNewsItem(
    {
      id: 'fallback-01',
      category: '模板就绪',
      shortTitle: '等待导入本期 AI 日报数据',
      title: '等待导入本期 AI 日报数据',
      summary: '当前输入数据为空或结构不完整，已自动启用安全示范页，保证视频画面零报错。',
      keyPoints: ['左侧展示精炼新闻梗概', '右侧引用官方图片或披露要点', '按 E 键打开编辑抽屉导入 JSON'],
      officialQuote: '模板支持通过 window.__NEWS_DECK__.setNewsData(json) 动态注入各期数据并自动对齐配音时长。',
      metrics: [
        { label: '画幅规格', value: '1920 × 1080' },
        { label: '容错机制', value: '零报错兜底' },
      ],
      source: '系统安全守卫',
      mascotId: 'deepseek',
    },
    0,
    'deepseek',
    [],
  );

  return {
    issueTitle: 'AI 每日报',
    issueNumber: 'NO. SAFE',
    date: '今日速递',
    headline: '等待导入本期精选 AI 动态',
    footerCta: '感谢收看 · 各条新闻原始信源链接已附于视频简介',
    hostMascotId: 'deepseek',
    mascotMode: 'per-item',
    coverDurationSec: HARD_LIMITS.defaultCoverDurationSec,
    outroDurationSec: HARD_LIMITS.defaultOutroDurationSec,
    items: [item],
  };
}

/**
 * Guaranteed zero-throw sanitizer for DailyIssue data.
 * Clamps items, truncates text cleanly, normalizes enums, and returns structured warnings.
 */
export function sanitizeDailyIssue(raw: unknown): SanitizedIssueResult {
  const warnings: ValidationWarning[] = [];

  try {
    const parsed = LooseRecordSchema.safeParse(raw);
    if (!parsed.success) {
      warnings.push({
        path: 'root',
        code: 'fallback',
        message: '输入数据非标准对象，已切换为安全示范期内容',
      });
      return {
        issue: createEmergencyFallbackIssue(),
        warnings,
        isClean: false,
      };
    }

    const root = parsed.data;
    const hostMascotId = sanitizeMascotId(root.hostMascotId, 'deepseek', 'hostMascotId', warnings);
    const mascotMode = sanitizeMascotMode(root.mascotMode, 'mascotMode', warnings);
    const rawItems = Array.isArray(root.items) ? root.items : [];

    if (rawItems.length === 0) {
      warnings.push({
        path: 'items',
        code: 'fallback',
        message: '新闻列表为空，已自动补充安全示范新闻以防空白页',
      });
    } else if (rawItems.length > HARD_LIMITS.maxItems) {
      warnings.push({
        path: 'items',
        code: 'clamped',
        message: `单期新闻超过上限 ${HARD_LIMITS.maxItems} 条，已安全截取前 ${HARD_LIMITS.maxItems} 条`,
      });
    }

    const sanitizedItems =
      rawItems.length > 0
        ? rawItems
            .slice(0, HARD_LIMITS.maxItems)
            .map((entry, idx) => sanitizeSingleNewsItem(entry, idx, hostMascotId, warnings))
        : createEmergencyFallbackIssue().items;

    const firstItem = sanitizedItems[0]!;
    const issueTitle = cleanAndTruncate(root.issueTitle, HARD_LIMITS.issueTitle, 'AI 每日报', 'issueTitle', warnings);
    const issueNumber = cleanAndTruncate(
      root.issueNumber,
      HARD_LIMITS.issueNumber,
      'NO. 042',
      'issueNumber',
      warnings,
    );
    const date = cleanAndTruncate(root.date, HARD_LIMITS.date, '今日速递', 'date', warnings);
    const headline = cleanAndTruncate(
      root.headline,
      HARD_LIMITS.headline,
      firstItem.shortTitle,
      'headline',
      warnings,
    );
    const footerCta = cleanAndTruncate(
      root.footerCta,
      HARD_LIMITS.footerCta,
      '感谢收看 · 各条新闻原始信源链接已附于视频简介',
      'footerCta',
      warnings,
    );

    const coverDurationSec = clampDuration(
      root.coverDurationSec,
      HARD_LIMITS.defaultCoverDurationSec,
      HARD_LIMITS.maxCoverOutroDurationSec,
      'coverDurationSec',
      warnings,
    );
    const outroDurationSec = clampDuration(
      root.outroDurationSec,
      HARD_LIMITS.defaultOutroDurationSec,
      HARD_LIMITS.maxCoverOutroDurationSec,
      'outroDurationSec',
      warnings,
    );

    return {
      issue: {
        issueTitle,
        issueNumber,
        date,
        headline,
        footerCta,
        hostMascotId,
        mascotMode,
        coverDurationSec,
        outroDurationSec,
        items: sanitizedItems,
      },
      warnings,
      isClean: warnings.length === 0,
    };
  } catch {
    warnings.push({
      path: 'root',
      code: 'fallback',
      message: '检测到异常数据结构，已触发全局防崩溃兜底',
    });
    return {
      issue: createEmergencyFallbackIssue(),
      warnings,
      isClean: false,
    };
  }
}
