import { Globe, Star } from 'lucide-react';
import type React from 'react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { SanitizedDailyIssue } from '../../schema/newsSchema';
import {
  assignMasonryColumns,
  buildCoverWaterfallGroups,
  type CoverWaterfallGroup,
  formatOverviewDateTitle,
} from '../../utils/coverOverview';
import { computeCoverScrollState } from '../../utils/coverScroll';
import { CompanyLogoBadge } from '../common/CompanyLogoBadge';

/** 封面总览页组件入参属性 */
export interface CoverPageProps {
  issue: SanitizedDailyIssue;
  onJumpToNews: (itemIndex: number) => void;
  hasMascot?: boolean;
  isExiting?: boolean;
  scrollLocalMs?: number | null;
  pageDurationMs?: number;
}

/** 封面总览页：顶部居中展示期次日期概览标题，主体以双列彩色瀑布流呈现要闻与按公司归组的新闻目录，内容较多时平滑下拉展示 */
export const CoverPage: React.FC<CoverPageProps> = ({
  issue,
  onJumpToNews,
  hasMascot = true,
  isExiting = false,
  scrollLocalMs = null,
  pageDurationMs = issue.coverDurationSec * 1000,
}) => {
  const groups = useMemo(() => buildCoverWaterfallGroups(issue.items), [issue.items]);
  const columns = useMemo(() => assignMasonryColumns(groups), [groups]);
  const titleText = useMemo(() => formatOverviewDateTitle(issue.date), [issue.date]);

  const viewportRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);

  const [maxScrollPx, setMaxScrollPx] = useState(0);
  const [manualOffsetPx, setManualOffsetPx] = useState(0);

  const measureOverflow = useCallback(() => {
    const viewportEl = viewportRef.current;
    const contentEl = contentRef.current;
    if (!viewportEl || !contentEl) {
      return;
    }
    const nextMax = Math.max(0, Math.ceil(contentEl.scrollHeight - viewportEl.clientHeight));
    setMaxScrollPx((prev) => (prev === nextMax ? prev : nextMax));
    setManualOffsetPx((prev) => Math.min(nextMax, Math.max(0, prev)));
  }, []);

  useLayoutEffect(() => {
    void groups;
    measureOverflow();
  }, [measureOverflow, groups]);

  useLayoutEffect(() => {
    const viewportEl = viewportRef.current;
    const contentEl = contentRef.current;
    if (!viewportEl || !contentEl || typeof ResizeObserver === 'undefined') {
      return;
    }
    const observer = new ResizeObserver(measureOverflow);
    observer.observe(viewportEl);
    observer.observe(contentEl);
    return () => {
      observer.disconnect();
    };
  }, [measureOverflow]);

  useEffect(() => {
    void issue.items;
    if (scrollLocalMs === null) {
      setManualOffsetPx(0);
    }
  }, [issue.items, scrollLocalMs]);

  const scrollState = computeCoverScrollState(
    scrollLocalMs,
    pageDurationMs,
    maxScrollPx,
    manualOffsetPx,
  );

  const handleViewportWheel = useCallback(
    (event: React.WheelEvent<HTMLDivElement>) => {
      if (scrollLocalMs !== null || isExiting || maxScrollPx <= 4) {
        return;
      }
      if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) {
        return;
      }
      setManualOffsetPx((prev) => Math.min(maxScrollPx, Math.max(0, prev + event.deltaY)));
    },
    [isExiting, maxScrollPx, scrollLocalMs],
  );

  const renderCard = (group: CoverWaterfallGroup) => (
    <section
      key={group.key}
      className={`cover-waterfall-card is-${group.kind}`}
      data-tone={group.tone}
      style={{ '--card-accent': group.accentColor } as React.CSSProperties}
    >
      <header className="waterfall-card-head">
        {group.kind === 'featured' ? (
          <span className="waterfall-card-icon is-featured" aria-hidden="true">
            <Star size={26} fill="currentColor" strokeWidth={2} />
          </span>
        ) : group.kind === 'company' && group.headerCompany ? (
          <CompanyLogoBadge company={group.headerCompany} size="card" />
        ) : (
          <span className="waterfall-card-icon is-other" aria-hidden="true">
            <Globe size={24} strokeWidth={2.2} />
          </span>
        )}
        <h2 className="waterfall-card-title">{group.title}</h2>
      </header>

      <ul className="waterfall-card-list">
        {group.items.map((entry) => (
          <li key={entry.item.id} className="waterfall-card-li">
            <button
              type="button"
              className="waterfall-item-btn"
              onClick={() => onJumpToNews(entry.originalIndex)}
            >
              {group.showItemLogos ? (
                <CompanyLogoBadge company={entry.company} size="item" />
              ) : (
                <span className="waterfall-bullet-dot" aria-hidden="true" />
              )}
              <span className="waterfall-item-text">{entry.item.shortTitle}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );

  return (
    <div
      className={`cover-overview-layout ${hasMascot ? 'has-mascot' : 'no-mascot'} ${
        scrollState.hasOverflow ? 'has-overflow' : ''
      }`}
      data-scroll-offset={scrollState.offsetPx}
      data-scroll-overflow={scrollState.hasOverflow ? 'true' : 'false'}
    >
      <header className="cover-overview-header">
        <h1 className="cover-overview-title">{titleText}</h1>
      </header>

      <div ref={viewportRef} className="cover-waterfall-viewport" onWheel={handleViewportWheel}>
        <div
          ref={contentRef}
          className={`cover-waterfall-track ${columns.singleColumn ? 'is-single-column' : ''}`}
          style={{ transform: `translate3d(0, ${-scrollState.offsetPx}px, 0)` }}
        >
          {columns.singleColumn ? (
            <div className="cover-waterfall-single">{columns.left.map(renderCard)}</div>
          ) : (
            <div className="cover-waterfall-columns">
              <div className="cover-waterfall-col">{columns.left.map(renderCard)}</div>
              <div className="cover-waterfall-col">{columns.right.map(renderCard)}</div>
            </div>
          )}
        </div>

        <div
          className={`cover-scroll-fade-top ${scrollState.canScrollUp ? 'is-visible' : ''}`}
          aria-hidden="true"
        />
        <div
          className={`cover-scroll-fade-bottom ${scrollState.canScrollDown ? 'is-visible' : ''}`}
          aria-hidden="true"
        />
      </div>
    </div>
  );
};
