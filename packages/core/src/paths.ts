import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 项目中各类配置文件、数据库与任务运行产物的标准路径集合 */
export interface RepoPaths {
  rootDir: string;
  configDir: string;
  settingsFile: string;
  sourcesFile: string;
  storageDir: string;
  dbFile: string;
  articlesDir: string;
  imagesDir: string;
  ttsCacheDir: string;
  tmpDir: string;
  secretsDir: string;
  logsDir: string;
  runsDir: string;
  /** 根据任务 ID 生成该期任务专属产物目录的绝对路径 */
  runDir: (runId: string) => string;
}

const SAFE_ID_PATTERN = /^[a-zA-Z0-9._-]+$/;

/** 从指定目录向上逐级尝试查找包含 `config/settings.yaml` 的项目根目录，找不到返回 null */
export function tryFindRepoRoot(startDir: string): string | null {
  let current = path.resolve(startDir);
  while (true) {
    const candidate = path.join(current, 'config', 'settings.yaml');
    if (fs.existsSync(candidate)) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

/** 从指定目录向上逐级查找包含 `config/settings.yaml` 的项目根目录 */
export function findRepoRoot(startDir: string = process.cwd()): string {
  const found = tryFindRepoRoot(startDir);
  if (!found) {
    throw new Error(`未找到包含 config/settings.yaml 的项目根目录（起始目录: ${startDir}）`);
  }
  return found;
}

/**
 * 解析当前默认使用的项目根目录：
 * 优先读取 `AIDAILY_ROOT` 环境变量，其次从当前工作目录向上查找，
 * 若从仓库外全局命令启动，则按代码实际安装路径回溯定位项目根目录。
 */
export function resolveDefaultRepoRoot(opts?: {
  cwd?: string;
  envRoot?: string;
  moduleUrl?: string;
}): string {
  const envRoot = (opts?.envRoot ?? process.env.AIDAILY_ROOT)?.trim();
  if (envRoot) {
    const resolvedEnv = path.resolve(envRoot);
    if (fs.existsSync(path.join(resolvedEnv, 'config', 'settings.yaml'))) {
      return resolvedEnv;
    }
    throw new Error(`环境变量 AIDAILY_ROOT 指向的目录缺少 config/settings.yaml: ${resolvedEnv}`);
  }

  const cwd = opts?.cwd ?? process.cwd();
  const fromCwd = tryFindRepoRoot(cwd);
  if (fromCwd) {
    return fromCwd;
  }

  const targetUrl = opts?.moduleUrl ?? import.meta.url;
  try {
    const modulePath = fs.realpathSync(fileURLToPath(targetUrl));
    const fromInstall = tryFindRepoRoot(path.dirname(modulePath));
    if (fromInstall) {
      return fromInstall;
    }
  } catch {
    // 忽略虚拟 URL 或无法解析真实路径的情况，走统一错误提示
  }

  throw new Error(`未找到包含 config/settings.yaml 的项目根目录（起始目录: ${cwd}）`);
}

/** 根据项目根目录拼装配置、数据库、缓存与任务目录的完整路径映射 */
export function resolveRepoPaths(rootDir: string): RepoPaths {
  const resolvedRoot = path.resolve(rootDir);
  const configDir = path.join(resolvedRoot, 'config');
  const storageDir = path.join(resolvedRoot, 'storage');
  const runsDir = path.join(storageDir, 'runs');

  return {
    rootDir: resolvedRoot,
    configDir,
    settingsFile: path.join(configDir, 'settings.yaml'),
    sourcesFile: path.join(configDir, 'sources.yaml'),
    storageDir,
    dbFile: path.join(storageDir, 'state.sqlite'),
    articlesDir: path.join(storageDir, 'articles'),
    imagesDir: path.join(storageDir, 'images'),
    ttsCacheDir: path.join(storageDir, 'tts-cache'),
    tmpDir: path.join(storageDir, 'tmp'),
    secretsDir: path.join(storageDir, 'secrets'),
    logsDir: path.join(storageDir, 'logs'),
    runsDir,
    runDir: (runId: string) => {
      if (!SAFE_ID_PATTERN.test(runId) || runId === '.' || runId === '..') {
        throw new Error(`非法的任务 ID: ${runId}`);
      }
      return path.join(runsDir, runId);
    },
  };
}

/** 解析目标路径及其已存在最近祖先的真实物理路径，拦截通过软链接逃逸目录 */
function resolveRealContainmentPath(targetPath: string): string {
  const unresolvedSuffix: string[] = [];
  let cursor = path.resolve(targetPath);
  while (true) {
    try {
      const real = fs.realpathSync(cursor);
      return unresolvedSuffix.length > 0 ? path.join(real, ...unresolvedSuffix.reverse()) : real;
    } catch {
      const parent = path.dirname(cursor);
      if (parent === cursor) {
        return path.resolve(targetPath);
      }
      unresolvedSuffix.push(path.basename(cursor));
      cursor = parent;
    }
  }
}

/** 安全解析某期任务目录内部的产物文件路径，防止通过 `../` 或软链接越界访问外部文件 */
export function resolveSafeArtifactPath(runsDir: string, runId: string, relPath: string): string {
  if (!SAFE_ID_PATTERN.test(runId) || runId === '.' || runId === '..') {
    throw new Error(`非法的任务 ID: ${runId}`);
  }
  if (!relPath || relPath.includes('\0')) {
    throw new Error(`非法的产物路径: ${relPath}`);
  }
  const normalizedRel = relPath.replace(/^\/+/, '');
  const baseRunDir = path.resolve(runsDir, runId);
  const resolvedTarget = path.resolve(baseRunDir, normalizedRel);
  if (!resolvedTarget.startsWith(`${baseRunDir}${path.sep}`)) {
    throw new Error(`禁止访问任务目录之外的路径: ${relPath}`);
  }

  const realBaseDir = resolveRealContainmentPath(baseRunDir);
  const realTarget = resolveRealContainmentPath(resolvedTarget);
  if (!realTarget.startsWith(`${realBaseDir}${path.sep}`)) {
    throw new Error(`禁止通过软链接访问任务目录之外的路径: ${relPath}`);
  }
  return resolvedTarget;
}
