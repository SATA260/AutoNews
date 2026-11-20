import { spawn } from 'node:child_process';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import type { DaemonWebState } from '@aidaily/contracts';

/** 网页按需网关的即时运行状态快照 */
export interface WebProxySnapshot {
  state: DaemonWebState;
  pid: number | null;
  lastActiveAt: string | null;
}

/** 内部托管的网页后端进程句柄，便于测试注入轻量替身实现 */
export interface WebBackendHandle {
  port: number;
  pid: number | null;
  stop: () => Promise<void>;
  onExit: (cb: () => void) => void;
}

/** 启动内部网页服务进程的工厂签名 */
export type WebBackendLauncher = (opts: {
  rootDir: string;
  port: number;
  logFile: string;
  startupTimeoutMs: number;
}) => Promise<WebBackendHandle>;

/** 网页按需代理网关初始化参数 */
export interface WebOnDemandProxyOptions {
  rootDir: string;
  host?: string;
  port?: number;
  idleTimeoutMs?: number;
  startupTimeoutMs?: number;
  logFile: string;
  now?: () => number;
  onStateChange?: (snapshot: WebProxySnapshot) => void;
  backendLauncher?: WebBackendLauncher;
}

const DEFAULT_IDLE_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_STARTUP_TIMEOUT_MS = 25_000;

/** 探测并返回本机回环地址上一个当前空闲可用的 TCP 端口号 */
export async function findFreeLocalPort(host = '127.0.0.1'): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, host, () => {
      const addr = probe.address();
      if (!addr || typeof addr === 'string') {
        probe.close(() => reject(new Error('无法获取空闲内部端口')));
        return;
      }
      const { port } = addr;
      probe.close((closeErr) => {
        if (closeErr) {
          reject(closeErr);
        } else {
          resolve(port);
        }
      });
    });
  });
}

/** 查找项目内已安装的 Next.js 启动脚本路径 */
export function resolveNextBinPath(rootDir: string): string {
  const candidates = [
    path.join(rootDir, 'node_modules', 'next', 'dist', 'bin', 'next'),
    path.join(rootDir, 'apps', 'web', 'node_modules', 'next', 'dist', 'bin', 'next'),
  ];
  for (const candidate of candidates) {
    if (fsSync.existsSync(candidate)) {
      return candidate;
    }
  }
  throw new Error(`未找到网页框架启动脚本（请确认已在项目根目录运行 npm install）`);
}

/** 校验网页生产包（`.next/BUILD_ID`）是否已完成构建 */
export function assertWebBuildPresent(rootDir: string): void {
  const buildIdFile = path.join(rootDir, 'apps', 'web', '.next', 'BUILD_ID');
  if (!fsSync.existsSync(buildIdFile)) {
    throw new Error('网页管理台尚未构建，请先在项目根目录执行 npm run build');
  }
}

/** 轮询等待本机回环端口进入可接收 TCP 连接状态 */
async function waitForPortReady(
  host: string,
  port: number,
  timeoutMs: number,
  hasExited: () => boolean,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (hasExited()) {
      throw new Error('网页后台进程在就绪前意外退出，请查看 web.log');
    }
    const ok = await new Promise<boolean>((resolve) => {
      const socket = net.createConnection({ host, port });
      const done = (result: boolean) => {
        socket.removeAllListeners();
        socket.destroy();
        resolve(result);
      };
      socket.setTimeout(500);
      socket.once('connect', () => done(true));
      socket.once('timeout', () => done(false));
      socket.once('error', () => done(false));
    });
    if (ok) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`等待网页后台端口 127.0.0.1:${port} 就绪超时`);
}

