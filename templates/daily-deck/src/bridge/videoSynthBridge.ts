import type { ValidationWarning } from '../schema/newsSchema';

export type DeckPageType = 'cover' | 'news' | 'outro';

export interface DeckBridgeState {
  currentPage: number;
  totalPages: number;
  pageType: DeckPageType;
  suggestedDurationSec: number;
  isAutoPlaying: boolean;
  cleanMode: boolean;
  theme: 'light' | 'dark';
}

export interface SetNewsDataResult {
  ok: boolean;
  warningCount: number;
  warnings: ValidationWarning[];
  totalPages: number;
}

export interface DeckHealthReport {
  ok: boolean;
  isDataClean: boolean;
  warningCount: number;
  warnings: ValidationWarning[];
  runtimeErrors: string[];
}

export interface NewsDeckBridgeAPI {
  getState: () => DeckBridgeState;
  getPageCount: () => number;
  getCurrentPage: () => number;
  goToPage: (index: number) => Promise<number>;
  nextPage: () => Promise<boolean>;
  prevPage: () => Promise<boolean>;
  setNewsData: (raw: unknown) => SetNewsDataResult;
  getHealthReport: () => DeckHealthReport;
}

declare global {
  interface Window {
    __NEWS_DECK__?: NewsDeckBridgeAPI;
  }
}

export function clampPageIndex(index: number, totalPages: number): number {
  const safeTotal = Math.max(1, Math.floor(totalPages));
  if (!Number.isFinite(index)) {
    return 0;
  }
  const rounded = Math.trunc(index);
  return Math.min(safeTotal - 1, Math.max(0, rounded));
}
