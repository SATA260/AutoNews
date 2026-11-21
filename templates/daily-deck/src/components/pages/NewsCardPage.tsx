import type React from 'react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { getCardIconComponent } from '../../icons/cardIconSet';
import {
  HARD_LIMITS,
  type SanitizedInfoCard,
  type SanitizedNewsItem,
  type SanitizedSubtitleCue,
} from '../../schema/newsSchema';
import {
  CARD_REVEAL_FADE_MS,
  CARD_REVEAL_RISE_PX,
  type CardRevealState,
  computeCardRevealTimesMs,
  resolveCardRevealStates,
} from '../../utils/cardReveal';
import { splitCardBody, trimCardTerminalPeriod } from '../../utils/cardTypography';
import {
  computeImageSpotlightWindow,
  resolveImageSpotlightState,
} from '../../utils/imageSpotlight';
import { AutoFitText } from '../guard/AutoFitText';
import { DeckErrorBoundary } from '../guard/DeckErrorBoundary';
import { SafeMedia } from '../guard/SafeMedia';

/** 单条新闻页面组件入参属性 */
export interface NewsCardPageProps {
  item: SanitizedNewsItem;
  totalItems: number;
  hasMascot?: boolean;
  isExiting?: boolean;
  onErrorCaptured?: (scopeName: string, message: string) => void;
  /** 本页已播放的毫秒数，用来让卡片跟着口播逐张出现；为空时所有卡片直接全部显示 */
  revealLocalMs?: number | null;
  /** 本页总停留时长（毫秒），用于规划配图展开和切页前收回的时间窗口 */
  pageDurationMs?: number;
  /** 本页口播的字幕时间表（相对本页开始），用来对齐卡片出现时刻 */
  subtitles?: readonly SanitizedSubtitleCue[];
  /** 本页画面出现后延迟多少毫秒再开始播报口播 */
  speechStartMs?: number;
  /** 本页实际口播时长（毫秒） */
  speechMs?: number;
}

/** 计算子元素相对指定祖先容器的未缩放布局偏移（不受外层缩放变换影响） */
function measureOffsetWithin(
  child: HTMLElement,
  ancestor: HTMLElement,
): { left: number; top: number } {
  let left = 0;
  let top = 0;
  let cursor: HTMLElement | null = child;
  while (cursor && cursor !== ancestor) {
    left += cursor.offsetLeft;
    top += cursor.offsetTop;
    cursor = cursor.offsetParent as HTMLElement | null;
  }
  return { left, top };
}

const DEFAULT_EXPAND_OFFSETS = { left: 896, top: 114, bottom: 42 };

const CARD_ACCENTS = ['coral', 'amber', 'teal', 'crimson'] as const;

/** 计算全幅卡片网格的列数：1～3 张排成一行，4 张排成两行两列 */
function resolveFullGridCols(count: number): number {
  if (count <= 1) return 1;
  if (count === 4) return 2;
  return Math.min(3, count);
}

/** 计算有配图时左侧卡片区的列数：3 张以内竖排一列，4 张排成两行两列 */
function resolveSplitGridCols(count: number): number {
  return count >= 4 ? 2 : 1;
}

/** 渲染卡片正文：去掉末尾句号，并把关键数字和单位包成不折行的强调片段 */
function renderCardBody(text: string): React.ReactNode {
  return splitCardBody(text).map((seg, idx) =>
    seg.kind === 'figure' ? (
      <span key={`f-${idx}-${seg.value}`} className="card-figure">
        {seg.value}
      </span>
    ) : (
      <span key={`t-${idx}`}>{seg.value}</span>
    ),
  );
}

