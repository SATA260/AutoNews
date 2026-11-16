import { execa } from 'execa';
import { CliNotFoundError, CliTimeoutError } from './errors.js';
import type { ExecOptions, ExecResult } from './types.js';

const MAX_BUFFER_BYTES = 16 * 1024 * 1024;
const DEFAULT_EXEC_TIMEOUT_MS = 300_000;

/** 启动并管理子进程，统一处理超时强杀、取消中断以及找不到命令的错误转换 */
export async function runSubprocess(
  bin: string,
  args: string[],
  opts: ExecOptions = {},
): Promise<ExecResult> {
  if (opts.signal?.aborted) {
    throw new DOMException('已取消', 'AbortError');
  }

  const timeoutMs = opts.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError(`非法的子进程超时时间 timeoutMs: ${String(timeoutMs)}`);
  }

  const startedAt = Date.now();
  try {
    const result = await execa(bin, args, {
      cwd: opts.cwd,
      env: opts.env,
      input: opts.stdin,
      timeout: timeoutMs,
      cancelSignal: opts.signal,
      reject: false,
      killDescendants: true,
      maxBuffer: MAX_BUFFER_BYTES,
      stdio: opts.stdio === 'inherit' ? 'inherit' : 'pipe',
    });

    if (result.isCanceled) {
      throw new DOMException('已取消', 'AbortError');
    }
    if (result.timedOut) {
      throw new CliTimeoutError(timeoutMs);
    }
    if (result.code === 'ENOENT') {
      throw new CliNotFoundError(bin);
    }

    return {
      stdout: typeof result.stdout === 'string' ? result.stdout : '',
      stderr: typeof result.stderr === 'string' ? result.stderr : '',
      exitCode: result.exitCode ?? (result.failed ? 1 : 0),
      durationMs: Math.max(0, Math.round(result.durationMs ?? Date.now() - startedAt)),
    };
  } catch (err) {
    if (err instanceof CliNotFoundError || err instanceof CliTimeoutError) {
      throw err;
    }
    if (err instanceof Error && err.name === 'AbortError') {
      throw err;
    }
    const errWithCode = err as { code?: string; timedOut?: boolean; isCanceled?: boolean };
    if (errWithCode.isCanceled) {
      throw new DOMException('已取消', 'AbortError');
    }
    if (errWithCode.timedOut) {
      throw new CliTimeoutError(timeoutMs, err);
    }
    if (errWithCode.code === 'ENOENT') {
      throw new CliNotFoundError(bin, err);
    }
    throw err;
  }
}
