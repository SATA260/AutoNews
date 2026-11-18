import { z } from 'zod';

/** 模板内置的右下角人物形象标识 */
export type PresetMascotId = 'deepseek' | 'gpt' | 'claude' | 'gemini' | 'grok' | 'none';
/** 右下角形象的切换方式：随每条新闻切换，或整期固定同一位 */
export type MascotMode = 'per-item' | 'fixed-host';
/** 看板娘随新闻阵营或话题呈现的微表情状态 */
export type MascotMood = 'neutral' | 'proud' | 'surprised' | 'thinking';

/** 数据清洗过程中记录的单条提示或自动修正明细 */
export interface ValidationWarning {
  path: string;
  code: 'truncated' | 'fallback' | 'clamped' | 'invalid_url';
  message: string;
}

/** 无配图时在右侧摘要表展示的单个参数条目 */
export interface SanitizedMetric {
  label: string;
  value: string;
}

/** 信息卡片网格支持的语义图标名称 */
export type CardIconName =
  | 'rocket'
  | 'cpu'
  | 'trending-down'
  | 'zap'
  | 'grid'
  | 'gift'
  | 'clipboard-check'
  | 'users'
  | 'code'
  | 'shield'
  | 'globe'
  | 'sparkles';

/** 外部传入的单张新闻信息卡片输入结构 */
export interface NewsCardInput {
  icon?: CardIconName | string;
  title: string;
  body: string;
}

/** 经安全清洗后的单张新闻信息卡片展示结构 */
export interface SanitizedInfoCard {
  icon: CardIconName;
  title: string;
  body: string;
}

/** 外部传入的单条同步口播字幕输入结构 */
export interface SubtitleCueInput {
  text: string;
  startSec: number;
  endSec: number;
}

/** 经安全清洗与边界校验后的单条口播字幕结构 */
export interface SanitizedSubtitleCue {
  text: string;
  startSec: number;
  endSec: number;
}

/** 外部传入的单条新闻原始输入结构 */
export interface NewsItemInput {
  id?: string;
  category?: string;
  shortTitle?: string;
  progressLabel?: string;
  title: string;
  summary: string;
  cards?: NewsCardInput[];
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
  mascotMood?: MascotMood | string;
  frameCount?: number | null;
  durationSec?: number;
  speechDurationSec?: number;
  audioUrl?: string | null;
  lipSyncFrames?: number[];
  subtitles?: SubtitleCueInput[];
}

/** 外部传入的整期日报原始输入结构 */
export interface DailyIssueInput {
  issueTitle?: string;
  issueNumber?: string;
  date?: string;
  headline?: string;
  footerCta?: string;
  fps?: number;
  hostMascotId?: PresetMascotId | string;
  hostDisplayName?: string;
  hostMascotUrl?: string | null;
  hostLive2dUrl?: string | null;
  mascotMode?: MascotMode | string;
  bgmAudioUrl?: string | null;
  bgmVolumeDb?: number;
  pagePaddingSec?: number;
  coverFrameCount?: number | null;
  coverDurationSec?: number;
  coverSpeechSec?: number;
  coverAudioUrl?: string | null;
  coverLipSync?: number[];
  coverSubtitles?: SubtitleCueInput[];
  outroFrameCount?: number | null;
  outroDurationSec?: number;
  outroSpeechSec?: number;
  outroAudioUrl?: string | null;
  outroLipSync?: number[];
  outroSubtitles?: SubtitleCueInput[];
  items: NewsItemInput[];
}

/** 经安全清洗与上限裁剪后的单条新闻渲染数据 */
export interface SanitizedNewsItem {
  id: string;
  indexLabel: string;
  category: string;
  shortTitle: string;
  progressLabel: string;
  title: string;
  summary: string;
  cards: SanitizedInfoCard[];
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
  mascotMood: MascotMood;
  frameCount: number | null;
  durationSec: number;
  speechDurationSec: number;
  audioUrl: string | null;
  lipSyncFrames: number[];
  subtitles: SanitizedSubtitleCue[];
}

