import type React from 'react';
import { useLayoutEffect, useRef, useState } from 'react';
import { getMascotProfile } from '../../mascots/mascotRegistry';
import type { PresetMascotId, SanitizedDailyIssue } from '../../schema/newsSchema';

/** 顶部双层章节进度导航栏组件入参属性 */
export interface DeckHeaderProps {
  issue: SanitizedDailyIssue;
  currentPage: number;
  totalPages: number;
  pageLabel: string;
  activeMascotId: PresetMascotId;
  sectionProgress: number;
  sectionDurationsMs?: readonly number[];
  globalTimeMs: number;
  totalDurationMs: number;
  onSelectPage?: (index: number) => void;
}

/** 顶部章节进度条单个胶囊的配置项 */
interface ChapterSlotSpec {
  pageIndex: number;
  kind: 'bookend' | 'news';
  numLabel?: string;
  label: string;
  titleAttr: string;
  durationMs: number;
  weightRatio: number;
}

/** 估算文本按中文全角宽度折算的视觉字符权重，用于无布局环境下的初始字号计算 */
function measureVisualUnits(text: string): number {
  let units = 0;
  for (const ch of text) {
    if (/\s/.test(ch)) {
      units += 0.32;
    } else if (/[\u0020-\u007e]/.test(ch)) {
      units += /[A-Z0-9]/.test(ch) ? 0.62 : 0.54;
    } else {
      units += 1;
    }
  }
  return Math.max(1.6, units);
}

/** 根据章节时长占比与文本长度计算进度条胶囊的初始响应式字号 */
function estimatePillFontSize(
  slot: ChapterSlotSpec,
  newsCount: number,
  totalSlots: number,
): number {
  const safeCount = Math.max(1, totalSlots);
  const trackBudget = Math.max(320, 1750 - safeCount * 6);
  const estWidth = Math.max(48, trackBudget * slot.weightRatio);
  const fullText = slot.numLabel ? `${slot.numLabel} ${slot.label}` : slot.label;
  const maxCap = slot.kind === 'bookend' ? (newsCount >= 8 ? 20 : newsCount >= 6 ? 23 : 27) : 31;
  const widthFit = Math.floor((estWidth * 0.86) / measureVisualUnits(fullText));
  return Math.min(maxCap, Math.max(12, widthFit));
}

