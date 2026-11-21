import { z } from 'zod';
import type { IssuePackage, MascotMood, PolishedItem } from './editorial.js';
import type { Timeline } from './media.js';
import type { HostMascotId } from './persona.js';

/** 视频模板各个画面文本区域的字数限制配置 */
export const ContentLimitsSchema = z.object({
  headline: z.number().int().positive(),
  leadSummary: z.number().int().positive(),
  title: z.number().int().positive(),
  shortTitle: z.number().int().positive(),
  progressLabel: z.number().int().positive().default(10),
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

/** 传递给前端视频模板的单条新闻跨阵营嘉宾插嘴数据 */
export interface RenderableGuestReaction {
  hostId: HostMascotId;
  hostName?: string;
  line: string;
  mood?: MascotMood;
  startSec: number;
  endSec: number;
  audioUrl?: string;
}

/** 传递给前端视频模板的单条新闻渲染数据 */
export interface RenderableNewsItem extends PolishedItem {
  id: string;
  position: number;
  source: string;
  sourceUrl: string;
  publishedAt: string;
  imagePath?: string;
  secondaryImagePath?: string;
  /** 匹配到的公司或机构 Logo 本地服务地址，未命中时为空 */
  companyLogoUrl?: string;
  impact: ImpactLevel;
  mascotMood?: MascotMood;
  /** 可选的跨阵营嘉宾插嘴气泡与时间窗 */
  guestReaction?: RenderableGuestReaction;
}

/** 传递给前端视频模板的整期结构化渲染数据 */
export interface RenderableIssue {
  hostId?: HostMascotId;
  hostDisplayName?: string;
  hostMascotPath?: string;
  hostLive2dModelUrl?: string;
  bgmAudioUrl?: string;
  bgmVolumeDb?: number;
  pagePaddingSec?: number;
  fps?: number;
  lipSyncBySectionKey?: Record<string, number[]>;
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

/** 单个动态视频章节的逐帧渲染计划与输出路径 */
export interface SectionRenderPlan {
  index: number;
  sectionKey: string;
  startFrame: number;
  frameCount: number;
  startMs: number;
  durationMs: number;
  /** 画面出现后延迟多少毫秒再开始播报口播 */
  speechOffsetMs?: number;
  speechMs: number;
  mood?: MascotMood;
  outMp4Path: string;
  outPngPath: string;
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
  /** 在网页上下文中执行脚本（例如注入日报 JSON 数据和推进虚拟时间） */
  evaluate<R, Arg = unknown>(pageFunction: (arg: Arg) => R | Promise<R>, arg: Arg): Promise<R>;
  /** 等待指定毫秒数 */
  waitForTimeout(timeout: number): Promise<void>;
  /** 将当前画面截取为图像文件或内存字节流 */
  screenshot(options?: {
    path?: string;
    type?: 'png' | 'jpeg';
    quality?: number;
    fullPage?: boolean;
  }): Promise<Buffer>;
}

/** 动态模板按虚拟时间逐帧渲染章节视频时的执行参数 */
export interface RenderSectionsOptions {
  page: BrowserPageLike;
  data: unknown;
  sections: SectionRenderPlan[];
  width: number;
  height: number;
  fps: number;
  ffmpegBin?: string;
  signal?: AbortSignal;
}

/** 前端视频模板适配器接口，用于把通用日报数据转为静态画面截图或动态章节视频 */
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
    rootDir?: string;
    signal?: AbortSignal;
  }): Promise<{ baseUrl: string; close(): Promise<void> }>;
  /** 打开浏览器逐页加载数据并截取全部 PNG 画面文件 */
  capture(
    page: BrowserPageLike,
    data: unknown,
    plan: PagePlan[],
    outDir: string,
  ): Promise<string[]>;
  /** 计算模板构建产物与角色模型文件的指纹摘要，用于判断分片缓存是否有效 */
  getAssetFingerprint?(opts: {
    templateDir: string;
    rootDir: string;
    issue: RenderableIssue;
    signal?: AbortSignal;
  }): Promise<string>;
  /** 按虚拟时钟逐帧步进渲染指定的动态章节视频分片与代表帧截图 */
  renderSections?(opts: RenderSectionsOptions): Promise<void>;
}

/** 传给视频封面模板（`window.__COVER__.setData`）的数据 */
export interface CoverTemplateData {
  /** 主标题，可用 *星号* 包住要高亮的词 */
  title: string;
  /** 副标题，可为空字符串 */
  subtitle: string;
  /** 刊名，如“AI 每日报” */
  masthead: string;
  /** 展示用日期，如“11月18日 周三” */
  date: string;
  /** 期号，如“VOL.2026.11.18” */
  issueNumber: string;
  /** 当期主播标识，决定主题色和立绘摆放 */
  hostId: HostMascotId;
  /** 当期主播显示名 */
  hostName: string;
  /** 主播立绘图片地址；没有立绘时为空字符串 */
  mascotUrl: string;
  /** 头条关联公司/产品 Logo 图片地址；未命中时为空 */
  brandLogoUrl?: string;
  /** 头条关联公司/产品名称；未命中时为空 */
  brandName?: string;
  /** 刊次徽章（如“早报”“晚报”“重磅专场”） */
  editionBadge?: string;
  /** 封面视觉主题：常规盘点（digest）或单点重磅专场（spotlight） */
  themeVariant?: 'digest' | 'spotlight';
}