/** 经安全清洗与上限裁剪后的整期日报渲染数据 */
export interface SanitizedDailyIssue {
  issueTitle: string;
  issueNumber: string;
  date: string;
  headline: string;
  footerCta: string;
  fps: number;
  hostMascotId: PresetMascotId;
  hostDisplayName: string;
  hostMascotUrl: string | null;
  hostLive2dUrl: string | null;
  mascotMode: MascotMode;
  bgmAudioUrl: string | null;
  bgmVolumeDb: number;
  pagePaddingSec: number;
  coverFrameCount: number | null;
  coverDurationSec: number;
  coverSpeechSec: number;
  coverAudioUrl: string | null;
  coverLipSync: number[];
  coverSubtitles: SanitizedSubtitleCue[];
  outroFrameCount: number | null;
  outroDurationSec: number;
  outroSpeechSec: number;
  outroAudioUrl: string | null;
  outroLipSync: number[];
  outroSubtitles: SanitizedSubtitleCue[];
  items: SanitizedNewsItem[];
}

/** 数据清洗与校检完成后返回的结果对象 */
export interface SanitizedIssueResult {
  issue: SanitizedDailyIssue;
  warnings: ValidationWarning[];
  isClean: boolean;
}

/** 画布各文本与数值字段的安全字数及范围硬上限 */
export const HARD_LIMITS = {
  maxItems: 12,
  minItems: 1,
  issueTitle: 14,
  issueNumber: 20,
  date: 20,
  headline: 48,
  footerCta: 56,
  hostDisplayName: 16,
  category: 10,
  shortTitle: 30,
  progressLabel: 12,
  title: 48,
  summary: 100,
  cardsMaxCount: 8,
  cardTitle: 16,
  cardBody: 80,
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
  maxLipSyncFrames: 12000,
  subtitleText: 80,
  subtitlesMaxCount: 24,
} as const;

const PRESET_MASCOTS: readonly PresetMascotId[] = [
  'deepseek',
  'gpt',
  'claude',
  'gemini',
  'grok',
  'none',
] as const;

const MASCOT_DEFAULT_NAMES: Record<PresetMascotId, string> = {
  deepseek: '聪明的大肥鱼',
  gpt: 'gpt',
  claude: '小克',
  gemini: '哈基米',
  grok: 'Grok',
  none: '',
};

const MASCOT_MODES: readonly MascotMode[] = ['per-item', 'fixed-host'] as const;
const MASCOT_MOODS: readonly MascotMood[] = ['neutral', 'proud', 'surprised', 'thinking'] as const;

const LooseRecordSchema = z.record(z.unknown());

const VALID_CARD_ICONS: readonly CardIconName[] = [
  'rocket',
  'cpu',
  'trending-down',
  'zap',
  'grid',
  'gift',
  'clipboard-check',
  'users',
  'code',
  'shield',
  'globe',
  'sparkles',
] as const;

const FALLBACK_CARD_ICON_ORDER: readonly CardIconName[] = [
  'rocket',
  'cpu',
  'trending-down',
  'grid',
  'gift',
  'clipboard-check',
  'users',
  'code',
] as const;

/** 根据标题与正文关键词匹配语义化卡片图标，未命中时按索引循环回退 */
function inferCardIcon(title: string, body: string, idx: number): CardIconName {
  const sample = `${title} ${body}`.toLowerCase();
  if (/参数|规格|架构|芯片|上下文|tokens|吞吐|延迟/.test(sample)) return 'cpu';
  if (/降价|成本|价格|收费|美元|万元|元|定价/.test(sample)) return 'trending-down';
  if (/多平台|平台|接入|客户端|上线|集成|生态/.test(sample)) return 'grid';
  if (/免费|折扣|限时|福利|配额|优惠/.test(sample)) return 'gift';
  if (/自评|评测|表现|基准|对比|准确|解决率|测试/.test(sample)) return 'clipboard-check';
  if (/盲测|用户|大众|开发者|团队|满意度/.test(sample)) return 'users';
  if (/开源|代码|协议|api|schema|json|重构/.test(sample)) return 'code';
  if (/限制|范围|边界|合规|安全|收费会员/.test(sample)) return 'shield';
  if (/检索|实时|网页|联网|全球/.test(sample)) return 'globe';
  if (/发布|推出|新品|亮相/.test(sample)) return 'rocket';
  if (/响应|提速|加速|高效|性能/.test(sample)) return 'zap';
  return FALLBACK_CARD_ICON_ORDER[idx % FALLBACK_CARD_ICON_ORDER.length]!;
}

