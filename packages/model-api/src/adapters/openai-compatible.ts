import { lookup } from 'node:dns/promises';
import {
  classifyIpAddress,
  isAllowedResolvedIpClass,
  isAllowedUrlTarget,
  isLocalModelApiAllowed,
  type ModelApiProvider,
  zodToJsonSchema,
} from '@aidaily/contracts';
import {
  createStrictOutputSchema,
  extractJsonFromText,
  type InvokeRequest,
  ModelCallError,
  ModelOutputError,
  type TokenUsage,
} from '@aidaily/model-runtime';
import { z } from 'zod';
import type { ModelApiAdapter, ModelApiDependencies } from '../index.js';

const OptionalUsage = z.number().int().nonnegative().optional();
const ApiFaultSchema = z.object({
  error: z.object({ code: z.string().nullish(), type: z.string().nullish() }),
});
const ChatSchema = z.object({
  id: z.string().optional(),
  choices: z
    .array(
      z.object({
        finish_reason: z.string(),
        message: z.object({ content: z.string().nullish(), refusal: z.string().nullish() }),
      }),
    )
    .min(1),
  usage: z.object({ prompt_tokens: OptionalUsage, completion_tokens: OptionalUsage }).nullish(),
});
const ResponsesSchema = z.object({
  id: z.string().optional(),
  status: z.string(),
  output: z
    .array(
      z.object({
        type: z.string(),
        content: z.array(z.object({ type: z.string(), text: z.string().optional() })).optional(),
      }),
    )
    .optional(),
  error: z.object({ code: z.string().nullish() }).nullish(),
  incomplete_details: z.object({ reason: z.string().nullish() }).nullish(),
  usage: z.object({ input_tokens: OptionalUsage, output_tokens: OptionalUsage }).nullish(),
});
const ModelListSchema = z.object({ data: z.array(z.object({ id: z.string().min(1) })) });

/** 取得当前服务的密钥，缺少已配置的密钥时报告认证错误 */
async function getApiKey(
  config: ModelApiProvider,
  dependencies: ModelApiDependencies,
): Promise<string | undefined> {
  const apiKey = await dependencies.resolveApiKey(config);
  if (!apiKey && (config.apiKeyEnv || config.apiKeyFile)) {
    throw new ModelCallError(
      '缺少模型 API 密钥，请检查该服务配置的环境变量或密钥文件',
      false,
      'auth_error',
    );
  }
  if (apiKey && /[^!-~]/.test(apiKey)) {
    throw new ModelCallError('模型 API 密钥含有空白或无效字符', false, 'auth_error');
  }
  return apiKey;
}

/** 在返回内容和诊断中隐去服务可能回显的密钥 */
function redact(value: string, key?: string): string {
  return key ? value.replaceAll(key, '[已隐去]') : value;
}

/** 只保留可安全展示的服务错误代码 */
function safeErrorCode(code: string | null | undefined, key?: string): string {
  const clean = redact(code ?? '', key);
  return /^[A-Za-z0-9_.-]{1,80}$/.test(clean) ? clean : '';
}

/** 识别服务在响应正文中返回的认证错误码 */
function isAuthCode(code: string | null | undefined): boolean {
  return /^(invalid_api_key|api_key_invalid|authentication_error|unauthorized|invalid_authentication)$/i.test(
    code ?? '',
  );
}

/** 按 HTTP 状态和服务错误代码判断是否应由调用方重试 */
function httpError(status: number, response: unknown, apiKey?: string): ModelCallError {
  const parsed = ApiFaultSchema.safeParse(response);
  const fault = parsed.success ? parsed.data.error : undefined;
  const rawCode = fault?.code ?? fault?.type;
  const code = safeErrorCode(rawCode, apiKey);
  const detail = `模型 API 请求失败（HTTP ${status}${code ? `，${code}` : ''}）`;
  if (status === 401 || status === 403 || isAuthCode(rawCode)) {
    return new ModelCallError(detail, false, 'auth_error');
  }
  const retryable =
    status === 408 ||
    status === 409 ||
    status >= 500 ||
    (status === 429 && rawCode !== 'insufficient_quota');
  return new ModelCallError(detail, retryable);
}