/** 渲染由结构化信息卡片组成的网格区域，每张卡片按显示状态淡入并标记当前正在讲的一张 */
const InfoCardsGrid: React.FC<{
  cards: readonly SanitizedInfoCard[];
  cols: number;
  compact: boolean;
  revealStates: readonly CardRevealState[] | null;
}> = ({ cards, cols, compact, revealStates }) => {
  const singleRow = cards.length <= cols;
  const maxBodyFont = compact ? (cols >= 2 ? 26 : 30) : cols >= 3 ? 30 : 34;
  const minBodyFont = compact ? 18 : 22;
  const iconSize = compact ? 22 : 26;

  return (
    <div
      className={`news-cards-grid cols-${cols} ${singleRow ? 'is-single-row' : 'is-two-rows'} ${compact ? 'is-split-cards' : ''}`}
    >
      {cards.map((card, idx) => {
        const state = revealStates?.[idx];
        const progress = state ? state.progress : 1;
        const Icon = getCardIconComponent(card.icon);
        const revealStyle: React.CSSProperties = state
          ? ({
              opacity: Number(progress.toFixed(4)),
              transform:
                progress >= 1
                  ? undefined
                  : `translate3d(0, ${(CARD_REVEAL_RISE_PX * (1 - progress)).toFixed(2)}px, 0)`,
              '--card-focus': state.focus,
            } as React.CSSProperties)
          : {};
        return (
          <article
            key={`${idx}-${card.title}`}
            className={`news-info-card ${progress <= 0 ? 'is-pending' : ''} ${
              state?.isCurrent ? 'is-current' : ''
            }`}
            data-accent={CARD_ACCENTS[idx % CARD_ACCENTS.length]}
            data-icon={card.icon}
            style={{ '--card-idx': idx, ...revealStyle } as React.CSSProperties}
          >
            <header className="info-card-head">
              <span className="info-card-icon" aria-hidden="true">
                <Icon size={iconSize} strokeWidth={2.2} aria-hidden={true} />
              </span>
              <h2 className="info-card-title">{card.title}</h2>
            </header>
            <AutoFitText
              as="p"
              text={trimCardTerminalPeriod(card.body)}
              maxFontSize={maxBodyFont}
              minFontSize={minBodyFont}
              maxLines={4}
              lineHeight={1.5}
              className="info-card-body"
              renderContent={renderCardBody}
            />
          </article>
        );
      })}
    </div>
  );
};

