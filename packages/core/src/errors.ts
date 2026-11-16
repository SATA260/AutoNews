import type { ErrorCode } from '@aidaily/contracts';

/**
 * 带标准错误码的流程执行异常，便于主执行器统一识别故障类型并记录状态。
 */
export class PipelineError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'PipelineError';
    this.code = code;
  }
}
