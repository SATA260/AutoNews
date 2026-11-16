import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  BrowserPageLike,
  ContentLimits,
  PagePlan,
  RenderableIssue,
  TemplateAdapter,
  Timeline,
} from '@aidaily/contracts';
import { execa } from 'execa';
import { startTemplateHttpServer } from '../server.js';

/** 视觉展示模板支持的右下角内置角色形象标识 */
export type DailyDeckMascotId = 'deepseek' | 'gpt' | 'claude' | 'gemini' | 'grok' | 'none';

/** 该展示模板推荐的内容字数限制上限（用于在采编阶段提前控制篇幅避免画面截断） */
export const DAILY_DECK_CONTENT_LIMITS: Partial<ContentLimits> = {
  headline: 48,
  title: 48,
  shortTitle: 30,
  category: 10,
  summary: 100,
  keyPointsMax: 3,
  keyPoint: 32,
};

/** 根据新闻主体公司或产品名称匹配对应角色标识 */
export function mapEntityToMascotId(entity: string): DailyDeckMascotId {
  const lower = entity.toLowerCase();
  if (lower.includes('deepseek') || lower.includes('深度求索')) {
    return 'deepseek';
  }
  if (
    lower.includes('openai') ||
    lower.includes('gpt') ||
    lower.includes('chatgpt') ||
    lower.includes('sora')
  ) {
    return 'gpt';
  }
  if (lower.includes('anthropic') || lower.includes('claude')) {
    return 'claude';
  }
  if (lower.includes('google') || lower.includes('deepmind') || lower.includes('gemini')) {
    return 'gemini';
  }
  if (lower.includes('xai') || lower.includes('grok')) {
    return 'grok';
  }
  return 'none';
}

/** 从完整文章链接提取简洁的主机域名展示 */
function extractDisplayHost(rawUrl: string): string {
  try {
    return new URL(rawUrl).hostname.replace(/^www\./i, '');
  } catch {
    return rawUrl;
  }
}

/** 将标准时间字符串转换为简短日期格式（YYYY.MM.DD） */
function formatShortDate(rawDate: string): string {
  const parsed = Date.parse(rawDate);
  if (!Number.isNaN(parsed)) {
    return new Date(parsed).toISOString().slice(0, 10).replace(/-/g, '.');
  }
  return rawDate.replace(/-/g, '.').slice(0, 16);
}

/** 确保独立前端模板已经完成生产构建，若尚未构建则自动执行依赖安装与打包 */
async function ensureDailyDeckBuilt(templateDir: string): Promise<string> {
  const distDir = path.join(templateDir, 'dist');
  const distIndex = path.join(distDir, 'index.html');
  try {
    await fs.access(distIndex);
    return distDir;
  } catch {
    // 产物尚未构建时按需在模板目录下执行构建
  }

  const nodeModulesDir = path.join(templateDir, 'node_modules');
  let hasNodeModules = false;
  try {
    await fs.access(nodeModulesDir);
    hasNodeModules = true;
  } catch {
    hasNodeModules = false;
  }

  if (!hasNodeModules) {
    await execa('npm', ['install'], {
      cwd: templateDir,
      timeout: 300_000,
    });
  }

  await execa('npm', ['run', 'build'], {
    cwd: templateDir,
    timeout: 300_000,
  });

  await fs.access(distIndex);
  return distDir;
}

