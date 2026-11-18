import { forwardRef, useCallback, useEffect, useState } from 'react';
import type { DeckClockMode } from '../../bridge/videoSynthBridge';
import { getMascotProfile } from '../../mascots/mascotRegistry';
import type { MascotMood, PresetMascotId } from '../../schema/newsSchema';
import { DeckErrorBoundary } from '../guard/DeckErrorBoundary';
import { SafeMedia } from '../guard/SafeMedia';
import {
  canAttemptLive2D,
  Live2DMascotCanvas,
  type MascotImperativeHandle,
} from './Live2DMascotCanvas';

const BUILTIN_LIVE2D_IDS: ReadonlySet<PresetMascotId> = new Set([
  'deepseek',
  'gpt',
  'gemini',
  'claude',
]);

/** 解析当前角色对应的 Live2D 模型入口链接；若无可用模型则返回空值并回退静态立绘 */
function resolveLive2DModelUrl(
  mascotId: PresetMascotId,
  explicitLive2dUrl?: string | null,
): string | null {
  if (explicitLive2dUrl) {
    return explicitLive2dUrl;
  }
  if (!BUILTIN_LIVE2D_IDS.has(mascotId)) {
    return null;
  }
  // 仅当页面显式配置了 Live2D 入口或后端挂载了模型目录时启用 Live2D
  return null;
}

/** 右下角看板娘舞台组件入参属性 */
export interface CornerMascotProps {
  mascotId: PresetMascotId;
  customMascotUrl?: string | null;
  live2dModelUrl?: string | null;
  clockMode?: DeckClockMode;
  globalTimeMs?: number;
  mouthOpen?: number;
  mood?: MascotMood;
  speaking?: boolean;
  onLive2DReadyChange?: (ready: boolean) => void;
  onErrorCaptured?: (scopeName: string, message: string) => void;
}

/**
 * 右下角大尺寸看板娘舞台（300 × 420 贴底站立）：
 * 优先渲染支持实时口型与微表情的 Live2D 模型，在无模型或无头测试环境下自动平滑回退到静态立绘。
 */
export const CornerMascot = forwardRef<MascotImperativeHandle, CornerMascotProps>(
  function CornerMascot(
    {
      mascotId,
      customMascotUrl,
      live2dModelUrl,
      clockMode = 'realtime',
      globalTimeMs = 0,
      mouthOpen = 0,
      mood = 'neutral',
      speaking = false,
      onLive2DReadyChange,
      onErrorCaptured,
    },
    ref,
  ) {
    const targetLive2dUrl = resolveLive2DModelUrl(mascotId, live2dModelUrl);
    const [failedLive2dUrl, setFailedLive2dUrl] = useState<string | null>(null);
    const [readyLive2dUrl, setReadyLive2dUrl] = useState<string | null>(null);
    const live2dFailed = Boolean(targetLive2dUrl && failedLive2dUrl === targetLive2dUrl);
    const live2dReady = Boolean(targetLive2dUrl && readyLive2dUrl === targetLive2dUrl);

    const handleReadyChange = useCallback(
      (ready: boolean) => {
        setReadyLive2dUrl(ready ? targetLive2dUrl : null);
        onLive2DReadyChange?.(ready);
      },
      [onLive2DReadyChange, targetLive2dUrl],
    );

    const handleFallback = useCallback(
      (reason: string) => {
        setFailedLive2dUrl(targetLive2dUrl);
        setReadyLive2dUrl(null);
        onLive2DReadyChange?.(false);
        onErrorCaptured?.('live2d', reason || 'Live2D 模型加载或渲染降级');
      },
      [onErrorCaptured, onLive2DReadyChange, targetLive2dUrl],
    );

    const profile = getMascotProfile(mascotId);
    const staticSrc = customMascotUrl || profile.assetUrl;
    const shouldMountLive2D = Boolean(targetLive2dUrl && !live2dFailed && canAttemptLive2D());

    useEffect(() => {
      if (!shouldMountLive2D) {
        onLive2DReadyChange?.(false);
      }
    }, [onLive2DReadyChange, shouldMountLive2D]);

    if (mascotId === 'none' && !customMascotUrl && !targetLive2dUrl) {
      return null;
    }

    if (!staticSrc && !shouldMountLive2D) {
      return null;
    }

    const isTallPresenter = mascotId === 'gpt' || mascotId === 'gemini' || mascotId === 'claude';

    return (
      <div
        className={`corner-mascot-dock ${isTallPresenter ? 'is-tall-presenter' : 'is-chibi-presenter'}`}
        aria-hidden="true"
      >
        <DeckErrorBoundary
          scopeName="corner-mascot"
          fallback={null}
          onErrorCaptured={onErrorCaptured}
        >
          {shouldMountLive2D && targetLive2dUrl && (
            <Live2DMascotCanvas
              ref={ref}
              modelJsonUrl={targetLive2dUrl}
              clockMode={clockMode}
              globalTimeMs={globalTimeMs}
              mouthOpen={mouthOpen}
              mood={mood}
              speaking={speaking}
              onReadyStateChange={handleReadyChange}
              onFallbackTriggered={handleFallback}
            />
          )}

          {(!shouldMountLive2D || !live2dReady) && staticSrc && (
            <div key={staticSrc} className="corner-mascot-entry">
              <div className="corner-mascot-float">
                <SafeMedia
                  src={staticSrc}
                  alt={profile.name}
                  className="corner-mascot-img"
                  fallback={
                    <div className="corner-mascot-monogram" data-testid="corner-mascot-fallback">
                      {profile.monogram || 'AI'}
                    </div>
                  }
                />
              </div>
            </div>
          )}
        </DeckErrorBoundary>
      </div>
    );
  },
);
