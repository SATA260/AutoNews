import type React from 'react';
import type { SanitizedDailyIssue } from '../../schema/newsSchema';

/** 顶部刊头栏组件入参属性 */
export interface DeckHeaderProps {
  issue: SanitizedDailyIssue;
  currentPage: number;
  totalPages: number;
  pageLabel: string;
  onSelectPage?: (index: number) => void;
}

/** 顶部刊头栏：展示刊名、发布日期、期号及可点击的细线翻页进度条 */
export const DeckHeader: React.FC<DeckHeaderProps> = ({
  issue,
  currentPage,
  totalPages,
  pageLabel,
  onSelectPage,
}) => {
  return (
    <header className="deck-header">
      <div className="deck-header-left">
        <span className="brand-wordmark">{issue.issueTitle}</span>
        <span className="header-sep">/</span>
        <span className="header-mono">{issue.date}</span>
        <span className="header-dot">·</span>
        <span className="header-mono">{issue.issueNumber}</span>
      </div>

      <div className="deck-header-right">
        <nav className="deck-header-ticks" aria-label="页面进度">
          {Array.from({ length: totalPages }).map((_, idx) => {
            const isActive = idx === currentPage;
            const isPast = idx < currentPage;
            return (
              <button
                key={idx}
                type="button"
                className={`progress-tick ${isActive ? 'is-active' : ''} ${isPast ? 'is-past' : ''}`}
                onClick={() => onSelectPage?.(idx)}
                aria-label={`跳转到第 ${idx + 1} 页`}
                title={`第 ${idx + 1} / ${totalPages} 页`}
              />
            );
          })}
        </nav>

        <span className="header-page-label">{pageLabel}</span>
        <span className="page-counter">
          <strong>{String(currentPage + 1).padStart(2, '0')}</strong>
          <span className="page-counter-sep">/</span>
          <span>{String(totalPages).padStart(2, '0')}</span>
        </span>
      </div>
    </header>
  );
};
