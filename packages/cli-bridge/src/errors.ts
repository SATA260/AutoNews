import { ModelCallError } from '@aidaily/model-runtime';

/**
 * CLI 桥接层统一异常基类，通过 `retryable` 标记调用方是否允许自动重试。
 */
export class CliBridgeError extends ModelCallError {
  constructor(message: string, retryable: boolean, options?: ErrorOptions) {
    super(message, retryable, 'exit_error', options);
  }
}

/** 指定的命令行可执行文件不存在或未安装（不可重试） */
export class CliNotFoundError extends CliBridgeError {
  readonly bin: string;

  constructor(bin: string, cause?: unknown) {
    super(`未找到命令行工具: ${bin}`, false, { cause });
    this.bin = bin;
  }
}

/** 命令行工具未登录或鉴权凭证失效（不可重试，需人工重新登录） */
export class CliAuthError extends CliBridgeError {
  override readonly status = 'auth_error';

  constructor(message: string, cause?: unknown) {
    super(message, false, { cause });
  }
}

/** 单次输入 Prompt 超出命令行或适配器字节上限（不可重试） */
export class PromptTooLargeError extends CliBridgeError {
  readonly bytes: number;
  readonly limitBytes: number;

  constructor(bytes: number, limitBytes: number) {
    super(`输入 Prompt 体积超出限制（${bytes} bytes > ${limitBytes} bytes）`, false);
    this.bytes = bytes;
    this.limitBytes = limitBytes;
  }
}

/** 子进程执行超出设定时长已被强杀（可重试） */
export class CliTimeoutError extends CliBridgeError {
  override readonly status = 'timeout';
  readonly timeoutMs: number;

  constructor(timeoutMs: number, cause?: unknown) {
    super(`命令执行超时（>${timeoutMs}ms）`, true, { cause });
    this.timeoutMs = timeoutMs;
  }
}

/** 子进程退出码非零或返回非 SUCCESS 状态（可重试） */
export class CliExitError extends CliBridgeError {
  readonly exitCode: number | undefined;
  readonly stderr: string;

  constructor(message: string, exitCode: number | undefined, stderr: string, cause?: unknown) {
    super(message, true, { cause });
    this.exitCode = exitCode;
    this.stderr = stderr;
  }
}

/** 模型输出非合法 JSON 或未通过 Zod Schema 校验（可携带错误提示重试） */
export class CliOutputError extends CliBridgeError {
  override readonly status = 'bad_output';
  override readonly issuesSummary: string;
  readonly rawOutput: string;

  constructor(message: string, issuesSummary: string, rawOutput: string, cause?: unknown) {
    super(message, true, { cause });
    this.issuesSummary = issuesSummary;
    this.rawOutput = rawOutput;
  }
}

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

/** 判断外部命令行输出中是否包含未登录、鉴权失败或凭证过期提示 */
export function hasAuthFailureMessage(text: string): boolean {
  return AUTH_ERROR_PATTERNS.some((pattern) => pattern.test(text));
}