/** 默认的网页后端启动器：拉起生产模式 Next.js 并在闲置或关闭时优雅终止 */
export const spawnNextBackend: WebBackendLauncher = async (opts) => {
  assertWebBuildPresent(opts.rootDir);
  const nextBin = resolveNextBinPath(opts.rootDir);
  const webDir = path.join(opts.rootDir, 'apps', 'web');
  await fs.mkdir(path.dirname(opts.logFile), { recursive: true });
  const logFd = fsSync.openSync(opts.logFile, 'a');

  let exited = false;
  const exitListeners: Array<() => void> = [];

  const child = spawn(
    process.execPath,
    [nextBin, 'start', '-H', '127.0.0.1', '-p', String(opts.port)],
    {
      cwd: webDir,
      detached: false,
      stdio: ['ignore', logFd, logFd],
      env: {
        ...process.env,
        NODE_ENV: 'production',
        AIDAILY_ROOT: opts.rootDir,
      },
    },
  );
  fsSync.closeSync(logFd);

  child.once('exit', () => {
    exited = true;
    for (const cb of exitListeners.splice(0)) {
      cb();
    }
  });

  await new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('spawn', () => resolve());
  });

  try {
    await waitForPortReady('127.0.0.1', opts.port, opts.startupTimeoutMs, () => exited);
  } catch (err) {
    if (!exited) {
      child.kill('SIGTERM');
    }
    throw err;
  }

  return {
    port: opts.port,
    pid: child.pid ?? null,
    onExit(cb: () => void) {
      if (exited) {
        cb();
      } else {
        exitListeners.push(cb);
      }
    },
    async stop() {
      if (exited) {
        return;
      }
      await new Promise<void>((resolve) => {
        const forceTimer = setTimeout(() => {
          if (!exited) {
            child.kill('SIGKILL');
          }
        }, 5_000);
        child.once('exit', () => {
          clearTimeout(forceTimer);
          resolve();
        });
        child.kill('SIGTERM');
      });
    },
  };
};

/** 渲染友好的中文错误页面，提示用户如何构建或排查日志 */
function renderUnavailableHtml(message: string, logFile: string): string {
  const esc = (raw: string) =>
    raw.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return [
    '<!doctype html>',
    '<html lang="zh-CN">',
    '<head><meta charset="utf-8"><title>AI 每日报 · 网页控制台暂不可用</title></head>',
    '<body style="font-family:system-ui,sans-serif;max-width:640px;margin:48px auto;padding:24px;line-height:1.6;color:#1e293b;">',
    '<h1 style="font-size:20px;margin-bottom:12px;">网页控制台暂时无法唤醒</h1>',
    `<p style="color:#b91c1c;background:#fef2f2;padding:12px 14px;border-radius:8px;border:1px solid #fecaca;">${esc(message)}</p>`,
    `<p style="font-size:13px;color:#475569;">日志文件：<code>${esc(logFile)}</code></p>`,
    '</body></html>',
  ].join('');
}

/**
 * 极低占用的按需唤醒网页代理网关：
 * 平时仅在监听端口维持一个轻量 HTTP 服务；有浏览器访问时自动拉起内部网页服务并透明转发全部页面、表单提交、SSE 日志流与视频切片，
 * 当无活跃请求或长连接且空闲超过阈值后自动关闭网页子进程释放内存。
 */
export class WebOnDemandProxy {
  private readonly rootDir: string;
  private readonly host: string;
  private readonly requestedPort: number;
  private readonly idleTimeoutMs: number;
  private readonly startupTimeoutMs: number;
  private readonly logFile: string;
  private readonly now: () => number;
  private readonly onStateChange?: (snapshot: WebProxySnapshot) => void;
  private readonly backendLauncher: WebBackendLauncher;

  private server: http.Server | null = null;
  private listeningPort = 0;
  private backend: WebBackendHandle | null = null;
  private startPromise: Promise<WebBackendHandle> | null = null;
  private stopPromise: Promise<void> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private activeRequests = 0;
  private state: DaemonWebState = 'stopped';
  private lastActiveMs: number | null = null;
  private closed = false;

  constructor(opts: WebOnDemandProxyOptions) {
    this.rootDir = path.resolve(opts.rootDir);
    this.host = opts.host ?? '127.0.0.1';
    this.requestedPort = opts.port ?? 3000;
    this.idleTimeoutMs = Math.max(1_000, opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS);
    this.startupTimeoutMs = Math.max(1_000, opts.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS);
    this.logFile = opts.logFile;
    this.now = opts.now ?? (() => Date.now());
    this.onStateChange = opts.onStateChange;
    this.backendLauncher = opts.backendLauncher ?? spawnNextBackend;
  }

