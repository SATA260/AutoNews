import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import type { DeckClockMode } from '../../bridge/videoSynthBridge';
import {
  type CubismMascotController,
  loadCubismMascotController,
} from '../../mascots/cubismWebGLRenderer';
import type { MascotMood } from '../../schema/newsSchema';

/** 暴露给主容器与虚拟时钟桥接层的看板娘命令式控制句柄 */
export interface MascotImperativeHandle {
  /** 当前是否已完成 Live2D 模型加载并处于可绘制状态 */
  isLive2DReady: () => boolean;
  /** 等待当前正在加载的模型完成就绪（若无模型或降级静态图则立即返回 false） */
  waitUntilReady: (timeoutMs?: number) => Promise<boolean>;
  /** 重置状态并在指定章节起点按真实表情与固定步长执行确定性物理预热 */
  warmupPhysics: (atTimeMs: number, steps?: number, mood?: MascotMood, stepMs?: number) => void;
  /** 按指定毫秒时刻、帧间隔与口型振幅同步推演并绘制一帧 */
  renderAt: (
    timeMs: number,
    dtMs: number,
    mouthOpen: number,
    mood: MascotMood,
    speaking: boolean,
  ) => void;
}

/** Live2D 画布组件入参属性 */
export interface Live2DMascotCanvasProps {
  modelJsonUrl: string;
  clockMode: DeckClockMode;
  globalTimeMs: number;
  mouthOpen: number;
  mood: MascotMood;
  speaking: boolean;
  onReadyStateChange?: (ready: boolean) => void;
  onFallbackTriggered?: (reason: string) => void;
}

/** 检查当前运行环境是否具备 WebGL 与 Cubism Core 运行条件 */
export function canAttemptLive2D(): boolean {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return false;
  }
  if (typeof navigator !== 'undefined' && /jsdom/i.test(navigator.userAgent)) {
    return false;
  }
  return Boolean(window.Live2DCubismCore);
}

/** 右下角 Live2D WebGL 渲染画布：支持浏览器实时帧循环驱动与确定性虚拟时钟单步驱动 */
export const Live2DMascotCanvas = forwardRef<MascotImperativeHandle, Live2DMascotCanvasProps>(
  function Live2DMascotCanvas(
    {
      modelJsonUrl,
      clockMode,
      globalTimeMs,
      mouthOpen,
      mood,
      speaking,
      onReadyStateChange,
      onFallbackTriggered,
    },
    ref,
  ) {
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const controllerRef = useRef<CubismMascotController | null>(null);
    const readyPromiseRef = useRef<Promise<boolean>>(Promise.resolve(false));
    const [ready, setReady] = useState(false);

    const livePropsRef = useRef({
      globalTimeMs,
      mouthOpen,
      mood,
      speaking,
    });
    livePropsRef.current = { globalTimeMs, mouthOpen, mood, speaking };

    useEffect(() => {
      const canvas = canvasRef.current;
      if (!canvas || !modelJsonUrl || !canAttemptLive2D()) {
        controllerRef.current = null;
        setReady(false);
        onReadyStateChange?.(false);
        readyPromiseRef.current = Promise.resolve(false);
        return;
      }

      let cancelled = false;
      setReady(false);
      onReadyStateChange?.(false);

      const handleContextLost = (reason: string) => {
        if (cancelled) {
          return;
        }
        controllerRef.current = null;
        setReady(false);
        onReadyStateChange?.(false);
        onFallbackTriggered?.(reason);
      };

      const loadTask = loadCubismMascotController(canvas, modelJsonUrl, handleContextLost)
        .then((ctrl) => {
          if (cancelled || ctrl.isDisposed()) {
            ctrl.dispose();
            return false;
          }
          controllerRef.current = ctrl;
          ctrl.step({
            timeMs: livePropsRef.current.globalTimeMs,
            dtMs: 1000 / 30,
            mouthOpen: livePropsRef.current.mouthOpen,
            mood: livePropsRef.current.mood,
            speaking: livePropsRef.current.speaking,
          });
          setReady(true);
          onReadyStateChange?.(true);
          return true;
        })
        .catch((err) => {
          if (!cancelled) {
            controllerRef.current = null;
            setReady(false);
            onReadyStateChange?.(false);
            onFallbackTriggered?.(err instanceof Error ? err.message : String(err));
          }
          return false;
        });

      readyPromiseRef.current = loadTask;

      return () => {
        cancelled = true;
        const active = controllerRef.current;
        controllerRef.current = null;
        active?.dispose();
      };
    }, [modelJsonUrl, onFallbackTriggered, onReadyStateChange]);

    // 实时预览模式下启动本地动画帧循环，驱动呼吸、眨眼、物理与语音口型
    useEffect(() => {
      if (clockMode !== 'realtime' || !ready) {
        return;
      }
      let rafId = 0;
      let lastPerf = performance.now();
      const basePerf = lastPerf;

      const tick = (now: number) => {
        const ctrl = controllerRef.current;
        if (ctrl && !ctrl.isDisposed()) {
          const dtMs = Math.min(66, Math.max(4, now - lastPerf));
          lastPerf = now;
          const timeMs =
            livePropsRef.current.globalTimeMs > 0
              ? livePropsRef.current.globalTimeMs
              : now - basePerf;
          try {
            ctrl.step({
              timeMs,
              dtMs,
              mouthOpen: livePropsRef.current.mouthOpen,
              mood: livePropsRef.current.mood,
              speaking: livePropsRef.current.speaking,
            });
          } catch (err) {
            controllerRef.current = null;
            setReady(false);
            onReadyStateChange?.(false);
            onFallbackTriggered?.(err instanceof Error ? err.message : String(err));
            return;
          }
        }
        rafId = window.requestAnimationFrame(tick);
      };

      rafId = window.requestAnimationFrame(tick);
      return () => {
        window.cancelAnimationFrame(rafId);
      };
    }, [clockMode, onFallbackTriggered, onReadyStateChange, ready]);

    useImperativeHandle(
      ref,
      () => ({
        isLive2DReady: () => Boolean(controllerRef.current && !controllerRef.current.isDisposed()),
        waitUntilReady: async (timeoutMs = 10_000) => {
          const timer = new Promise<boolean>((resolve) =>
            setTimeout(() => resolve(false), timeoutMs),
          );
          return Promise.race([readyPromiseRef.current, timer]);
        },
        warmupPhysics: (
          atTimeMs: number,
          steps = 18,
          nextMood: MascotMood = 'neutral',
          stepMs = 1000 / 30,
        ) => {
          controllerRef.current?.warmup(atTimeMs, steps, nextMood, stepMs);
        },
        renderAt: (
          timeMs: number,
          dtMs: number,
          nextMouthOpen: number,
          nextMood: MascotMood,
          nextSpeaking: boolean,
        ) => {
          controllerRef.current?.step({
            timeMs,
            dtMs,
            mouthOpen: nextMouthOpen,
            mood: nextMood,
            speaking: nextSpeaking,
          });
        },
      }),
      [],
    );

    return (
      <canvas
        ref={canvasRef}
        width={600}
        height={840}
        className={`corner-mascot-live2d-canvas ${ready ? 'is-ready' : 'is-loading'}`}
        data-testid="corner-mascot-live2d"
      />
    );
  },
);
