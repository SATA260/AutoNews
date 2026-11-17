import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { confirmRetryStartup, type RetryReservation } from './retry-startup.js';

/** 查找后台工作进程入口脚本（`worker.mjs`）的绝对路径，兼容打包运行与源码测试环境 */
export function resolveWorkerScriptPath(rootDir: string): string {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(moduleDir, 'worker.mjs'),
    path.resolve(moduleDir, '../dist/worker.mjs'),
    path.resolve(moduleDir, '../../dist/worker.mjs'),
    path.join(path.resolve(rootDir), 'packages', 'core', 'dist', 'worker.mjs'),
    path.join(process.cwd(), 'packages', 'core', 'dist', 'worker.mjs'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  throw new Error(
    `未找到后台工作进程脚本 worker.mjs（请先运行 npm run build -w @aidaily/core，已查找路径: ${candidates.join(', ')}）`,
  );
}

/**
 * 启动脱离当前终端与请求生命周期的独立后台工作进程，并将标准输出与错误分别追加到指定日志文件。
 * 等待系统确认子进程已启动，重试操作还会等待子进程写入运行状态。
 */
export async function spawnDetachedWorker(
  args: string[],
  opts: { rootDir: string; logFile: string; retryReservation?: RetryReservation },
): Promise<{ pid: number | undefined }> {
  const scriptPath = resolveWorkerScriptPath(opts.rootDir);
  fs.mkdirSync(path.dirname(opts.logFile), { recursive: true });
  const outFd = fs.openSync(opts.logFile, 'a');
  try {
    const workerArgs = opts.retryReservation ? [...args, '--wait-for-retry-grant'] : args;
    const child = spawn(process.execPath, [scriptPath, ...workerArgs], {
      cwd: opts.rootDir,
      detached: true,
      stdio: opts.retryReservation ? ['ignore', outFd, outFd, 'ipc'] : ['ignore', outFd, outFd],
      env: process.env,
    });

    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => {
        child.off('spawn', onSpawn);
        reject(err);
      };
      const onSpawn = () => {
        child.off('error', onError);
        resolve();
      };
      child.once('error', onError);
      child.once('spawn', onSpawn);
    });

    try {
      if (opts.retryReservation) {
        await confirmRetryStartup(child, opts.retryReservation);
      }
      return { pid: child.pid };
    } finally {
      if (child.connected) {
        child.disconnect();
      }
      child.unref();
    }
  } finally {
    fs.closeSync(outFd);
  }
}
