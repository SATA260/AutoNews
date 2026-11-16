import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
 * 会等待系统确认子进程已成功拉起并拿到进程号后再返回，防止异步启动报错变为未捕获异常。
 */
export async function spawnDetachedWorker(
  args: string[],
  opts: { rootDir: string; logFile: string },
): Promise<{ pid: number | undefined }> {
  const scriptPath = resolveWorkerScriptPath(opts.rootDir);
  fs.mkdirSync(path.dirname(opts.logFile), { recursive: true });
  const outFd = fs.openSync(opts.logFile, 'a');
  const errFd = fs.openSync(opts.logFile, 'a');
  try {
    const child = spawn(process.execPath, [scriptPath, ...args], {
      cwd: opts.rootDir,
      detached: true,
      stdio: ['ignore', outFd, errFd],
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

    child.unref();
    return { pid: child.pid };
  } finally {
    fs.closeSync(outFd);
    fs.closeSync(errFd);
  }
}
