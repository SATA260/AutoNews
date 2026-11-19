import { CARD_REVEAL_FADE_MS } from './cardReveal';

/** 配图从右向左展开铺满信息板所需的动画时长（毫秒） */
export const IMAGE_SPOTLIGHT_EXPAND_MS = 560;

/** 配图从左向右收回右侧栏所需的动画时长（毫秒） */
export const IMAGE_SPOTLIGHT_RETRACT_MS = 480;

/** 配图全板放大停留的最长时长（毫秒） */
export const IMAGE_SPOTLIGHT_MAX_HOLD_MS = 5400;

/** 最后一张信息卡片淡入完毕后留给观众的默认阅读停顿（毫秒） */
export const IMAGE_SPOTLIGHT_POST_CARD_BREATH_MS = 900;

/** 配图收回归位后到翻页切换前的默认平稳留白（毫秒） */
export const IMAGE_SPOTLIGHT_TAIL_SETTLE_MS = 550;

/** 配图动态放大展示所处的阶段标识 */
export type ImageSpotlightPhase = 'idle' | 'expanding' | 'holding' | 'retracting';

/** 单页内配图展开与收回的时间窗口边界（单位均为相对本页起点的毫秒数） */
export interface ImageSpotlightWindow {
  /** 开始从右向左展开的毫秒时刻 */
  expandStartMs: number;
  /** 完全铺满信息板的毫秒时刻 */
  expandEndMs: number;
  /** 开始从左向右收回的毫秒时刻 */
  retractStartMs: number;
  /** 完全收回到右侧栏的毫秒时刻 */
  retractEndMs: number;
}

/** 某一播放时刻下配图的展示阶段与展开进度（0 表示常态分栏，1 表示铺满整块信息板） */
export interface ImageSpotlightState {
  /** 当前展示阶段 */
  phase: ImageSpotlightPhase;
  /** 展开进度（0～1） */
  progress: number;
}

/** 三次方缓入缓出曲线：让配图展开与收回的起步和收尾都柔和自然 */
export function easeInOutCubic(t: number): number {
  const c = Math.min(1, Math.max(0, Number.isFinite(t) ? t : 0));
  return c < 0.5 ? 4 * c * c * c : 1 - (-2 * c + 2) ** 3 / 2;
}

/**
 * 计算单条新闻页面内配图「从右向左展开 → 停留放大 → 从左向右收回」的时间窗口。
 * 保证展开动作发生在最后一张信息卡片完全出现并留出阅读停顿之后，
 * 并在页面结束翻页前完成归位；若页面有效空闲时间太短则跳过放大并返回空值。
 */
export function computeImageSpotlightWindow(
  pageDurationMs: number,
  lastCardRevealMs: number,
  cardFadeMs = CARD_REVEAL_FADE_MS,
): ImageSpotlightWindow | null {
  if (!Number.isFinite(pageDurationMs) || pageDurationMs < 3500) {
    return null;
  }

  const safeLastReveal =
    Number.isFinite(lastCardRevealMs) && lastCardRevealMs > 0 ? lastCardRevealMs : 0;
  const safeFade = Number.isFinite(cardFadeMs) && cardFadeMs > 0 ? cardFadeMs : 0;
  const lastCardDoneMs = safeLastReveal + safeFade;

  const tailSettleMs = Math.min(
    IMAGE_SPOTLIGHT_TAIL_SETTLE_MS,
    Math.max(250, pageDurationMs * 0.03),
  );
  const retractEndMs = pageDurationMs - tailSettleMs;
  const rawAvailable = retractEndMs - lastCardDoneMs;
  if (rawAvailable < 1150) {
    return null;
  }

  const comfortThreshold =
    IMAGE_SPOTLIGHT_POST_CARD_BREATH_MS +
    IMAGE_SPOTLIGHT_EXPAND_MS +
    4500 +
    IMAGE_SPOTLIGHT_RETRACT_MS;

  let breathMs: number;
  if (rawAvailable >= comfortThreshold) {
    breathMs = IMAGE_SPOTLIGHT_POST_CARD_BREATH_MS;
  } else if (pageDurationMs < 12_000) {
    breathMs = Math.min(450, Math.max(220, rawAvailable * 0.16));
  } else {
    breathMs = Math.min(IMAGE_SPOTLIGHT_POST_CARD_BREATH_MS, Math.max(450, rawAvailable * 0.1));
  }

  const availableWindow = retractEndMs - (lastCardDoneMs + breathMs);
  if (availableWindow < 900) {
    return null;
  }

  const useStandardTransition =
    availableWindow >= IMAGE_SPOTLIGHT_EXPAND_MS + IMAGE_SPOTLIGHT_RETRACT_MS + 1000;
  const expandMs = useStandardTransition
    ? IMAGE_SPOTLIGHT_EXPAND_MS
    : Math.round(Math.min(IMAGE_SPOTLIGHT_EXPAND_MS, availableWindow * 0.25));
  const retractMs = useStandardTransition
    ? IMAGE_SPOTLIGHT_RETRACT_MS
    : Math.round(Math.min(IMAGE_SPOTLIGHT_RETRACT_MS, availableWindow * 0.23));

  const holdMs = Math.min(
    IMAGE_SPOTLIGHT_MAX_HOLD_MS,
    Math.max(0, availableWindow - expandMs - retractMs),
  );

  // 将展示窗口右对齐到收回结束点，给前面的信息卡片留足阅读时间
  const retractStartMs = retractEndMs - retractMs;
  const expandEndMs = retractStartMs - holdMs;
  const expandStartMs = expandEndMs - expandMs;

  return {
    expandStartMs,
    expandEndMs,
    retractStartMs,
    retractEndMs,
  };
}

/**
 * 根据本页当前播放毫秒数计算配图的阶段与展开进度。
 * 输出完全由输入时间决定，重复查询同一时刻保证得到一致结果，适合逐帧渲染与预览联动。
 */
export function resolveImageSpotlightState(
  windowSpec: ImageSpotlightWindow | null,
  localMs: number,
): ImageSpotlightState {
  if (!windowSpec || !Number.isFinite(localMs)) {
    return { phase: 'idle', progress: 0 };
  }
  const { expandStartMs, expandEndMs, retractStartMs, retractEndMs } = windowSpec;
  if (localMs <= expandStartMs || localMs >= retractEndMs) {
    return { phase: 'idle', progress: 0 };
  }
  if (localMs < expandEndMs) {
    const t = (localMs - expandStartMs) / Math.max(1, expandEndMs - expandStartMs);
    return {
      phase: 'expanding',
      progress: Number(easeInOutCubic(t).toFixed(4)),
    };
  }
  if (localMs <= retractStartMs) {
    return { phase: 'holding', progress: 1 };
  }
  const t = (localMs - retractStartMs) / Math.max(1, retractEndMs - retractStartMs);
  return {
    phase: 'retracting',
    progress: Number((1 - easeInOutCubic(t)).toFixed(4)),
  };
}
