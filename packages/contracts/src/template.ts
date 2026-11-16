import { z } from 'zod';
import type { IssuePackage, PolishedItem } from './editorial.js';
import type { Timeline } from './media.js';

export const ContentLimitsSchema = z.object({
  headline: z.number().int().positive(),
  leadSummary: z.number().int().positive(),
  title: z.number().int().positive(),
  shortTitle: z.number().int().positive(),
  category: z.number().int().positive(),
  summary: z.number().int().positive(),
  keyPointsMax: z.number().int().positive(),
  keyPoint: z.number().int().positive(),
  detail: z.number().int().positive(),
  hostComment: z.number().int().positive(),
  narrationSentence: z.number().int().positive(),
});
export type ContentLimits = z.infer<typeof ContentLimitsSchema>;

export type ImpactLevel = 'breaking' | 'high' | 'normal';

export interface RenderableNewsItem extends PolishedItem {
  id: string;
  position: number;
  source: string;
  sourceUrl: string;
  publishedAt: string;
  imagePath?: string;
  impact: ImpactLevel;
}

export interface RenderableIssue {
  date: string;
  issueNumber: string;
  headline: string;
  leadSummary: string;
  intro: IssuePackage['intro'];
  outro: IssuePackage['outro'];
  items: RenderableNewsItem[];
}

export interface PagePlan {
  index: number;
  sectionKey: string;
  durationMs: number;
}

/**
 * Minimal structural interface matching Playwright's Page without introducing
 * a runtime dependency on playwright inside @aidaily/contracts.
 */
export interface BrowserPageLike {
  setViewportSize(viewportSize: { width: number; height: number }): Promise<void>;
  goto(
    url: string,
    options?: { waitUntil?: 'load' | 'domcontentloaded' | 'networkidle'; timeout?: number },
  ): Promise<unknown>;
  evaluate<R, Arg = unknown>(pageFunction: (arg: Arg) => R | Promise<R>, arg: Arg): Promise<R>;
  waitForTimeout(timeout: number): Promise<void>;
  screenshot(options?: {
    path?: string;
    type?: 'png' | 'jpeg';
    fullPage?: boolean;
  }): Promise<Buffer>;
}

export interface TemplateAdapter {
  id: string;
  contentLimits?: Partial<ContentLimits>;
  buildData(issue: RenderableIssue, timeline: Timeline): unknown;
  planPages(issue: RenderableIssue, timeline: Timeline): PagePlan[];
  prepare(opts: {
    dir: string;
    runDir: string;
  }): Promise<{ baseUrl: string; close(): Promise<void> }>;
  capture(
    page: BrowserPageLike,
    data: unknown,
    plan: PagePlan[],
    outDir: string,
  ): Promise<string[]>;
}
