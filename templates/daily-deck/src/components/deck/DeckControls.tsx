import React from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Edit3,
  EyeOff,
  Moon,
  Pause,
  Play,
  Sun,
} from 'lucide-react';

interface DeckControlsProps {
  currentPage: number;
  totalPages: number;
  isAutoPlaying: boolean;
  theme: 'light' | 'dark';
  cleanMode: boolean;
  warningCount: number;
  runtimeErrorCount: number;
  onPrev: () => void;
  onNext: () => void;
  onToggleAutoPlay: () => void;
  onToggleTheme: () => void;
  onToggleCleanMode: () => void;
  onOpenInspector: (tab?: 'summary' | 'json' | 'health') => void;
}

export const DeckControls: React.FC<DeckControlsProps> = ({
  currentPage,
  totalPages,
  isAutoPlaying,
  theme,
  cleanMode,
  warningCount,
  runtimeErrorCount,
  onPrev,
  onNext,
  onToggleAutoPlay,
  onToggleTheme,
  onToggleCleanMode,
  onOpenInspector,
}) => {
  if (cleanMode) {
    return null;
  }

  const hasIssues = warningCount > 0 || runtimeErrorCount > 0;

  return (
    <div className="deck-controls-dock" role="toolbar" aria-label="新闻翻页控制台">
      <div className="controls-group">
        <button
          type="button"
          className="ctrl-btn"
          onClick={onPrev}
          disabled={currentPage <= 0}
          aria-label="上一页"
          title="上一页 (←)"
        >
          <ChevronLeft size={18} />
          <span>上一页</span>
        </button>

        <span className="ctrl-page-readout">
          {String(currentPage + 1).padStart(2, '0')} / {String(totalPages).padStart(2, '0')}
        </span>

        <button
          type="button"
          className="ctrl-btn"
          onClick={onNext}
          disabled={currentPage >= totalPages - 1}
          aria-label="下一页"
          title="下一页 (→ / Space)"
        >
          <span>下一页</span>
          <ChevronRight size={18} />
        </button>
      </div>

      <div className="controls-divider" />

      <div className="controls-group">
        <button
          type="button"
          className={`ctrl-btn ${isAutoPlaying ? 'is-primary' : ''}`}
          onClick={onToggleAutoPlay}
          title="自动翻页播放 (P)"
        >
          {isAutoPlaying ? <Pause size={16} /> : <Play size={16} />}
          <span>{isAutoPlaying ? '暂停轮播' : '自动播放'}</span>
        </button>

        <button
          type="button"
          className="ctrl-btn"
          onClick={onToggleTheme}
          title="切换主题风格"
        >
          {theme === 'light' ? <Moon size={16} /> : <Sun size={16} />}
          <span>{theme === 'light' ? '深色风格' : '浅色风格'}</span>
        </button>

        <button
          type="button"
          className="ctrl-btn is-accent"
          onClick={() => onOpenInspector('summary')}
          title="编辑新闻梗概、官方配图与 JSON 数据 (E)"
        >
          <Edit3 size={16} />
          <span>编辑梗概 / 导入 (E)</span>
        </button>
      </div>

      <div className="controls-divider" />

      <div className="controls-group">
        <button
          type="button"
          className={`ctrl-health-pill ${hasIssues ? 'is-warn' : 'is-ok'}`}
          onClick={() => onOpenInspector('health')}
          title="查看防错校验与运行状态"
        >
          {hasIssues ? <AlertTriangle size={15} /> : <CheckCircle2 size={15} />}
          <span>
            {runtimeErrorCount > 0
              ? `隔离 ${runtimeErrorCount} 异常`
              : warningCount > 0
                ? `${warningCount} 项自动修正`
                : '零异常合规'}
          </span>
        </button>

        <button
          type="button"
          className="ctrl-btn"
          onClick={onToggleCleanMode}
          title="隐藏底部控制台用于纯净录屏 (按 H 键恢复)"
        >
          <EyeOff size={16} />
          <span>纯净录屏 (H)</span>
        </button>
      </div>
    </div>
  );
};
