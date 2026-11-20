import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { GlobalCliStatus } from '@aidaily/contracts';
import { writeFileAtomic } from '../storage/files.js';

const MANAGED_CLI_MARKER = '# managed-by: aidaily-global-cli';

/** 全局命令行安装目录解析选项 */
export interface GlobalCliOptions {
  rootDir: string;
  binDir?: string;
  cliScriptPath?: string;
  nodePath?: string;
  pathEnv?: string;
}

/** 将文件路径包装为 POSIX Shell 安全的单引号转义字面量 */
function quotePosixShell(raw: string): string {
  return `'${raw.replace(/'/g, "'\\''")}'`;
}

/** 解析当前用户主目录（优先读取环境变量 HOME 以适配不同会话和隔离运行环境） */
function resolveHomeDir(): string {
  return process.env.HOME?.trim() || os.homedir();
}

/** 解析默认的本地用户命令安装目录（`~/.local/bin`） */
export function resolveDefaultGlobalBinDir(): string {
  return process.env.AIDAILY_GLOBAL_BIN_DIR?.trim() || path.join(resolveHomeDir(), '.local', 'bin');
}

/** 解析命令行打包入口脚本的绝对路径，找不到时回退到当前代码所在仓库的产物路径 */
export function resolveCliEntryScript(rootDir: string, overridePath?: string): string {
  if (overridePath) {
    return path.resolve(overridePath);
  }
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(path.resolve(rootDir), 'apps', 'cli', 'dist', 'index.js'),
    path.resolve(moduleDir, '../../../../apps/cli/dist/index.js'),
    path.resolve(moduleDir, '../../../apps/cli/dist/index.js'),
    path.resolve(moduleDir, '../../apps/cli/dist/index.js'),
  ];
  for (const candidate of candidates) {
    if (fsSync.existsSync(candidate)) {
      return candidate;
    }
  }
  return candidates[0] ?? path.join(path.resolve(rootDir), 'apps', 'cli', 'dist', 'index.js');
}

/** 检查指定命令目录是否已包含在当前环境 `PATH` 变量中 */
export function isDirInPath(
  dirPath: string,
  pathEnv: string | undefined = process.env.PATH,
): boolean {
  if (!pathEnv) {
    return false;
  }
  const normalizedTarget = path.resolve(dirPath);
  return pathEnv
    .split(path.delimiter)
    .filter(Boolean)
    .some((entry) => path.resolve(entry) === normalizedTarget);
}

/** 读取本机全局 `aidaily` 命令的注册状态、脚本指向与 `PATH` 可见性 */
export async function getGlobalCliStatus(opts: GlobalCliOptions): Promise<GlobalCliStatus> {
  const repoRoot = path.resolve(opts.rootDir);
  const binDir = path.resolve(opts.binDir ?? resolveDefaultGlobalBinDir());
  const binPath = path.join(binDir, 'aidaily');
  const targetScriptPath = resolveCliEntryScript(repoRoot, opts.cliScriptPath);

  let installed = false;
  let managedBySelf = false;
  try {
    const stat = await fs.lstat(binPath);
    if (stat.isFile() || stat.isSymbolicLink()) {
      installed = true;
      const content = await fs.readFile(binPath, 'utf8').catch(() => '');
      managedBySelf = content.includes(MANAGED_CLI_MARKER);
    }
  } catch {
    installed = false;
    managedBySelf = false;
  }

  return {
    installed,
    managedBySelf,
    binPath,
    targetScriptPath,
    repoRoot,
    inPath: isDirInPath(binDir, opts.pathEnv),
  };
}

/**
 * 将 `aidaily` 全局注册到本地命令目录（默认 `~/.local/bin/aidaily`），
 * 绑定当前项目根目录与 Node.js 运行时，使终端在任意目录均可直接启动。
 */
export async function installGlobalCli(opts: GlobalCliOptions): Promise<GlobalCliStatus> {
  const repoRoot = path.resolve(opts.rootDir);
  const binDir = path.resolve(opts.binDir ?? resolveDefaultGlobalBinDir());
  const binPath = path.join(binDir, 'aidaily');
  const targetScriptPath = resolveCliEntryScript(repoRoot, opts.cliScriptPath);
  const nodePath = path.resolve(opts.nodePath ?? process.execPath);

  if (!fsSync.existsSync(targetScriptPath)) {
    throw new Error(
      `未找到已构建的命令行入口文件（请先在项目目录执行 npm run build）：${targetScriptPath}`,
    );
  }

  try {
    const existingStat = await fs.lstat(binPath);
    if (existingStat.isDirectory()) {
      throw new Error(`目标安装路径已被同名目录占用，无法写入全局命令：${binPath}`);
    }
    const existingText = await fs.readFile(binPath, 'utf8').catch(() => '');
    const pointsToSameScript = existingText.includes(targetScriptPath);
    if (!existingText.includes(MANAGED_CLI_MARKER) && !pointsToSameScript) {
      throw new Error(`目标路径已存在非本项目创建的命令文件，请先确认或清理：${binPath}`);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw err;
    }
  }

  const launcherScript = [
    '#!/bin/sh',
    MANAGED_CLI_MARKER,
    `# repo-root: ${repoRoot}`,
    'set -eu',
    `NODE_BIN="\${AIDAILY_NODE_BIN:-${quotePosixShell(nodePath).slice(1, -1)}}"`,
    'if [ ! -x "$NODE_BIN" ]; then',
    '  NODE_BIN="$(command -v node || true)"',
    'fi',
    'if [ -z "$NODE_BIN" ]; then',
    '  echo "错误：未找到可用的 Node.js 运行时（需要 Node.js >= 24）" >&2',
    '  exit 127',
    'fi',
    `export AIDAILY_ROOT="\${AIDAILY_ROOT:-${quotePosixShell(repoRoot).slice(1, -1)}}"`,
    `exec "$NODE_BIN" ${quotePosixShell(targetScriptPath)} "$@"`,
    '',
  ].join('\n');

  await writeFileAtomic(binPath, launcherScript, { mode: 0o755 });
  return getGlobalCliStatus(opts);
}

/** 卸载由本项目注册的全局 `aidaily` 启动命令 */
export async function uninstallGlobalCli(
  opts: GlobalCliOptions,
): Promise<{ removed: boolean; binPath: string }> {
  const binDir = path.resolve(opts.binDir ?? resolveDefaultGlobalBinDir());
  const binPath = path.join(binDir, 'aidaily');

  let content = '';
  try {
    content = await fs.readFile(binPath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { removed: false, binPath };
    }
    throw err;
  }

  if (!content.includes(MANAGED_CLI_MARKER)) {
    throw new Error(`目标文件不是由本项目注册的全局命令，已跳过移除：${binPath}`);
  }

  await fs.rm(binPath, { force: true });
  return { removed: true, binPath };
}
