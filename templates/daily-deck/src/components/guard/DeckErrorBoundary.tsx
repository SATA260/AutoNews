import React from 'react';

interface DeckErrorBoundaryProps {
  scopeName: string;
  children: React.ReactNode;
  fallback?: React.ReactNode;
  onErrorCaptured?: (scopeName: string, message: string) => void;
}

interface DeckErrorBoundaryState {
  hasError: boolean;
}

export class DeckErrorBoundary extends React.Component<
  DeckErrorBoundaryProps,
  DeckErrorBoundaryState
> {
  constructor(props: DeckErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(): DeckErrorBoundaryState {
    return { hasError: true };
  }

  override componentDidCatch(error: Error): void {
    this.props.onErrorCaptured?.(
      this.props.scopeName,
      error?.message || 'Unknown render error',
    );
  }

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
