import path from 'node:path';
import type { SourceHealth, SourceTestResult } from '@aidaily/contracts';
import { fetchFeedWithRetry } from '../collector/fetcher.js';
import { fetchHtmlListWithRetry } from '../collector/html-list-fetcher.js';
import { resolveSourceTimezone } from '../collector/index.js';
import {
  fetchXSourceItems,
  importXCookieFile,
  inspectXCookieFile,
  interactiveXLogin,
  type XAuthStatus,
} from '../collector/x-collector.js';
import type { CoreContext } from '../context.js';

/** 新闻信源管理服务接口（供命令行工具与网页后台共同使用） */
export interface SourceService {
  /** 列出全部已配置的信源及其抓取健康状态 */
  list(): Promise<SourceHealth[]>;
  /** 立即对指定信源执行一次无缓存试抓并返回诊断结果与示例标题 */
  test(sourceId: string): Promise<SourceTestResult>;
  /** 查询本机 X 账号登录凭证文件的配置与可用状态 */
  getXAuthStatus(): Promise<XAuthStatus>;
  /** 校验并导入外部提供的 X Cookie JSON 文本 */
  importXCookies(rawJson: string): Promise<XAuthStatus>;
  /** 打开本地可视浏览器引导登录 X 并自动保存凭证 */
  loginXInteractive(opts?: { timeoutMs?: number }): Promise<XAuthStatus>;
}

const UNHEALTHY_FAILURE_THRESHOLD = 3;

/** 创建新闻信源管理服务实例 */
export function createSourceService(ctx: CoreContext): SourceService {
  const resolveXCookieAbsPath = () =>
    path.resolve(ctx.paths.rootDir, ctx.settings.collector.xCookieFile);

  return {
    /** 列出所有配置的信源并关联数据库里的历史抓取状态与连续失败统计 */
    async list(): Promise<SourceHealth[]> {
      const states = ctx.repos.sourceState.listAll();
      const stateById = new Map(states.map((s) => [s.sourceId, s]));

      return ctx.sources.map((source) => {
        const state = stateById.get(source.id) ?? null;
        const healthy = (state?.consecutiveFailures ?? 0) < UNHEALTHY_FAILURE_THRESHOLD;
        return {
          source,
          state,
          healthy,
        };
      });
    },

    /** 对单个信源发起直接试抓（不发送条件缓存头，不写入正式文章库），支持全部信源协议 */
    async test(sourceId: string): Promise<SourceTestResult> {
      const source = ctx.sources.find((s) => s.id === sourceId);
      if (!source) {
        return {
          sourceId,
          ok: false,
          itemCount: 0,
          sampleTitles: [],
          durationMs: 0,
          error: `未找到信源配置: ${sourceId}`,
        };
      }

      const startedAt = ctx.now().getTime();
      const needsBrowser =
        source.kind === 'x-timeline' ||
        (source.kind === 'html-list' && source.listConfig?.renderJs === true);
      const driver = needsBrowser ? ctx.createCollectorDriver() : undefined;

      const sourceTimezone = resolveSourceTimezone(source, ctx.settings.timezone);

      try {
        if (source.kind === 'rss') {
          const res = await fetchFeedWithRetry(source, null, {
            fetchImpl: ctx.fetchImpl,
            timeoutMs: 15_000,
            retries: 1,
            useConditionalHeaders: false,
            timezone: sourceTimezone,
          });
          return {
            sourceId: source.id,
            ok: true,
            statusCode: res.statusCode,
            itemCount: res.items.length,
            sampleTitles: res.items.slice(0, 5).map((item) => item.title),
            durationMs: Math.max(0, ctx.now().getTime() - startedAt),
          };
        }

        if (source.kind === 'html-list') {
          const res = await fetchHtmlListWithRetry(source, {
            fetchImpl: ctx.fetchImpl,
            driver,
            timeoutMs: source.listConfig?.renderJs ? 25_000 : 18_000,
            retries: 1,
            timezone: sourceTimezone,
          });
          return {
            sourceId: source.id,
            ok: true,
            statusCode: res.statusCode,
            itemCount: res.items.length,
            sampleTitles: res.items.slice(0, 5).map((item) => item.title),
            durationMs: Math.max(0, ctx.now().getTime() - startedAt),
          };
        }

        const items = await fetchXSourceItems(source, {
          cookieFileAbs: resolveXCookieAbsPath(),
          driver: driver ?? ctx.createCollectorDriver(),
        });
        return {
          sourceId: source.id,
          ok: true,
          statusCode: 200,
          itemCount: items.length,
          sampleTitles: items.slice(0, 5).map((item) => item.title),
          durationMs: Math.max(0, ctx.now().getTime() - startedAt),
        };
      } catch (err) {
        return {
          sourceId: source.id,
          ok: false,
          itemCount: 0,
          sampleTitles: [],
          durationMs: Math.max(0, ctx.now().getTime() - startedAt),
          error: err instanceof Error ? err.message : String(err),
        };
      } finally {
        if (driver) {
          await driver.close().catch(() => undefined);
        }
      }
    },

    /** 查询本机 X 登录凭证是否已就绪 */
    async getXAuthStatus(): Promise<XAuthStatus> {
      return inspectXCookieFile(resolveXCookieAbsPath());
    },

    /** 导入并安全保存 X Cookie 文件 */
    async importXCookies(rawJson: string): Promise<XAuthStatus> {
      return importXCookieFile(rawJson, resolveXCookieAbsPath());
    },

    /** 启动可视化浏览器引导用户登录 X 并自动保存凭证 */
    async loginXInteractive(opts?: { timeoutMs?: number }): Promise<XAuthStatus> {
      return interactiveXLogin(resolveXCookieAbsPath(), opts);
    },
  };
}
