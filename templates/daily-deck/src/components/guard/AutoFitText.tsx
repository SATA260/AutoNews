import React, { useLayoutEffect, useRef, useState } from 'react';

interface AutoFitTextProps {
  text: string;
  maxFontSize: number;
  minFontSize: number;
  maxLines: number;
  lineHeight?: number;
  as?: 'h1' | 'h2' | 'h3' | 'p' | 'div';
  className?: string;
  style?: React.CSSProperties;
}

/**
 * Automatically shrinks font size within [minFontSize, maxFontSize] so copy
 * fits cleanly inside its container, then clamps at maxLines to prevent overflow.
 */
export const AutoFitText: React.FC<AutoFitTextProps> = ({
  text,
  maxFontSize,
  minFontSize,
  maxLines,
  lineHeight = 1.35,
  as = 'div',
  className = '',
  style,
}) => {
  const ref = useRef<HTMLElement | null>(null);
  const [fontSize, setFontSize] = useState<number>(maxFontSize);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) {
      setFontSize(maxFontSize);
      return;
    }

    let current = maxFontSize;
    el.style.fontSize = `${current}px`;

    if (el.clientHeight > 0 && el.scrollHeight > 0) {
      while (current > minFontSize && el.scrollHeight > el.clientHeight + 2) {
        current -= 1;
        el.style.fontSize = `${current}px`;
      }
    }

    setFontSize(current);
  }, [text, maxFontSize, minFontSize, maxLines, lineHeight]);

  const Component = as as React.ElementType;

  return (
    <Component
      ref={ref}
      className={className}
      style={{
        ...style,
        fontSize: `${fontSize}px`,
        lineHeight,
        display: '-webkit-box',
        WebkitBoxOrient: 'vertical',
        WebkitLineClamp: maxLines,
        overflow: 'hidden',
        overflowWrap: 'anywhere',
        wordBreak: 'break-word',
      }}
    >
      {text}
    </Component>
  );
};
