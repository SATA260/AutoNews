import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';

/** 本地模板预览与静态资源 HTTP 服务的启动参数 */
export interface TemplateHttpServerOptions {
  /** 静态构建产物目录（与 htmlContent 二选一） */
  distDir?: string;
  /** 直接由内存提供的单页 HTML 内容（测试纯色模板时使用） */
  htmlContent?: string;
  /** 本期任务目录，挂载在 `/__run_assets__/` 之下仅供同源页面安全读取配图与口播音频等本地素材 */
  runDir?: string;
  /** 角色立绘与 Live2D 模型包目录，只读挂载在 `/__mascot_assets__/` 之下 */
  mascotDir?: string;
}

/** 已启动的本地模板静态服务实例 */
export interface TemplateHttpServer {
  /** 本机访问地址，固定绑定 127.0.0.1 随机空闲端口 */
  baseUrl: string;
  /** 关闭 HTTP 服务并断开全部活跃长连接 */
  close(): Promise<void>;
}

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.moc3': 'application/octet-stream',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg',
  '.mp4': 'video/mp4',
  '.txt': 'text/plain; charset=utf-8',
};

const ASSET_PREFIX = '/__run_assets__/';
const MASCOT_PREFIX = '/__mascot_assets__/';

/** 根据文件后缀名判断 HTTP 响应所需的 MIME 类型 */
function guessMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_TYPES[ext] ?? 'application/octet-stream';
}

/** 将请求相对路径安全约束在目标根目录之内，防止目录穿越和软链接越界 */
async function resolveConfinedFile(
  rootDir: string,
  relPath: string,
): Promise<{
  status: number;
  filePath?: string;
}> {
  if (relPath.includes('\0')) {
    return { status: 400 };
  }
  const cleanRel = relPath.replace(/^\/+/, '');
  const resolvedRoot = path.resolve(rootDir);
  const candidate = path.resolve(resolvedRoot, cleanRel);
  if (candidate !== resolvedRoot && !candidate.startsWith(`${resolvedRoot}${path.sep}`)) {
    return { status: 403 };
  }

  let stat: Awaited<ReturnType<typeof fs.stat>>;
  try {
    stat = await fs.stat(candidate);
  } catch {
    return { status: 404 };
  }
  if (!stat.isFile()) {
    return { status: 404 };
  }

  const realRoot = await fs.realpath(resolvedRoot).catch(() => resolvedRoot);
  const realTarget = await fs.realpath(candidate).catch(() => null);
  if (!realTarget?.startsWith(`${realRoot}${path.sep}`)) {
    return { status: 403 };
  }

  return { status: 200, filePath: realTarget };
}

/** 通过受控可读流传输本地静态文件并在正常结束、客户端断连或流报错时立即释放文件句柄 */
async function pipeStaticFileStream(
  res: http.ServerResponse,
  filePath: string,
  range?: { start: number; end: number },
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const stream = fsSync.createReadStream(filePath, range);
    let settled = false;

    const cleanup = () => {
      stream.removeListener('end', onEnd);
      stream.removeListener('close', onClose);
      stream.removeListener('error', onError);
      res.removeListener('close', onResClose);
      res.removeListener('error', onResClose);
    };

    const finishOk = () => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve();
    };

    const onEnd = () => {
      finishOk();
    };

    const onClose = () => {
      finishOk();
    };

    const onError = (err: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      stream.unpipe(res);
      stream.destroy();
      reject(err);
    };

    const onResClose = () => {
      stream.unpipe(res);
      stream.destroy();
      finishOk();
    };

    stream.on('end', onEnd);
    stream.on('close', onClose);
    stream.on('error', onError);
    res.on('close', onResClose);
    res.on('error', onResClose);
    stream.pipe(res);
  });
}

