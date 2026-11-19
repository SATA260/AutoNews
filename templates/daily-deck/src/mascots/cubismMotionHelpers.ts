/** 单个动作文件的基本元信息摘要，用于决定多动作交替与嘴型衔接方式 */
export interface MotionClipSummary {
  durationSec: number;
  loop?: boolean;
  hasMouthFormCurve?: boolean;
}

/** 根据当前时间与说话状态选出的动作采样结果 */
export interface SelectedMotionSample {
  clipKind: 'fullbody' | 'talk' | 'idle';
  localTimeSec: number;
  preserveNeutralMouthForm: boolean;
}

/** 角色在默认参数下的可见几何边界（模型坐标系），用于精准对齐头顶与大腿中部裁剪 */
export interface ModelRestBounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

/** 渲染顶点着色器所需的二维缩放与平移投影参数 */
export interface MascotProjection {
  scaleX: number;
  scaleY: number;
  offsetX: number;
  offsetY: number;
}

/** 计算在正负实数输入下始终落在 `[0, period)` 区间的非负数学取模值 */
export function positiveModulo(value: number, period: number): number {
  const m = value % period;
  return m < 0 ? m + period : m;
}

/**
 * 为当前帧确定性选择动作片段与局部采样时间：
 * 具备全身动作的模型按「全身动作 + 待机/口播待机」无缝交替循环；仅表情版模型直接循环待机或口播待机。
 */
export function selectMotionSample(opts: {
  timeSec: number;
  speaking: boolean;
  fullBody: MotionClipSummary | null;
  idle: MotionClipSummary | null;
  talk: MotionClipSummary | null;
}): SelectedMotionSample | null {
  const restClip = opts.speaking && opts.talk ? opts.talk : (opts.idle ?? opts.talk);
  const restKind: 'idle' | 'talk' =
    opts.speaking && opts.talk ? 'talk' : opts.idle ? 'idle' : 'talk';

  if (opts.fullBody) {
    const fullBodyDur = Math.max(0.1, opts.fullBody.durationSec);
    if (restClip) {
      const restDur = Math.max(0.1, restClip.durationSec);
      const cycleDur = fullBodyDur + restDur;
      const phaseSec = positiveModulo(opts.timeSec, cycleDur);
      if (phaseSec < fullBodyDur) {
        return {
          clipKind: 'fullbody',
          localTimeSec: phaseSec,
          preserveNeutralMouthForm: Boolean(opts.fullBody.hasMouthFormCurve),
        };
      }
      return {
        clipKind: restKind,
        localTimeSec: phaseSec - fullBodyDur,
        preserveNeutralMouthForm: false,
      };
    }
    return {
      clipKind: 'fullbody',
      localTimeSec: positiveModulo(opts.timeSec, fullBodyDur),
      preserveNeutralMouthForm: Boolean(opts.fullBody.hasMouthFormCurve),
    };
  }

  if (!restClip) {
    return null;
  }
  const dur = Math.max(0.1, restClip.durationSec);
  const localTimeSec =
    restClip.loop !== false
      ? positiveModulo(opts.timeSec, dur)
      : Math.min(dur, Math.max(0, opts.timeSec));
  return {
    clipKind: restKind,
    localTimeSec,
    preserveNeutralMouthForm: false,
  };
}

/**
 * 根据默认姿态几何包围盒与画布宽高比计算 WebGL 投影参数：
 * 高挑角色裁切至大腿中部以上并留出横向挥手空间，Q 版角色完整展示主体与鲸尾。
 */
export function computeMascotProjection(opts: {
  canvasWidth: number;
  canvasHeight: number;
  unitW: number;
  unitH: number;
  restBounds: ModelRestBounds | null;
}): MascotProjection {
  const cw = Math.max(1, opts.canvasWidth);
  const ch = Math.max(1, opts.canvasHeight);
  const aspectCanvas = cw / ch;

  if (opts.restBounds) {
    const restWidth = opts.restBounds.maxX - opts.restBounds.minX;
    const restHeight = opts.restBounds.maxY - opts.restBounds.minY;
    if (restWidth > 0.05 && restHeight > 0.05) {
      const bodyAspect = restHeight / restWidth;
      const isTall = bodyAspect > 1.45;
      const maxHorizontalSpan = Math.max(opts.unitW, restWidth * 1.04);
      const visibleSpanY = restHeight * (isTall ? 0.62 : 0.9);
      const targetNdcSpanY = isTall ? 1.94 : 1.92;
      const maxNdcSpanX = isTall ? 1.94 : 1.92;
      const idealScaleY = targetNdcSpanY / visibleSpanY;
      const scaleX = Math.min(maxNdcSpanX / maxHorizontalSpan, idealScaleY / aspectCanvas);
      const scaleY = scaleX * aspectCanvas;
      const offsetY = 0.94 - opts.restBounds.maxY * scaleY;
      return {
        scaleX,
        scaleY,
        offsetX: 0,
        offsetY,
      };
    }
  }

  if (opts.unitH > 1.38) {
    const visibleSpanY = opts.unitH * 0.59;
    const idealScaleY = 1.94 / visibleSpanY;
    const scaleX = Math.min(1.94 / opts.unitW, idealScaleY * (1 / aspectCanvas));
    const scaleY = scaleX * aspectCanvas;
    const topModelY = opts.unitH / 2;
    return {
      scaleX,
      scaleY,
      offsetX: 0,
      offsetY: 0.95 - topModelY * scaleY,
    };
  }

  const visibleSpanY = opts.unitH * 0.9;
  const idealScaleY = 1.92 / visibleSpanY;
  const scaleX = Math.min(1.92 / opts.unitW, idealScaleY * (1 / aspectCanvas));
  const scaleY = scaleX * aspectCanvas;
  const topModelY = opts.unitH / 2;
  return {
    scaleX,
    scaleY,
    offsetX: 0,
    offsetY: 0.94 - topModelY * scaleY,
  };
}
