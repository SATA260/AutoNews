import type { SourceHealth, SourceTestResult } from '@aidaily/contracts';
import { fetchFeedWithRetry } from '../collector/fetcher.js';
import type { CoreContext } from '../context.js';

/** 新闻信源管理服务接口（供命令行工具与网页后台共同使用） */
export interface SourceService {
  /** 列出全部已配置的信源及其抓取健康状态 */
  list(): Promise<SourceHealth[]>;
  /** 立即对指定信源执行一次无缓存试抓并返回诊断结果与示例标题 */
  test(sourceId: string): Promise<SourceTestResult>;
}

const UNHEALTHY_FAILURE_THRESHOLD = 3;

/** 创建新闻信源管理服务实例 */
export function createSourceService(ctx: CoreContext): SourceService {
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

    /** 对单个信源发起直接试抓（不发送条件缓存头，不写入正式文章库），用于验证订阅可用性 */
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
      if (source.kind !== 'rss') {
        return {
          sourceId,
          ok: false,
          itemCount: 0,
          sampleTitles: [],
          durationMs: 0,
          error: `暂不支持试抓 ${source.kind} 类型信源`,
        };
      }

      const startedAt = ctx.now().getTime();
      try {
        const res = await fetchFeedWithRetry(source, null, {
          fetchImpl: ctx.fetchImpl,
          timeoutMs: 15_000,
          retries: 1,
          useConditionalHeaders: false,
          timezone: ctx.settings.timezone,
        });
        return {
          sourceId: source.id,
          ok: true,
          statusCode: res.statusCode,
          itemCount: res.items.length,
          sampleTitles: res.items.slice(0, 5).map((item) => item.title),
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
      }
    },
  };
}
