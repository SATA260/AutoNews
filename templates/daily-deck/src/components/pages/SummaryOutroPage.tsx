import React from 'react';
import type { SanitizedDailyIssue } from '../../schema/newsSchema';
import { AutoFitText } from '../guard/AutoFitText';

interface SummaryOutroPageProps {
  issue: SanitizedDailyIssue;
  onJumpToNews: (itemIndex: number) => void;
}

export const SummaryOutroPage: React.FC<SummaryOutroPageProps> = ({
  issue,
  onJumpToNews,
}) => {
  const isDense = issue.items.length > 6;

  return (
    <div className="outro-layout">
      <div className="outro-top-bar">
        <div>
          <span className="outro-eyebrow">SUMMARY · {issue.date}</span>
          <h1 className="outro-heading">本期速览</h1>
        </div>
        <span className="outro-count">共 {issue.items.length} 条要闻</span>
      </div>

      <div className={`outro-table ${isDense ? 'is-dense' : ''}`}>
        {issue.items.map((item, idx) => (
          <button
            key={item.id}
            type="button"
            className="outro-row"
            onClick={() => onJumpToNews(idx)}
          >
            <span className="outro-row-num">{item.indexLabel}</span>
            <span className="outro-row-title">{item.shortTitle}</span>
            <div className="outro-row-summary-wrap">
              <AutoFitText
                as="p"
                text={item.summary}
                maxFontSize={isDense ? 20 : 24}
                minFontSize={17}
                maxLines={isDense ? 1 : 2}
                lineHeight={1.38}
                className="outro-row-summary"
              />
            </div>
            <span className="outro-row-source">{item.source}</span>
          </button>
        ))}
      </div>

      <div className="outro-footer-note">{issue.footerCta}</div>
    </div>
  );
};
