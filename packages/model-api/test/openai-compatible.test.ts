import {
  createPolishedItemSchema,
  FactCheckResultSchema,
  IssuePackageSchema,
  type ModelApiProvider,
  SelectionResultSchema,
  SummaryDraftSchema,
} from '@aidaily/contracts';
import type { CallRecord } from '@aidaily/model-runtime';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ModelApi } from '../src/index.js';

const provider = {
  adapter: 'openai-compatible',
  protocol: 'chat-completions',
  baseUrl: 'https://models.test/gateway/v1/',
  apiKeyEnv: 'TEST_MODEL_KEY',
} satisfies ModelApiProvider;
const key = 'fixture-key-for-audit';
const request = {
  cli: 'deepseek',
  model: 'deepseek-fixture',
  prompt: '提取新闻标题',
  schema: z.object({ title: z.string() }),
  timeoutMs: 1_000,
  retries: 0,
};

/** 按 Chat Completions 协议生成服务响应 */
function chatResult(content: string, finishReason = 'stop'): Response {
  return Response.json({
    id: 'chat-1',
    choices: [{ message: { content, reasoning_content: key }, finish_reason: finishReason }],
    usage: { prompt_tokens: 33, completion_tokens: 8 },
  });
}

/** 创建完全由测试提供输入与输出的 HTTP 模型服务 */
function setup(fetchImpl: typeof fetch, apiKey: string | null = key) {
  const calls: CallRecord[] = [];
  const api = new ModelApi({
    fetchImpl,
    resolveApiKey: async () => apiKey ?? undefined,
    logCall: (record) => {
      calls.push(record);
    },
    retryDelaysMs: [0],
  });
  return { api, calls };
}

