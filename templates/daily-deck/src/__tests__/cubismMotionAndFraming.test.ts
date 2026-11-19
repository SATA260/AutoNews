import { describe, expect, it } from 'vitest';
import {
  computeMascotProjection,
  type ModelRestBounds,
  type MotionClipSummary,
  selectMotionSample,
} from '../mascots/cubismMotionHelpers';

describe('全身 Live2D 动作调度与构图测算', () => {
  const fullBodyClip: MotionClipSummary = {
    durationSec: 8,
    loop: false,
    hasMouthFormCurve: true,
  };
  const idleClip: MotionClipSummary = {
    durationSec: 8,
    loop: true,
    hasMouthFormCurve: false,
  };
  const talkClip: MotionClipSummary = {
    durationSec: 8,
    loop: true,
    hasMouthFormCurve: false,
  };

  it('具备全身动作时按 8 秒全身动作与 8 秒待机/说话无缝交替循环，并支持负时间预热', () => {
    // 0 ~ 8s 处于全身动作区间，且中性情绪下保留动作自带嘴角曲线
    const atStart = selectMotionSample({
      timeSec: 0,
      speaking: false,
      fullBody: fullBodyClip,
      idle: idleClip,
      talk: talkClip,
    });
    expect(atStart).toEqual({
      clipKind: 'fullbody',
      localTimeSec: 0,
      preserveNeutralMouthForm: true,
    });

    const atPeakSpeak = selectMotionSample({
      timeSec: 1.5,
      speaking: true,
      fullBody: fullBodyClip,
      idle: idleClip,
      talk: talkClip,
    });
    expect(atPeakSpeak).toEqual({
      clipKind: 'fullbody',
      localTimeSec: 1.5,
      preserveNeutralMouthForm: true,
    });

    // 8 ~ 16s 进入 Idle 或 Talk 区间，localTimeSec 从 0 开始计算
    const atIdle = selectMotionSample({
      timeSec: 9.25,
      speaking: false,
      fullBody: fullBodyClip,
      idle: idleClip,
      talk: talkClip,
    });
    expect(atIdle).toEqual({
      clipKind: 'idle',
      localTimeSec: 1.25,
      preserveNeutralMouthForm: false,
    });

    const atTalk = selectMotionSample({
      timeSec: 11.4,
      speaking: true,
      fullBody: fullBodyClip,
      idle: idleClip,
      talk: talkClip,
    });
    expect(atTalk?.clipKind).toBe('talk');
    expect(atTalk?.localTimeSec).toBeCloseTo(3.4, 6);
    expect(atTalk?.preserveNeutralMouthForm).toBe(false);

    // 16s 起开启新一轮全身动作
    const secondCycle = selectMotionSample({
      timeSec: 17.2,
      speaking: true,
      fullBody: fullBodyClip,
      idle: idleClip,
      talk: talkClip,
    });
    expect(secondCycle?.clipKind).toBe('fullbody');
    expect(secondCycle?.localTimeSec).toBeCloseTo(1.2, 6);

    // 负时间预热（例如在 t=0 之前从 -0.5s 开始预热物理）落在上一周期末尾 idle@7.5s
    const negativeWarmup = selectMotionSample({
      timeSec: -0.5,
      speaking: false,
      fullBody: fullBodyClip,
      idle: idleClip,
      talk: talkClip,
    });
    expect(negativeWarmup?.clipKind).toBe('idle');
    expect(negativeWarmup?.localTimeSec).toBeCloseTo(7.5, 6);
  });

  it('无全身动作的仅表情版模型自动回退 Idle/Talk 循环且不锁定嘴角参数', () => {
    const atIdle = selectMotionSample({
      timeSec: 10.5,
      speaking: false,
      fullBody: null,
      idle: idleClip,
      talk: talkClip,
    });
    expect(atIdle?.clipKind).toBe('idle');
    expect(atIdle?.localTimeSec).toBeCloseTo(2.5, 6);
    expect(atIdle?.preserveNeutralMouthForm).toBe(false);

    const atTalk = selectMotionSample({
      timeSec: 3.2,
      speaking: true,
      fullBody: null,
      idle: idleClip,
      talk: talkClip,
    });
    expect(atTalk?.clipKind).toBe('talk');
    expect(atTalk?.localTimeSec).toBeCloseTo(3.2, 6);
    expect(atTalk?.preserveNeutralMouthForm).toBe(false);
  });

  it('高挑角色与 Q 版角色在全身版与仅表情版下均对齐头顶、裁至大腿中部且挥手峰值不裁边', () => {
    const tallCases: Array<{
      name: string;
      unitW: number;
      unitH: number;
      bounds: ModelRestBounds;
      peakArmMinX?: number;
    }> = [
      {
        name: 'fullbody-gemini',
        unitW: 1.0,
        unitH: 1.636,
        bounds: { minX: -0.414, maxX: 0.414, minY: -0.732, maxY: 0.732 },
        peakArmMinX: -0.505,
      },
      {
        name: 'fullbody-gpt',
        unitW: 1.0,
        unitH: 1.613,
        bounds: { minX: -0.415, maxX: 0.415, minY: -0.722, maxY: 0.722 },
      },
      {
        name: 'fullbody-claude',
        unitW: 1.0,
        unitH: 1.704,
        bounds: { minX: -0.411, maxX: 0.411, minY: -0.762, maxY: 0.762 },
      },
      {
        name: 'expression-gemini',
        unitW: 1.0,
        unitH: 1.734,
        bounds: { minX: -0.478, maxX: 0.478, minY: -0.845, maxY: 0.845 },
      },
    ];

    for (const c of tallCases) {
      const proj = computeMascotProjection({
        canvasWidth: 632,
        canvasHeight: 580,
        unitW: c.unitW,
        unitH: c.unitH,
        restBounds: c.bounds,
      });
      // 头顶落在 NDC +0.94
      expect(c.bounds.maxY * proj.scaleY + proj.offsetY).toBeCloseTo(0.94, 4);
      // 画布底边 (-1.0) 对应的身体可见比例落在大腿中部 (0.60 ~ 0.66)
      const visibleTop = c.bounds.maxY;
      const visibleBottom = (-1 - proj.offsetY) / proj.scaleY;
      const visibleRatio = (visibleTop - visibleBottom) / (c.bounds.maxY - c.bounds.minY);
      expect(visibleRatio).toBeGreaterThan(0.6);
      expect(visibleRatio).toBeLessThan(0.66);
      // 横向（含手臂峰值）不超出 NDC [-1, 1]
      expect(c.bounds.minX * proj.scaleX + proj.offsetX).toBeGreaterThan(-0.98);
      expect(c.bounds.maxX * proj.scaleX + proj.offsetX).toBeLessThan(0.98);
      if (c.peakArmMinX !== undefined) {
        expect(c.peakArmMinX * proj.scaleX + proj.offsetX).toBeGreaterThan(-0.99);
      }
    }

    const chibiCases: Array<{
      name: string;
      unitW: number;
      unitH: number;
      bounds: ModelRestBounds;
    }> = [
      {
        name: 'fullbody-deepseek',
        unitW: 1.0,
        unitH: 1.192,
        bounds: { minX: -0.422, maxX: 0.422, minY: -0.518, maxY: 0.518 },
      },
      {
        name: 'expression-deepseek',
        unitW: 1.0,
        unitH: 1.218,
        bounds: { minX: -0.48, maxX: 0.48, minY: -0.589, maxY: 0.589 },
      },
    ];

    for (const c of chibiCases) {
      const proj = computeMascotProjection({
        canvasWidth: 632,
        canvasHeight: 580,
        unitW: c.unitW,
        unitH: c.unitH,
        restBounds: c.bounds,
      });
      expect(c.bounds.maxY * proj.scaleY + proj.offsetY).toBeCloseTo(0.94, 4);
      expect(c.bounds.minX * proj.scaleX + proj.offsetX).toBeGreaterThan(-0.98);
      expect(c.bounds.maxX * proj.scaleX + proj.offsetX).toBeLessThan(0.98);
    }
  });
});
