import fs from 'node:fs';
import path from 'node:path';

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
  runDir: (runId: string) => string;
}

const SAFE_ID_PATTERN = /^[a-zA-Z0-9._-]+$/;

/**
 * Walk upward from `startDir` until a directory containing `config/settings.yaml` is found.
 */
export function findRepoRoot(startDir: string = process.cwd()): string {
  let current = path.resolve(startDir);
  while (true) {
    const candidate = path.join(current, 'config', 'settings.yaml');
    if (fs.existsSync(candidate)) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      throw new Error(`未找到包含 config/settings.yaml 的项目根目录（起始目录: ${startDir}）`);
    }
    current = parent;
  }
}

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

/**
 * Resolve an artifact path inside `runsDir/<runId>` safely, blocking directory traversal.
 */
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
  return resolvedTarget;
}
