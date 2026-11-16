export class CliBridgeError extends Error {
  readonly retryable: boolean;

  constructor(message: string, retryable: boolean, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
    this.retryable = retryable;
  }
}

export class CliNotFoundError extends CliBridgeError {
  readonly bin: string;

  constructor(bin: string, cause?: unknown) {
    super(`未找到命令行工具: ${bin}`, false, { cause });
    this.bin = bin;
  }
}

export class CliAuthError extends CliBridgeError {
  constructor(message: string, cause?: unknown) {
    super(message, false, { cause });
  }
}

export class PromptTooLargeError extends CliBridgeError {
  readonly bytes: number;
  readonly limitBytes: number;

  constructor(bytes: number, limitBytes: number) {
    super(`输入 Prompt 体积超出限制（${bytes} bytes > ${limitBytes} bytes）`, false);
    this.bytes = bytes;
    this.limitBytes = limitBytes;
  }
}

export class CliTimeoutError extends CliBridgeError {
  readonly timeoutMs: number;

  constructor(timeoutMs: number, cause?: unknown) {
    super(`命令执行超时（>${timeoutMs}ms）`, true, { cause });
    this.timeoutMs = timeoutMs;
  }
}

export class CliExitError extends CliBridgeError {
  readonly exitCode: number | undefined;
  readonly stderr: string;

  constructor(message: string, exitCode: number | undefined, stderr: string, cause?: unknown) {
    super(message, true, { cause });
    this.exitCode = exitCode;
    this.stderr = stderr;
  }
}

export class CliOutputError extends CliBridgeError {
  readonly issuesSummary: string;
  readonly rawOutput: string;

  constructor(message: string, issuesSummary: string, rawOutput: string, cause?: unknown) {
    super(message, true, { cause });
    this.issuesSummary = issuesSummary;
    this.rawOutput = rawOutput;
  }
}
