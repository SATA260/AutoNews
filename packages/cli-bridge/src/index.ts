import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { CliConfig } from '@aidaily/contracts';
import { ModelOutputError, ModelRuntime, type ModelRuntimeOptions } from '@aidaily/model-runtime';
import { agyAdapter } from './adapters/agy.js';
import { codexAdapter } from './adapters/codex.js';
import { createConfiguredGenericAdapter, genericAdapter } from './adapters/generic.js';
import { CliNotFoundError, CliOutputError } from './errors.js';
import { runSubprocess } from './exec.js';
import type { CliAdapter, ExecOptions, ExecResult, InvokeRequest, InvokeResult } from './types.js';

export const CLI_BRIDGE_VERSION = '0.1.0';

export * from './adapters/agy.js';
export * from './adapters/codex.js';
export * from './adapters/generic.js';
export * from './errors.js';
export * from './exec.js';
export * from './json.js';
export * from './semaphore.js';
export * from './types.js';

/** 命令行调用调度中心（CliBridge）的初始化选项 */
export interface CliBridgeOptions extends ModelRuntimeOptions {
  configs: Record<string, CliConfig>;
  tmpDir: string;
}

/** 将共享校验异常转换为原有 CLI 错误类型 */
function asCliError(err: unknown): unknown {
  return err instanceof ModelOutputError
    ? new CliOutputError(err.message, err.issuesSummary, err.rawOutput, err.cause)
    : err;
}

/**
 * 通用外部命令行统一调度器：负责适配器分发、并发数限制、临时空目录隔离、失败自动重试与调用日志记录。
 */
export class CliBridge {
  private configs: Record<string, CliConfig>;
  private readonly tmpDir: string;
  private readonly adapters = new Map<string, CliAdapter>();
  private readonly runtime: ModelRuntime;

  constructor(opts: CliBridgeOptions) {
    this.configs = { ...opts.configs };
    this.tmpDir = opts.tmpDir;
    this.runtime = new ModelRuntime(opts);

    this.register(agyAdapter);
    this.register(codexAdapter);
    this.register(genericAdapter);
  }

  /** 热更新内存中的命令行工具配置映射 */
  updateConfigs(nextConfigs: Record<string, CliConfig>): void {
    this.configs = { ...nextConfigs };
  }

  /** 注册或替换命令行适配器 */
  register(adapter: CliAdapter): void {
    this.adapters.set(adapter.id, adapter);
  }

  /** 查找已注册的命令行配置，未找到则抛出 CliNotFoundError */
  private getCliConfig(cliName: string): CliConfig {
    const cfg = this.configs[cliName];
    if (!cfg) {
      throw new CliNotFoundError(cliName);
    }
    return cfg;
  }

  /** 根据命令行配置选取并组装对应的适配器实例 */
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

  /** 在隔离目录中执行模型命令，允许按本期配置快照指定工具 */
  async invoke<T>(
    req: InvokeRequest<T>,
    config?: CliConfig,
    maxConcurrentCalls?: number,
  ): Promise<InvokeResult<T>> {
    const cfg = config ?? this.getCliConfig(req.cli);
    const adapter = this.resolveAdapter(cfg);
    try {
      return await this.runtime.invoke(
        req,
        async (attempt, trace) => {
          const workDir = path.join(this.tmpDir, 'cli-bridge', crypto.randomUUID());
          await fs.mkdir(workDir, { recursive: true, mode: 0o700 });
          try {
            const cmd = await adapter.buildCommand(attempt, cfg, workDir);
            trace.args = cmd.args;
            const result = await runSubprocess(cmd.bin, cmd.args, {
              cwd: workDir,
              env: cmd.env,
              stdin: cmd.stdin,
              timeoutMs: attempt.timeoutMs,
              signal: attempt.signal,
              stdio: 'pipe',
            });
            trace.durationMs = result.durationMs;
            trace.rawStderr = result.stderr;
            const outFileContent = cmd.outFile
              ? await fs.readFile(cmd.outFile, 'utf8').catch(() => undefined)
              : undefined;
            trace.rawStdout = outFileContent ?? result.stdout;

            const output = adapter.parse(result.stdout, result.stderr, result.exitCode, {
              hasSchema: Boolean(attempt.schema),
              outFileContent,
            });
            return cmd.normalizeOutput
              ? { ...output, payload: cmd.normalizeOutput(output.payload) }
              : output;
          } finally {
            await fs.rm(workDir, { recursive: true, force: true }).catch(() => undefined);
          }
        },
        maxConcurrentCalls,
      );
    } catch (err) {
      throw asCliError(err);
    }
  }

  /** 直接执行通用非大模型外部命令（例如 B 站投稿工具、系统定时任务管理命令等） */
  async exec(cli: string, args: string[], opts: ExecOptions = {}): Promise<ExecResult> {
    const cfg = this.getCliConfig(cli);
    return runSubprocess(cfg.bin, [...cfg.extraArgs, ...args], opts);
  }

  /** 检查指定命令行工具的健康可用状态 */
  async health(cli: string): Promise<{ ok: boolean; detail: string }> {
    const cfg = this.configs[cli];
    if (!cfg) {
      return { ok: false, detail: `未配置 CLI: ${cli}` };
    }
    const adapter = this.resolveAdapter(cfg);
    return adapter.healthcheck(cfg);
  }

  /** 获取指定命令行工具支持的模型名称列表 */
  async listModels(cli: string): Promise<string[]> {
    const cfg = this.getCliConfig(cli);
    const adapter = this.resolveAdapter(cfg);
    if (!adapter.listModels) {
      return [];
    }
    return adapter.listModels(cfg);
  }
}