/** 校验单张卡片图标标识，未传或非法时结合文案自动选择匹配图标 */
function sanitizeCardIcon(
  rawIcon: unknown,
  title: string,
  body: string,
  idx: number,
): CardIconName {
  const cleaned = normalizeText(rawIcon).toLowerCase();
  if ((VALID_CARD_ICONS as readonly string[]).includes(cleaned)) {
    return cleaned as CardIconName;
  }
  return inferCardIcon(title, body, idx);
}

/** 清洗结构化信息卡片数组；当旧版输入未提供 cards 时，从核心结论与要点自动拆解生成安全卡片 */
function sanitizeItemCards(
  rawCards: unknown,
  summary: string,
  keyPoints: readonly string[],
  officialQuote: string,
  basePath: string,
  warnings: ValidationWarning[],
): SanitizedInfoCard[] {
  if (Array.isArray(rawCards) && rawCards.length > 0) {
    if (rawCards.length > HARD_LIMITS.cardsMaxCount) {
      warnings.push({
        path: `${basePath}.cards`,
        code: 'clamped',
        message: `${basePath}.cards 超过 ${HARD_LIMITS.cardsMaxCount} 张，已保留前 ${HARD_LIMITS.cardsMaxCount} 张`,
      });
    }
    const cleanedCards = rawCards
      .slice(0, HARD_LIMITS.cardsMaxCount)
      .map((entry, cIdx): SanitizedInfoCard | null => {
        const rec = LooseRecordSchema.safeParse(entry);
        if (!rec.success) {
          return null;
        }
        const title = cleanAndTruncate(
          rec.data.title,
          HARD_LIMITS.cardTitle,
          '',
          `${basePath}.cards[${cIdx}].title`,
          warnings,
        );
        const body = cleanAndTruncate(
          rec.data.body,
          HARD_LIMITS.cardBody,
          '',
          `${basePath}.cards[${cIdx}].body`,
          warnings,
        );
        if (!title || !body) {
          return null;
        }
        return {
          icon: sanitizeCardIcon(rec.data.icon, title, body, cIdx),
          title,
          body,
        };
      })
      .filter((card): card is SanitizedInfoCard => card !== null);

    if (cleanedCards.length > 0) {
      return cleanedCards;
    }
  }

  // 兼容旧版未传入 cards 的数据，仅基于摘要、要点及正文引语补全网格卡片
  const fallbackCards: SanitizedInfoCard[] = [
    {
      icon: 'rocket',
      title: '核心进展',
      body: truncateCodepoints(summary, HARD_LIMITS.cardBody).text,
    },
  ];
  keyPoints.forEach((kp, idx) => {
    fallbackCards.push({
      icon: inferCardIcon('', kp, idx + 1),
      title: `关键要点 ${String(idx + 1).padStart(2, '0')}`,
      body: truncateCodepoints(kp, HARD_LIMITS.cardBody).text,
    });
  });
  if (keyPoints.length === 0 && officialQuote) {
    fallbackCards.push({
      icon: 'clipboard-check',
      title: '官方披露',
      body: truncateCodepoints(officialQuote, HARD_LIMITS.cardBody).text,
    });
  }
  return fallbackCards.slice(0, HARD_LIMITS.cardsMaxCount);
}

/** 去除文本中的不可见控制字符并合并多余空白 */
function normalizeText(value: unknown): string {
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (typeof value !== 'string') {
    return '';
  }
  let sanitized = '';
  for (const ch of value) {
    const code = ch.charCodeAt(0);
    sanitized += code < 32 || code === 127 ? ' ' : ch;
  }
  return sanitized.replace(/\s+/g, ' ').trim();
}

