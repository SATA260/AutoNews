import type React from 'react';
import type { DeckTransitionStyle } from '../../bridge/videoSynthBridge';

/** 每种翻页动效样式对应的总过渡时长（毫秒） */
export const PAGE_TURN_DURATION_MS: Record<DeckTransitionStyle, number> = {
  glide: 520,
  flip: 540,
  fade: 600,
  none: 0,
};

/** 双层书页翻页容器组件的入参属性 */
export interface PageTransitionStageProps {
  currentPage: number;
  exitingPage: number | null;
  direction: 'next' | 'prev';
  issueVersion: number;
  transitionStyle: DeckTransitionStyle;
  motion: 'animated' | 'static';
  /** 确定性虚拟时钟模式下传入的 [0, 1] 翻页进度插值；为空时使用浏览器原生实时 CSS 动画 */
  virtualProgress?: number | null;
  renderPage: (pageIndex: number, isExiting: boolean) => React.ReactNode;
}

/** 计算与 CSS cubic-bezier(0.22, 1, 0.36, 1) 对齐的平滑缓出曲线 */
function easeOutEditorial(t: number): number {
  const clamped = Math.min(1, Math.max(0, t));
  return 1 - (1 - clamped) ** 3.4;
}

/** 对称的缓入缓出曲线，让渐变的开始和结束都柔和（与 CSS 渐变动画的曲线保持一致） */
export function easeInOutSine(t: number): number {
  const clamped = Math.min(1, Math.max(0, t));
  return 0.5 - Math.cos(Math.PI * clamped) / 2;
}

/** 在虚拟时钟手动步进模式下计算离场页与入场页的精确内联变换样式 */
function computeVirtualTurnStyles(
  style: DeckTransitionStyle,
  direction: 'next' | 'prev',
  rawProgress: number,
): {
  entering: React.CSSProperties;
  exiting: React.CSSProperties;
  dimOpacity: number;
} {
  if (style === 'fade') {
    // 纯透明度交叉渐变：旧页不透明地垫在下面，新页从透明渐显到完全不透明
    return {
      entering: {
        zIndex: 4,
        opacity: Number(easeInOutSine(rawProgress).toFixed(4)),
        transform: 'none',
      },
      exiting: {
        zIndex: 2,
        opacity: 1,
        transform: 'none',
      },
      dimOpacity: 0,
    };
  }

  const e = easeOutEditorial(rawProgress);

  if (style === 'flip') {
    if (direction === 'next') {
      const rot = -16 * e;
      const tx = -26 * e;
      const op = e <= 0.55 ? 1 : Math.max(0, 1 - (e - 0.55) / 0.45);
      const scaleIn = 0.992 + 0.008 * e;
      return {
        entering: {
          zIndex: 2,
          transform: `translate3d(0, 0, 0) scale(${scaleIn.toFixed(4)})`,
        },
        exiting: {
          zIndex: 4,
          transformOrigin: '0% 50%',
          transform: `rotateY(${rot.toFixed(2)}deg) translate3d(${tx.toFixed(2)}%, 0, 0)`,
          opacity: op,
        },
        dimOpacity: 0,
      };
    }
    const rot = -16 * (1 - e);
    const tx = -26 * (1 - e);
    const op = e >= 0.45 ? 1 : e / 0.45;
    const scaleOut = 1 - 0.008 * e;
    return {
      entering: {
        zIndex: 4,
        transformOrigin: '0% 50%',
        transform: `rotateY(${rot.toFixed(2)}deg) translate3d(${tx.toFixed(2)}%, 0, 0)`,
        opacity: op,
      },
      exiting: {
        zIndex: 2,
        transform: `translate3d(0, 0, 0) scale(${scaleOut.toFixed(4)})`,
      },
      dimOpacity: 0,
    };
  }

  // 默认 glide 纸张滑移过渡
  if (direction === 'next') {
    const enterTx = 100 * (1 - e);
    const exitTx = -8 * e;
    const exitScale = 1 - 0.014 * e;
    return {
      entering: {
        zIndex: 4,
        transform: `translate3d(${enterTx.toFixed(3)}%, 0, 0)`,
      },
      exiting: {
        zIndex: 2,
        transform: `translate3d(${exitTx.toFixed(3)}%, 0, 0) scale(${exitScale.toFixed(4)})`,
      },
      dimOpacity: 0.07 * e,
    };
  }

  const exitTx = 100 * e;
  const enterTx = -8 * (1 - e);
  const enterScale = 0.986 + 0.014 * e;
  return {
    entering: {
      zIndex: 2,
      transform: `translate3d(${enterTx.toFixed(3)}%, 0, 0) scale(${enterScale.toFixed(4)})`,
    },
    exiting: {
      zIndex: 4,
      transform: `translate3d(${exitTx.toFixed(3)}%, 0, 0)`,
    },
    dimOpacity: 0.07 * (1 - e),
  };
}

/** 双层书页过渡舞台：同时支持实时 CSS 翻页动画与确定性虚拟时钟插值渲染 */
export const PageTransitionStage: React.FC<PageTransitionStageProps> = ({
  currentPage,
  exitingPage,
  direction,
  issueVersion,
  transitionStyle,
  motion,
  virtualProgress = null,
  renderPage,
}) => {
  const effectiveStyle: DeckTransitionStyle = motion === 'static' ? 'none' : transitionStyle;
  const isTurning =
    effectiveStyle !== 'none' && exitingPage !== null && exitingPage !== currentPage;
  const isVirtual = isTurning && virtualProgress !== null && Number.isFinite(virtualProgress);
  const virtualStyles = isVirtual
    ? computeVirtualTurnStyles(effectiveStyle, direction, virtualProgress)
    : null;

  return (
    <div
      className={`page-turn-stage mode-${effectiveStyle} ${
        isTurning ? `is-turning dir-${direction}` : 'is-settled'
      } ${isVirtual ? 'is-virtual-turn' : ''}`}
    >
      {isTurning && exitingPage !== null && (
        <div
          key={`issue-${issueVersion}-page-${exitingPage}`}
          className="page-sheet is-exiting"
          style={virtualStyles?.exiting}
          aria-hidden="true"
        >
          <div className="page-sheet-inner">{renderPage(exitingPage, true)}</div>
          <div
            className="page-exit-dim"
            style={
              virtualStyles ? { opacity: Number(virtualStyles.dimOpacity.toFixed(4)) } : undefined
            }
            aria-hidden="true"
          />
        </div>
      )}

      <div
        key={`issue-${issueVersion}-page-${currentPage}`}
        className={`page-sheet is-active ${isTurning ? 'is-entering' : ''}`}
        style={virtualStyles?.entering}
      >
        <div className="page-sheet-inner">{renderPage(currentPage, false)}</div>
      </div>
    </div>
  );
};