/** 在发起模型接口请求前核验目标网址与解析 IP，防止指向未授权内网或云元数据服务 */
async function assertSafeModelEndpoint(
  url: URL,
  dependencies: ModelApiDependencies,
): Promise<void> {
  const allowLoopback = isLocalModelApiAllowed();
  if (!isAllowedUrlTarget(url, { allowLoopback })) {
    throw new ModelCallError('模型 API 地址指向受限内网、回环或元数据地址，已拒绝请求', false);
  }
  const shouldLookup =
    dependencies.lookupFn !== undefined || dependencies.fetchImpl === globalThis.fetch;
  if (!shouldLookup || classifyIpAddress(url.hostname) !== null) {
    return;
  }
  const resolved = dependencies.lookupFn
    ? await dependencies.lookupFn(url.hostname)
    : await lookup(url.hostname, { all: true, verbatim: true });
  if (resolved.length === 0) {
    throw new ModelCallError('模型 API 域名未能解析到有效网络地址', false);
  }
  for (const entry of resolved) {
    const cls = classifyIpAddress(entry.address);
    if (!cls || !isAllowedResolvedIpClass(cls, url, { allowLoopback })) {
      throw new ModelCallError('模型 API 域名解析指向受限内网或元数据地址，已拒绝请求', false);
    }
  }
}

/** 在指定超时时间内读取 HTTP 响应，区分主动取消、超时和请求失败 */
async function requestJson(opts: {
  config: ModelApiProvider;
  dependencies: ModelApiDependencies;
  endpoint: string;
  body?: object;
  key?: string;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<{ status: number; ok: boolean; json: unknown }> {
  const timeout = AbortSignal.timeout(opts.timeoutMs);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
  try {
    signal.throwIfAborted();
    const url = new URL(opts.config.baseUrl);
    url.pathname = `${url.pathname.replace(/\/+$/, '')}/${opts.endpoint}`;
    await assertSafeModelEndpoint(url, opts.dependencies);
    const response = await opts.dependencies.fetchImpl(url.href, {
      method: opts.body ? 'POST' : 'GET',
      headers: {
        Accept: 'application/json',
        ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
        ...(opts.key ? { Authorization: `Bearer ${opts.key}` } : {}),
      },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      redirect: 'manual',
      signal,
    });
    const text = await response.text();
    signal.throwIfAborted();
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      if (response.ok) {
        throw new ModelOutputError('模型 API 响应无法解析', 'HTTP 响应不是 JSON', '');
      }
    }
    return { status: response.status, ok: response.ok, json };
  } catch (err) {
    if (opts.signal?.aborted) {
      throw new DOMException('已取消', 'AbortError');
    }
    if (timeout.aborted) {
      throw new ModelCallError(`模型 API 请求超时（${opts.timeoutMs}ms）`, true, 'timeout');
    }
    if (err instanceof ModelCallError) {
      throw err;
    }
    throw new ModelCallError('无法连接模型 API，请检查服务地址和网络', true);
  }
}

/** 只有服务返回完整的计数时才记录 Token 用量 */
function tokenUsage(input?: number, output?: number): TokenUsage | undefined {
  return input === undefined || output === undefined
    ? undefined
    : { inputTokens: input, outputTokens: output };
}

/** 生成 Chat Completions 的消息，并用原有契约提示模型输出 JSON */
function chatBody(request: InvokeRequest<unknown>, config: ModelApiProvider): object {
  const messages = [];
  if (request.schema) {
    messages.push({
      role: 'system',
      content: `只输出一个符合以下 JSON Schema 的 JSON 对象。\n${JSON.stringify(zodToJsonSchema(request.schema))}`,
    });
  }
  messages.push({ role: 'user', content: request.prompt });
  return {
    model: request.model,
    messages,
    stream: false,
    ...(request.schema && config.jsonMode !== 'prompt'
      ? { response_format: { type: 'json_object' } }
      : {}),
  };
}

/** 读取 Chat Completions 的最终消息，拒绝使用截断或只含推理的结果 */
function parseChat(raw: unknown): { text: string; id?: string; usage?: TokenUsage } {
  const parsed = ChatSchema.safeParse(raw);
  const first = parsed.success ? parsed.data.choices[0] : undefined;
  if (!parsed.success || !first) {
    throw new ModelOutputError('Chat Completions 响应格式异常', '缺少有效的 choices 消息', '');
  }
  if (first.message.refusal || first.finish_reason === 'content_filter') {
    throw new ModelCallError('模型拒绝生成本次输出', false, 'bad_output');
  }
  if (first.finish_reason === 'insufficient_system_resource' || first.finish_reason === 'aborted') {
    throw new ModelCallError('模型服务在生成期间中断', true);
  }
  if (first.finish_reason !== 'stop' || !first.message.content?.trim()) {
    throw new ModelOutputError('Chat Completions 输出不完整', '请返回完整、非空的最终 JSON', '');
  }
  return {
    text: first.message.content,
    id: parsed.data.id,
    usage: tokenUsage(parsed.data.usage?.prompt_tokens, parsed.data.usage?.completion_tokens),
  };
}

/** 从 Responses 的最终消息提取文本，忽略推理和工具事件 */
function parseResponses(
  raw: unknown,
  key?: string,
): { text: string; id?: string; usage?: TokenUsage } {
  const parsed = ResponsesSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ModelOutputError('Responses 响应格式异常', '缺少有效的状态或输出', '');
  }
  const response = parsed.data;
  const content =
    response.output?.flatMap((item) => (item.type === 'message' ? (item.content ?? []) : [])) ?? [];
  if (
    response.incomplete_details?.reason === 'content_filter' ||
    content.some(({ type }) => type === 'refusal')
  ) {
    throw new ModelCallError('模型拒绝生成本次输出', false, 'bad_output');
  }
  if (response.status === 'failed') {
    const rawCode = response.error?.code;
    const code = safeErrorCode(rawCode, key);
    const message = `Responses 生成失败${code ? `（${code}）` : ''}`;
    if (isAuthCode(rawCode)) {
      throw new ModelCallError(message, false, 'auth_error');
    }
    throw new ModelCallError(
      message,
      rawCode === 'server_error' || rawCode === 'rate_limit_exceeded',
    );
  }
  const text = content
    .filter(({ type }) => type === 'output_text')
    .map((item) => item.text ?? '')
    .join('');
  if (response.status !== 'completed' || !text.trim()) {
    throw new ModelOutputError('Responses 输出不完整', '请返回完整、非空的最终 JSON', '');
  }
  return {
    text,
    id: response.id,
    usage: tokenUsage(response.usage?.input_tokens, response.usage?.output_tokens),
  };
}

