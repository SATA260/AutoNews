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
    if (launchToken && /^[a-z0-9-]+$/i.test(launchToken)) {
      await execa('pkill', ['-9', '-f', `--aidaily-browser-token=${launchToken}`], {
        timeout: 3_000,
        reject: false,
      }).catch(() => undefined);
    }
  }
}

/**
 * 探测可用的 Chromium 可执行程序路径：
 * 优先使用与当前 Playwright 版本完全匹配的浏览器；
 * 若当前目录缺少完整版，依次回退查找本地已缓存的 Playwright Chromium 与系统 Google Chrome。
 */
export async function resolveChromiumExecutablePath(): Promise<string | undefined> {
  const defaultExe = chromium.executablePath();
  if (defaultExe && fsSync.existsSync(defaultExe)) {
    return defaultExe;
  }

  const cacheDir = path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright');
  try {
    const entries = await fs.readdir(cacheDir, { withFileTypes: true });
    const sorted = entries
      .filter((e) => e.isDirectory() && e.name.startsWith('chromium-'))
      .sort((a, b) => b.name.localeCompare(a.name, undefined, { numeric: true }));

    for (const dir of sorted) {
      const armExe = path.join(
        cacheDir,
        dir.name,
        'chrome-mac-arm64',
        'Google Chrome for Testing.app',
        'Contents',
        'MacOS',
        'Google Chrome for Testing',
      );
      if (fsSync.existsSync(armExe)) {
        return armExe;
      }
      const x64Exe = path.join(
        cacheDir,
        dir.name,
        'chrome-mac',
        'Google Chrome for Testing.app',
        'Contents',
        'MacOS',
        'Google Chrome for Testing',
      );
      if (fsSync.existsSync(x64Exe)) {
        return x64Exe;
      }
    }
  } catch {
    // 缓存目录不存在时继续尝试系统安装的浏览器
  }

  const systemChrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  if (fsSync.existsSync(systemChrome)) {
    return systemChrome;
  }

  return undefined;
}
