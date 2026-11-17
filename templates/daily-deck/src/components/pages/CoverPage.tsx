import type React from 'react';
import type { SanitizedDailyIssue } from '../../schema/newsSchema';
import { AutoFitText } from '../guard/AutoFitText';

/** 封面导览页组件入参属性 */
export interface CoverPageProps {
  issue: SanitizedDailyIssue;
  onJumpToNews: (itemIndex: number) => void;
}

/** 封面导览页：左侧呈现今日要闻焦点，右侧以可点击编号列表展示全期新闻目录 */
export const CoverPage: React.FC<CoverPageProps> = ({ issue, onJumpToNews }) => {
  const isDenseList = issue.items.length > 6;

  return (
    <div className="cover-layout">
      <section className="cover-left">
        <div className="cover-eyebrow">DAILY BRIEFING · {issue.date}</div>
        <h1 className="cover-display-title">今日要闻</h1>
        <div className="editorial-rule-short" />
        <AutoFitText
          as="p"
          text={issue.headline}
          maxFontSize={34}
          minFontSize={24}
          maxLines={4}
          lineHeight={1.45}
          className="cover-focus-line"
        />
        <div className="cover-count-note">本期共 {issue.items.length} 条精选资讯</div>
      </section>

      <section className="cover-right" aria-label="本期新闻目录">
        <div className="cover-agenda-header">
          <span>目录 / CONTENTS</span>
          <span>SOURCE</span>
        </div>
        <div className={`cover-agenda-list ${isDenseList ? 'is-dense' : ''}`}>
          {issue.items.map((item, idx) => (
            <button
              key={item.id}
              type="button"
              className="agenda-row"
              style={{ '--row-idx': idx } as React.CSSProperties}
              onClick={() => onJumpToNews(idx)}
            >
              <span className="agenda-index">{item.indexLabel}</span>
              <span className="agenda-title">{item.shortTitle}</span>
              <span className="agenda-meta">
                {item.category} · {item.source}
              </span>
            </button>
          ))}
        </div>
      </section>
    </div>
  );
};