/** 创建独立新闻画报前端模板的适配实现 */
export function createDailyDeckAdapter(): TemplateAdapter {
  return {
    id: 'daily-deck',
    contentLimits: DAILY_DECK_CONTENT_LIMITS,

    /** 把核心引擎组装好的整期新闻对象转换为前端模板可识别的输入数据结构 */
    buildData(issue: RenderableIssue, timeline: Timeline): Record<string, unknown> {
      const introSec = timeline.sections.find((s) => s.kind === 'intro');
      const outroSec = timeline.sections.find((s) => s.kind === 'outro');
      const itemSecById = new Map(
        timeline.sections.filter((s) => s.itemId).map((s) => [s.itemId as string, s]),
      );

      const coverDurationSec = Math.max(
        1,
        Number((((introSec?.pageMs ?? 5000) as number) / 1000).toFixed(1)),
      );
      const outroDurationSec = Math.max(
        1,
        Number((((outroSec?.pageMs ?? 6000) as number) / 1000).toFixed(1)),
      );

      return {
        issueTitle: 'AI 每日报',
        issueNumber: issue.issueNumber,
        date: issue.date.replace(/-/g, '.'),
        headline: issue.headline,
        footerCta: issue.outro.cta,
        hostMascotId: 'gemini',
        mascotMode: 'per-item',
        coverDurationSec,
        outroDurationSec,
        items: issue.items.map((item) => {
          const sec = itemSecById.get(item.id);
          const durationSec = Math.max(1, Number(((sec?.pageMs ?? 8000) / 1000).toFixed(1)));
          const assetPath = item.imagePath
            ? `/__run_assets__/${item.imagePath.replace(/^\/+/, '')}`
            : null;
          return {
            id: item.id,
            category: item.category,
            shortTitle: item.shortTitle,
            title: item.title,
            summary: item.summary,
            keyPoints: item.keyPoints.slice(0, 3),
            imageUrl: assetPath,
            secondaryImageUrl: null,
            imageCaption: assetPath ? `${item.source} 配图` : null,
            officialQuote: item.officialQuote ?? item.evidence[0]?.quote ?? item.detail,
            metrics: item.metrics ?? [],
            source: item.source,
            sourceUrl: extractDisplayHost(item.sourceUrl),
            publishedAt: formatShortDate(item.publishedAt),
            mascotId: mapEntityToMascotId(item.entity),
            durationSec,
          };
        }),
      };
    },

    /** 按时间轴段落顺序输出每一页（封面、各新闻页、尾页）的编号与停留毫秒数 */
    planPages(_issue: RenderableIssue, timeline: Timeline): PagePlan[] {
      return timeline.sections.map((section, index) => ({
        index,
        sectionKey: section.key,
        durationMs: section.pageMs,
      }));
    },

    /** 确认前端模板已打包完成，并启动指向其静态产物与当期素材目录的本地服务 */
    async prepare(opts) {
      const distDir = await ensureDailyDeckBuilt(opts.dir);
      return startTemplateHttpServer({
        distDir,
        runDir: opts.runDir,
      });
    },

    /** 在无头浏览器中等待前端控制接口就绪、注入整期数据并逐页截取 PNG 画面 */
    async capture(
      page: BrowserPageLike,
      data: unknown,
      plan: PagePlan[],
      outDir: string,
    ): Promise<string[]> {
      await fs.mkdir(outDir, { recursive: true });

      const bridgeReady = await page.evaluate(async () => {
        const deadline = Date.now() + 15_000;
        while (Date.now() < deadline) {
          const win = window as unknown as { __NEWS_DECK__?: unknown };
          if (win.__NEWS_DECK__) {
            return true;
          }
          await new Promise((r) => setTimeout(r, 50));
        }
        return false;
      }, undefined);

      if (!bridgeReady) {
        throw new Error('前端视频模板加载超时，未能检测到 window.__NEWS_DECK__ 控制接口');
      }

      const injectRes = await page.evaluate(async (payload) => {
        const win = window as unknown as {
          __NEWS_DECK__?: {
            setNewsData: (raw: unknown) => { ok: boolean; warningCount: number };
          };
        };
        if (!win.__NEWS_DECK__) {
          throw new Error('模板控制接口不可用');
        }
        const res = win.__NEWS_DECK__.setNewsData(payload);
        if (document.fonts?.ready) {
          await document.fonts.ready;
        }
        return res;
      }, data);

      if (!injectRes.ok) {
        throw new Error('向前端模板注入整期新闻数据失败');
      }

      const capturedFiles: string[] = [];
      for (const item of plan) {
        await page.evaluate(async (pageIdx) => {
          const win = window as unknown as {
            __NEWS_DECK__?: {
              goToPage: (index: number) => Promise<number>;
            };
          };
          if (!win.__NEWS_DECK__) {
            throw new Error('模板翻页前控制接口丢失');
          }
          await win.__NEWS_DECK__.goToPage(pageIdx);
          if (document.fonts?.ready) {
            await document.fonts.ready;
          }
        }, item.index);

        await page.waitForTimeout(50);

        const health = await page.evaluate(() => {
          const win = window as unknown as {
            __NEWS_DECK__?: {
              getHealthReport: () => { ok: boolean; runtimeErrors: string[] };
            };
          };
          return win.__NEWS_DECK__?.getHealthReport() ?? { ok: true, runtimeErrors: [] };
        }, undefined);

        if (!health.ok || health.runtimeErrors.length > 0) {
          throw new Error(
            `前端模板渲染第 ${item.index} 页时报告异常: ${health.runtimeErrors.join('; ')}`,
          );
        }

        const outFile = path.join(outDir, `page-${String(item.index).padStart(2, '0')}.png`);
        await page.screenshot({ path: outFile, type: 'png', fullPage: false });
        capturedFiles.push(outFile);
      }

      return capturedFiles;
    },
  };
}
