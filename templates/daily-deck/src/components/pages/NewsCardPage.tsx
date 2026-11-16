import React, { useEffect, useState } from 'react';
import type { SanitizedNewsItem } from '../../schema/newsSchema';
import { AutoFitText } from '../guard/AutoFitText';
import { DeckErrorBoundary } from '../guard/DeckErrorBoundary';
import { SafeMedia } from '../guard/SafeMedia';

/** 单条新闻页面组件入参属性 */
export interface NewsCardPageProps {
  item: SanitizedNewsItem;
  totalItems: number;
  onErrorCaptured?: (scopeName: string, message: string) => void;
}

/** 单条新闻页面：左侧呈现标题、简短梗概、事实要点与来源，右侧展示官方配图或披露摘录 */
export const NewsCardPage: React.FC<NewsCardPageProps> = ({
  item,
  totalItems,
  onErrorCaptured,
}) => {
  const [mediaFailed, setMediaFailed] = useState(false);
  const [secondaryFailed, setSecondaryFailed] = useState(false);

  useEffect(() => {
    setMediaFailed(false);
    setSecondaryFailed(false);
  }, [item.id, item.imageUrl, item.secondaryImageUrl]);

  const hasPrimaryImage = Boolean(item.imageUrl) && !mediaFailed;
  const hasSecondaryImage = Boolean(item.secondaryImageUrl) && !secondaryFailed;

  const fallbackSpecs =
    item.metrics.length > 0
      ? item.metrics
      : [
          { label: '所属领域', value: item.category },
          { label: '发布主体', value: item.source },
          { label: '发布日期', value: item.publishedAt },
        ];

  return (
    <div className="news-editorial-layout">
      <section className="news-synopsis-col">
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
          maxFontSize={54}
          minFontSize={36}
          maxLines={3}
          lineHeight={1.22}
          className="news-editorial-title"
        />

        <div className="news-rule" />

        <AutoFitText
          as="p"
          text={item.summary}
          maxFontSize={32}
          minFontSize={24}
          maxLines={4}
          lineHeight={1.46}
          className="news-synopsis-text"
        />

        {item.keyPoints.length > 0 && (
          <ul className="news-keypoints-list">
            {item.keyPoints.map((point, idx) => (
              <li
                key={idx}
                className="news-keypoint-item"
                style={{ '--row-idx': idx } as React.CSSProperties}
              >
                <span className="keypoint-dash" aria-hidden="true">
                  —
                </span>
                <span className="keypoint-text">{point}</span>
              </li>
            ))}
          </ul>
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
      </section>

      <section className="news-reference-col">
        <DeckErrorBoundary scopeName={`news-ref-${item.id}`} onErrorCaptured={onErrorCaptured}>
          {hasPrimaryImage ? (
            <figure className="official-plate-figure">
              <div className={`official-plate-frame ${hasSecondaryImage ? 'is-two-up' : ''}`}>
                <div className="official-media-slot">
                  <SafeMedia
                    src={item.imageUrl}
                    alt={item.imageCaption || item.title}
                    className="official-media-img"
                    onFallback={() => setMediaFailed(true)}
                    fallback={null}
                  />
                </div>
                {hasSecondaryImage && (
                  <div className="official-media-slot">
                    <SafeMedia
                      src={item.secondaryImageUrl}
                      alt={`${item.title} 补充引用`}
                      className="official-media-img"
                      onFallback={() => setSecondaryFailed(true)}
                      fallback={null}
                    />
                  </div>
                )}
              </div>
              <figcaption className="official-plate-caption">
                {item.imageCaption || `图｜${item.source} 官方发布资料`}
              </figcaption>
            </figure>
          ) : (
            <div className="official-excerpt-sheet">
              <div className="excerpt-sheet-kicker">官方披露摘录 / PRIMARY SOURCE NOTES</div>

              {item.officialQuote && (
                <blockquote className="excerpt-quote">
                  <AutoFitText
                    as="p"
                    text={item.officialQuote}
                    maxFontSize={30}
                    minFontSize={22}
                    maxLines={4}
                    lineHeight={1.5}
                    className="excerpt-quote-text"
                  />
                </blockquote>
              )}

              <div className="excerpt-specs-table">
                {fallbackSpecs.map((spec, sIdx) => (
                  <div
                    key={sIdx}
                    className="excerpt-spec-row"
                    style={{ '--row-idx': sIdx } as React.CSSProperties}
                  >
                    <span className="spec-label">{spec.label}</span>
                    <strong className="spec-value">{spec.value}</strong>
                  </div>
                ))}
              </div>

              <div className="excerpt-source-foot">
                来源归属：{item.source}
                {item.sourceUrl ? ` (${item.sourceUrl})` : ''}
              </div>
            </div>
          )}
        </DeckErrorBoundary>
      </section>
    </div>
  );
};
