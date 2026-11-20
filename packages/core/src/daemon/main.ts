import fsSync from 'node:fs';
import { fileURLToPath } from 'node:url';
import { startDaemonHost } from './runner.js';

/** 解析守护进程独立启动脚本支持的命令行参数 */
export interface ParsedDaemonArgs {
  rootDir?: string;
  webEnabled: boolean;
  webHost: string;
  webPort: number;
  webIdleTimeoutSec: number;
}

/** 读取参数取值并在缺失时给出清晰错误 */
function requireFlagValue(argv: readonly string[], idx: number, flag: string): string {
  const val = argv[idx + 1];
  if (!val || val.startsWith('--')) {
    throw new Error(`守护进程参数 ${flag} 缺少取值`);
  }
  return val;
}

/** 解析守护进程命令行启动参数 */
export function parseDaemonArgs(argv: readonly string[]): ParsedDaemonArgs {
  let rootDir: string | undefined;
  let webEnabled = true;
  let webHost = '127.0.0.1';
  let webPort = 3000;
  let webIdleTimeoutSec = 900;

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    switch (token) {
      case '--root':
        rootDir = requireFlagValue(argv, i, '--root');
        i += 1;
        break;
      case '--host':
        webHost = requireFlagValue(argv, i, '--host');
        i += 1;
        break;
      case '--port': {
        const raw = requireFlagValue(argv, i, '--port');
        const portNum = Number(raw);
        if (!Number.isInteger(portNum) || portNum <= 0 || portNum > 65535) {
          throw new RangeError(`非法的端口参数 --port: ${raw}`);
        }
        webPort = portNum;
        i += 1;
        break;
      }
      case '--idle-sec': {
        const raw = requireFlagValue(argv, i, '--idle-sec');
        const sec = Number(raw);
        if (!Number.isInteger(sec) || sec < 10) {
          throw new RangeError(`非法的闲置休眠秒数 --idle-sec（至少 10 秒）: ${raw}`);
        }
        webIdleTimeoutSec = sec;
        i += 1;
        break;
      }
      case '--no-web':
        webEnabled = false;
        break;
      default:
        throw new Error(`未知的守护进程启动参数: ${token}`);
    }
  }

  return {
    rootDir,
    webEnabled,
    webHost,
    webPort,
    webIdleTimeoutSec,
  };
}

/** 运行极低占用后台守护进程并阻塞至收到停止信号 */
export async function runDaemonMain(
  argv: readonly string[] = process.argv.slice(2),
): Promise<void> {
  const parsed = parseDaemonArgs(argv);
  const handle = await startDaemonHost({
    rootDir: parsed.rootDir,
    webEnabled: parsed.webEnabled,
    webHost: parsed.webHost,
    webPort: parsed.webPort,
    webIdleTimeoutSec: parsed.webIdleTimeoutSec,
  });
  await handle.waitUntilStopped;
}

/** 判断当前模块是否作为独立 Node 进程入口直接执行（兼容中文路径） */
function isMainModule(metaUrl: string): boolean {
  const arg = process.argv[1];
  if (!arg) {
    return false;
  }
  try {
    return fsSync.realpathSync(fileURLToPath(metaUrl)) === fsSync.realpathSync(arg);
  } catch {
    return false;
  }
}

if (isMainModule(import.meta.url)) {
  try {
    await runDaemonMain();
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}
