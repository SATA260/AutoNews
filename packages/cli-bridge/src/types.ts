import type { CliConfig, LlmCallStatus, LlmStage } from '@aidaily/contracts';
import type { z } from 'zod';

/** 关联的任务追踪信息，用于记录每次命令行调用属于哪一期任务和哪条新闻 */
export interface InvokeMeta {
  runId?: string;
  stage?: LlmStage;
  itemId?: string;
}

/** 发起一次模型命令行调用所需的请求参数 */
export interface InvokeRequest<T> {
  cli: string;
  prompt: string;
  schema?: z.ZodType<T>;
  model?: string;
  timeoutMs: number;
  retries: number;
  signal?: AbortSignal;
  meta?: InvokeMeta;
}

/** 单次模型调用消耗的输入与输出 Token 数量 */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

/** 模型命令行调用成功后的标准化返回结果 */
export interface InvokeResult<T> {
  data: T;
  rawStdout: string;
  durationMs: number;
  attempts: number;
  usage?: TokenUsage;
  conversationId?: string;
}

/** 适配器拼装出来的实际子进程命令行参数与环境 */
export interface AdapterCommand {
  bin: string;
  args: string[];
  stdin?: string;
  env?: Record<string, string>;
  outFile?: string;
}

/** 适配器从命令行输出中解析出的数据主体与附带统计信息 */
export interface AdapterParsedOutput {
  payload: unknown;
  usage?: TokenUsage;
  conversationId?: string;
}

/** 外部命令行工具适配器接口，用于屏蔽不同命令行的传参方式与返回格式差异 */
export interface CliAdapter {
  id: string;
  /** 根据请求内容、配置和临时工作目录构造要运行的命令行参数 */
  buildCommand(
    req: InvokeRequest<unknown>,
    cfg: CliConfig,
    workDir: string,
  ): Promise<AdapterCommand> | AdapterCommand;
  /** 解析子进程的标准输出、错误输出和退出码，提取目标数据或抛出标准异常 */
  parse(
    stdout: string,
    stderr: string,
    exitCode: number,
    ctx: { hasSchema: boolean; outFileContent?: string },
  ): AdapterParsedOutput;
  /** 检查当前命令行工具是否可正常运行 */
  healthcheck(cfg: CliConfig): Promise<{ ok: boolean; detail: string }>;
  /** 可选方法：查询该命令行工具当前支持选用的模型列表 */
  listModels?(cfg: CliConfig): Promise<string[]>;
}

/** 单次命令行调用（包含失败重试）向日志系统上报的完整审计记录 */
export interface CallRecord {
  runId?: string;
  stage?: LlmStage;
  itemId?: string;
  cli: string;
  model?: string;
  attempt: number;
  status: LlmCallStatus;
  durationMs: number;
  inputTokens?: number;
  outputTokens?: number;
  conversationId?: string;
  prompt: string;
  args: string[];
  rawStdout: string;
  rawStderr: string;
  parsed?: unknown;
  error?: string;
  createdAt: string;
}

/** 通用外部命令执行参数 */
export interface ExecOptions {
  cwd?: string;
  env?: Record<string, string>;
  stdin?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  stdio?: 'pipe' | 'inherit';
}

/** 通用外部命令执行结果 */
export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
}
