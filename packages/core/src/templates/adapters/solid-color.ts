import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  BrowserPageLike,
  PagePlan,
  RenderableIssue,
  TemplateAdapter,
  Timeline,
} from '@aidaily/contracts';
import { startTemplateHttpServer } from '../server.js';

interface SolidPagePayload {
  kind: 'cover' | 'item' | 'outro';
  badge: string;
  title: string;
  subtitle: string;
  summary: string;
  meta: string;
}

interface SolidDeckPayload {
  issueNumber: string;
  date: string;
  pages: SolidPagePayload[];
}

const SOLID_COLOR_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <title>AI 每日报 - 标准纯色排版模板</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    html, body {
      width: 100vw;
      height: 100vh;
      overflow: hidden;
      background: linear-gradient(135deg, #1e293b 0%, #0f172a 100%);
      color: #f8fafc;
      font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Helvetica Neue", sans-serif;
    }
    .canvas {
      width: 100vw;
      height: 100vh;
      padding: 64px 88px;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      border: 8px solid #334155;
    }
    .topbar {
      display: flex;
      justify-content: space-between;
      align-items: center;
      border-bottom: 3px solid #38bdf8;
      padding-bottom: 24px;
    }
    .brand {
      font-size: 36px;
      font-weight: 800;
      letter-spacing: 2px;
      color: #38bdf8;
    }
    .badge {
      font-size: 28px;
      font-weight: 700;
      padding: 10px 24px;
      border-radius: 999px;
      background: #1d4ed8;
      color: #eff6ff;
    }
    .card {
      background: rgba(30, 41, 59, 0.9);
      border: 2px solid #475569;
      border-radius: 24px;
      padding: 56px 64px;
      display: flex;
      flex-direction: column;
      gap: 28px;
      box-shadow: 0 24px 60px rgba(0, 0, 0, 0.35);
    }
    .subtitle {
      font-size: 28px;
      color: #7dd3fc;
      font-weight: 600;
    }
    .title {
      font-size: 56px;
      line-height: 1.25;
      font-weight: 800;
      color: #ffffff;
    }
    .summary {
      font-size: 34px;
      line-height: 1.55;
      color: #cbd5e1;
    }
    .footer {
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-size: 26px;
      color: #94a3b8;
      border-top: 2px solid #334155;
      padding-top: 22px;
    }
  </style>
</head>
<body>
  <div class="canvas">
    <div class="topbar">
      <div class="brand" id="brand">AI 每日报</div>
      <div class="badge" id="badge">封面</div>
    </div>
    <div class="card">
      <div class="subtitle" id="subtitle"></div>
      <div class="title" id="title"></div>
      <div class="summary" id="summary"></div>
    </div>
    <div class="footer">
      <div id="issueMeta"></div>
      <div id="pageMeta"></div>
    </div>
  </div>
  <script>
    (function () {
      let currentData = null;
      let currentPage = 0;
      function renderPage(index) {
        if (!currentData || !Array.isArray(currentData.pages) || currentData.pages.length === 0) return 0;
        const max = currentData.pages.length - 1;
        currentPage = Math.max(0, Math.min(max, Math.floor(Number(index) || 0)));
        const page = currentData.pages[currentPage];
        document.getElementById('brand').textContent = 'AI 每日报 · ' + (currentData.issueNumber || '');
        document.getElementById('badge').textContent = page.badge || '';
        document.getElementById('subtitle').textContent = page.subtitle || '';
        document.getElementById('title').textContent = page.title || '';
        document.getElementById('summary').textContent = page.summary || '';
        document.getElementById('issueMeta').textContent = page.meta || '';
        document.getElementById('pageMeta').textContent = '第 ' + (currentPage + 1) + ' / ' + currentData.pages.length + ' 页';
        return currentPage;
      }
      window.__SOLID_DECK__ = {
        setData(data) {
          currentData = data;
          return renderPage(0);
        },
        goToPage(index) {
          return renderPage(index);
        },
        getPage() {
          return currentPage;
        }
      };
    })();
  </script>
</body>
</html>`;

/** 创建内置纯色简洁排版模板适配器，无需外部构建即可完成高对比度画面渲染与测试 */
export function createSolidColorAdapter(): TemplateAdapter {
  return {
    id: 'solid-color',

    /** 把整期新闻结构转为纯色模板各页展示文本 */
    buildData(issue: RenderableIssue): SolidDeckPayload {
      const pages: SolidPagePayload[] = [
        {
          kind: 'cover',
          badge: `封面 · ${issue.date}`,
          subtitle: 'AI 每日报 · 今日要点速览',
          title: issue.headline,
          summary: issue.leadSummary,
          meta: `${issue.issueNumber} · 共 ${issue.items.length} 条热点资讯`,
        },
      ];

      issue.items.forEach((item, idx) => {
        const idxText = String(idx + 1).padStart(2, '0');
        pages.push({
          kind: 'item',
          badge: `${idxText} · ${item.category}`,
          subtitle: `${item.entity} · 来源：${item.source}`,
          title: item.title,
          summary: item.summary,
          meta: item.keyPoints.join(' ｜ '),
        });
      });

      pages.push({
        kind: 'outro',
        badge: '尾页 · 下期再见',
        subtitle: issue.outro.hostComment,
        title: issue.outro.cta,
        summary: issue.items.map((it, idx) => `${idx + 1}. ${it.shortTitle}`).join('  ·  '),
        meta: `${issue.issueNumber} · 感谢观看`,
      });

      return {
        issueNumber: issue.issueNumber,
        date: issue.date,
        pages,
      };
    },

    /** 根据音频时间轴依次生成每一页画面的页码索引与停留时长 */
    planPages(_issue: RenderableIssue, timeline: Timeline): PagePlan[] {
      return timeline.sections.map((section, index) => ({
        index,
        sectionKey: section.key,
        durationMs: section.pageMs,
      }));
    },

    /** 启动仅返回内联纯色模板页面的本地 HTTP 服务 */
    async prepare(opts) {
      return startTemplateHttpServer({
        htmlContent: SOLID_COLOR_HTML,
        runDir: opts.runDir,
      });
    },

    /** 注入模板数据并依次跳转所需页面截取 PNG 画面 */
    async capture(
      page: BrowserPageLike,
      data: unknown,
      plan: PagePlan[],
      outDir: string,
    ): Promise<string[]> {
      await fs.mkdir(outDir, { recursive: true });
      await page.evaluate((payload) => {
        const win = window as unknown as {
          __SOLID_DECK__?: { setData: (raw: unknown) => number };
        };
        if (!win.__SOLID_DECK__) {
          throw new Error('纯色模板桥接接口尚未就绪');
        }
        win.__SOLID_DECK__.setData(payload);
      }, data);

      const capturedFiles: string[] = [];
      for (const item of plan) {
        const landed = await page.evaluate(async (pageIdx) => {
          const win = window as unknown as {
            __SOLID_DECK__?: { goToPage: (idx: number) => number };
          };
          if (!win.__SOLID_DECK__) {
            throw new Error('纯色模板翻页时控制接口丢失');
          }
          const idx = win.__SOLID_DECK__.goToPage(pageIdx);
          await new Promise<void>((resolve) => {
            requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
          });
          return idx;
        }, item.index);

        if (landed !== item.index) {
          throw new Error(`纯色模板翻页偏移：期望页 ${item.index}，实际停留 ${landed}`);
        }

        const outFile = path.join(outDir, `page-${String(item.index).padStart(2, '0')}.png`);
        const tmpFile = path.join(
          outDir,
          `.page-${String(item.index).padStart(2, '0')}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp.png`,
        );
        try {
          await page.screenshot({ path: tmpFile, type: 'png', fullPage: false });
          await fs.rename(tmpFile, outFile);
        } catch (err) {
          await fs.rm(tmpFile, { force: true }).catch(() => undefined);
          throw err;
        }
        capturedFiles.push(outFile);
      }
      return capturedFiles;
    },
  };
}
