import { type CliConfig, zodToJsonSchema } from '@aidaily/contracts';
import { CliAuthError, CliExitError, CliOutputError, PromptTooLargeError } from '../errors.js';
import { runSubprocess } from '../exec.js';
import { extractJsonFromText } from '../json.js';
import type { AdapterCommand, AdapterParsedOutput, CliAdapter, InvokeRequest } from '../types.js';

const MAX_PROMPT_BYTES = 400_000;

const AUTH_ERROR_PATTERNS = [
  /not logged in/i,
  /please\s+log\s*in/i,
  /authentication\s+required/i,
  /unauthenticated/i,
  /login\s+required/i,
  /invalid\s+credentials/i,
  /token\s+expired/i,
  /未登录/,
  /请先登录/,
  /认证失败/,
];

/** Antigravity CLI 返回的标准 JSON 包装结构 */
interface AgyEnvelope {
  conversation_id?: string;
  status?: string;
  response?: unknown;
  structured_output?: unknown;
  error?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
  };
}

/** 检查错误输出或返回文本中是否包含未登录、Token 过期等鉴权提示 */
function hasAuthFailure(text: string): boolean {
  return AUTH_ERROR_PATTERNS.some((pattern) => pattern.test(text));
}

/** 去除命令行加载动画里的终端颜色码与回车控制字符 */
function stripAnsiAndSpinner(raw: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: strip ANSI escape codes from CLI TTY output
  return raw.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\r/g, '\n');
}

/**
 * Antigravity 命令行工具（`agy`）适配器：将提示词通过 `-p` 参数传入，
 * 并要求输出结构化 JSON，从中抽取结果主体与 Token 用量。
 */
export const agyAdapter: CliAdapter = {
  id: 'agy',

  /** 构造调用 `agy` 所需的参数列表，并校验提示词长度不超过命令行安全上限 */
  buildCommand(req: InvokeRequest<unknown>, cfg: CliConfig): AdapterCommand {
    const promptBytes = Buffer.byteLength(req.prompt, 'utf8');
    if (promptBytes > MAX_PROMPT_BYTES) {
      throw new PromptTooLargeError(promptBytes, MAX_PROMPT_BYTES);
    }

    const timeoutSec = Math.max(1, Math.ceil(req.timeoutMs / 1000));
    const args: string[] = [
      '-p',
      req.prompt,
      ...(req.model ? ['--model', req.model] : []),
      '--output-format',
      'json',
      '--disable-slash-commands',
      '--print-timeout',
      `${timeoutSec}s`,
    ];

    if (req.schema) {
      const schemaJson = JSON.stringify(zodToJsonSchema(req.schema));
      args.push('--json-schema', schemaJson);
    }

    if (cfg.extraArgs.length > 0) {
      args.push(...cfg.extraArgs);
    }

    return {
      bin: cfg.bin,
      args,
    };
  },

  /** 解析 `agy` 返回的 JSON 响应信封，提取结构化输出并识别认证异常或执行错误 */
  parse(
    stdout: string,
    stderr: string,
    exitCode: number,
    ctx: { hasSchema: boolean },
  ): AdapterParsedOutput {
    const combinedDiag = `${stderr}\n${stdout}`;
    if (hasAuthFailure(stderr)) {
      throw new CliAuthError(`agy 认证失败或未登录: ${stderr.trim()}`);
    }

    let envelope: AgyEnvelope;
    try {
      const parsed = extractJsonFromText(stdout);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new CliOutputError('agy 输出不是 JSON 对象', '根输出必须为对象', stdout);
      }
      envelope = parsed as AgyEnvelope;
    } catch (err) {
      if (hasAuthFailure(combinedDiag)) {
        throw new CliAuthError(`agy 认证失败或未登录: ${combinedDiag.trim()}`, err);
      }
      if (exitCode !== 0) {
        throw new CliExitError(
          `agy 退出异常（code=${exitCode}）: ${stderr.trim() || stdout.trim().slice(0, 300)}`,
          exitCode,
          stderr,
          err,
        );
      }
      if (err instanceof CliOutputError) {
        throw err;
      }
      throw new CliOutputError('agy JSON 解析失败', String(err), stdout, err);
    }

    if (exitCode !== 0 || envelope.status !== 'SUCCESS') {
      const msg = envelope.error || stderr.trim() || `status=${String(envelope.status)}`;
      if (hasAuthFailure(msg)) {
        throw new CliAuthError(`agy 认证失败或未登录: ${msg}`);
      }
      throw new CliExitError(
        `agy 执行失败（code=${exitCode}, status=${String(envelope.status)}）: ${msg}`,
        exitCode,
        stderr,
      );
    }

    const payload = ctx.hasSchema
      ? (envelope.structured_output ?? envelope.response)
      : envelope.response;

    const usage =
      envelope.usage &&
      typeof envelope.usage.input_tokens === 'number' &&
      typeof envelope.usage.output_tokens === 'number'
        ? {
            inputTokens: envelope.usage.input_tokens,
            outputTokens: envelope.usage.output_tokens,
          }
        : undefined;

    return {
      payload,
      usage,
      conversationId: envelope.conversation_id,
    };
  },

  /** 运行 `--help` 检查本机 `agy` 可执行文件是否正常响应 */
  async healthcheck(cfg: CliConfig): Promise<{ ok: boolean; detail: string }> {
    try {
      const res = await runSubprocess(cfg.bin, ['--help'], { timeoutMs: 10_000 });
      if (res.exitCode === 0) {
        return { ok: true, detail: `agy 可用 (${cfg.bin})` };
      }
      return {
        ok: false,
        detail: `agy --help 返回退出码 ${res.exitCode}: ${res.stderr.trim() || res.stdout.trim()}`,
      };
    } catch (err) {
      return {
        ok: false,
        detail: err instanceof Error ? err.message : String(err),
      };
    }
  },

  /** 运行 `agy models` 并过滤终端加载字符，提取当前可用模型名称列表 */
  async listModels(cfg: CliConfig): Promise<string[]> {
    const res = await runSubprocess(cfg.bin, ['models'], { timeoutMs: 30_000 });
    if (res.exitCode !== 0) {
      throw new CliExitError(
        `获取 agy 模型列表失败 (code=${res.exitCode}): ${res.stderr.trim()}`,
        res.exitCode,
        res.stderr,
      );
    }
    const cleaned = stripAnsiAndSpinner(res.stdout);
    const models: string[] = [];
    const seen = new Set<string>();

    for (const rawLine of cleaned.split('\n')) {
      const line = rawLine.trim();
      if (!line || /fetching/i.test(line)) {
        continue;
      }
      const firstToken = line.split(/\s+/)[0];
      if (firstToken && /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(firstToken) && !seen.has(firstToken)) {
        seen.add(firstToken);
        models.push(firstToken);
      }
    }
    return models;
  },
};
