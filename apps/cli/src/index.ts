import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';

/** 构建 `aidaily` 命令行程序的根命令与参数解析器 */
export function buildProgram(): Command {
  const program = new Command();
  program.name('aidaily').description('AI 每日报自动化视频工作流命令行工具').version('0.1.0');
  return program;
}

/** 判断当前文件是否直接作为可执行入口脚本启动（兼容含中文的路径对比） */
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
  await buildProgram().parseAsync(process.argv);
}
