/**
 * CLI 桥接层统一异常基类，通过 `retryable` 标记调用方是否允许自动重试。
 */
export class CliBridgeError extends Error {
  readonly retryable: boolean;

  constructor(message: string, retryable: boolean, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
    this.retryable = retryable;
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
  readonly issuesSummary: string;
  readonly rawOutput: string;

  constructor(message: string, issuesSummary: string, rawOutput: string, cause?: unknown) {
    super(message, true, { cause });
    this.issuesSummary = issuesSummary;
    this.rawOutput = rawOutput;
  }
}
