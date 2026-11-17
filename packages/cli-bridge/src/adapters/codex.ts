import fs from 'node:fs/promises';
import path from 'node:path';
import { createStrictOutputSchema } from '@aidaily/model-runtime';
import { z } from 'zod';
import { CliAuthError, CliExitError, CliOutputError, hasAuthFailureMessage } from '../errors.js';
import { runSubprocess } from '../exec.js';
import type { AdapterParsedOutput, CliAdapter } from '../types.js';

const CodexEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('thread.started'), thread_id: z.string() }),
  z.object({
    type: z.literal('turn.completed'),
    usage: z.object({
      input_tokens: z.number().int().nonnegative(),
      output_tokens: z.number().int().nonnegative(),
    }),
  }),
  z.object({ type: z.literal('turn.failed'), error: z.object({ message: z.string() }) }),
  z.object({ type: z.literal('error'), message: z.string() }),
]);

const ModelListSchema = z.object({
  models: z.array(z.object({ slug: z.string().min(1), visibility: z.string().optional() })),
});

const EXEC_OPTIONS = [
  '--sandbox',
  'read-only',
  '--skip-git-repo-check',
  '--ephemeral',
  '--ignore-user-config',
  '--disable',
  'shell_tool',
  '--disable',
  'plugins',
  '--disable',
  'hooks',
  '-c',
  'approval_policy="never"',
  '-c',
  'web_search="disabled"',
  '-c',
  'project_doc_max_bytes=0',
  '--json',
];

/** 读取 Codex 的 JSONL 事件，提取线程、用量和失败原因 */
function parseEvents(stdout: string): {
  usage?: AdapterParsedOutput['usage'];
  conversationId?: string;
  failures: string[];
  diagnostics: string[];
} {
  const details: ReturnType<typeof parseEvents> = { failures: [], diagnostics: [] };
  for (const line of stdout.split('\n')) {
    if (!line.startsWith('{')) {
      continue;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      continue;
    }
    const event = CodexEventSchema.safeParse(raw);
    if (!event.success) {
      continue;
    }
    switch (event.data.type) {
      case 'thread.started':
        details.conversationId = event.data.thread_id;
        break;
      case 'turn.completed':
        details.usage = {
          inputTokens: event.data.usage.input_tokens,
          outputTokens: event.data.usage.output_tokens,
        };
        break;
      case 'turn.failed':
        details.failures.push(event.data.error.message);
        break;
      case 'error':
        details.diagnostics.push(event.data.message);
        break;
    }
  }
  return details;
}

/** 从完整错误信息识别认证失败，避免将普通数字当作 HTTP 状态 */
function isCodexAuthFailure(text: string): boolean {
  return (
    hasAuthFailureMessage(text) ||
    /\b(?:status(?:\s+code)?\s*[:=]?\s*401|http(?:\/\d+(?:\.\d+)?)?\s+401|401\s+unauthorized|invalid_api_key|codex login)\b/i.test(
      text,
    )
  );
}

/** 在临时目录中用本机 Codex CLI 发起独立的文本调用 */
export const codexAdapter: CliAdapter = {
  id: 'codex',

  /** 将提示词送入标准输入，并为最终消息准备输出文件 */
  async buildCommand(req, cfg, workDir) {
    const outFile = path.join(workDir, 'last-message.txt');
    const args = [
      'exec',
      ...cfg.extraArgs,
      ...EXEC_OPTIONS,
      ...(req.model ? ['--model', req.model] : []),
      '--output-last-message',
      outFile,
    ];
    const output = req.schema ? createStrictOutputSchema(req.schema) : undefined;
    if (output) {
      const schemaFile = path.join(workDir, 'output-schema.json');
      await fs.writeFile(schemaFile, JSON.stringify(output.schema), { mode: 0o600 });
      args.push('--output-schema', schemaFile);
    }
    args.push('-');
    return { bin: cfg.bin, args, stdin: req.prompt, outFile, normalizeOutput: output?.restore };
  },

  /** 从最终消息读取答案，按退出码和事件区分认证与执行错误 */
  parse(stdout, stderr, exitCode, ctx) {
    const { usage, conversationId, failures, diagnostics } = parseEvents(stdout);
    const failed = exitCode !== 0 || failures.length > 0;
    const finalMessage = ctx.outFileContent?.trim();
    if (
      (failed || !finalMessage) &&
      [...failures, ...diagnostics, stderr].some(isCodexAuthFailure)
    ) {
      throw new CliAuthError('Codex CLI 认证失败，请检查本机登录');
    }
    if (failed) {
      const detail = (
        failures.at(-1) ||
        diagnostics.at(-1) ||
        stderr.trim() ||
        `退出码 ${exitCode}`
      ).slice(0, 400);
      throw new CliExitError(`Codex CLI 执行失败。${detail}`, exitCode, stderr);
    }
    if (!finalMessage) {
      throw new CliOutputError('Codex CLI 未写出最终消息', '最终消息为空', stdout);
    }
    return { payload: finalMessage, usage, conversationId };
  },

  /** 检查本机 CLI 是否支持结构化输出且已有登录 */
  async healthcheck(cfg) {
    const args = [
      'exec',
      ...cfg.extraArgs,
      ...EXEC_OPTIONS,
      '--output-schema',
      'schema.json',
      '--output-last-message',
      'output.txt',
      '--help',
    ];
    const help = await runSubprocess(cfg.bin, args, { timeoutMs: 5_000 });
    if (help.exitCode !== 0 || !help.stdout.includes('--output-schema')) {
      return { ok: false, detail: '当前 Codex CLI 版本缺少所需的 exec 参数' };
    }
    const login = await runSubprocess(cfg.bin, ['login', 'status'], { timeoutMs: 5_000 });
    return login.exitCode === 0
      ? { ok: true, detail: '本机 Codex CLI 已登录' }
      : { ok: false, detail: '请先通过本机 codex login 完成登录' };
  },

  /** 读取本机 Codex 自带的可选模型目录 */
  async listModels(cfg) {
    const result = await runSubprocess(cfg.bin, ['debug', 'models', '--bundled'], {
      timeoutMs: 5_000,
    });
    if (result.exitCode !== 0) {
      throw new CliExitError('读取 Codex 模型目录失败', result.exitCode, result.stderr);
    }
    let payload: unknown;
    try {
      payload = JSON.parse(result.stdout);
    } catch (err) {
      throw new CliOutputError(
        '无法读取 Codex 模型目录',
        '模型目录不是有效 JSON',
        result.stdout,
        err,
      );
    }
    const catalog = ModelListSchema.safeParse(payload);
    if (!catalog.success) {
      throw new CliOutputError('无法读取 Codex 模型目录', '模型目录结构异常', result.stdout);
    }
    return catalog.data.models
      .filter(({ visibility }) => !visibility || visibility === 'list')
      .map(({ slug }) => slug);
  },
};
