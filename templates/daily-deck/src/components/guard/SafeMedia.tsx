import type React from 'react';
import { useEffect, useId, useState } from 'react';
import { mediaReadyTracker } from '../../utils/mediaReadyTracker';

/** 媒体安全加载组件的入参属性 */
interface SafeMediaProps {
  src: string | null | undefined;
  alt: string;
  fallback: React.ReactNode;
  onFallback?: () => void;
  className?: string;
  style?: React.CSSProperties;
}

const VIDEO_EXTENSION_RE = /\.(webm|mp4|mov)(\?.*)?$/i;

/** 安全媒体加载器：统一处理图片与循环视频的加载状态，失败时无感切换为降级内容 */
export const SafeMedia: React.FC<SafeMediaProps> = ({
  src,
  alt,
  fallback,
  onFallback,
  className = '',
  style,
}) => {
  const tokenId = useId();
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const hasFailed = Boolean(src) && failedSrc === src;

  useEffect(() => {
    if (!src) {
      return;
    }

    const token = `${tokenId}:${src}`;
    mediaReadyTracker.markPending(token);
    return () => {
      mediaReadyTracker.markSettled(token);
    };
  }, [src, tokenId]);

  if (!src || hasFailed) {
    return <>{fallback}</>;
  }

  const token = `${tokenId}:${src}`;
  const handleLoaded = () => {
    mediaReadyTracker.markSettled(token);
  };
  const handleError = () => {
    mediaReadyTracker.markSettled(token);
    setFailedSrc(src);
    onFallback?.();
  };

  if (VIDEO_EXTENSION_RE.test(src)) {
    return (
      <video
        src={src}
        autoPlay
        loop
        muted
        playsInline
        className={className}
        style={style}
        aria-label={alt}
        onLoadedData={handleLoaded}
        onError={handleError}
      />
    );
  }

  return (
    <img
      src={src}
      alt={alt}
      className={className}
      style={style}
      loading="eager"
      decoding="sync"
      onLoad={handleLoaded}
      onError={handleError}
    />
  );
};
