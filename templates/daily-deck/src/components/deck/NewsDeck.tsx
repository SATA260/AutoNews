import type React from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  clampPageIndex,
  type DeckBridgeState,
  type DeckPageType,
  type DeckTransitionStyle,
  parseTransitionStyle,
} from '../../bridge/videoSynthBridge';
import { SAMPLE_DAILY_ISSUE } from '../../data/sampleIssue';
import { MASCOT_REGISTRY } from '../../mascots/mascotRegistry';
import {
  type DailyIssueInput,
  type SanitizedIssueResult,
  sanitizeDailyIssue,
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

/** 页面翻页原子状态：在同一渲染周期同步更新当前页、离场页与翻页方向 */
interface PageNavState {
  currentPage: number;
  exitingPage: number | null;
  direction: 'next' | 'prev';
  turnSeq: number;
}

const TRANSITION_ORDER: readonly DeckTransitionStyle[] = ['glide', 'flip', 'fade', 'none'];

/** 从浏览器网址查询参数中读取初始播放、主题与动效配置 */
function parseStartupOptions(): StartupOptions {
  if (typeof window === 'undefined') {
    return {
      cleanMode: false,
      autoplay: false,
      initialPage: 0,
      theme: 'light',
      transition: 'glide',
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
  const [navState, setNavState] = useState<PageNavState>(() => ({
    currentPage: clampPageIndex(startup.initialPage, totalPages),
    exitingPage: null,
    direction: 'next',
    turnSeq: 0,
  }));
  const [issueVersion, setIssueVersion] = useState<number>(0);
  const [isAutoPlaying, setIsAutoPlaying] = useState<boolean>(startup.autoplay);
  const [cleanMode, setCleanMode] = useState<boolean>(startup.cleanMode);
  const [theme, setTheme] = useState<'light' | 'dark'>(startup.theme);
  const [transitionStyle, setTransitionStyle] = useState<DeckTransitionStyle>(startup.transition);
  const [inspectorOpen, setInspectorOpen] = useState<boolean>(false);
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>('summary');
  const [runtimeErrors, setRuntimeErrors] = useState<string[]>([]);
  const [progressRatio, setProgressRatio] = useState<number>(0);

  const wheelLockUntilRef = useRef<number>(0);
  const { currentPage, exitingPage, direction } = navState;
  const effectiveTransition: DeckTransitionStyle =
    startup.motion === 'static' ? 'none' : transitionStyle;

  useEffect(() => {
    setNavState((prev) => {
      const nextCurrent = clampPageIndex(prev.currentPage, totalPages);
      const nextExiting =
        prev.exitingPage !== null &&
        prev.exitingPage < totalPages &&
        prev.exitingPage !== nextCurrent
          ? prev.exitingPage
          : null;
      if (nextCurrent === prev.currentPage && nextExiting === prev.exitingPage) {
        return prev;
      }
      return {
        currentPage: nextCurrent,
        exitingPage: nextExiting,
        direction: prev.direction,
        turnSeq: prev.turnSeq + 1,
      };
    });
  }, [totalPages]);

  useEffect(() => {
    if (navState.exitingPage === null) {
      return;
    }
    if (effectiveTransition === 'none') {
      setNavState((prev) => (prev.exitingPage === null ? prev : { ...prev, exitingPage: null }));
      return;
    }

    const activeSeq = navState.turnSeq;
    const duration = PAGE_TURN_DURATION_MS[effectiveTransition];
    const timer = window.setTimeout(() => {
      setNavState((prev) => (prev.turnSeq === activeSeq ? { ...prev, exitingPage: null } : prev));
    }, duration);

    return () => {
      window.clearTimeout(timer);
    };
  }, [navState.exitingPage, navState.turnSeq, effectiveTransition]);

  useEffect(() => {
    if (typeof Image === 'undefined') {
      return;
    }
    const urls = new Set<string>();
    for (const profile of Object.values(MASCOT_REGISTRY)) {
      if (profile.assetUrl) {
        urls.add(profile.assetUrl);
      }
    }
    for (const item of sanitized.issue.items) {
      if (item.imageUrl) {
        urls.add(item.imageUrl);
      }
      if (item.secondaryImageUrl) {
        urls.add(item.secondaryImageUrl);
      }
      if (item.customMascotUrl) {
        urls.add(item.customMascotUrl);
      }
    }
    for (const url of urls) {
      const img = new Image();
      img.decoding = 'sync';
      img.src = url;
    }
  }, [sanitized.issue.items]);

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
      setNavState((prev) => {
        if (clamped === prev.currentPage) {
          return prev;
        }
        return {
          currentPage: clamped,
          exitingPage: effectiveTransition === 'none' ? null : prev.currentPage,
          direction: clamped > prev.currentPage ? 'next' : 'prev',
          turnSeq: prev.turnSeq + 1,
        };
      });
      setProgressRatio(0);
      return clamped;
    },
    [effectiveTransition, totalPages],
  );

  const cycleTransitionStyle = useCallback(() => {
    setTransitionStyle((prev) => {
      const idx = TRANSITION_ORDER.indexOf(prev);
      return TRANSITION_ORDER[(idx + 1) % TRANSITION_ORDER.length] ?? 'glide';
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
    setIssueVersion((v) => v + 1);
    setNavState((prev) => (prev.exitingPage === null ? prev : { ...prev, exitingPage: null }));
    return check;
  }, []);

  const resetSampleIssue = useCallback(() => {
    setRawIssue(SAMPLE_DAILY_ISSUE);
    setIssueVersion((v) => v + 1);
    setNavState((prev) => (prev.exitingPage === null ? prev : { ...prev, exitingPage: null }));
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
    sanitized.issue.mascotMode === 'per-item'
      ? (activeNewsItem?.customMascotUrl ?? null)
      : sanitized.issue.hostMascotUrl;

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

  const controlsOverlay = (
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
  );

  return (
    <DeckErrorBoundary scopeName="deck-root" onErrorCaptured={recordRuntimeError}>
      <ViewportScaler
        theme={theme}
        motion={startup.motion}
        cleanMode={cleanMode}
        overlay={controlsOverlay}
      >
        <div className="deck-canvas" data-host={activeMascotId}>
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
              exitingPage={exitingPage}
              direction={direction}
              issueVersion={issueVersion}
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
      </ViewportScaler>

      <DataInspectorDrawer
        open={!cleanMode && inspectorOpen}
        activeTab={inspectorTab}
        rawIssue={rawIssue}
        sanitizedIssue={sanitized.issue}
        warnings={sanitized.warnings}
        runtimeErrors={runtimeErrors}
        activeNewsItemIndex={Math.max(pageMeta.newsIndex, 0)}
        onTabChange={setInspectorTab}
        onClose={() => setInspectorOpen(false)}
        onApplyRawData={applyRawData}
        onResetSample={resetSampleIssue}
        onJumpToNewsPage={(idx) => navigateTo(idx + 1)}
      />
    </DeckErrorBoundary>
  );
};