/** 按完整字符码点安全截断文本，避免把表情符号从中间劈开产生乱码 */
export function truncateCodepoints(
  str: string,
  maxLen: number,
): { text: string; truncated: boolean } {
  const chars = Array.from(str);
  if (chars.length <= maxLen) {
    return { text: str, truncated: false };
  }
  if (maxLen <= 1) {
    return { text: chars.slice(0, Math.max(0, maxLen)).join(''), truncated: true };
  }
  return {
    text: `${chars
      .slice(0, maxLen - 1)
      .join('')
      .trimEnd()}…`,
    truncated: true,
  };
}

/** 清洗字符串并在为空或超长时执行安全替补与截断，绝不抛出异常 */
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

/** 校验图片或模型链接，仅允许安全的网址、本地相对路径或合法图片数据编码 */
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

/** 校验口播与背景音频链接，允许本地静态路径、标准网址、Blob 或音频数据编码 */
export function sanitizeAudioUrl(
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
    lower.startsWith('blob:') ||
    cleaned.startsWith('/') ||
    cleaned.startsWith('./') ||
    /^data:audio\/(wav|x-wav|mpeg|mp3|mp4|ogg|flac);/i.test(cleaned)
  ) {
    return cleaned;
  }

  warnings.push({
    path,
    code: 'invalid_url',
    message: `${path} 不是受支持的音频链接，已安全忽略`,
  });
  return null;
}

/** 清洗预计算的口型振幅序列，将数值钳制在 [0, 1] 范围内 */
function sanitizeLipSyncArray(raw: unknown): number[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    return [];
  }
  const limit = Math.min(raw.length, HARD_LIMITS.maxLipSyncFrames);
  const result: number[] = new Array<number>(limit);
  for (let i = 0; i < limit; i++) {
    const num = Number(raw[i]);
    result[i] = Number.isFinite(num) ? Math.min(1, Math.max(0, num)) : 0;
  }
  return result;
}

/** 清洗同步口播字幕列表，限制文字长度并保证起止秒数合法且位于章节总时长之内 */
function sanitizeSubtitleArray(raw: unknown, maxDurationSec: number): SanitizedSubtitleCue[] {
  if (!Array.isArray(raw) || raw.length === 0 || maxDurationSec <= 0) {
    return [];
  }
  const cues: SanitizedSubtitleCue[] = [];
  let prevEndSec = 0;
  for (const entry of raw.slice(0, HARD_LIMITS.subtitlesMaxCount)) {
    const rec = LooseRecordSchema.safeParse(entry);
    if (!rec.success) {
      continue;
    }
    const rawText = normalizeText(rec.data.text).replace(/。+$/, '').trim();
    if (!rawText) {
      continue;
    }
    const text = truncateCodepoints(rawText, HARD_LIMITS.subtitleText).text;
    const rawStart = Number(rec.data.startSec);
    const rawEnd = Number(rec.data.endSec);
    if (!Number.isFinite(rawStart) || !Number.isFinite(rawEnd)) {
      continue;
    }
    if (prevEndSec >= maxDurationSec - 0.02) {
      break;
    }
    const startSec = Math.max(
      prevEndSec,
      Math.min(maxDurationSec - 0.02, Math.round(rawStart * 1000) / 1000),
    );
    if (startSec >= maxDurationSec - 0.02) {
      continue;
    }
    const endSec = Math.max(
      startSec + 0.02,
      Math.min(maxDurationSec, Math.round(rawEnd * 1000) / 1000),
    );
    prevEndSec = endSec;
    cues.push({ text, startSec, endSec });
  }
  return cues;
}

/** 校验可选的章节精确帧数配置，仅接受合理正整数 */
function sanitizeOptionalFrameCount(raw: unknown, maxFrames: number): number | null {
  if (raw === undefined || raw === null || raw === '') {
    return null;
  }
  const num = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(num) || num < 1) {
    return null;
  }
  return Math.min(maxFrames, Math.max(1, Math.round(num)));
}

