import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execa } from 'execa';
import { chromium } from 'playwright';

/** 安全关闭无头浏览器实例；若优雅关闭超时则按唯一启动标识强制终止底层浏览器进程树防止残留 */
export async function closeBrowserSafely(
  browser: Awaited<ReturnType<typeof chromium.launch>> | null,
  launchToken?: string,
): Promise<void> {
  if (!browser) {
    return;
  }
  const maybeProcessGetter = (browser as unknown as { process?: () => { pid?: number } | null })
    .process;
  const browserProc =
    typeof maybeProcessGetter === 'function' ? maybeProcessGetter.call(browser) : null;
  let closedInTime = false;
  let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
  try {
    await Promise.race([
      browser
        .close()
        .then(() => {
          closedInTime = true;
        })
        .catch(() => {
          closedInTime = true;
        }),
      new Promise<void>((resolve) => {
        timeoutTimer = setTimeout(resolve, 5000);
      }),
    ]);
  } finally {
    if (timeoutTimer !== null) {
      clearTimeout(timeoutTimer);
    }
  }
  if (!closedInTime) {
    if (browserProc?.pid) {
      try {
        process.kill(browserProc.pid, 'SIGKILL');
      } catch {
        // 底层子进程已退出时忽略
      }
    }
    if (process.platform !== 'win32' && launchToken && /^[a-z0-9-]+$/i.test(launchToken)) {
      await execa('pkill', ['-9', '-f', `--aidaily-browser-token=${launchToken}`], {
        timeout: 3_000,
        reject: false,
      }).catch(() => undefined);
    }
  }
}

/** 根据操作系统返回 Playwright 默认浏览器缓存根目录与常见系统浏览器可执行路径候选 */
function getChromiumCandidatePaths(): { cacheDirs: string[]; systemBins: string[] } {
  const home = os.homedir();
  const envCache = process.env.PLAYWRIGHT_BROWSERS_PATH?.trim();
  if (process.platform === 'darwin') {
    return {
      cacheDirs: [
        ...(envCache && envCache !== '0' ? [envCache] : []),
        path.join(home, 'Library', 'Caches', 'ms-playwright'),
      ],
      systemBins: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],
    };
  }
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local');
    return {
      cacheDirs: [
        ...(envCache && envCache !== '0' ? [envCache] : []),
        path.join(localAppData, 'ms-playwright'),
      ],
      systemBins: [
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      ],
    };
  }
  return {
    cacheDirs: [
      ...(envCache && envCache !== '0' ? [envCache] : []),
      path.join(process.env.XDG_CACHE_HOME || path.join(home, '.cache'), 'ms-playwright'),
    ],
    systemBins: ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'],
  };
}

/** 返回单个 Playwright Chromium 缓存子目录中各架构对应的可执行文件路径候选 */
function getCachedBrowserExeCandidates(cacheSubDir: string): string[] {
  return [
    path.join(
      cacheSubDir,
      'chrome-mac-arm64',
      'Google Chrome for Testing.app',
      'Contents',
      'MacOS',
      'Google Chrome for Testing',
    ),
    path.join(
      cacheSubDir,
      'chrome-mac',
      'Google Chrome for Testing.app',
      'Contents',
      'MacOS',
      'Google Chrome for Testing',
    ),
    path.join(cacheSubDir, 'chrome-linux', 'chrome'),
    path.join(cacheSubDir, 'chrome-linux64', 'chrome'),
    path.join(cacheSubDir, 'chrome-win64', 'chrome.exe'),
  ];
}

/**
 * 探测可用的 Chromium 可执行程序路径：
 * 优先使用与当前 Playwright 版本完全匹配的浏览器；
 * 若当前目录缺少完整版，依次回退查找本地已缓存的 Playwright Chromium 与系统浏览器。
 */
export async function resolveChromiumExecutablePath(): Promise<string | undefined> {
  const defaultExe = chromium.executablePath();
  if (defaultExe && fsSync.existsSync(defaultExe)) {
    return defaultExe;
  }

  const { cacheDirs, systemBins } = getChromiumCandidatePaths();
  for (const cacheDir of cacheDirs) {
    try {
      const entries = await fs.readdir(cacheDir, { withFileTypes: true });
      const sorted = entries
        .filter((e) => e.isDirectory() && e.name.startsWith('chromium-'))
        .sort((a, b) => b.name.localeCompare(a.name, undefined, { numeric: true }));

      for (const dir of sorted) {
        for (const candidate of getCachedBrowserExeCandidates(path.join(cacheDir, dir.name))) {
          if (fsSync.existsSync(candidate)) {
            return candidate;
          }
        }
      }
    } catch {
      // 缓存目录不存在时继续尝试其他位置
    }
  }

  for (const sysBin of systemBins) {
    if (fsSync.existsSync(sysBin)) {
      return sysBin;
    }
  }

  return undefined;
}
