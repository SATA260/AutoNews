import React, { useEffect, useId, useState } from 'react';
import { mediaReadyTracker } from '../../utils/mediaReadyTracker';

interface SafeMediaProps {
  src: string | null | undefined;
  alt: string;
  fallback: React.ReactNode;
  onFallback?: () => void;
  className?: string;
  style?: React.CSSProperties;
}

const VIDEO_EXTENSION_RE = /\.(webm|mp4|mov)(\?.*)?$/i;

export const SafeMedia: React.FC<SafeMediaProps> = ({
  src,
  alt,
  fallback,
  onFallback,
  className = '',
  style,
}) => {
  const tokenId = useId();
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setFailed(false);
    if (!src) {
      return;
    }

    const token = `${tokenId}:${src}`;
    mediaReadyTracker.markPending(token);
    return () => {
      mediaReadyTracker.markSettled(token);
    };
  }, [src, tokenId]);

  if (!src || failed) {
    return <>{fallback}</>;
  }

  const token = `${tokenId}:${src}`;
  const handleLoaded = () => {
    mediaReadyTracker.markSettled(token);
  };
  const handleError = () => {
    mediaReadyTracker.markSettled(token);
    setFailed(true);
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
      decoding="async"
      onLoad={handleLoaded}
      onError={handleError}
    />
  );
};