/** 校验并钳制页面停留秒数，保留毫秒级精度并在传入精确帧数时严格使用帧网格时长 */
function clampDuration(
  raw: unknown,
  frameCount: number | null,
  fps: number,
  fallback: number,
  maxSec: number,
  path: string,
  warnings: ValidationWarning[],
): number {
  if (frameCount !== null && fps > 0) {
    return Math.min(maxSec, Math.max(1 / fps, frameCount / fps));
  }
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
  const rounded = Math.round(num * 1000) / 1000;
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

/** 校验并归一化章节纯人声播报秒数，确保不超过当前页面总停留时长 */
function sanitizeSpeechSec(raw: unknown, pageDurationSec: number): number {
  if (raw === undefined || raw === null || raw === '') {
    return pageDurationSec;
  }
  const num = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(num) || num < 0) {
    return pageDurationSec;
  }
  return Math.min(pageDurationSec, Math.round(num * 1000) / 1000);
}

/** 校验右下角角色标识，遇到未知标识时记录提示并回退默认角色 */
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

/** 校验角色展示切换模式，非法输入自动回退按条目切换 */
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

/** 校验看板娘表情状态，未知值统一回退自然状态 */
function sanitizeMascotMood(raw: unknown): MascotMood {
  const normalized = normalizeText(raw).toLowerCase();
  if ((MASCOT_MOODS as readonly string[]).includes(normalized)) {
    return normalized as MascotMood;
  }
  return 'neutral';
}

/** 清洗并补全单条新闻的全部文本、配图、音频与口型字段 */
function sanitizeSingleNewsItem(
  rawItem: unknown,
  index: number,
  hostMascotId: PresetMascotId,
  fps: number,
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
  const category = cleanAndTruncate(
    obj.category,
    HARD_LIMITS.category,
    'AI 动向',
    `${basePath}.category`,
    warnings,
  );
  const title = cleanAndTruncate(
    obj.title,
    HARD_LIMITS.title,
    `今日 AI 核心动态 #${indexLabel}`,
    `${basePath}.title`,
    warnings,
    true,
  );

  // 未显式传入短标题时从主标题安全截取，不产生额外告警
  const rawShortTitle = normalizeText(obj.shortTitle);
  const shortTitle = rawShortTitle
    ? cleanAndTruncate(
        rawShortTitle,
        HARD_LIMITS.shortTitle,
        title,
        `${basePath}.shortTitle`,
        warnings,
      )
    : truncateCodepoints(title, HARD_LIMITS.shortTitle).text;

  // 未显式传入进度条极简总结时从短标题安全截取，兼容旧版手写预览数据
  const rawProgressLabel = normalizeText(obj.progressLabel);
  const progressLabel = rawProgressLabel
    ? cleanAndTruncate(
        rawProgressLabel,
        HARD_LIMITS.progressLabel,
        shortTitle,
        `${basePath}.progressLabel`,
        warnings,
      )
    : truncateCodepoints(shortTitle, HARD_LIMITS.progressLabel).text;

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
  const source = cleanAndTruncate(
    obj.source,
    HARD_LIMITS.source,
    '官方发布',
    `${basePath}.source`,
    warnings,
  );
  const sourceUrl = cleanAndTruncate(
    obj.sourceUrl,
    HARD_LIMITS.sourceUrl,
    '',
    `${basePath}.sourceUrl`,
    warnings,
  );
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
  const mascotMood = sanitizeMascotMood(obj.mascotMood);

  const cards = sanitizeItemCards(obj.cards, summary, keyPoints, officialQuote, basePath, warnings);

  const frameCount = sanitizeOptionalFrameCount(
    obj.frameCount,
    HARD_LIMITS.maxItemDurationSec * fps,
  );
  const durationSec = clampDuration(
    obj.durationSec,
    frameCount,
    fps,
    HARD_LIMITS.defaultItemDurationSec,
    HARD_LIMITS.maxItemDurationSec,
    `${basePath}.durationSec`,
    warnings,
  );
  const speechDurationSec = sanitizeSpeechSec(obj.speechDurationSec, durationSec);
  const audioUrl = sanitizeAudioUrl(obj.audioUrl, `${basePath}.audioUrl`, warnings);
  const lipSyncFrames = sanitizeLipSyncArray(obj.lipSyncFrames);
  const subtitles = sanitizeSubtitleArray(obj.subtitles, durationSec);

  const id = normalizeText(obj.id) || `news-${indexLabel}`;

  return {
    id,
    indexLabel,
    category,
    shortTitle,
    progressLabel,
    title,
    summary,
    cards,
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
    mascotMood,
    frameCount,
    durationSec,
    speechDurationSec,
    audioUrl,
    lipSyncFrames,
    subtitles,
  };
}

