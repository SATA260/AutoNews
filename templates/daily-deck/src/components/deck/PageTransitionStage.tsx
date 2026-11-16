import React, { useEffect, useRef, useState } from 'react';
import type { DeckTransitionStyle } from '../../bridge/videoSynthBridge';

/** 每种翻页动效样式对应的总过渡时长（毫秒） */
export const PAGE_TURN_DURATION_MS: Record<DeckTransitionStyle, number> = {
  flip: 700,
  glide: 640,
  shutter: 580,
  none: 0,
};

/** 双层书页翻页容器组件的入参属性 */
export interface PageTransitionStageProps {
  currentPage: number;
  direction: 'next' | 'prev';
  transitionStyle: DeckTransitionStyle;
  motion: 'animated' | 'static';
  renderPage: (pageIndex: number, isExiting: boolean) => React.ReactNode;
}

interface ActiveTurnState {
  fromPage: number;
  toPage: number;
  dir: 'next' | 'prev';
  seq: number;
}

/** 双层书页过渡舞台：在翻页瞬间同时保留离场页与入场页，完成流畅的三维翻页或视差过渡 */
export const PageTransitionStage: React.FC<PageTransitionStageProps> = ({
  currentPage,
  direction,
  transitionStyle,
  motion,
  renderPage,
}) => {
  const prevPageRef = useRef<number>(currentPage);
  const seqRef = useRef<number>(0);
  const [turnState, setTurnState] = useState<ActiveTurnState | null>(null);

  const effectiveStyle: DeckTransitionStyle = motion === 'static' ? 'none' : transitionStyle;

  useEffect(() => {
    const previousPage = prevPageRef.current;
    if (previousPage === currentPage) {
      return;
    }

    prevPageRef.current = currentPage;
    if (effectiveStyle === 'none') {
      setTurnState(null);
      return;
    }

    seqRef.current += 1;
    setTurnState({
      fromPage: previousPage,
      toPage: currentPage,
      dir: direction,
      seq: seqRef.current,
    });

    const duration = PAGE_TURN_DURATION_MS[effectiveStyle];
    const timer = window.setTimeout(() => {
      setTurnState(null);
    }, duration);

    return () => {
      window.clearTimeout(timer);
    };
  }, [currentPage, direction, effectiveStyle]);

  return (
    <div
      className={`page-turn-stage mode-${effectiveStyle} ${
        turnState ? `is-turning dir-${turnState.dir}` : 'is-settled'
      }`}
    >
      {turnState && effectiveStyle === 'flip' && (
        <div className="book-spine-shadow" aria-hidden="true" />
      )}

      {turnState && (
        <div
          key={`exit-${turnState.seq}-${turnState.fromPage}`}
          className="page-sheet is-exiting"
          aria-hidden="true"
        >
          <div className="page-sheet-inner">{renderPage(turnState.fromPage, true)}</div>
          <div className="page-curl-sheen" aria-hidden="true" />
          <div className="page-exit-dim" aria-hidden="true" />
        </div>
      )}

      <div
        key={`active-${currentPage}`}
        className={`page-sheet is-active ${turnState ? 'is-entering' : ''}`}
      >
        <div className="page-sheet-inner">{renderPage(currentPage, false)}</div>
        {turnState && <div className="page-enter-sheen" aria-hidden="true" />}
        {turnState && <div className="page-enter-shadow" aria-hidden="true" />}
      </div>
    </div>
  );
};
