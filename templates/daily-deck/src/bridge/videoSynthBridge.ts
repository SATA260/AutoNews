import type { MascotMood, ValidationWarning } from '../schema/newsSchema';

/** 页面在整期新闻中的角色类型 */
export type DeckPageType = 'cover' | 'news' | 'outro';

/** 翻页过渡动画样式：平滑渐变（默认）、纸张滑移、轻柔翻页、无动效 */
export type DeckTransitionStyle = 'glide' | 'flip' | 'fade' | 'none';

/** 时间轴驱动模式：浏览器实时播放模式或无头渲染手动步进模式 */
export type DeckClockMode = 'realtime' | 'manual';

/** 外部脚本或控制台查询的当前播放状态 */
export interface DeckBridgeState {
  currentPage: number;
  totalPages: number;
  pageType: DeckPageType;
  suggestedDurationSec: number;
  isAutoPlaying: boolean;
  cleanMode: boolean;
  theme: 'light' | 'dark';
  transition: DeckTransitionStyle;
  clockMode: DeckClockMode;
  globalTimeMs: number;
  totalDurationMs: number;
  sectionProgress: number;
  mouthOpen: number;
  live2dReady: boolean;
}

/** 注入新闻数据后返回的安全校验结果 */
export interface SetNewsDataResult {
  ok: boolean;
  warningCount: number;
  warnings: ValidationWarning[];
  totalPages: number;
}

/** 模板当前运行健康检查与数据修正明细报告 */
export interface DeckHealthReport {
  ok: boolean;
  isDataClean: boolean;
  warningCount: number;
  warnings: ValidationWarning[];
  runtimeErrors: string[];
}

/** 将虚拟时钟定位到指定毫秒后返回的同步帧状态快照 */
export interface SeekToResult {
  currentPage: number;
  exitingPage: number | null;
  transitionProgress: number;
  sectionProgress: number;
  mouthOpen: number;
  live2dReady: boolean;
}

/** 挂载在浏览器窗口上的自动化视频合成控制接口 */
export interface NewsDeckBridgeAPI {
  getState: () => DeckBridgeState;
  getPageCount: () => number;
  getCurrentPage: () => number;
  goToPage: (index: number) => Promise<number>;
  nextPage: () => Promise<boolean>;
  prevPage: () => Promise<boolean>;
  setNewsData: (raw: unknown) => SetNewsDataResult;
  getHealthReport: () => DeckHealthReport;
  waitUntilReady: (timeoutMs?: number) => Promise<{ ok: boolean; live2dReady: boolean }>;
  warmupPhysics: (
    atTimeMs: number,
    steps?: number,
    mood?: MascotMood,
    stepMs?: number,
  ) => Promise<void>;
  seekTo: (globalTimeMs: number, dtMs?: number) => Promise<SeekToResult>;
}

declare global {
  interface Window {
    __NEWS_DECK__?: NewsDeckBridgeAPI;
  }
}

/** 将外部传入的页码索引安全限制在有效页面范围内 */
export function clampPageIndex(index: number, totalPages: number): number {
  const safeTotal = Math.max(1, Math.floor(totalPages));
  if (!Number.isFinite(index)) {
    return 0;
  }
  const rounded = Math.trunc(index);
  return Math.min(safeTotal - 1, Math.max(0, rounded));
}

/** 解析网址参数或配置中的翻页动效名称，未知值或未填写时默认使用平滑渐变 */
export function parseTransitionStyle(raw: string | null | undefined): DeckTransitionStyle {
  const normalized = (raw ?? '').trim().toLowerCase();
  if (normalized === 'none') {
    return 'none';
  }
  if (normalized === 'flip') {
    return 'flip';
  }
  if (normalized === 'glide' || normalized === 'slide') {
    return 'glide';
  }
  return 'fade';
}
