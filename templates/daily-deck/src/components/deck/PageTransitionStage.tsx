import type React from 'react';
import type { DeckTransitionStyle } from '../../bridge/videoSynthBridge';

/** 每种翻页动效样式对应的总过渡时长（毫秒） */
export const PAGE_TURN_DURATION_MS: Record<DeckTransitionStyle, number> = {
  glide: 520,
  flip: 540,
  fade: 400,
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
  renderPage: (pageIndex: number, isExiting: boolean) => React.ReactNode;
}

/** 双层书页过渡舞台：通过稳定的页码键值同步维护离场页与入场页，消除翻页瞬间的空白闪屏 */
export const PageTransitionStage: React.FC<PageTransitionStageProps> = ({
  currentPage,
  exitingPage,
  direction,
  issueVersion,
  transitionStyle,
  motion,
  renderPage,
}) => {
  const effectiveStyle: DeckTransitionStyle = motion === 'static' ? 'none' : transitionStyle;
  const isTurning =
    effectiveStyle !== 'none' && exitingPage !== null && exitingPage !== currentPage;

  return (
    <div
      className={`page-turn-stage mode-${effectiveStyle} ${
        isTurning ? `is-turning dir-${direction}` : 'is-settled'
      }`}
    >
      {isTurning && exitingPage !== null && (
        <div
          key={`issue-${issueVersion}-page-${exitingPage}`}
          className="page-sheet is-exiting"
          aria-hidden="true"
        >
          <div className="page-sheet-inner">{renderPage(exitingPage, true)}</div>
          <div className="page-exit-dim" aria-hidden="true" />
        </div>
      )}

      <div
        key={`issue-${issueVersion}-page-${currentPage}`}
        className={`page-sheet is-active ${isTurning ? 'is-entering' : ''}`}
      >
        <div className="page-sheet-inner">{renderPage(currentPage, false)}</div>
      </div>
    </div>
  );
};