/** 生成极端空输入或异常对象时的安全示范日报数据 */
function createEmergencyFallbackIssue(): SanitizedDailyIssue {
  const item = sanitizeSingleNewsItem(
    {
      id: 'fallback-01',
      category: '模板就绪',
      shortTitle: '等待导入本期 AI 日报数据',
      progressLabel: '等待导入日报',
      title: '等待导入本期 AI 日报数据',
      summary: '当前输入数据为空或结构不完整，已自动启用安全示范页，保证视频画面零报错。',
      cards: [
        {
          icon: 'rocket',
          title: '多卡片事实网格',
          body: '画布采用多张结构化信息卡片呈现核心事实，适合高密度呈现新闻细节。',
        },
        {
          icon: 'grid',
          title: '图文双模自适应',
          body: '提供完整卡片矩阵与图文并排两种版式，坏图时无感切回全幅面板。',
        },
        {
          icon: 'shield',
          title: '五层零报错守卫',
          body: '所有超长文案、异常数据与非标准链接均自动截断清理并兜底渲染。',
        },
        {
          icon: 'code',
          title: '快速导入与预览',
          body: '按 E 键打开编辑抽屉导入 JSON，或通过脚本控制接口实时注入各期数据。',
        },
      ],
      keyPoints: [
        '左侧展示精炼新闻梗概',
        '右侧引用官方图片或披露要点',
        '按 E 键打开编辑抽屉导入 JSON',
      ],
      officialQuote:
        '模板支持通过 window.__NEWS_DECK__.setNewsData(json) 动态注入各期数据并自动对齐配音时长。',
      metrics: [
        { label: '画幅规格', value: '1920 × 1080' },
        { label: '容错机制', value: '零报错兜底' },
      ],
      source: '系统安全守卫',
      mascotId: 'deepseek',
    },
    0,
    'deepseek',
    30,
    [],
  );

  return {
    issueTitle: 'AI 每日报',
    issueNumber: 'NO. SAFE',
    date: '今日速递',
    headline: '等待导入本期精选 AI 动态',
    footerCta: '感谢收看 · 各条新闻原始信源链接已附于视频简介',
    fps: 30,
    hostMascotId: 'deepseek',
    hostDisplayName: '聪明的大肥鱼',
    hostMascotUrl: null,
    hostLive2dUrl: null,
    mascotMode: 'per-item',
    bgmAudioUrl: null,
    bgmVolumeDb: -18,
    pagePaddingSec: 1.0,
    coverFrameCount: null,
    coverDurationSec: HARD_LIMITS.defaultCoverDurationSec,
    coverSpeechSec: HARD_LIMITS.defaultCoverDurationSec,
    coverAudioUrl: null,
    coverLipSync: [],
    coverSubtitles: [],
    outroFrameCount: null,
    outroDurationSec: HARD_LIMITS.defaultOutroDurationSec,
    outroSpeechSec: HARD_LIMITS.defaultOutroDurationSec,
    outroAudioUrl: null,
    outroLipSync: [],
    outroSubtitles: [],
    items: [item],
  };
}