  /** 启动代理网关监听端口（此时不提前拉起网页子进程） */
  async listen(): Promise<{ host: string; port: number }> {
    if (this.server) {
      return { host: this.host, port: this.listeningPort };
    }
    const server = http.createServer((req, res) => {
      void this.handleRequest(req, res);
    });
    server.requestTimeout = 0;
    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => {
        server.off('listening', onListening);
        if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') {
          reject(
            new Error(
              `端口 ${this.host}:${this.requestedPort} 已被其他进程占用，请先关闭已有网页服务或改用其他端口`,
            ),
          );
          return;
        }
        reject(err);
      };
      const onListening = () => {
        server.off('error', onError);
        const addr = server.address();
        if (!addr || typeof addr === 'string') {
          reject(new Error('无法解析网页网关监听端口'));
          return;
        }
        this.listeningPort = addr.port;
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(this.requestedPort, this.host);
    });
    this.server = server;
    return { host: this.host, port: this.listeningPort };
  }

  /** 读取当前网页子进程状态与最近活跃时间快照 */
  getSnapshot(): WebProxySnapshot {
    return {
      state: this.state,
      pid: this.backend?.pid ?? null,
      lastActiveAt: this.lastActiveMs !== null ? new Date(this.lastActiveMs).toISOString() : null,
    };
  }

  /** 主动让空闲中的网页子进程进入休眠；若有活跃连接默认不强行中断 */
  async sleepIfIdle(force = false): Promise<boolean> {
    if (!this.backend && !this.startPromise) {
      return true;
    }
    if (!force && this.activeRequests > 0) {
      return false;
    }
    await this.stopBackend();
    return true;
  }

  /** 停止监听并安全关闭所有托管的网页子进程 */
  async close(): Promise<void> {
    this.closed = true;
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    const currentServer = this.server;
    this.server = null;
    if (currentServer) {
      await new Promise<void>((resolve) => {
        currentServer.close(() => resolve());
        currentServer.closeAllConnections?.();
      });
    }
    await this.stopBackend();
  }

  /** 触发状态变更通知回调 */
  private emitState(): void {
    this.onStateChange?.(this.getSnapshot());
  }

  /** 清除现有空闲休眠定时器 */
  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  /** 重新计算并设定空闲自动休眠定时器 */
  private scheduleIdleCheck(): void {
    this.clearIdleTimer();
    if (this.closed || !this.backend || this.activeRequests > 0) {
      return;
    }
    const lastMs = this.lastActiveMs ?? this.now();
    const remainingMs = Math.max(50, this.idleTimeoutMs - (this.now() - lastMs));
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.closed || !this.backend || this.activeRequests > 0) {
        return;
      }
      const elapsed = this.now() - (this.lastActiveMs ?? this.now());
      if (elapsed >= this.idleTimeoutMs) {
        void this.stopBackend();
      } else {
        this.scheduleIdleCheck();
      }
    }, remainingMs);
    this.idleTimer.unref?.();
  }

  /** 停止当前运行的内部网页子进程并回归休眠状态 */
  private async stopBackend(): Promise<void> {
    this.clearIdleTimer();
    if (this.stopPromise) {
      await this.stopPromise;
      return;
    }
    if (this.startPromise) {
      await this.startPromise.catch(() => null);
    }
    const target = this.backend;
    if (!target) {
      if (this.state !== 'stopped') {
        this.state = 'stopped';
        this.emitState();
      }
      return;
    }

    this.stopPromise = (async () => {
      try {
        await target.stop();
      } finally {
        if (this.backend === target) {
          this.backend = null;
        }
        this.state = 'stopped';
        this.emitState();
      }
    })();

    try {
      await this.stopPromise;
    } finally {
      this.stopPromise = null;
    }
  }

  /** 确保内部网页进程处于运行并就绪状态，并发请求自动合并为单次启动 */
  private async ensureBackendReady(): Promise<WebBackendHandle> {
    if (this.closed) {
      throw new Error('守护进程正在关闭');
    }
    if (this.stopPromise) {
      await this.stopPromise;
    }
    if (this.backend) {
      return this.backend;
    }
    if (this.startPromise) {
      return this.startPromise;
    }

    this.state = 'starting';
    this.emitState();

    const booting = (async () => {
      const internalPort = await findFreeLocalPort('127.0.0.1');
      const handle = await this.backendLauncher({
        rootDir: this.rootDir,
        port: internalPort,
        logFile: this.logFile,
        startupTimeoutMs: this.startupTimeoutMs,
      });
      handle.onExit(() => {
        if (this.backend === handle) {
          this.backend = null;
          this.clearIdleTimer();
          this.state = 'stopped';
          this.emitState();
        }
      });
      this.backend = handle;
      this.state = 'running';
      this.emitState();
      this.scheduleIdleCheck();
      return handle;
    })();

    this.startPromise = booting;
    try {
      return await booting;
    } catch (err) {
      if (!this.backend) {
        this.state = 'stopped';
        this.emitState();
      }
      throw err;
    } finally {
      if (this.startPromise === booting) {
        this.startPromise = null;
      }
    }
  }

  /** 处理单个 HTTP 请求（唤醒后端并流式透传页面、接口与实时事件流） */
  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    this.activeRequests += 1;
    this.lastActiveMs = this.now();
    this.clearIdleTimer();

    let settled = false;
    const finishRequest = () => {
      if (settled) {
        return;
      }
      settled = true;
      this.activeRequests = Math.max(0, this.activeRequests - 1);
      this.lastActiveMs = this.now();
      this.scheduleIdleCheck();
    };
    res.once('finish', finishRequest);
    res.once('close', finishRequest);

    let backend: WebBackendHandle;
    try {
      backend = await this.ensureBackendReady();
    } catch (err) {
      if (!res.headersSent && !res.writableEnded) {
        const msg = err instanceof Error ? err.message : String(err);
        res.writeHead(503, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(renderUnavailableHtml(msg, this.logFile));
      }
      return;
    }

    if (req.destroyed || res.writableEnded) {
      return;
    }

    const forwardHeaders: http.OutgoingHttpHeaders = { ...req.headers };
    if (req.headers.host && !forwardHeaders['x-forwarded-host']) {
      forwardHeaders['x-forwarded-host'] = req.headers.host;
    }
    if (!forwardHeaders['x-forwarded-proto']) {
      forwardHeaders['x-forwarded-proto'] = 'http';
    }
    if (!forwardHeaders['x-forwarded-for'] && req.socket.remoteAddress) {
      forwardHeaders['x-forwarded-for'] = req.socket.remoteAddress;
    }

    await new Promise<void>((resolve) => {
      const proxyReq = http.request(
        {
          hostname: '127.0.0.1',
          port: backend.port,
          path: req.url ?? '/',
          method: req.method ?? 'GET',
          headers: forwardHeaders,
        },
        (proxyRes) => {
          if (res.writableEnded) {
            proxyRes.resume();
            resolve();
            return;
          }
          res.writeHead(proxyRes.statusCode ?? 502, proxyRes.statusMessage, proxyRes.headers);
          proxyRes.pipe(res);
          proxyRes.once('end', resolve);
          proxyRes.once('error', () => {
            res.destroy();
            resolve();
          });
        },
      );

      proxyReq.once('error', (err) => {
        if (!res.headersSent && !res.writableEnded) {
          res.writeHead(502, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(renderUnavailableHtml(`连接内部网页服务失败：${err.message}`, this.logFile));
        } else {
          res.destroy();
        }
        resolve();
      });

      const abortUpstream = () => {
        if (!res.writableEnded) {
          proxyReq.destroy();
        }
        resolve();
      };
      req.once('aborted', abortUpstream);
      res.once('close', () => {
        if (!proxyReq.destroyed) {
          proxyReq.destroy();
        }
        resolve();
      });

      req.pipe(proxyReq);
    });
  }
}