/** 发送单个磁盘文件的 HTTP 响应内容，全程流式传输并支持音频与贴图的字节区间请求 */
async function sendStaticFile(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  filePath: string,
): Promise<void> {
  const stat = await fs.stat(filePath);
  const totalBytes = stat.size;
  const contentType = guessMimeType(filePath);
  const rangeHeader = req.headers.range;

  if (rangeHeader && totalBytes > 0 && /^bytes=/i.test(rangeHeader)) {
    const match = /^bytes=(\d*)-(\d*)/i.exec(rangeHeader.trim());
    if (match) {
      const rawStart = match[1] ?? '';
      const rawEnd = match[2] ?? '';
      let start = rawStart ? Number.parseInt(rawStart, 10) : 0;
      let end = rawEnd ? Number.parseInt(rawEnd, 10) : totalBytes - 1;
      if (!rawStart && rawEnd) {
        const suffixLen = Number.parseInt(rawEnd, 10);
        start = Math.max(0, totalBytes - suffixLen);
        end = totalBytes - 1;
      }
      if (
        Number.isFinite(start) &&
        Number.isFinite(end) &&
        start >= 0 &&
        start <= end &&
        start < totalBytes
      ) {
        end = Math.min(end, totalBytes - 1);
        const chunkLen = end - start + 1;
        res.writeHead(206, {
          'Content-Type': contentType,
          'Content-Range': `bytes ${start}-${end}/${totalBytes}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': String(chunkLen),
          'Cache-Control': 'no-store',
        });
        if (req.method === 'HEAD') {
          res.end();
          return;
        }
        await pipeStaticFileStream(res, filePath, { start, end });
        return;
      }
      res.writeHead(416, { 'Content-Range': `bytes */${totalBytes}` });
      res.end();
      return;
    }
  }

  res.writeHead(200, {
    'Content-Type': contentType,
    'Accept-Ranges': 'bytes',
    'Content-Length': String(totalBytes),
    'Cache-Control': 'no-store',
  });
  if (req.method === 'HEAD' || totalBytes === 0) {
    res.end();
    return;
  }
  await pipeStaticFileStream(res, filePath);
}

/**
 * 启动仅监听本机回环地址的模板静态资源服务器，用于向浏览器稳定提供模板页面、当期配音配图及只读 Live2D 模型文件。
 */
export async function startTemplateHttpServer(
  opts: TemplateHttpServerOptions,
): Promise<TemplateHttpServer> {
  if (!opts.distDir && !opts.htmlContent) {
    throw new Error('启动模板静态服务时必须提供 distDir 或 htmlContent');
  }

  const distRoot = opts.distDir ? path.resolve(opts.distDir) : null;
  const runRoot = opts.runDir ? path.resolve(opts.runDir) : null;
  const mascotRoot = opts.mascotDir ? path.resolve(opts.mascotDir) : null;

  const server = http.createServer((req, res) => {
    void (async () => {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Method Not Allowed');
        return;
      }

      let rawUrlPath = '/';
      try {
        rawUrlPath = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
      } catch {
        res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Bad Request');
        return;
      }

      let decodedPath: string;
      try {
        decodedPath = decodeURIComponent(rawUrlPath);
      } catch {
        res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Bad Request');
        return;
      }

      if (decodedPath.startsWith(ASSET_PREFIX)) {
        if (!runRoot) {
          res.writeHead(404);
          res.end('Not Found');
          return;
        }
        const relAsset = decodedPath.slice(ASSET_PREFIX.length);
        const resolved = await resolveConfinedFile(runRoot, relAsset);
        if (resolved.status !== 200 || !resolved.filePath) {
          res.writeHead(resolved.status);
          res.end();
          return;
        }
        await sendStaticFile(req, res, resolved.filePath);
        return;
      }

      if (decodedPath.startsWith(MASCOT_PREFIX)) {
        if (!mascotRoot) {
          res.writeHead(404);
          res.end('Not Found');
          return;
        }
        const relMascot = decodedPath.slice(MASCOT_PREFIX.length);
        const resolved = await resolveConfinedFile(mascotRoot, relMascot);
        if (resolved.status !== 200 || !resolved.filePath) {
          res.writeHead(resolved.status);
          res.end();
          return;
        }
        await sendStaticFile(req, res, resolved.filePath);
        return;
      }

      if (opts.htmlContent !== undefined) {
        if (decodedPath === '/' || decodedPath === '/index.html') {
          const buf = Buffer.from(opts.htmlContent, 'utf8');
          res.writeHead(200, {
            'Content-Type': 'text/html; charset=utf-8',
            'Content-Length': String(buf.byteLength),
            'Cache-Control': 'no-store',
          });
          if (req.method === 'HEAD') {
            res.end();
            return;
          }
          res.end(buf);
          return;
        }
        res.writeHead(404);
        res.end('Not Found');
        return;
      }

      if (distRoot) {
        const rel = decodedPath === '/' ? 'index.html' : decodedPath.replace(/^\/+/, '');
        const resolved = await resolveConfinedFile(distRoot, rel);
        if (resolved.status === 200 && resolved.filePath) {
          await sendStaticFile(req, res, resolved.filePath);
          return;
        }
        if (resolved.status === 403 || resolved.status === 400) {
          res.writeHead(resolved.status);
          res.end();
          return;
        }
        // 对于不带文件扩展名的单页应用路由，回退返回入口页面
        if (!path.extname(rel)) {
          const fallback = await resolveConfinedFile(distRoot, 'index.html');
          if (fallback.status === 200 && fallback.filePath) {
            await sendStaticFile(req, res, fallback.filePath);
            return;
          }
        }
      }

      res.writeHead(404);
      res.end('Not Found');
    })().catch(() => {
      if (!res.headersSent) {
        res.writeHead(500);
      }
      if (!res.writableEnded) {
        res.end();
      }
    });
  });
  server.requestTimeout = 30_000;

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => {
      server.off('listening', onListening);
      reject(err);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(0, '127.0.0.1');
  });

  const addr = server.address();
  if (!addr || typeof addr === 'string') {
    server.close();
    throw new Error('未能获取本地模板服务的监听端口');
  }

  return {
    baseUrl: `http://127.0.0.1:${addr.port}`,
    async close() {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      });
    },
  };
}
