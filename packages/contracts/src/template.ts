import { z } from 'zod';
import type { IssuePackage, PolishedItem } from './editorial.js';
import type { Timeline } from './media.js';

/** 视频模板各个画面文本区域的字数限制配置 */
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
/** 画面文本字数限制类型 */
export type ContentLimits = z.infer<typeof ContentLimitsSchema>;

/** 新闻重要程度标签，供前端模板展示不同视觉徽章 */
export type ImpactLevel = 'breaking' | 'high' | 'normal';

/** 传递给前端视频模板的单条新闻渲染数据 */
export interface RenderableNewsItem extends PolishedItem {
  id: string;
  position: number;
  source: string;
  sourceUrl: string;
  publishedAt: string;
  imagePath?: string;
  impact: ImpactLevel;
}

/** 传递给前端视频模板的整期结构化渲染数据 */
export interface RenderableIssue {
  date: string;
  issueNumber: string;
  headline: string;
  leadSummary: string;
  intro: IssuePackage['intro'];
  outro: IssuePackage['outro'];
  items: RenderableNewsItem[];
}

/** 单个视频画面的页码索引与停留时长计划 */
export interface PagePlan {
  index: number;
  sectionKey: string;
  durationMs: number;
}

/**
 * 浏览器页面操作最小接口（与 Playwright 的 Page 结构一致），
 * 使共享类型包不直接绑定浏览器引擎实现。
 */
export interface BrowserPageLike {
  /** 设置浏览器可视窗口分辨率 */
  setViewportSize(viewportSize: { width: number; height: number }): Promise<void>;
  /** 打开指定页面链接并等待加载完成 */
  goto(
    url: string,
    options?: { waitUntil?: 'load' | 'domcontentloaded' | 'networkidle'; timeout?: number },
  ): Promise<unknown>;
  /** 在网页上下文中执行脚本（例如注入日报 JSON 数据和翻页） */
  evaluate<R, Arg = unknown>(pageFunction: (arg: Arg) => R | Promise<R>, arg: Arg): Promise<R>;
  /** 等待指定毫秒数 */
  waitForTimeout(timeout: number): Promise<void>;
  /** 将当前画面截取为图像文件 */
  screenshot(options?: {
    path?: string;
    type?: 'png' | 'jpeg';
    fullPage?: boolean;
  }): Promise<Buffer>;
}

/** 前端视频模板适配器接口，用于把通用日报数据转为具体模板画面截图 */
export interface TemplateAdapter {
  id: string;
  contentLimits?: Partial<ContentLimits>;
  /** 将整期新闻数据转换为当前模板能识别的 JSON 数据 */
  buildData(issue: RenderableIssue, timeline: Timeline): unknown;
  /** 根据整期数据与音频时间轴计算出每一页画面的停留毫秒数 */
  planPages(issue: RenderableIssue, timeline: Timeline): PagePlan[];
  /** 构建模板代码并启动本地静态预览服务，返回访问地址与关闭函数 */
  prepare(opts: {
    dir: string;
    runDir: string;
  }): Promise<{ baseUrl: string; close(): Promise<void> }>;
  /** 打开浏览器逐页加载数据并截取全部 PNG 画面文件 */
  capture(
    page: BrowserPageLike,
    data: unknown,
    plan: PagePlan[],
    outDir: string,
  ): Promise<string[]>;
}
