/** 封面总览溢出滚动的当前偏移与边界指示状态 */
export interface CoverScrollState {
  offsetPx: number;
  progress: number;
  hasOverflow: boolean;
  canScrollUp: boolean;
  canScrollDown: boolean;
}

const OVERFLOW_DEADZONE_PX = 4;

/** 正弦缓入缓出曲线：让自动下拉起步和停稳过程柔和不突兀 */
export function easeInOutSine(t: number): number {
  const c = Math.min(1, Math.max(0, Number.isFinite(t) ? t : 0));
  return -(Math.cos(Math.PI * c) - 1) / 2;
}

/**
 * 计算封面总览瀑布流的垂直滚动偏移（像素）：
 * - 当未溢出可视区（<= 4px）时恒定返回 0；
 * - 播放或逐帧渲染模式下，按「顶部停留 -> 正弦缓动平滑下拉 -> 底部停留」确定性推进；
 * - 暂停浏览模式下直接采用并钳制用户的手动滚轮偏移。
 */
export function computeCoverScrollState(
  localMs: number | null,
  pageDurationMs: number,
  maxScrollPx: number,
  manualOffsetPx = 0,
): CoverScrollState {
  const safeMax =
    Number.isFinite(maxScrollPx) && maxScrollPx > OVERFLOW_DEADZONE_PX ? maxScrollPx : 0;
  if (safeMax <= 0) {
    return {
      offsetPx: 0,
      progress: 0,
      hasOverflow: false,
      canScrollUp: false,
      canScrollDown: false,
    };
  }

  let rawOffset = 0;
  if (localMs === null) {
    rawOffset = Number.isFinite(manualOffsetPx) ? manualOffsetPx : 0;
  } else {
    const safeDur = Number.isFinite(pageDurationMs) && pageDurationMs > 0 ? pageDurationMs : 5000;
    const clampedMs = Math.min(safeDur, Math.max(0, Number.isFinite(localMs) ? localMs : 0));
    const holdTopMs = Math.min(1400, Math.max(400, safeDur * 0.2));
    const holdBottomMs = Math.min(1200, Math.max(350, safeDur * 0.16));
    const travelEndMs = safeDur - holdBottomMs;
    const travelSpanMs = travelEndMs - holdTopMs;

    if (travelSpanMs <= 200) {
      rawOffset = (clampedMs / safeDur) * safeMax;
    } else if (clampedMs <= holdTopMs) {
      rawOffset = 0;
    } else if (clampedMs >= travelEndMs) {
      rawOffset = safeMax;
    } else {
      const linear = (clampedMs - holdTopMs) / travelSpanMs;
      rawOffset = easeInOutSine(linear) * safeMax;
    }
  }

  const offsetPx = Number(Math.min(safeMax, Math.max(0, rawOffset)).toFixed(2));
  const progress = Number(Math.min(1, Math.max(0, offsetPx / safeMax)).toFixed(4));

  return {
    offsetPx,
    progress,
    hasOverflow: true,
    canScrollUp: offsetPx > 2,
    canScrollDown: offsetPx < safeMax - 2,
  };
}