/** 单条新闻页面：顶部展示醒目居中大标题，主体是跟着口播逐张出现的信息卡片；有官方配图时切成左右图文并排布局，并在卡片讲完后从右向左动态展开大图 */
export const NewsCardPage: React.FC<NewsCardPageProps> = ({
  item,
  totalItems,
  hasMascot = true,
  isExiting = false,
  onErrorCaptured,
  revealLocalMs = null,
  pageDurationMs,
  subtitles = [],
  speechStartMs = 0,
  speechMs = 0,
}) => {
  const [failedPrimaryUrl, setFailedPrimaryUrl] = useState<string | null>(null);
  const [manualExpanded, setManualExpanded] = useState<boolean>(false);
  const [expandOffsets, setExpandOffsets] = useState(DEFAULT_EXPAND_OFFSETS);

  const layoutRef = useRef<HTMLDivElement | null>(null);
  const refColRef = useRef<HTMLElement | null>(null);
  const wasExitingRef = useRef<boolean>(isExiting);

  const hasPrimaryImage = Boolean(item.imageUrl) && failedPrimaryUrl !== item.imageUrl;

  const visibleCards = item.cards.slice(0, HARD_LIMITS.cardsVisibleMax);
  const fullGridCols = resolveFullGridCols(visibleCards.length);
  const splitGridCols = resolveSplitGridCols(visibleCards.length);

  const revealTimesMs = useMemo(
    () => computeCardRevealTimesMs(visibleCards.length, subtitles, speechMs, speechStartMs),
    [visibleCards.length, subtitles, speechMs, speechStartMs],
  );
  const revealStates =
    revealLocalMs === null
      ? null
      : resolveCardRevealStates(revealTimesMs, revealLocalMs, speechMs, speechStartMs);

  const effectivePageDurationMs =
    pageDurationMs !== undefined && Number.isFinite(pageDurationMs) && pageDurationMs > 0
      ? pageDurationMs
      : item.durationSec * 1000;
  const lastCardRevealMs =
    revealTimesMs.length > 0 ? (revealTimesMs[revealTimesMs.length - 1] ?? 0) : 0;
  const spotlightWindow = useMemo(
    () =>
      hasPrimaryImage
        ? computeImageSpotlightWindow(
            effectivePageDurationMs,
            lastCardRevealMs,
            visibleCards.length <= 1 ? 0 : CARD_REVEAL_FADE_MS,
          )
        : null,
    [hasPrimaryImage, effectivePageDurationMs, lastCardRevealMs, visibleCards.length],
  );

  // 切换新闻条目、从离场页重新切回当前页、开启自动播放或图片失效时自动收起暂停态的手动大图预览
  const isPlayingOrManualClock = revealLocalMs !== null;
  useEffect(() => {
    void item.id;
    const returnedFromExit = wasExitingRef.current && !isExiting;
    wasExitingRef.current = isExiting;
    if (isPlayingOrManualClock || !hasPrimaryImage || returnedFromExit) {
      setManualExpanded(false);
    }
  }, [item.id, isPlayingOrManualClock, hasPrimaryImage, isExiting]);

  const updateExpandOffsets = useCallback(() => {
    const layoutEl = layoutRef.current;
    const colEl = refColRef.current;
    if (!layoutEl || !colEl) {
      return;
    }
    if (layoutEl.clientWidth <= 0 || colEl.offsetHeight <= 0) {
      setExpandOffsets(DEFAULT_EXPAND_OFFSETS);
      return;
    }
    const rel = measureOffsetWithin(colEl, layoutEl);
    const next = {
      left: Math.max(0, Math.round(rel.left)),
      top: Math.max(0, Math.round(rel.top)),
      bottom: Math.max(0, Math.round(layoutEl.clientHeight - (rel.top + colEl.offsetHeight))),
    };
    setExpandOffsets((prev) =>
      prev.left === next.left && prev.top === next.top && prev.bottom === next.bottom ? prev : next,
    );
  }, []);

  useLayoutEffect(() => {
    if (!hasPrimaryImage) {
      return;
    }
    updateExpandOffsets();
    const layoutEl = layoutRef.current;
    const colEl = refColRef.current;
    if (!layoutEl || !colEl || typeof ResizeObserver === 'undefined') {
      return;
    }
    const observer = new ResizeObserver(updateExpandOffsets);
    observer.observe(layoutEl);
    observer.observe(colEl);
    return () => {
      observer.disconnect();
    };
  }, [hasPrimaryImage, updateExpandOffsets]);

  const spotlightState = useMemo(() => {
    if (!hasPrimaryImage) {
      return { phase: 'idle' as const, progress: 0 };
    }
    if (revealLocalMs !== null) {
      return resolveImageSpotlightState(spotlightWindow, revealLocalMs);
    }
    return manualExpanded
      ? { phase: 'holding' as const, progress: 1 }
      : { phase: 'idle' as const, progress: 0 };
  }, [hasPrimaryImage, revealLocalMs, spotlightWindow, manualExpanded]);

  const isManualToggleable = hasPrimaryImage && revealLocalMs === null;
  const isSpotlightActive = spotlightState.progress > 0.001;

  return (
    <div
      ref={layoutRef}
      className={`news-editorial-layout ${hasPrimaryImage ? 'is-split-image' : 'is-full-panel'} ${
        hasMascot ? 'has-mascot' : 'no-mascot'
      } ${isSpotlightActive ? 'is-spotlight-active' : ''}`}
      style={{ '--spotlight-p': spotlightState.progress } as React.CSSProperties}
    >
      <header className="news-slide-top">
        <div className="news-kicker">
          <span className="news-kicker-num">{item.indexLabel}</span>
          <span className="news-kicker-sep" />
          <span className="news-kicker-text">
            {item.category} · {item.source}
          </span>
          <span className="news-kicker-count">
            {item.indexLabel} / {String(totalItems).padStart(2, '0')}
          </span>
        </div>

        <AutoFitText
          as="h1"
          text={item.title}
          maxFontSize={hasPrimaryImage ? 46 : 52}
          minFontSize={32}
          maxLines={2}
          lineHeight={1.2}
          className="news-editorial-title"
        />
        {item.actionHint && (
          <div className="news-action-hint" data-testid="news-action-hint">
            <span className="news-action-hint-badge">实操检索</span>
            <span className="news-action-hint-text">{item.actionHint}</span>
          </div>
        )}
      </header>

      {hasPrimaryImage && <div className="image-spotlight-scrim" aria-hidden="true" />}

      {hasPrimaryImage ? (
        <div className="news-split-body">
          <section className="news-cards-pane">
            <InfoCardsGrid
              cards={visibleCards}
              cols={splitGridCols}
              compact
              revealStates={revealStates}
            />
          </section>

          <section
            ref={refColRef}
            className={`news-reference-col ${isSpotlightActive ? 'is-spotlight-active' : ''}`}
          >
            <DeckErrorBoundary scopeName={`news-ref-${item.id}`} onErrorCaptured={onErrorCaptured}>
              <figure
                className={`official-plate-figure ${isSpotlightActive ? 'is-spotlight-active' : ''} ${
                  isManualToggleable ? 'is-manual-toggleable' : ''
                }`}
                data-spotlight-phase={spotlightState.phase}
                data-spotlight-progress={spotlightState.progress.toFixed(4)}
                style={
                  {
                    '--spotlight-p': spotlightState.progress,
                    '--expand-left-px': `${expandOffsets.left}px`,
                    '--expand-top-px': `${expandOffsets.top}px`,
                    '--expand-bottom-px': `${expandOffsets.bottom}px`,
                  } as React.CSSProperties
                }
                onClick={isManualToggleable ? () => setManualExpanded((prev) => !prev) : undefined}
                onKeyDown={
                  isManualToggleable
                    ? (event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault();
                          event.stopPropagation();
                          setManualExpanded((prev) => !prev);
                        }
                      }
                    : undefined
                }
                title={
                  isManualToggleable
                    ? manualExpanded
                      ? '点击收起配图'
                      : '点击放大查看配图'
                    : undefined
                }
              >
                <div className="official-plate-frame">
                  <div className="official-media-slot">
                    <SafeMedia
                      src={item.imageUrl}
                      alt={item.imageCaption || item.title}
                      className="official-media-img"
                      onFallback={() => setFailedPrimaryUrl(item.imageUrl)}
                      fallback={null}
                    />
                  </div>
                </div>
                <figcaption className="official-plate-caption">
                  {item.imageCaption || `图｜${item.source} 官方发布资料`}
                </figcaption>
              </figure>
            </DeckErrorBoundary>
          </section>
        </div>
      ) : (
        <section className="news-full-cards-pane">
          <InfoCardsGrid
            cards={visibleCards}
            cols={fullGridCols}
            compact={false}
            revealStates={revealStates}
          />
        </section>
      )}

      {item.guestReaction &&
        (revealLocalMs === null ||
          (revealLocalMs >= item.guestReaction.startSec * 1000 - 120 &&
            revealLocalMs <= item.guestReaction.endSec * 1000 + 400)) && (
          <aside
            className="guest-reaction-bubble"
            data-testid="guest-reaction-bubble"
            data-guest-host={item.guestReaction.hostId}
            aria-label="跨阵营嘉宾插嘴"
          >
            {item.guestReaction.hostId !== 'none' && (
              <img
                className="guest-reaction-avatar"
                src={`/mascots/${item.guestReaction.hostId}.png`}
                alt={item.guestReaction.hostName}
              />
            )}
            <div className="guest-reaction-body">
              <span className="guest-reaction-name">{item.guestReaction.hostName} 插嘴</span>
              <p className="guest-reaction-line">{item.guestReaction.line}</p>
            </div>
          </aside>
        )}
    </div>
  );
};
