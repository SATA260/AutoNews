import { execa } from 'execa';
import { CliNotFoundError, CliTimeoutError } from './errors.js';
import type { ExecOptions, ExecResult } from './types.js';

const MAX_BUFFER_BYTES = 16 * 1024 * 1024;

export async function runSubprocess(
  bin: string,
  args: string[],
  opts: ExecOptions = {},
): Promise<ExecResult> {
  if (opts.signal?.aborted) {
    throw new DOMException('已取消', 'AbortError');
  }

  const startedAt = Date.now();
  try {
    const result = await execa(bin, args, {
      cwd: opts.cwd,
      env: opts.env,
      input: opts.stdin,
      timeout: opts.timeoutMs && opts.timeoutMs > 0 ? opts.timeoutMs : 0,
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
      throw new CliTimeoutError(opts.timeoutMs ?? 0);
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
      throw new CliTimeoutError(opts.timeoutMs ?? 0, err);
    }
    if (errWithCode.code === 'ENOENT') {
      throw new CliNotFoundError(bin, err);
    }
    throw err;
  }
}
