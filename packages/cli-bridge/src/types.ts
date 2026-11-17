import type { CliConfig } from '@aidaily/contracts';
import type { InvokeRequest, TokenUsage } from '@aidaily/model-runtime';

export type {
  CallRecord,
  InvokeMeta,
  InvokeRequest,
  InvokeResult,
  TokenUsage,
} from '@aidaily/model-runtime';

/** 适配器拼装出来的实际子进程命令行参数与环境 */
export interface AdapterCommand {
  bin: string;
  args: string[];
  stdin?: string;
  env?: Record<string, string>;
  outFile?: string;
  normalizeOutput?: (payload: unknown) => unknown;
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
