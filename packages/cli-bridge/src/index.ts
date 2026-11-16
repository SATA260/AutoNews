import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { CliConfig, LlmCallStatus } from '@aidaily/contracts';
import { agyAdapter } from './adapters/agy.js';
import { createConfiguredGenericAdapter, genericAdapter } from './adapters/generic.js';
import {
  CliAuthError,
  CliBridgeError,
  CliNotFoundError,
  CliOutputError,
  CliTimeoutError,
} from './errors.js';
import { runSubprocess } from './exec.js';
import { validateWithSchema } from './json.js';
import { Semaphore } from './semaphore.js';
import type {
  CallRecord,
  CliAdapter,
  ExecOptions,
  ExecResult,
  InvokeRequest,
  InvokeResult,
} from './types.js';

export const CLI_BRIDGE_VERSION = '0.1.0';

export * from './adapters/agy.js';
export * from './adapters/generic.js';
export * from './errors.js';
export * from './exec.js';
export * from './json.js';
export * from './semaphore.js';
export * from './types.js';

export interface CliBridgeOptions {
  configs: Record<string, CliConfig>;
  tmpDir: string;
  maxConcurrentCalls?: number;
  retryDelaysMs?: readonly number[];
  logCall?: (record: CallRecord) => Promise<void> | void;
}

const DEFAULT_RETRY_DELAYS_MS = [2000, 8000, 20000] as const;

