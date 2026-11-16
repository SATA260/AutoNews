import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  clampPageIndex,
  parseTransitionStyle,
  type DeckBridgeState,
  type DeckPageType,
  type DeckTransitionStyle,
} from '../../bridge/videoSynthBridge';
import { SAMPLE_DAILY_ISSUE } from '../../data/sampleIssue';
import {
  sanitizeDailyIssue,
  type DailyIssueInput,
  type SanitizedIssueResult,
} from '../../schema/newsSchema';
import { mediaReadyTracker, transitionTiming } from '../../utils/mediaReadyTracker';
import { DeckErrorBoundary } from '../guard/DeckErrorBoundary';
import { ViewportScaler } from '../guard/ViewportScaler';
import { CornerMascot } from '../mascot/CornerMascot';
import { CoverPage } from '../pages/CoverPage';
import { NewsCardPage } from '../pages/NewsCardPage';
import { SummaryOutroPage } from '../pages/SummaryOutroPage';
import { DataInspectorDrawer, type InspectorTab } from './DataInspectorDrawer';
import { DeckControls } from './DeckControls';
import { DeckHeader } from './DeckHeader';
import { PAGE_TURN_DURATION_MS, PageTransitionStage } from './PageTransitionStage';

interface StartupOptions {
  cleanMode: boolean;
  autoplay: boolean;
  initialPage: number;
  theme: 'light' | 'dark';
  transition: DeckTransitionStyle;
  motion: 'animated' | 'static';
}

const TRANSITION_ORDER: readonly DeckTransitionStyle[] = ['flip', 'glide', 'shutter', 'none'];

/** 从浏览器网址查询参数中读取初始播放、主题与动效配置 */
function parseStartupOptions(): StartupOptions {
  if (typeof window === 'undefined') {
    return {
      cleanMode: false,
      autoplay: false,
      initialPage: 0,
      theme: 'light',
      transition: 'flip',
      motion: 'animated',
    };
  }
  const params = new URLSearchParams(window.location.search);
  const cleanMode = params.get('clean') === '1' || params.get('clean') === 'true';
  const autoplay = params.get('autoplay') === '1' || params.get('autoplay') === 'true';
  const pageParam = Number(params.get('page') ?? '0');
  const initialPage = Number.isFinite(pageParam) ? Math.max(0, Math.trunc(pageParam)) : 0;
  const theme = params.get('theme') === 'dark' ? 'dark' : 'light';
  const transition = parseTransitionStyle(params.get('transition'));
  const motion = params.get('motion') === 'static' ? 'static' : 'animated';

  return { cleanMode, autoplay, initialPage, theme, transition, motion };
}

/** 新闻模板主容器组件的入参属性 */
export interface NewsDeckProps {
  initialData?: unknown;
}