/** 响应式章节进度胶囊：按对应阶段时长等比例分配宽度，并在任意时长占比下自动适配字号 */
const ResponsiveChapterPill: React.FC<{
  slot: ChapterSlotSpec;
  newsCount: number;
  totalSlots: number;
  isActive: boolean;
  isPast: boolean;
  fillScale: number;
  clampedRatio: number;
  onSelect?: (pageIndex: number) => void;
}> = ({ slot, newsCount, totalSlots, isActive, isPast, fillScale, clampedRatio, onSelect }) => {
  const pillRef = useRef<HTMLButtonElement | null>(null);
  const boxRef = useRef<HTMLSpanElement | null>(null);
  const measureRef = useRef<HTMLSpanElement | null>(null);

  const initialFont = estimatePillFontSize(slot, newsCount, totalSlots);
  const [fitStyle, setFitStyle] = useState<{ fontSize: number; letterSpacingEm: number }>({
    fontSize: initialFont,
    letterSpacingEm: 0,
  });

  useLayoutEffect(() => {
    const pillEl = pillRef.current;
    const boxEl = boxRef.current;
    const measureEl = measureRef.current;
    const fallbackSize = estimatePillFontSize(slot, newsCount, totalSlots);

    if (!pillEl || !boxEl || !measureEl) {
      setFitStyle({ fontSize: fallbackSize, letterSpacingEm: 0 });
      return;
    }

    const fitNow = () => {
      const availWidth = boxEl.clientWidth;
      const pillHeight = pillEl.clientHeight;
      if (availWidth <= 0 || pillHeight <= 0) {
        setFitStyle({ fontSize: fallbackSize, letterSpacingEm: 0 });
        return;
      }

      const maxCap =
        slot.kind === 'bookend' ? (newsCount >= 8 ? 20 : newsCount >= 6 ? 23 : 27) : 34;
      const maxByHeight = Math.min(maxCap, Math.max(16, Math.floor(pillHeight * 0.56)));
      const minFont = 12;

      measureEl.style.letterSpacing = '0em';
      let current = maxByHeight;
      measureEl.style.fontSize = `${current}px`;

      while (current > minFont && measureEl.scrollWidth > availWidth - 2) {
        current -= 1;
        measureEl.style.fontSize = `${current}px`;
      }

      const sparePx = availWidth - measureEl.scrollWidth;
      const charCount = Array.from(slot.label).length + (slot.numLabel ? 2 : 0);
      let letterSpacingEm = 0;
      if (sparePx > current * 1.1 && charCount >= 2) {
        letterSpacingEm = Math.min(0.14, (sparePx * 0.52) / (charCount * current));
        letterSpacingEm = Math.round(letterSpacingEm * 1000) / 1000;
        measureEl.style.letterSpacing = `${letterSpacingEm}em`;
        if (measureEl.scrollWidth > availWidth - 2) {
          letterSpacingEm = 0;
          measureEl.style.letterSpacing = '0em';
        }
      }

      setFitStyle({ fontSize: current, letterSpacingEm });
    };

    fitNow();
    if (typeof ResizeObserver === 'undefined') {
      return;
    }
    const observer = new ResizeObserver(() => fitNow());
    observer.observe(pillEl);
    return () => observer.disconnect();
  }, [slot, newsCount, totalSlots]);

  return (
    <button
      ref={pillRef}
      type="button"
      className={`chapter-pill is-${slot.kind} ${isActive ? 'is-active' : ''} ${
        isPast ? 'is-past' : ''
      }`}
      style={{ flex: `${Math.max(1, Math.round(slot.durationMs))} 1 0px` }}
      onClick={() => onSelect?.(slot.pageIndex)}
      aria-label={`跳转到第 ${slot.pageIndex + 1} 页：${slot.label}`}
      aria-current={isActive ? 'step' : undefined}
      title={slot.titleAttr}
    >
      <span
        className="chapter-pill-fill"
        style={{ transform: `scaleX(${fillScale.toFixed(4)})` }}
        aria-hidden="true"
      />
      {isActive && (
        <span
          className="chapter-pill-bar"
          style={{ transform: `scaleX(${clampedRatio.toFixed(4)})` }}
          aria-hidden="true"
        />
      )}
      <span ref={boxRef} className="chapter-pill-content">
        <span
          ref={measureRef}
          className="chapter-pill-track-inner"
          style={{
            fontSize: `${fitStyle.fontSize}px`,
            letterSpacing:
              fitStyle.letterSpacingEm > 0 ? `${fitStyle.letterSpacingEm}em` : undefined,
          }}
        >
          {slot.numLabel && <span className="chapter-pill-num">{slot.numLabel}</span>}
          <span className="chapter-pill-text">{slot.label}</span>
        </span>
      </span>
    </button>
  );
};

/** 将毫秒时长格式化为紧凑的 MM:SS 读数 */
function formatClockMmSs(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSec / 60);
  const seconds = totalSec % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

/**
 * 顶部双层响应式章节进度导航栏：
 * 第一层展示刊名、日期、期号、当值播报角色徽章、总计时器与页码；
 * 第二层展示 [导览] + [01..0N 响应式撑满极简总结] + [速览] 分段式连续进度条。
 */
