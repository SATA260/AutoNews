import type { CliConfig, LlmCallStatus, LlmStage } from '@aidaily/contracts';
import type { z } from 'zod';

export interface InvokeMeta {
  runId?: string;
  stage?: LlmStage;
  itemId?: string;
}

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

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface InvokeResult<T> {
  data: T;
  rawStdout: string;
  durationMs: number;
  attempts: number;
  usage?: TokenUsage;
  conversationId?: string;
}

export interface AdapterCommand {
  bin: string;
  args: string[];
  stdin?: string;
  env?: Record<string, string>;
  outFile?: string;
}

export interface AdapterParsedOutput {
  payload: unknown;
  usage?: TokenUsage;
  conversationId?: string;
}

export interface CliAdapter {
  id: string;
  buildCommand(
    req: InvokeRequest<unknown>,
    cfg: CliConfig,
    workDir: string,
  ): Promise<AdapterCommand> | AdapterCommand;
  parse(
    stdout: string,
    stderr: string,
    exitCode: number,
    ctx: { hasSchema: boolean; outFileContent?: string },
  ): AdapterParsedOutput;
  healthcheck(cfg: CliConfig): Promise<{ ok: boolean; detail: string }>;
  listModels?(cfg: CliConfig): Promise<string[]>;
}

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

export interface ExecOptions {
  cwd?: string;
  env?: Record<string, string>;
  stdin?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  stdio?: 'pipe' | 'inherit';
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
}