/** 先解析结构化结果，再在字符串值中隐去密钥，保留字段名和数据类型 */
function readStructuredOutput(text: string, key?: string): { payload: unknown; raw: string } {
  let payload: unknown;
  try {
    payload = extractJsonFromText(text);
  } catch (err) {
    if (key && err instanceof ModelOutputError) {
      throw new ModelOutputError(err.message, err.issuesSummary, '');
    }
    throw err;
  }
  if (!key) {
    return { payload, raw: text };
  }
  const raw = JSON.stringify(payload, (_name, value: unknown) =>
    typeof value === 'string' ? redact(value, key) : value,
  );
  return { payload: JSON.parse(raw) as unknown, raw };
}

/** 为支持 OpenAI 请求格式的模型服务提供两种独立协议 */
export const openAiCompatibleAdapter: ModelApiAdapter = {
  /** 发送一次模型请求并规范化最终结果 */
  async invoke(config, request, trace, dependencies) {
    if (!request.model) {
      throw new ModelCallError('模型 API 调用需要显式指定模型 ID', false);
    }
    const key = await getApiKey(config, dependencies);
    const isResponses = config.protocol === 'responses';
    const output =
      isResponses && request.schema ? createStrictOutputSchema(request.schema) : undefined;
    const response = await requestJson({
      config,
      dependencies,
      key,
      endpoint: isResponses ? 'responses' : 'chat/completions',
      body: isResponses
        ? {
            model: request.model,
            input: request.prompt,
            stream: false,
            store: false,
            ...(output
              ? {
                  text: {
                    format: {
                      type: 'json_schema',
                      name: 'aidaily_output',
                      strict: true,
                      schema: output.schema,
                    },
                  },
                }
              : {}),
          }
        : chatBody(request, config),
      timeoutMs: request.timeoutMs,
      signal: request.signal,
    });
    if (!response.ok) {
      throw httpError(response.status, response.json, key);
    }
    const result = isResponses ? parseResponses(response.json, key) : parseChat(response.json);
    const structured = request.schema ? readStructuredOutput(result.text, key) : undefined;
    trace.rawStdout = structured?.raw ?? redact(result.text, key);
    const payload = structured ? structured.payload : trace.rawStdout;
    return {
      payload: output ? output.restore(payload) : payload,
      conversationId: result.id === undefined ? undefined : redact(result.id, key),
      usage: result.usage,
    };
  },

  /** 查询模型 ID，网关没有模型列表时允许调用者手动输入 */
  async listModels(config, dependencies) {
    const key = await getApiKey(config, dependencies);
    const response = await requestJson({
      config,
      dependencies,
      key,
      endpoint: 'models',
      timeoutMs: 5_000,
    });
    if (response.status === 404 || response.status === 405 || response.status === 501) {
      return null;
    }
    if (!response.ok) {
      throw httpError(response.status, response.json, key);
    }
    const parsed = ModelListSchema.safeParse(response.json);
    if (!parsed.success) {
      throw new ModelOutputError('模型列表格式异常', '缺少 data[].id', '');
    }
    return Array.from(new Set(parsed.data.data.map(({ id }) => redact(id, key))));
  },
};
