import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

// 独立 worker 进程入口（M8 补全具体动作分发）
export async function runWorkerMain(): Promise<void> {
  // 占位入口，确保 dist/worker.mjs 可在 M0 阶段构建
}

function isMainModule(metaUrl: string): boolean {
  const arg = process.argv[1];
  if (!arg) {
    return false;
  }
  try {
    return fs.realpathSync(fileURLToPath(metaUrl)) === fs.realpathSync(arg);
  } catch {
    return false;
  }
}

if (isMainModule(import.meta.url)) {
  await runWorkerMain();
}