/** 新闻模板主容器：负责数据安全清洗、翻页状态机、动效调度、快捷键以及外部合成桥接 */
export const NewsDeck: React.FC<NewsDeckProps> = ({ initialData }) => {
  const startup = useMemo(() => parseStartupOptions(), []);

  const [rawIssue, setRawIssue] = useState<DailyIssueInput>(() =>
    initialData && typeof initialData === 'object'
      ? (initialData as DailyIssueInput)
      : SAMPLE_DAILY_ISSUE,
  );

  const sanitized: SanitizedIssueResult = useMemo(
    () =>
      sanitizeDailyIssue(
        initialData !== undefined && rawIssue === initialData ? initialData : rawIssue,
      ),
    [initialData, rawIssue],
  );

  const totalPages = sanitized.issue.items.length + 2;
  const [currentPage, setCurrentPage] = useState<number>(() =>
    clampPageIndex(startup.initialPage, totalPages),
  );
  const [direction, setDirection] = useState<'next' | 'prev'>('next');
  const [isAutoPlaying, setIsAutoPlaying] = useState<boolean>(startup.autoplay);
  const [cleanMode, setCleanMode] = useState<boolean>(startup.cleanMode);
  const [theme, setTheme] = useState<'light' | 'dark'>(startup.theme);
  const [transitionStyle, setTransitionStyle] = useState<DeckTransitionStyle>(startup.transition);
  const [inspectorOpen, setInspectorOpen] = useState<boolean>(false);
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>('summary');
  const [runtimeErrors, setRuntimeErrors] = useState<string[]>([]);
  const [progressRatio, setProgressRatio] = useState<number>(0);

  const wheelLockUntilRef = useRef<number>(0);

  useEffect(() => {
    setCurrentPage((prev) => clampPageIndex(prev, totalPages));
  }, [totalPages]);

  const recordRuntimeError = useCallback((scopeName: string, message: string) => {
    setRuntimeErrors((prev) => {
      const entry = `[${scopeName}] ${message}`;
      return prev.includes(entry) ? prev : [...prev.slice(-19), entry];
    });
  }, []);

  useEffect(() => {
    const onError = (event: ErrorEvent) => {
      recordRuntimeError('window', event.message || 'Unhandled error');
    };
    const onRejection = (event: PromiseRejectionEvent) => {
      const msg =
        event.reason instanceof Error
          ? event.reason.message
          : String(event.reason ?? 'Promise rejection');
      recordRuntimeError('promise', msg);
    };
    window.addEventListener('error', onError);
    window.addEventListener('unhandledrejection', onRejection);
    return () => {
      window.removeEventListener('error', onError);
      window.removeEventListener('unhandledrejection', onRejection);
    };
  }, [recordRuntimeError]);

  const pageMeta = useMemo((): {
    pageType: DeckPageType;
    durationSec: number;
    pageLabel: string;
    newsIndex: number;
  } => {
    if (currentPage === 0) {
      return {
        pageType: 'cover',
        durationSec: sanitized.issue.coverDurationSec,
        pageLabel: '本期导览',
        newsIndex: -1,
      };
    }
    if (currentPage >= totalPages - 1) {
      return {
        pageType: 'outro',
        durationSec: sanitized.issue.outroDurationSec,
        pageLabel: '全期速览',
        newsIndex: -1,
      };
    }
    const newsIndex = currentPage - 1;
    const item = sanitized.issue.items[newsIndex]!;
    return {
      pageType: 'news',
      durationSec: item.durationSec,
      pageLabel: `资讯 ${item.indexLabel}`,
      newsIndex,
    };
  }, [currentPage, sanitized.issue, totalPages]);

  const navigateTo = useCallback(
    (targetPage: number) => {
      const clamped = clampPageIndex(targetPage, totalPages);
      setCurrentPage((prev) => {
        if (clamped !== prev) {
          setDirection(clamped > prev ? 'next' : 'prev');
        }
        return clamped;
      });
      setProgressRatio(0);
      return clamped;
    },
    [totalPages],
  );

  const cycleTransitionStyle = useCallback(() => {
    setTransitionStyle((prev) => {
      const idx = TRANSITION_ORDER.indexOf(prev);
      return TRANSITION_ORDER[(idx + 1) % TRANSITION_ORDER.length] ?? 'flip';
    });
  }, []);

  useEffect(() => {
    if (!isAutoPlaying || inspectorOpen) {
      setProgressRatio(0);
      return;
    }

    const durationMs = pageMeta.durationSec * 1000;
    const startedAt = Date.now();
    const tick = window.setInterval(() => {
      const elapsed = Date.now() - startedAt;
      const ratio = Math.min(1, elapsed / durationMs);
      setProgressRatio(ratio);
      if (elapsed >= durationMs) {
        window.clearInterval(tick);
        if (currentPage < totalPages - 1) {
          navigateTo(currentPage + 1);
        } else {
          setIsAutoPlaying(false);
          setProgressRatio(1);
        }
      }
    }, 50);

    return () => window.clearInterval(tick);
  }, [isAutoPlaying, inspectorOpen, pageMeta.durationSec, currentPage, totalPages, navigateTo]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName?.toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select' || target?.isContentEditable) {
        if (event.key === 'Escape' && inspectorOpen) {
          setInspectorOpen(false);
        }
        return;
      }

      if (event.key === 'ArrowRight' || event.key === 'PageDown' || event.key === ' ') {
        event.preventDefault();
        navigateTo(currentPage + 1);
      } else if (event.key === 'ArrowLeft' || event.key === 'PageUp') {
        event.preventDefault();
        navigateTo(currentPage - 1);
      } else if (event.key.toLowerCase() === 'p') {
        event.preventDefault();
        setIsAutoPlaying((prev) => !prev);
      } else if (event.key.toLowerCase() === 't') {
        event.preventDefault();
        cycleTransitionStyle();
      } else if (event.key.toLowerCase() === 'h') {
        event.preventDefault();
        setCleanMode((prev) => !prev);
      } else if (event.key.toLowerCase() === 'e') {
        event.preventDefault();
        setInspectorTab('summary');
        setInspectorOpen((prev) => !prev);
      } else if (event.key === 'Escape' && inspectorOpen) {
        setInspectorOpen(false);
      }
    };

    const onWheel = (event: WheelEvent) => {
      if (inspectorOpen || cleanMode) {
        return;
      }
      const absX = Math.abs(event.deltaX);
      const absY = Math.abs(event.deltaY);
      if (absX < 36 || absX <= absY) {
        return;
      }
      const now = Date.now();
      if (now < wheelLockUntilRef.current) {
        return;
      }
      wheelLockUntilRef.current = now + 750;
      navigateTo(event.deltaX > 0 ? currentPage + 1 : currentPage - 1);
    };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('wheel', onWheel, { passive: true });
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('wheel', onWheel);
    };
  }, [currentPage, inspectorOpen, cleanMode, navigateTo, cycleTransitionStyle]);

  const applyRawData = useCallback((nextRaw: unknown) => {
    const check = sanitizeDailyIssue(nextRaw);
    if (nextRaw && typeof nextRaw === 'object' && !Array.isArray(nextRaw)) {
      setRawIssue(nextRaw as DailyIssueInput);
    } else {
      setRawIssue(check.issue);
    }
    return check;
  }, []);

  const stateRef = useRef<{
    currentPage: number;
    totalPages: number;
    pageMeta: typeof pageMeta;
    isAutoPlaying: boolean;
    cleanMode: boolean;
    theme: 'light' | 'dark';
    transitionStyle: DeckTransitionStyle;
    motion: 'animated' | 'static';
    sanitized: SanitizedIssueResult;
    runtimeErrors: string[];
  }>({
    currentPage,
    totalPages,
    pageMeta,
    isAutoPlaying,
    cleanMode,
    theme,
    transitionStyle,
    motion: startup.motion,
    sanitized,
    runtimeErrors,
  });

  stateRef.current = {
    currentPage,
    totalPages,
    pageMeta,
    isAutoPlaying,
    cleanMode,
    theme,
    transitionStyle,
    motion: startup.motion,
    sanitized,
    runtimeErrors,
  };

  useEffect(() => {
    const waitSettledFrame = async (pageChanged: boolean) => {
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      });
      if (pageChanged && stateRef.current.motion !== 'static') {
        const settleMs = PAGE_TURN_DURATION_MS[stateRef.current.transitionStyle];
        await transitionTiming.wait(settleMs);
      }
      await mediaReadyTracker.waitForAll(1500);
    };

    window.__NEWS_DECK__ = {
      getState: (): DeckBridgeState => ({
        currentPage: stateRef.current.currentPage,
        totalPages: stateRef.current.totalPages,
        pageType: stateRef.current.pageMeta.pageType,
        suggestedDurationSec: stateRef.current.pageMeta.durationSec,
        isAutoPlaying: stateRef.current.isAutoPlaying,
        cleanMode: stateRef.current.cleanMode,
        theme: stateRef.current.theme,
        transition: stateRef.current.transitionStyle,
      }),
      getPageCount: () => stateRef.current.totalPages,
      getCurrentPage: () => stateRef.current.currentPage,
      goToPage: async (index: number) => {
        const prev = stateRef.current.currentPage;
        const clamped = navigateTo(index);
        await waitSettledFrame(clamped !== prev);
        return clamped;
      },
      nextPage: async () => {
        const curr = stateRef.current.currentPage;
        const max = stateRef.current.totalPages - 1;
        if (curr >= max) {
          return false;
        }
        navigateTo(curr + 1);
        await waitSettledFrame(true);
        return true;
      },
      prevPage: async () => {
        const curr = stateRef.current.currentPage;
        if (curr <= 0) {
          return false;
        }
        navigateTo(curr - 1);
        await waitSettledFrame(true);
        return true;
      },
      setNewsData: (raw: unknown) => {
        const result = applyRawData(raw);
        return {
          ok: true,
          warningCount: result.warnings.length,
          warnings: result.warnings,
          totalPages: result.issue.items.length + 2,
        };
      },
      getHealthReport: () => ({
        ok: stateRef.current.runtimeErrors.length === 0,
        isDataClean: stateRef.current.sanitized.isClean,
        warningCount: stateRef.current.sanitized.warnings.length,
        warnings: stateRef.current.sanitized.warnings,
        runtimeErrors: stateRef.current.runtimeErrors,
      }),
    };

    return () => {
      delete window.__NEWS_DECK__;
    };
  }, [applyRawData, navigateTo]);

  const activeNewsItem =
    pageMeta.pageType === 'news' ? sanitized.issue.items[pageMeta.newsIndex] : undefined;

  const activeMascotId =
    sanitized.issue.mascotMode === 'fixed-host'
      ? sanitized.issue.hostMascotId
      : activeNewsItem
        ? activeNewsItem.mascotId
        : sanitized.issue.hostMascotId;

  const activeCustomMascotUrl =
    sanitized.issue.mascotMode === 'per-item' ? activeNewsItem?.customMascotUrl ?? null : null;

  const renderPageByIndex = useCallback(
    (pageIdx: number, isExiting: boolean) => {
      const clampedIdx = clampPageIndex(pageIdx, totalPages);
      if (clampedIdx === 0) {
        return (
          <CoverPage
            issue={sanitized.issue}
            onJumpToNews={isExiting ? () => {} : (itemIdx) => navigateTo(itemIdx + 1)}
          />
        );
      }
      if (clampedIdx >= totalPages - 1) {
        return (
          <SummaryOutroPage
            issue={sanitized.issue}
            onJumpToNews={isExiting ? () => {} : (itemIdx) => navigateTo(itemIdx + 1)}
          />
        );
      }
      const item = sanitized.issue.items[clampedIdx - 1];
      if (!item) {
        return null;
      }
      return (
        <NewsCardPage
          item={item}
          totalItems={sanitized.issue.items.length}
          onErrorCaptured={isExiting ? undefined : recordRuntimeError}
        />
      );
    },
    [navigateTo, recordRuntimeError, sanitized.issue, totalPages],
  );

  return (
    <DeckErrorBoundary scopeName="deck-root" onErrorCaptured={recordRuntimeError}>
      <ViewportScaler theme={theme} motion={startup.motion}>
        <div className="deck-canvas">
          <DeckHeader
            issue={sanitized.issue}
            currentPage={currentPage}
            totalPages={totalPages}
            pageLabel={pageMeta.pageLabel}
            onSelectPage={(idx) => navigateTo(idx)}
          />

          <main className="deck-slide-body">
            <PageTransitionStage
              currentPage={currentPage}
              direction={direction}
              transitionStyle={transitionStyle}
              motion={startup.motion}
              renderPage={renderPageByIndex}
            />
          </main>

          <CornerMascot
            mascotId={activeMascotId}
            customMascotUrl={activeCustomMascotUrl}
            onErrorCaptured={recordRuntimeError}
          />

          {isAutoPlaying && (
            <div className="autoplay-progress-track" aria-hidden="true">
              <div
                className="autoplay-progress-fill"
                style={{ width: `${Math.round(progressRatio * 100)}%` }}
              />
            </div>
          )}
        </div>

        <DeckControls
          currentPage={currentPage}
          totalPages={totalPages}
          isAutoPlaying={isAutoPlaying}
          theme={theme}
          cleanMode={cleanMode}
          transitionStyle={transitionStyle}
          warningCount={sanitized.warnings.length}
          runtimeErrorCount={runtimeErrors.length}
          onPrev={() => navigateTo(currentPage - 1)}
          onNext={() => navigateTo(currentPage + 1)}
          onToggleAutoPlay={() => setIsAutoPlaying((prev) => !prev)}
          onCycleTransition={cycleTransitionStyle}
          onToggleTheme={() => setTheme((prev) => (prev === 'light' ? 'dark' : 'light'))}
          onToggleCleanMode={() => setCleanMode((prev) => !prev)}
          onOpenInspector={(tab = 'summary') => {
            setInspectorTab(tab);
            setInspectorOpen(true);
          }}
        />
      </ViewportScaler>

      <DataInspectorDrawer
        open={!cleanMode && inspectorOpen}
        activeTab={inspectorTab}
        rawIssue={rawIssue}
        sanitizedIssue={sanitized.issue}
        warnings={sanitized.warnings}
        runtimeErrors={runtimeErrors}
        activeNewsItemIndex={pageMeta.newsIndex >= 0 ? pageMeta.newsIndex : 0}
        onTabChange={setInspectorTab}
        onClose={() => setInspectorOpen(false)}
        onApplyRawData={applyRawData}
        onResetSample={() => setRawIssue(SAMPLE_DAILY_ISSUE)}
        onJumpToNewsPage={(idx) => navigateTo(idx + 1)}
      />
    </DeckErrorBoundary>
  );
};
