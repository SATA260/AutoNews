import React, { useEffect, useRef, useState } from 'react';

/** 画布逻辑基准宽度（像素） */
export const STAGE_WIDTH = 1920;
/** 画布逻辑基准高度（像素） */
export const STAGE_HEIGHT = 1080;

/** 固定比例缩放容器的入参属性 */
interface ViewportScalerProps {
  children: React.ReactNode;
  theme?: 'light' | 'dark';
  motion?: 'animated' | 'static';
}

/** 固定比例缩放容器：将内部 1920×1080 版面按浏览器视口等比缩放并居中显示 */
export const ViewportScaler: React.FC<ViewportScalerProps> = ({
  children,
  theme = 'light',
  motion = 'animated',
}) => {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [scale, setScale] = useState<number>(1);

  useEffect(() => {
    const computeScale = () => {
      const host = hostRef.current;
      const vw = host?.clientWidth || window.innerWidth || STAGE_WIDTH;
      const vh = host?.clientHeight || window.innerHeight || STAGE_HEIGHT;
      if (vw <= 0 || vh <= 0) {
        setScale(1);
        return;
      }
      const next = Math.min(vw / STAGE_WIDTH, vh / STAGE_HEIGHT);
      setScale(Number.isFinite(next) && next > 0 ? next : 1);
    };

    computeScale();

    let observer: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined' && hostRef.current) {
      observer = new ResizeObserver(computeScale);
      observer.observe(hostRef.current);
    }
    window.addEventListener('resize', computeScale);

    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', computeScale);
    };
  }, []);

  return (
    <div ref={hostRef} className="viewport-host">
      <div
        className="viewport-stage-wrapper"
        style={{
          width: STAGE_WIDTH * scale,
          height: STAGE_HEIGHT * scale,
        }}
      >
        <div
          className="deck-stage"
          data-theme={theme}
          data-motion={motion}
          style={{
            width: STAGE_WIDTH,
            height: STAGE_HEIGHT,
            transform: `scale(${scale})`,
            transformOrigin: 'top left',
          }}
        >
          {children}
        </div>
      </div>
    </div>
  );
};
