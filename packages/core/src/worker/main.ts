import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

/** 独立后台子进程主入口，用于在网页后台触发任务后脱离主进程长期运行 */
export async function runWorkerMain(): Promise<void> {
  // 后续在此解析 --run-id 与 --action 并调用核心任务执行器
}

/** 判断当前文件是否作为独立 Node 脚本直接启动（兼容中文路径） */
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