export const DeckHeader: React.FC<DeckHeaderProps> = ({
  issue,
  currentPage,
  totalPages,
  pageLabel,
  activeMascotId,
  sectionProgress,
  sectionDurationsMs,
  globalTimeMs,
  totalDurationMs,
  onSelectPage,
}) => {
  const newsCount = issue.items.length;
  const isDenseTrack = newsCount >= 6;
  const clampedRatio = Math.min(1, Math.max(0, sectionProgress));

  const presenterName =
    issue.mascotMode === 'fixed-host'
      ? issue.hostDisplayName ||
        (issue.hostMascotId !== 'none' ? getMascotProfile(issue.hostMascotId).name : '')
      : activeMascotId !== 'none'
        ? getMascotProfile(activeMascotId).name
        : '';

  const fallbackDurations = [
    issue.coverDurationSec * 1000,
    ...issue.items.map((item) => item.durationSec * 1000),
    issue.outroDurationSec * 1000,
  ];
  const rawSlots = [
    {
      pageIndex: 0,
      kind: 'bookend' as const,
      label: '导览',
      titleAttr: `第 1 / ${totalPages} 页 · 本期导览`,
    },
    ...issue.items.map((item, idx) => ({
      pageIndex: idx + 1,
      kind: 'news' as const,
      numLabel: item.indexLabel,
      label: item.progressLabel,
      titleAttr: `第 ${idx + 2} / ${totalPages} 页 · ${item.shortTitle}`,
    })),
    {
      pageIndex: totalPages - 1,
      kind: 'bookend' as const,
      label: '速览',
      titleAttr: `第 ${totalPages} / ${totalPages} 页 · 全期速览`,
    },
  ];
  const resolvedDurations = rawSlots.map((_, idx) =>
    Math.max(100, Math.round(sectionDurationsMs?.[idx] ?? fallbackDurations[idx] ?? 1000)),
  );
  const trackTotalMs = Math.max(
    1,
    resolvedDurations.reduce((sum, dur) => sum + dur, 0),
  );
  const slots: ChapterSlotSpec[] = rawSlots.map((slot, idx) => {
    const durationMs = resolvedDurations[idx] ?? 1000;
    return {
      ...slot,
      durationMs,
      weightRatio: durationMs / trackTotalMs,
    };
  });

  return (
    <header className="deck-header">
      <div className="deck-header-meta">
        <div className="deck-header-left">
          <span className="brand-wordmark">{issue.issueTitle}</span>
          <span className="header-sep">/</span>
          <span className="header-mono">{issue.date}</span>
          <span className="header-dot">·</span>
          <span className="header-mono">{issue.issueNumber}</span>

          {presenterName && (
            <span className="header-host-badge" data-testid="header-host-badge">
              <span className="header-host-dot" aria-hidden="true" />
              <span>本期播报 · {presenterName}</span>
            </span>
          )}
        </div>

        <div className="deck-header-right">
          {totalDurationMs > 0 && (
            <span className="header-global-timer" data-testid="header-global-timer">
              {formatClockMmSs(globalTimeMs)} / {formatClockMmSs(totalDurationMs)}
            </span>
          )}
          <span className="header-page-label">{pageLabel}</span>
          <span className="page-counter">
            <strong>{String(currentPage + 1).padStart(2, '0')}</strong>
            <span className="page-counter-sep">/</span>
            <span>{String(totalPages).padStart(2, '0')}</span>
          </span>
        </div>
      </div>

      <nav
        className={`deck-chapter-bar ${isDenseTrack ? 'is-dense-track' : ''}`}
        aria-label="章节播报进度"
      >
        {slots.map((slot) => {
          const isActive = slot.pageIndex === currentPage;
          const isPast = slot.pageIndex < currentPage;
          const fillScale = isPast ? 1 : isActive ? clampedRatio : 0;

          return (
            <ResponsiveChapterPill
              key={slot.pageIndex}
              slot={slot}
              newsCount={newsCount}
              totalSlots={slots.length}
              isActive={isActive}
              isPast={isPast}
              fillScale={fillScale}
              clampedRatio={clampedRatio}
              onSelect={onSelectPage}
            />
          );
        })}
      </nav>
    </header>
  );
};