describe('OpenAI 兼容模型 API', () => {
  it('uses the configured Chat Completions address and never logs the credential or reasoning', async () => {
    const mock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(chatResult(JSON.stringify({ title: `新闻 ${key}` })));
    const { api, calls } = setup(mock);
    const result = await api.invoke(request, provider);
    expect(result).toMatchObject({
      data: { title: '新闻 [已隐去]' },
      usage: { inputTokens: 33, outputTokens: 8 },
      conversationId: 'chat-1',
    });
    const [url, init] = mock.mock.calls[0] ?? [];
    expect(url).toBe('https://models.test/gateway/v1/chat/completions');
    expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${key}`);
    expect(init?.redirect).toBe('manual');
    expect(JSON.parse(init?.body as string)).toMatchObject({
      model: request.model,
      messages: [
        { role: 'system', content: expect.stringContaining('JSON Schema') },
        { role: 'user', content: request.prompt },
      ],
      stream: false,
      response_format: { type: 'json_object' },
    });
    expect(JSON.stringify(calls)).not.toContain(key);
    expect(JSON.stringify(calls)).not.toContain('reasoning_content');
  });

  it('supports prompt-only gateways and lets users enter model IDs when the catalog is absent', async () => {
    const mock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(chatResult('```json\n{"title":"完成"}\n```'))
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(new Response(null, { status: 405 }));
    const { api } = setup(mock, null);
    const gateway: ModelApiProvider = { ...provider, jsonMode: 'prompt', apiKeyEnv: undefined };
    await expect(api.invoke(request, gateway)).resolves.toMatchObject({ data: { title: '完成' } });
    expect(JSON.parse(mock.mock.calls[0]?.[1]?.body as string)).not.toHaveProperty(
      'response_format',
    );
    await expect(api.listModels(gateway)).resolves.toEqual([]);
    await expect(api.health(gateway)).resolves.toMatchObject({
      ok: true,
      detail: expect.stringContaining('填写模型 ID'),
    });
    expect(mock.mock.calls[1]?.[0]).toBe('https://models.test/gateway/v1/models');
    expect(new Headers(mock.mock.calls[1]?.[1]?.headers).has('authorization')).toBe(false);
  });

  it.each(['id', '1', key])(
    'redacts decoded string values while preserving JSON structure for %s',
    async (credential) => {
      const encoded = `\\u${credential.charCodeAt(0).toString(16).padStart(4, '0')}${credential.slice(1)}`;
      const mock = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(chatResult(`{"articleId":"新闻","score":10,"note":"${encoded}"}`));
      const { api, calls } = setup(mock, credential);
      const schema = z.object({ articleId: z.string(), score: z.number(), note: z.string() });
      const data = { articleId: '新闻', score: 10, note: '[已隐去]' };
      await expect(api.invoke({ ...request, schema }, provider)).resolves.toMatchObject({ data });
      expect(JSON.parse(calls[0]?.rawStdout ?? '')).toEqual(data);
      expect(calls[0]?.parsed).toEqual(data);
    },
  );

  it('restores optional fields only in the matching strict union branch', async () => {
    const a = z.object({ kind: z.literal('a'), note: z.string().optional() });
    const b = z.object({ kind: z.literal('b'), note: z.string().nullable() });
    const schema = z.object({
      items: z.array(z.union([a, b])),
      featured: z.discriminatedUnion('kind', [a, b]),
    });
    const wire = {
      items: [
        { kind: 'a', note: null },
        { kind: 'b', note: null },
      ],
      featured: { kind: 'a', note: null },
    };
    const mock = vi.fn<typeof fetch>().mockResolvedValueOnce(
      Response.json({
        status: 'completed',
        output: [
          { type: 'message', content: [{ type: 'output_text', text: JSON.stringify(wire) }] },
        ],
      }),
    );
    const { api } = setup(mock);
    await expect(
      api.invoke({ ...request, schema }, { ...provider, protocol: 'responses' }),
    ).resolves.toMatchObject({
      data: { items: [{ kind: 'a' }, { kind: 'b', note: null }], featured: { kind: 'a' } },
    });
    const sent = JSON.parse(mock.mock.calls[0]?.[1]?.body as string).text.format.schema;
    expect(sent.properties.featured).not.toHaveProperty('oneOf');
    expect(sent.properties.featured.anyOf[0].required).toEqual(['kind', 'note']);
  });

  it('builds strict Responses schemas and validates outputs for all five editorial stages', async () => {
    const evidence = { claim: '事实', articleId: 'article-1', quote: '原文' };
    const polished = {
      title: '标题',
      shortTitle: '短题',
      progressLabel: '核心进展',
      category: '分类',
      entity: '主体',
      summary: '摘要',
      keyPoints: ['重点'],
      detail: '详情',
      hostComment: '点评',
      narration: ['口播'],
      evidence: [evidence],
    };
    const pack = {
      order: ['item-1'],
      headlineItemId: 'item-1',
      headline: '标题',
      leadSummary: '导语',
      intro: { narration: ['开头'], hostComment: '点评' },
      outro: { narration: ['结尾'], hostComment: '点评', cta: '关注' },
      publish: { title: '标题', descriptionIntro: '简介', tags: ['AI'] },
    };
    const checks: Array<{ schema: z.ZodType; wire: object; output: object }> = [
      { schema: SelectionResultSchema, wire: { events: [] }, output: { events: [] } },
      {
        schema: SummaryDraftSchema,
        wire: {
          facts: ['事实'],
          relevance: '相关性',
          availability: 'unknown',
          availabilityNote: '待确认',
          evidence: [evidence],
        },
        output: {
          facts: ['事实'],
          relevance: '相关性',
          availability: 'unknown',
          availabilityNote: '待确认',
          evidence: [evidence],
        },
      },
      {
        schema: createPolishedItemSchema(),
        wire: {
          title: polished.title,
          shortTitle: polished.shortTitle,
          progressLabel: polished.progressLabel,
          category: polished.category,
          entity: polished.entity,
          summary: polished.summary,
          highlight: null,
          preferArticleImage: null,
          imageCaption: null,
          cards: null,
          keyPoints: polished.keyPoints,
          detail: polished.detail,
          hostComment: polished.hostComment,
          narration: polished.narration,
          evidence: polished.evidence,
          officialQuote: null,
          metrics: null,
        },
        output: polished,
      },
      {
        schema: FactCheckResultSchema,
        wire: {
          verdict: 'pass',
          claims: [{ text: '事实无误', status: 'supported', severity: null, note: '一致' }],
          revisionNotes: [],
          dropReason: null,
        },
        output: {
          verdict: 'pass',
          claims: [{ text: '事实无误', status: 'supported', note: '一致' }],
          revisionNotes: [],
        },
      },
      { schema: IssuePackageSchema, wire: pack, output: pack },
    ];
    const mock = vi.fn<typeof fetch>();
    const { api } = setup(mock);
    for (const { schema, wire, output } of checks) {
      mock.mockResolvedValueOnce(
        Response.json({
          id: 'response-1',
          status: 'completed',
          output: [
            { type: 'reasoning' },
            { type: 'message', content: [{ type: 'output_text', text: JSON.stringify(wire) }] },
          ],
          usage: { input_tokens: 9, output_tokens: 4 },
        }),
      );
      const result = await api.invoke(
        { ...request, schema },
        { ...provider, protocol: 'responses' },
      );
      expect(result.data).toEqual(output);
      expect(result.usage).toEqual({ inputTokens: 9, outputTokens: 4 });
      const [url, init] = mock.mock.calls.at(-1) ?? [];
      expect(url).toBe('https://models.test/gateway/v1/responses');
      expect(JSON.parse(init?.body as string)).toMatchObject({
        input: request.prompt,
        store: false,
        text: {
          format: {
            type: 'json_schema',
            strict: true,
            schema: { additionalProperties: false, required: Object.keys(wire) },
          },
        },
      });
    }
    const polishedSchema = JSON.parse(mock.mock.calls[2]?.[1]?.body as string).text.format.schema;
    expect(polishedSchema.properties.officialQuote.anyOf).toEqual([
      { type: 'string' },
      { type: 'null' },
    ]);
    expect(polishedSchema.properties.evidence.items.additionalProperties).toBe(false);
  });

  it('retries throttling, truncation, and blank output, and explains invalid JSON to the model', async () => {
    const mock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({ error: { code: 'rate_limit_exceeded' } }, { status: 429 }),
      )
      .mockResolvedValueOnce(chatResult('{"title":', 'length'))
      .mockResolvedValueOnce(chatResult('   '))
      .mockResolvedValueOnce(chatResult('{"title":"通过"}'));
    const { api, calls } = setup(mock);
    await expect(api.invoke({ ...request, retries: 3 }, provider)).resolves.toMatchObject({
      attempts: 4,
      data: { title: '通过' },
    });
    expect(calls.map((entry) => entry.status)).toEqual([
      'exit_error',
      'bad_output',
      'bad_output',
      'ok',
    ]);
    expect(calls[3]?.prompt).toContain('上次输出格式校验失败');
  });

  it.each([
    [401, 'invalid_api_key', 'auth_error'],
    [429, 'insufficient_quota', 'exit_error'],
    [400, 'invalid_request_error', 'exit_error'],
  ])('does not retry permanent HTTP %s errors (%s)', async (status, code, category) => {
    const mock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ error: { code, message: key } }, { status }));
    const { api, calls } = setup(mock);
    await expect(api.invoke({ ...request, retries: 3 }, provider)).rejects.toMatchObject({
      status: category,
      retryable: false,
    });
    expect(mock).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(calls)).not.toContain(key);
  });

  it('classifies missing credentials, refusal, timeout, and user cancellation separately', async () => {
    const unused = vi.fn<typeof fetch>();
    await expect(setup(unused, null).api.invoke(request, provider)).rejects.toMatchObject({
      status: 'auth_error',
    });
    expect(unused).not.toHaveBeenCalled();

    const refusal = vi.fn<typeof fetch>().mockResolvedValueOnce(chatResult('', 'content_filter'));
    await expect(setup(refusal).api.invoke(request, provider)).rejects.toMatchObject({
      status: 'bad_output',
      retryable: false,
    });

    const waitForAbort: typeof fetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      });
    const { api, calls } = setup(waitForAbort);
    await expect(api.invoke({ ...request, timeoutMs: 10 }, provider)).rejects.toMatchObject({
      status: 'timeout',
    });
    const abort = new AbortController();
    const pending = api.invoke({ ...request, signal: abort.signal }, provider);
    setTimeout(() => abort.abort(), 5);
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(calls.map(({ status }) => status)).toEqual(['timeout']);
  });

  it('reports malformed credentials and unsuccessful Responses authorization without retrying', async () => {
    const mock = vi.fn<typeof fetch>().mockResolvedValueOnce(
      Response.json({
        status: 'failed',
        error: { code: 'invalid_api_key', message: key },
      }),
    );
    const invalid = setup(mock, `${key}\nextra line`);
    await expect(invalid.api.invoke({ ...request, retries: 2 }, provider)).rejects.toMatchObject({
      status: 'auth_error',
      retryable: false,
    });
    expect(mock).not.toHaveBeenCalled();
    const { api, calls } = setup(mock);
    await expect(
      api.invoke({ ...request, retries: 2 }, { ...provider, protocol: 'responses' }),
    ).rejects.toMatchObject({
      status: 'auth_error',
      retryable: false,
    });
    expect(mock).toHaveBeenCalledTimes(1);
    expect(calls.map(({ status }) => status)).toEqual(['auth_error']);
    expect(JSON.stringify([...invalid.calls, ...calls])).not.toContain(key);
  });
});
