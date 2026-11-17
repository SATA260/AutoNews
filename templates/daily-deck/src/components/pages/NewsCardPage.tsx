import type React from 'react';
import { useState } from 'react';
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

/** 单条新闻页面：展示标题、核心结论与要点，有图时显示配图，无图时使用全幅布局 */
export const NewsCardPage: React.FC<NewsCardPageProps> = ({
  item,
  totalItems,
  onErrorCaptured,
}) => {
  const [failedPrimaryUrl, setFailedPrimaryUrl] = useState<string | null>(null);
  const [failedSecondaryUrl, setFailedSecondaryUrl] = useState<string | null>(null);

  const hasPrimaryImage = Boolean(item.imageUrl) && failedPrimaryUrl !== item.imageUrl;
  const hasSecondaryImage =
    Boolean(item.secondaryImageUrl) && failedSecondaryUrl !== item.secondaryImageUrl;

  return (
    <div className={`news-editorial-layout ${hasPrimaryImage ? 'is-split-image' : 'is-full-panel'}`}>
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
          maxFontSize={hasPrimaryImage ? 56 : 72}
          minFontSize={hasPrimaryImage ? 38 : 52}
          maxLines={3}
          lineHeight={1.24}
          className="news-editorial-title"
        />

        <div className="news-rule" />

        <AutoFitText
          as="p"
          text={item.summary}
          maxFontSize={30}
          minFontSize={23}
          maxLines={4}
          lineHeight={1.48}
          className="news-synopsis-text news-highlight"
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

      {hasPrimaryImage && <section className="news-reference-col">
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
      </section>}
    </div>
  );
};
