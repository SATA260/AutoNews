import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';

export function buildProgram(): Command {
  const program = new Command();
  program.name('aidaily').description('AI 每日报自动化视频工作流 CLI').version('0.1.0');
  return program;
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
  await buildProgram().parseAsync(process.argv);
}