/** 将外部输入的不规范日报数据安全清洗为可直接渲染的结构，保证在任何异常输入下都不会抛出错误 */
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
    const rawFps = Number(root.fps);
    const fps = Number.isFinite(rawFps) && rawFps >= 1 && rawFps <= 120 ? Math.round(rawFps) : 30;

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
            .map((entry, idx) => sanitizeSingleNewsItem(entry, idx, hostMascotId, fps, warnings))
        : createEmergencyFallbackIssue().items;

    const firstItem = sanitizedItems[0]!;
    const issueTitle = cleanAndTruncate(
      root.issueTitle,
      HARD_LIMITS.issueTitle,
      'AI 每日报',
      'issueTitle',
      warnings,
    );
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

    const rawHostDisplayName = normalizeText(root.hostDisplayName);
    const hostDisplayName = rawHostDisplayName
      ? cleanAndTruncate(
          rawHostDisplayName,
          HARD_LIMITS.hostDisplayName,
          MASCOT_DEFAULT_NAMES[hostMascotId],
          'hostDisplayName',
          warnings,
        )
      : MASCOT_DEFAULT_NAMES[hostMascotId];

    const coverFrameCount = sanitizeOptionalFrameCount(
      root.coverFrameCount,
      HARD_LIMITS.maxCoverOutroDurationSec * fps,
    );
    const coverDurationSec = clampDuration(
      root.coverDurationSec,
      coverFrameCount,
      fps,
      HARD_LIMITS.defaultCoverDurationSec,
      HARD_LIMITS.maxCoverOutroDurationSec,
      'coverDurationSec',
      warnings,
    );

    const outroFrameCount = sanitizeOptionalFrameCount(
      root.outroFrameCount,
      HARD_LIMITS.maxCoverOutroDurationSec * fps,
    );
    const outroDurationSec = clampDuration(
      root.outroDurationSec,
      outroFrameCount,
      fps,
      HARD_LIMITS.defaultOutroDurationSec,
      HARD_LIMITS.maxCoverOutroDurationSec,
      'outroDurationSec',
      warnings,
    );

    const rawBgmVol = Number(root.bgmVolumeDb);
    const bgmVolumeDb = Number.isFinite(rawBgmVol) ? Math.max(-60, Math.min(0, rawBgmVol)) : -18;

    const rawPadSec = Number(root.pagePaddingSec);
    const pagePaddingSec =
      Number.isFinite(rawPadSec) && rawPadSec >= 0 ? Math.min(10, rawPadSec) : 1.0;

    return {
      issue: {
        issueTitle,
        issueNumber,
        date,
        headline,
        footerCta,
        fps,
        hostMascotId,
        hostDisplayName,
        hostMascotUrl: sanitizeMediaUrl(root.hostMascotUrl, 'hostMascotUrl', warnings),
        hostLive2dUrl: sanitizeMediaUrl(root.hostLive2dUrl, 'hostLive2dUrl', warnings),
        mascotMode,
        bgmAudioUrl: sanitizeAudioUrl(root.bgmAudioUrl, 'bgmAudioUrl', warnings),
        bgmVolumeDb,
        pagePaddingSec,
        coverFrameCount,
        coverDurationSec,
        coverSpeechSec: sanitizeSpeechSec(root.coverSpeechSec, coverDurationSec),
        coverAudioUrl: sanitizeAudioUrl(root.coverAudioUrl, 'coverAudioUrl', warnings),
        coverLipSync: sanitizeLipSyncArray(root.coverLipSync),
        coverSubtitles: sanitizeSubtitleArray(root.coverSubtitles, coverDurationSec),
        outroFrameCount,
        outroDurationSec,
        outroSpeechSec: sanitizeSpeechSec(root.outroSpeechSec, outroDurationSec),
        outroAudioUrl: sanitizeAudioUrl(root.outroAudioUrl, 'outroAudioUrl', warnings),
        outroLipSync: sanitizeLipSyncArray(root.outroLipSync),
        outroSubtitles: sanitizeSubtitleArray(root.outroSubtitles, outroDurationSec),
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
