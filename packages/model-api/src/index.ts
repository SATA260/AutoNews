import type { ModelApiProvider } from '@aidaily/contracts';
import {
  type AttemptTrace,
  type InvokeRequest,
  type InvokeResult,
  type ModelAttemptResult,
  ModelRuntime,
  type ModelRuntimeOptions,
} from '@aidaily/model-runtime';
import { openAiCompatibleAdapter } from './adapters/openai-compatible.js';

/** DNS 解析返回的单个地址条目 */
export interface ResolvedHostAddress {
  address: string;
}

/** 由核心传入的网络接口、可选域名解析函数和密钥读取方法 */
export interface ModelApiDependencies {
  fetchImpl: typeof fetch;
  resolveApiKey: (config: ModelApiProvider) => Promise<string | undefined>;
  lookupFn?: (hostname: string) => Promise<ResolvedHostAddress[]>;
}

/** HTTP 模型服务的单次调用与模型发现接口 */
export interface ModelApiAdapter<Provider extends ModelApiProvider = ModelApiProvider> {
  invoke(
    config: Provider,
    request: InvokeRequest<unknown>,
    trace: AttemptTrace,
    dependencies: ModelApiDependencies,
  ): Promise<ModelAttemptResult>;
  listModels(config: Provider, dependencies: ModelApiDependencies): Promise<string[] | null>;
}

const adapters = { 'openai-compatible': openAiCompatibleAdapter };

/** 以配置选取 HTTP 适配器，并使用统一的模型调用规则 */
export class ModelApi {
  private readonly runtime: ModelRuntime;

  constructor(private readonly options: ModelApiDependencies & ModelRuntimeOptions) {
    this.runtime = new ModelRuntime(options);
  }

  /** 发起一次由任务快照指定的模型 API 调用 */
  invoke<T>(
    request: InvokeRequest<T>,
    config: ModelApiProvider,
    maxConcurrentCalls?: number,
  ): Promise<InvokeResult<T>> {
    const adapter = adapters[config.adapter];
    return this.runtime.invoke(
      request,
      (req, trace) => adapter.invoke(config, req, trace, this.options),
      maxConcurrentCalls,
    );
  }

  /** 读取服务提供的模型名称，兼容省略模型列表的网关 */
  async listModels(config: ModelApiProvider): Promise<string[]> {
    return (await adapters[config.adapter].listModels(config, this.options)) ?? [];
  }

  /** 用模型列表检查服务可达性与认证状态 */
  async health(config: ModelApiProvider): Promise<{ ok: boolean; detail: string }> {
    try {
      const models = await adapters[config.adapter].listModels(config, this.options);
      return {
        ok: true,
        detail: models
          ? `API 可达，查询到 ${models.length} 个模型`
          : 'API 可达，服务未提供模型列表，请填写模型 ID',
      };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : '模型 API 检查失败' };
    }
  }
}
