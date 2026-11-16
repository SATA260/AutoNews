import React from 'react';

/** 局部错误隔离边界组件的入参属性 */
interface DeckErrorBoundaryProps {
  scopeName: string;
  children: React.ReactNode;
  fallback?: React.ReactNode;
  onErrorCaptured?: (scopeName: string, message: string) => void;
}

interface DeckErrorBoundaryState {
  hasError: boolean;
}

/** 局部错误隔离边界：捕获子组件渲染异常并展示安全占位内容，避免整页白屏 */
export class DeckErrorBoundary extends React.Component<
  DeckErrorBoundaryProps,
  DeckErrorBoundaryState
> {
  constructor(props: DeckErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false };
  }

  /** 将渲染异常转换为降级状态标记 */
  static getDerivedStateFromError(): DeckErrorBoundaryState {
    return { hasError: true };
  }

  /** 将捕获到的错误信息静默上报给外层健康统计 */
  override componentDidCatch(error: Error): void {
    this.props.onErrorCaptured?.(
      this.props.scopeName,
      error?.message || 'Unknown render error',
    );
  }

  /** 正常时直接透传子节点，异常时展示降级占位 */
  override render(): React.ReactNode {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }
      return (
        <div
          className="safe-boundary-fallback"
          data-testid={`boundary-fallback-${this.props.scopeName}`}
        >
          <span className="safe-boundary-badge">安全容错占位 · {this.props.scopeName}</span>
          <p className="safe-boundary-text">
            当前局部内容已由防错边界自动隔离，确保整页画面完整显示。
          </p>
        </div>
      );
    }

    return this.props.children;
  }
}
