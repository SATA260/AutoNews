import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  clampPageIndex,
  type DeckBridgeState,
  type DeckPageType,
} from '../../bridge/videoSynthBridge';
import { SAMPLE_DAILY_ISSUE } from '../../data/sampleIssue';
import {
  sanitizeDailyIssue,
  type DailyIssueInput,
  type SanitizedIssueResult,
} from '../../schema/newsSchema';
import { mediaReadyTracker } from '../../utils/mediaReadyTracker';
import { DeckErrorBoundary } from '../guard/DeckErrorBoundary';
import { ViewportScaler } from '../guard/ViewportScaler';
import { CornerMascot } from '../mascot/CornerMascot';
import { CoverPage } from '../pages/CoverPage';
import { NewsCardPage } from '../pages/NewsCardPage';
import { SummaryOutroPage } from '../pages/SummaryOutroPage';
import { DataInspectorDrawer, type InspectorTab } from './DataInspectorDrawer';
import { DeckControls } from './DeckControls';
import { DeckHeader } from './DeckHeader';

interface StartupOptions {
  cleanMode: boolean;
  autoplay: boolean;
  initialPage: number;
  theme: 'light' | 'dark';
  transition: 'slide' | 'none';
  motion: 'animated' | 'static';
}

function parseStartupOptions(): StartupOptions {
  if (typeof window === 'undefined') {
    return {
      cleanMode: false,
      autoplay: false,
      initialPage: 0,
      theme: 'light',
      transition: 'slide',
      motion: 'animated',
    };
  }
  const params = new URLSearchParams(window.location.search);
  const cleanMode = params.get('clean') === '1' || params.get('clean') === 'true';
  const autoplay = params.get('autoplay') === '1' || params.get('autoplay') === 'true';
  const pageParam = Number(params.get('page') ?? '0');
  const initialPage = Number.isFinite(pageParam) ? Math.max(0, Math.trunc(pageParam)) : 0;
  const theme = params.get('theme') === 'dark' ? 'dark' : 'light';
  const transition = params.get('transition') === 'none' ? 'none' : 'slide';
  const motion = params.get('motion') === 'static' ? 'static' : 'animated';

  return { cleanMode, autoplay, initialPage, theme, transition, motion };
}

interface NewsDeckProps {
  initialData?: unknown;
}

export const NewsDeck: React.FC<NewsDeckProps> = ({ initialData }) => {
  const startup = useMemo(() => parseStartupOptions(), []);

  const [rawIssue, setRawIssue] = useState<DailyIssueInput>(() =>
    initialData && typeof initialData === 'object'
      ? (initialData as DailyIssueInput)
      : SAMPLE_DAILY_ISSUE,
  );

  const sanitized: SanitizedIssueResult = useMemo(
    () => sanitizeDailyIssue(initialData !== undefined && rawIssue === initialData ? initialData : rawIssue),
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
  const [inspectorOpen, setInspectorOpen] = useState<boolean>(false);
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>('summary');
  const [runtimeErrors, setRuntimeErrors] = useState<string[]>([]);
  const [progressRatio, setProgressRatio] = useState<number>(0);

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
        event.reason instanceof Error ? event.reason.message : String(event.reason ?? 'Promise rejection');
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
        setDirection(clamped >= prev ? 'next' : 'prev');
        return clamped;
      });
      setProgressRatio(0);
      return clamped;
    },
    [totalPages],
  );

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

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [currentPage, inspectorOpen, navigateTo]);

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
    sanitized: SanitizedIssueResult;
    runtimeErrors: string[];
  }>({
    currentPage,
    totalPages,
    pageMeta,
    isAutoPlaying,
    cleanMode,
    theme,
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
    sanitized,
    runtimeErrors,
  };

  useEffect(() => {
    const waitSettledFrame = async () => {
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      });
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
      }),
      getPageCount: () => stateRef.current.totalPages,
      getCurrentPage: () => stateRef.current.currentPage,
      goToPage: async (index: number) => {
        const clamped = navigateTo(index);
        await waitSettledFrame();
        return clamped;
      },
      nextPage: async () => {
        const curr = stateRef.current.currentPage;
        const max = stateRef.current.totalPages - 1;
        if (curr >= max) {
          return false;
        }
        navigateTo(curr + 1);
        await waitSettledFrame();
        return true;
      },
      prevPage: async () => {
        const curr = stateRef.current.currentPage;
        if (curr <= 0) {
          return false;
        }
        navigateTo(curr - 1);
        await waitSettledFrame();
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

          <main
            key={`slide-${currentPage}-${activeNewsItem?.id ?? pageMeta.pageType}`}
            className={`deck-slide-body ${
              startup.transition === 'slide'
                ? direction === 'next'
                  ? 'anim-slide-next'
                  : 'anim-slide-prev'
                : ''
            }`}
          >
            {pageMeta.pageType === 'cover' && (
              <CoverPage
                issue={sanitized.issue}
                onJumpToNews={(itemIdx) => navigateTo(itemIdx + 1)}
              />
            )}

            {pageMeta.pageType === 'news' && activeNewsItem && (
              <NewsCardPage
                item={activeNewsItem}
                totalItems={sanitized.issue.items.length}
                onErrorCaptured={recordRuntimeError}
              />
            )}

            {pageMeta.pageType === 'outro' && (
              <SummaryOutroPage
                issue={sanitized.issue}
                onJumpToNews={(itemIdx) => navigateTo(itemIdx + 1)}
              />
            )}
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
          warningCount={sanitized.warnings.length}
          runtimeErrorCount={runtimeErrors.length}
          onPrev={() => navigateTo(currentPage - 1)}
          onNext={() => navigateTo(currentPage + 1)}
          onToggleAutoPlay={() => setIsAutoPlaying((prev) => !prev)}
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