async function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) {
    return;
  }
  if (signal?.aborted) {
    throw new DOMException('已取消', 'AbortError');
  }
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException('已取消', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function classifyErrorStatus(err: unknown): LlmCallStatus {
  if (err instanceof CliTimeoutError) {
    return 'timeout';
  }
  if (err instanceof CliAuthError) {
    return 'auth_error';
  }
  if (err instanceof CliOutputError) {
    return 'bad_output';
  }
  return 'exit_error';
}

export class CliBridge {
  private readonly configs: Record<string, CliConfig>;
  private readonly tmpDir: string;
  private readonly adapters = new Map<string, CliAdapter>();
  private readonly semaphores = new Map<string, Semaphore>();
  private readonly maxConcurrentCalls: number;
  private readonly retryDelaysMs: readonly number[];
  private readonly logCall?: (record: CallRecord) => Promise<void> | void;

  constructor(opts: CliBridgeOptions) {
    this.configs = opts.configs;
    this.tmpDir = opts.tmpDir;
    this.maxConcurrentCalls = opts.maxConcurrentCalls ?? 3;
    this.retryDelaysMs = opts.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
    this.logCall = opts.logCall;

    this.register(agyAdapter);
    this.register(genericAdapter);
  }

  register(adapter: CliAdapter): void {
    this.adapters.set(adapter.id, adapter);
  }

  private getCliConfig(cliName: string): CliConfig {
    const cfg = this.configs[cliName];
    if (!cfg) {
      throw new CliNotFoundError(cliName);
    }
    return cfg;
  }

  private resolveAdapter(cfg: CliConfig): CliAdapter {
    if (cfg.adapter === 'generic' && (cfg.argsTemplate || cfg.parse)) {
      return createConfiguredGenericAdapter(cfg);
    }
    const adapter = this.adapters.get(cfg.adapter);
    if (!adapter) {
      throw new Error(`未注册 CLI 适配器: ${cfg.adapter}`);
    }
    return adapter;
  }

  private getSemaphore(cliName: string): Semaphore {
    let sem = this.semaphores.get(cliName);
    if (!sem) {
      sem = new Semaphore(this.maxConcurrentCalls);
      this.semaphores.set(cliName, sem);
    }
    return sem;
  }

  async invoke<T>(req: InvokeRequest<T>): Promise<InvokeResult<T>> {
    const cfg = this.getCliConfig(req.cli);
    const adapter = this.resolveAdapter(cfg);
    const sem = this.getSemaphore(req.cli);

    let currentPrompt = req.prompt;
    let totalDurationMs = 0;
    const maxAttempts = 1 + Math.max(0, req.retries);

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (req.signal?.aborted) {
        throw new DOMException('已取消', 'AbortError');
      }

      const workDir = path.join(this.tmpDir, 'cli-bridge', crypto.randomUUID());
      await fs.mkdir(workDir, { recursive: true });

      let rawStdout = '';
      let rawStderr = '';
      let commandArgs: string[] = [];
      let callDurationMs = 0;
      const attemptStartedAt = Date.now();

      try {
        const result = await sem.run(async () => {
          const attemptReq: InvokeRequest<unknown> = {
            ...req,
            prompt: currentPrompt,
          };
          const cmd = await adapter.buildCommand(attemptReq, cfg, workDir);
          commandArgs = cmd.args;

          const execRes = await runSubprocess(cmd.bin, cmd.args, {
            cwd: workDir,
            env: cmd.env,
            stdin: cmd.stdin,
            timeoutMs: req.timeoutMs,
            signal: req.signal,
            stdio: 'pipe',
          });

          rawStdout = execRes.stdout;
          rawStderr = execRes.stderr;
          callDurationMs = execRes.durationMs;

          let outFileContent: string | undefined;
          if (cmd.outFile) {
            outFileContent = await fs.readFile(cmd.outFile, 'utf8').catch(() => undefined);
          }

          const parsedOut = adapter.parse(execRes.stdout, execRes.stderr, execRes.exitCode, {
            hasSchema: Boolean(req.schema),
            outFileContent,
          });

          const validatedData = req.schema
            ? validateWithSchema(parsedOut.payload, req.schema, execRes.stdout)
            : (parsedOut.payload as T);

          return {
            data: validatedData,
            usage: parsedOut.usage,
            conversationId: parsedOut.conversationId,
          };
        });

        totalDurationMs += callDurationMs;
        await this.logCall?.({
          runId: req.meta?.runId,
          stage: req.meta?.stage,
          itemId: req.meta?.itemId,
          cli: req.cli,
          model: req.model,
          attempt,
          status: 'ok',
          durationMs: callDurationMs,
          inputTokens: result.usage?.inputTokens,
          outputTokens: result.usage?.outputTokens,
          conversationId: result.conversationId,
          prompt: currentPrompt,
          args: commandArgs,
          rawStdout,
          rawStderr,
          parsed: result.data,
          createdAt: new Date().toISOString(),
        });

        return {
          data: result.data,
          rawStdout,
          durationMs: totalDurationMs,
          attempts: attempt,
          usage: result.usage,
          conversationId: result.conversationId,
        };
      } catch (err) {
        const elapsed = callDurationMs || Math.max(0, Date.now() - attemptStartedAt);
        totalDurationMs += elapsed;

        if (!(err instanceof Error && err.name === 'AbortError')) {
          await this.logCall?.({
            runId: req.meta?.runId,
            stage: req.meta?.stage,
            itemId: req.meta?.itemId,
            cli: req.cli,
            model: req.model,
            attempt,
            status: classifyErrorStatus(err),
            durationMs: elapsed,
            prompt: currentPrompt,
            args: commandArgs,
            rawStdout,
            rawStderr,
            error: err instanceof Error ? err.message : String(err),
            createdAt: new Date().toISOString(),
          });
        }

        const retryable = err instanceof CliBridgeError && err.retryable;
        if (!retryable || attempt >= maxAttempts) {
          throw err;
        }

        if (err instanceof CliOutputError) {
          currentPrompt = `${req.prompt}\n\n[上次输出格式校验失败，请严格按 JSON Schema 修正以下问题后重新输出]: ${err.issuesSummary}`;
        }

        const delay =
          this.retryDelaysMs[Math.min(attempt - 1, this.retryDelaysMs.length - 1)] ?? 2000;
        await sleepWithAbort(delay, req.signal);
      } finally {
        await fs.rm(workDir, { recursive: true, force: true }).catch(() => undefined);
      }
    }

    throw new Error('invoke 循环意外结束');
  }

  async exec(cli: string, args: string[], opts: ExecOptions = {}): Promise<ExecResult> {
    const cfg = this.getCliConfig(cli);
    return runSubprocess(cfg.bin, [...cfg.extraArgs, ...args], opts);
  }

  async health(cli: string): Promise<{ ok: boolean; detail: string }> {
    const cfg = this.configs[cli];
    if (!cfg) {
      return { ok: false, detail: `未配置 CLI: ${cli}` };
    }
    const adapter = this.resolveAdapter(cfg);
    return adapter.healthcheck(cfg);
  }

  async listModels(cli: string): Promise<string[]> {
    const cfg = this.getCliConfig(cli);
    const adapter = this.resolveAdapter(cfg);
    if (!adapter.listModels) {
      return [];
    }
    return adapter.listModels(cfg);
  }
}
