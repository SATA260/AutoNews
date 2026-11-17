import type { LlmCallStatus } from '@aidaily/contracts';

/** 模型调用失败时记录错误类别、是否可重试以及可用于修正输出的提示 */
export class ModelCallError extends Error {
  readonly issuesSummary?: string;

  constructor(
    message: string,
    readonly retryable: boolean,
    readonly status: Exclude<LlmCallStatus, 'ok'> = 'exit_error',
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** 模型输出无法解析或未通过校验，可提示模型修正后重试 */
export class ModelOutputError extends ModelCallError {
  constructor(
    message: string,
    override readonly issuesSummary: string,
    readonly rawOutput: string,
    cause?: unknown,
  ) {
    super(message, true, 'bad_output', { cause });
  }
}
