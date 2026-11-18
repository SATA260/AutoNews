import {
  ClipboardCheck,
  Code2,
  Cpu,
  Gift,
  Globe,
  LayoutGrid,
  Rocket,
  ShieldCheck,
  Sparkles,
  TrendingDown,
  Users,
  Zap,
} from 'lucide-react';
import type React from 'react';
import { useState } from 'react';
import type { CardIconName, SanitizedInfoCard, SanitizedNewsItem } from '../../schema/newsSchema';
import { AutoFitText } from '../guard/AutoFitText';
import { DeckErrorBoundary } from '../guard/DeckErrorBoundary';
import { SafeMedia } from '../guard/SafeMedia';

/** 单条新闻页面组件入参属性 */
export interface NewsCardPageProps {
  item: SanitizedNewsItem;
  totalItems: number;
  hasMascot?: boolean;
  onErrorCaptured?: (scopeName: string, message: string) => void;
}

const CARD_ACCENTS = ['coral', 'amber', 'teal', 'crimson'] as const;

/** 按卡片语义图标名称渲染对应的线条图标 */
function renderCardIcon(icon: CardIconName, size: number): React.ReactElement {
  const props = { size, strokeWidth: 2.2, 'aria-hidden': true as const };
  switch (icon) {
    case 'rocket':
      return <Rocket {...props} />;
    case 'cpu':
      return <Cpu {...props} />;
    case 'trending-down':
      return <TrendingDown {...props} />;
    case 'zap':
      return <Zap {...props} />;
    case 'grid':
      return <LayoutGrid {...props} />;
    case 'gift':
      return <Gift {...props} />;
    case 'clipboard-check':
      return <ClipboardCheck {...props} />;
    case 'users':
      return <Users {...props} />;
    case 'code':
      return <Code2 {...props} />;
    case 'shield':
      return <ShieldCheck {...props} />;
    case 'globe':
      return <Globe {...props} />;
    default:
      return <Sparkles {...props} />;
  }
}

/** 计算全幅信息卡片网格对应的列数（最多 4 列，兼顾 2～8 张卡片的视觉平衡） */
function resolveFullGridCols(count: number): number {
  if (count <= 1) return 1;
  if (count <= 4) return 2;
  if (count <= 6) return 3;
  return 4;
}

/** 渲染由结构化信息卡片组成的网格区域 */
const InfoCardsGrid: React.FC<{
  cards: readonly SanitizedInfoCard[];
  cols: number;
  compact: boolean;
}> = ({ cards, cols, compact }) => {
  const singleRow = cards.length <= cols;
  const maxBodyFont = compact ? 24 : cols >= 4 ? 26 : cols === 3 ? 28 : 30;
  const minBodyFont = compact ? 16 : 19;

  return (
    <div
      className={`news-cards-grid cols-${cols} ${singleRow ? 'is-single-row' : 'is-two-rows'} ${compact ? 'is-split-cards' : ''}`}
    >
      {cards.map((card, idx) => (
        <article
          key={`${idx}-${card.title}`}
          className="news-info-card"
          data-accent={CARD_ACCENTS[idx % CARD_ACCENTS.length]}
          style={{ '--card-idx': idx } as React.CSSProperties}
        >
          <header className="info-card-head">
            <span className="info-card-icon">{renderCardIcon(card.icon, compact ? 24 : 26)}</span>
            <h2 className="info-card-title">{card.title}</h2>
          </header>
          <AutoFitText
            as="p"
            text={card.body}
            maxFontSize={maxBodyFont}
            minFontSize={minBodyFont}
            maxLines={5}
            lineHeight={compact ? 1.46 : 1.52}
            className="info-card-body"
          />
        </article>
      ))}
    </div>
  );
};

/** 单条新闻页面：顶部展示醒目居中大标题，主体采用多张结构化信息卡片网格；有官方配图时自动切分左右图文并排布局 */
export const NewsCardPage: React.FC<NewsCardPageProps> = ({
  item,
  totalItems,
  hasMascot = true,
  onErrorCaptured,
}) => {
  const [failedPrimaryUrl, setFailedPrimaryUrl] = useState<string | null>(null);
  const [failedSecondaryUrl, setFailedSecondaryUrl] = useState<string | null>(null);

  const hasPrimaryImage = Boolean(item.imageUrl) && failedPrimaryUrl !== item.imageUrl;
  const hasSecondaryImage =
    Boolean(item.secondaryImageUrl) && failedSecondaryUrl !== item.secondaryImageUrl;

  const visibleCards = hasPrimaryImage ? item.cards.slice(0, 6) : item.cards.slice(0, 8);
  const fullGridCols = resolveFullGridCols(visibleCards.length);

  return (
    <div
      className={`news-editorial-layout ${hasPrimaryImage ? 'is-split-image' : 'is-full-panel'} ${
        hasMascot ? 'has-mascot' : 'no-mascot'
      }`}
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
      </header>

      {hasPrimaryImage ? (
        <div className="news-split-body">
          <section className="news-cards-pane">
            <InfoCardsGrid cards={visibleCards} cols={visibleCards.length <= 1 ? 1 : 2} compact />
          </section>

          <section className="news-reference-col">
            <DeckErrorBoundary scopeName={`news-ref-${item.id}`} onErrorCaptured={onErrorCaptured}>
              <figure className="official-plate-figure">
                <div className={`official-plate-frame ${hasSecondaryImage ? 'is-two-up' : ''}`}>
                  <div className="official-media-slot">
                    <SafeMedia
                      src={item.imageUrl}
                      alt={item.imageCaption || item.title}
                      className="official-media-img"
                      onFallback={() => setFailedPrimaryUrl(item.imageUrl)}
                      fallback={null}
                    />
                  </div>
                  {hasSecondaryImage && (
                    <div className="official-media-slot">
                      <SafeMedia
                        src={item.secondaryImageUrl}
                        alt={`${item.title} 补充引用`}
                        className="official-media-img"
                        onFallback={() => setFailedSecondaryUrl(item.secondaryImageUrl)}
                        fallback={null}
                      />
                    </div>
                  )}
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
          <InfoCardsGrid cards={visibleCards} cols={fullGridCols} compact={false} />
        </section>
      )}

      <footer className="news-source-footer">
        <span className="source-label">信源</span>
        <span className="source-value">{item.source}</span>
        {item.sourceUrl && (
          <>
            <span className="source-dot">·</span>
            <span className="source-url">{item.sourceUrl}</span>
          </>
        )}
        <span className="source-dot">·</span>
        <span className="source-date">{item.publishedAt}</span>
      </footer>
    </div>
  );
};
