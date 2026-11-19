/** 每张卡片从透明到完全显示的淡入时长（毫秒） */
export const CARD_REVEAL_FADE_MS = 420;

/** 相邻两张卡片出现的最小间隔（毫秒），避免几张卡挤在同一时刻冒出来 */
export const CARD_REVEAL_MIN_GAP_MS = 1200;

/** 所有卡片最晚要在口播进行到这个比例前出齐，给观众留出回看时间 */
export const CARD_REVEAL_DEADLINE_RATIO = 0.7;

/** 淡入时卡片从下方上移的距离（像素） */
export const CARD_REVEAL_RISE_PX = 14;

/** 单张卡片在某一时刻的显示状态 */
export interface CardRevealState {
  /** 淡入进度：0 表示还没出现，1 表示完全显示 */
  progress: number;
  /** 高亮强度：0 表示普通状态，1 表示完全高亮；在新旧两张卡之间平滑交接 */
  focus: number;
  /** 是否是主播此刻正在讲的那张（高亮强度过半即算） */
  isCurrent: boolean;
}

/** 口播结束后高亮淡出的时长（毫秒） */
export const CARD_FOCUS_RELEASE_MS = 300;

/**
 * 计算每张信息卡片相对本页开始的出现时间（毫秒）。
 * 第一张随翻页一起出现（在播前留白期让观众先看大标题和首张卡）；
 * 其余优先对齐口播字幕句首，没有字幕时在口播真正开始后的前 70% 时长内均匀铺开；
 * 相邻两张至少间隔 1.2 秒，且都不晚于口播开始后 70% 处。
 */
export function computeCardRevealTimesMs(
  cardCount: number,
  subtitles: readonly { startSec: number }[],
  speechMs: number,
  speechStartMs = 0,
): number[] {
  const count = Math.max(0, Math.floor(cardCount));
  if (count === 0) {
    return [];
  }
  const safeStartMs = Number.isFinite(speechStartMs) && speechStartMs > 0 ? speechStartMs : 0;
  const safeSpeechMs = Number.isFinite(speechMs) && speechMs > 0 ? speechMs : 0;
  const deadlineMs = safeStartMs + safeSpeechMs * CARD_REVEAL_DEADLINE_RATIO;
  const cueStartsMs = subtitles
    .map((cue) => cue.startSec * 1000)
    .filter((ms) => Number.isFinite(ms) && ms >= 0)
    .sort((a, b) => a - b);

  const times: number[] = [0];
  for (let i = 1; i < count; i++) {
    let target: number;
    if (cueStartsMs.length >= 2) {
      const cueIdx = Math.min(cueStartsMs.length - 1, Math.floor((i * cueStartsMs.length) / count));
      target = cueStartsMs[cueIdx] ?? safeStartMs;
    } else {
      target =
        safeStartMs + (i * safeSpeechMs * CARD_REVEAL_DEADLINE_RATIO) / Math.max(1, count - 1);
    }
    const prev = times[i - 1] ?? 0;
    const spaced = Math.max(target, safeStartMs, prev + CARD_REVEAL_MIN_GAP_MS);
    times.push(Math.min(spaced, Math.max(prev, deadlineMs)));
  }
  return times;
}

/** 平滑的缓出曲线，让卡片淡入的收尾更柔和 */
function easeOutCubic(t: number): number {
  const c = Math.min(1, Math.max(0, t));
  return 1 - (1 - c) ** 3;
}

/**
 * 根据本页已播放的毫秒数，算出每张卡片的淡入进度和高亮强度。
 * 最近出现的一张卡片高亮（随它淡入逐渐变亮，上一张同步变暗）；口播结束后高亮淡出，所有卡片恢复平级。
 * 结果只由传入的时间决定，同一时刻重复计算结果完全一致，可用于逐帧渲染。
 */
export function resolveCardRevealStates(
  revealTimesMs: readonly number[],
  localMs: number,
  speechMs: number,
  speechStartMs = 0,
): CardRevealState[] {
  const safeLocalMs = Number.isFinite(localMs) ? localMs : 0;
  const safeStartMs = Number.isFinite(speechStartMs) && speechStartMs > 0 ? speechStartMs : 0;
  const count = revealTimesMs.length;

  // 第一张随页面一起渐变进场，本身不再单独淡入
  const progresses = revealTimesMs.map((startMs, idx) =>
    idx === 0 ? 1 : easeOutCubic((safeLocalMs - startMs) / CARD_REVEAL_FADE_MS),
  );

  let currentIdx = -1;
  for (let i = 0; i < count; i++) {
    if (safeLocalMs >= (revealTimesMs[i] ?? 0)) {
      currentIdx = i;
    }
  }

  const hasSpeech = Number.isFinite(speechMs) && speechMs > 0;
  const speechEndMs = safeStartMs + (hasSpeech ? speechMs : 0);
  const releaseFactor = hasSpeech
    ? 1 - Math.min(1, Math.max(0, (safeLocalMs - speechEndMs) / CARD_FOCUS_RELEASE_MS))
    : 0;
  const currentProgress = currentIdx >= 0 ? (progresses[currentIdx] ?? 1) : 0;

  return progresses.map((progress, idx) => {
    let focus = 0;
    if (count > 1 && currentIdx >= 0) {
      if (idx === currentIdx) {
        focus = currentProgress;
      } else if (idx === currentIdx - 1) {
        focus = 1 - currentProgress;
      }
    }
    focus = Number((focus * releaseFactor).toFixed(4));
    return { progress, focus, isCurrent: focus >= 0.5 };
  });
}
