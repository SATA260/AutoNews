import { type ChildProcess, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { createWriteStream, type WriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { writeTtsFileAtomic } from '../atomic.mjs';
import type { SynthesizeRequest, TtsProvider } from '../types.js';

const HOST_IDS = ['deepseek', 'gpt', 'gemini', 'claude'] as const;

/** 基于本机模型服务启动的语音克隆引擎配置说明 */
export interface AudiocppProviderSpec {
  id: string;
  family: string;
  task: string;
  defaultBin: string;
  defaultModel: string;
  requireTranscript: boolean;
  startupTimeoutMs?: number;
  buildRequestBody: (params: {
    serverModelId: string;
    req: SynthesizeRequest;
    voiceAudioPath: string;
    voiceTranscript: string;
  }) => Record<string, unknown>;
}

/** 根据项目根目录与配置项解析可执行程序或模型文件的绝对路径 */
function resolveAudiocppPath(
  rootDir: string,
  source: Record<string, unknown>,
  key: string,
  fallback: string,
): string {
  const raw =
    typeof source[key] === 'string' && String(source[key]).trim()
      ? String(source[key]).trim()
      : fallback;
  const expanded = raw.replace(/^~(?=\/)/, os.homedir());
  return path.isAbsolute(expanded) ? expanded : path.resolve(rootDir, expanded);
}

/** 解析指定主播对应的参考音频及可选对应文本文件绝对路径 */
function resolveVoiceFiles(
  rootDir: string,
  baseConfig: Record<string, unknown>,
  providerConfig: Record<string, unknown>,
  host: string,
  requireTranscript: boolean,
): { audio: string; text?: string } {
  const voices = providerConfig.voices ?? baseConfig.voices;
  if (!voices || typeof voices !== 'object' || Array.isArray(voices)) {
    throw new Error('请在语音配置中填写各主播的参考音频路径');
  }
  const voice = (voices as Record<string, unknown>)[host];
  if (!voice || typeof voice !== 'object' || Array.isArray(voice)) {
    throw new Error(`未配置主播音色: ${host}`);
  }
  const fields = voice as Record<string, unknown>;
  if (typeof fields.audio !== 'string' || !fields.audio.trim()) {
    throw new Error(`主播音色参考音频路径无效: ${host}`);
  }
  const hasText = typeof fields.text === 'string' && fields.text.trim().length > 0;
  if (requireTranscript && !hasText) {
    throw new Error(`主播音色参考文本路径无效: ${host}`);
  }
  return {
    audio: path.resolve(rootDir, fields.audio),
    ...(hasText ? { text: path.resolve(rootDir, String(fields.text)) } : {}),
  };
}

/** 校验并读取已明确指定的当期主播标识，避免声音与画面不一致 */
function requireHostId(providerConfig: Record<string, unknown>): string {
  if (
    typeof providerConfig.hostId !== 'string' ||
    !HOST_IDS.includes(providerConfig.hostId as (typeof HOST_IDS)[number])
  ) {
    throw new Error('尚未确定本期主播，无法合成对应音色');
  }
  return providerConfig.hostId;
}

/** 申请一个本机临时空闲端口供本地推理服务监听 */
async function allocateLoopbackPort(): Promise<number> {
  const listener = net.createServer();
  return new Promise<number>((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', () => {
      const address = listener.address();
      if (!address || typeof address === 'string') {
        reject(new Error('无法分配本地端口'));
        return;
      }
      const selected = address.port;
      listener.close((error) => (error ? reject(error) : resolve(selected)));
    });
  });
}

/** 在给定父进程退出后自动结束孤儿本地推理子进程 */
function spawnExitWatcher(childPid: number): ChildProcess {
  const watcherCode = `const parent=Number(process.argv[1]), child=Number(process.argv[2]); setInterval(()=>{ try { process.kill(child,0); } catch { process.exit(0); } try { process.kill(parent,0); } catch { try { process.kill(child,'SIGTERM'); } catch {} process.exit(0); } },1000);`;
  const watcher = spawn(
    process.execPath,
    ['-e', watcherCode, String(process.pid), String(childPid)],
    { stdio: 'ignore' },
  );
  watcher.on('error', () => undefined);
  watcher.unref();
  return watcher;
}

/** 轮询本地推理服务健康状态与模型注册列表直至就绪 */
async function waitForServerReady(opts: {
  server: ChildProcess;
  serverUrl: string;
  serverModelId: string;
  timeoutMs: number;
  fetchImpl: typeof fetch;
  signal?: AbortSignal;
  getSpawnError: () => Error | undefined;
}): Promise<boolean> {
  const deadline = Date.now() + opts.timeoutMs;
  while (Date.now() < deadline) {
    if (opts.signal?.aborted) {
      throw new DOMException('已取消', 'AbortError');
    }
    if (opts.getSpawnError() || opts.server.exitCode !== null || opts.server.signalCode !== null) {
      return false;
    }
    try {
      const probeSignal = opts.signal
        ? AbortSignal.any([opts.signal, AbortSignal.timeout(500)])
        : AbortSignal.timeout(500);
      const response = await opts.fetchImpl(`${opts.serverUrl}/health`, { signal: probeSignal });
      if (response.ok) {
        const models = await opts.fetchImpl(`${opts.serverUrl}/v1/models`, { signal: probeSignal });
        const body = (await models.json()) as { data?: Array<{ id?: string }> };
        if (
          models.ok &&
          body.data?.some((entry) => entry.id === opts.serverModelId) &&
          opts.server.exitCode === null &&
          opts.server.signalCode === null
        ) {
          return true;
        }
      }
    } catch {
      /* 等待本机服务开始监听。 */
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

/** 创建基于本机音频推理服务进程与参考音色的语音合成引擎 */
export function createAudiocppLocalTtsProvider(
  spec: AudiocppProviderSpec,
  rootDir: string,
  config: Record<string, unknown>,
  opts?: { fetchImpl?: typeof fetch },
): TtsProvider {
  const fetchImpl = opts?.fetchImpl ?? globalThis.fetch;
  const defaultBin = resolveAudiocppPath(rootDir, config, 'bin', spec.defaultBin);
  const defaultModel = resolveAudiocppPath(rootDir, config, 'model', spec.defaultModel);

  let server: ChildProcess | undefined;
  let serverDir: string | undefined;
  let serverUrl: string | undefined;
  let serverModelId: string | undefined;
  let watcher: ChildProcess | undefined;
  let onProcessExit: (() => void) | undefined;
  let logStream: WriteStream | undefined;

  const stop = async () => {
    const child = server;
    if (onProcessExit) process.removeListener('exit', onProcessExit);
    onProcessExit = undefined;
    server = undefined;
    serverUrl = undefined;
    serverModelId = undefined;
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      const ended = new Promise<void>((resolve) => child.once('close', () => resolve()));
      child.kill('SIGTERM');
      const timeout = setTimeout(() => child.kill('SIGKILL'), 3000);
      await ended;
      clearTimeout(timeout);
    }
    watcher?.kill('SIGTERM');
    watcher = undefined;
    if (logStream) {
      const stream = logStream;
      logStream = undefined;
      await new Promise<void>((resolve) => {
        if (stream.destroyed) resolve();
        else {
          stream.once('error', () => resolve());
          stream.end(resolve);
        }
      });
    }
    if (serverDir) await fs.rm(serverDir, { recursive: true, force: true });
    serverDir = undefined;
  };

  return {
    id: spec.id,
    async healthcheck() {
      try {
        const voiceFiles = HOST_IDS.flatMap((host) => {
          const voice = resolveVoiceFiles(rootDir, config, config, host, spec.requireTranscript);
          return voice.text ? [voice.audio, voice.text] : [voice.audio];
        });
        await Promise.all([defaultBin, defaultModel, ...voiceFiles].map((file) => fs.access(file)));
        const probe = createAudiocppLocalTtsProvider(spec, rootDir, config);
        try {
          await probe.start?.(config, AbortSignal.timeout(15_000));
        } finally {
          await probe.stop?.();
        }
        return { ok: true, detail: `本地语音运行时（${spec.id}）、模型配置和参考文件可用` };
      } catch (error) {
        return {
          ok: false,
          detail: `本地语音运行时（${spec.id}）或模型文件不可用: ${String(error)}`,
        };
      }
    },
    async cacheIdentity(providerConfig) {
      const host = requireHostId(providerConfig);
      const files = resolveVoiceFiles(
        rootDir,
        config,
        providerConfig,
        host,
        spec.requireTranscript,
      );
      const hash = crypto.createHash('sha256').update(host);
      hash.update(await fs.readFile(files.audio));
      if (spec.requireTranscript && files.text) {
        hash.update(await fs.readFile(files.text));
      }
      return hash.digest('hex');
    },
    async start(providerConfig = config, signal) {
      if (signal?.aborted) throw new DOMException('已取消', 'AbortError');
      if (server) throw new Error('语音服务已经启动');

      const selectedBin = resolveAudiocppPath(rootDir, providerConfig, 'bin', defaultBin);
      const selectedModel = resolveAudiocppPath(rootDir, providerConfig, 'model', defaultModel);
      const backend =
        typeof providerConfig.backend === 'string'
          ? providerConfig.backend
          : typeof config.backend === 'string'
            ? config.backend
            : 'metal';

      const port = await allocateLoopbackPort();
      serverDir = await fs.mkdtemp(path.join(os.tmpdir(), `aidaily-${spec.id}-`));
      const configFile = path.join(serverDir, 'server.json');
      serverModelId = `aidaily-${crypto.randomBytes(12).toString('hex')}`;
      await writeTtsFileAtomic(
        configFile,
        JSON.stringify({
          host: '127.0.0.1',
          port,
          backend,
          lazy_load: true,
          models: [
            {
              id: serverModelId,
              family: spec.family,
              path: selectedModel,
              task: spec.task,
              mode: 'offline',
            },
          ],
        }),
      );

      const logDir = path.join(rootDir, 'storage', 'logs');
      try {
        await fs.mkdir(logDir, { recursive: true });
      } catch (error) {
        await stop();
        throw error;
      }
      logStream = createWriteStream(path.join(logDir, `${spec.id}.log`), {
        flags: 'a',
        mode: 0o600,
      });
      logStream.on('error', () => undefined);
      logStream.write(`\n[${new Date().toISOString()}] 本地语音服务启动 (${spec.id})\n`);

      server = spawn(selectedBin, ['--config', configFile, '--no-ui'], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stderr = '';
      const recordOutput = (chunk: Buffer) => {
        stderr = (stderr + chunk.toString()).slice(-4000);
        logStream?.write(chunk);
      };
      server.stdout?.on('data', recordOutput);
      server.stderr?.on('data', recordOutput);

      if (server.pid) {
        watcher = spawnExitWatcher(server.pid);
        const child = server;
        onProcessExit = () => {
          child.kill('SIGTERM');
        };
        process.once('exit', onProcessExit);
      }

      let spawnError: Error | undefined;
      server.on('error', (error) => {
        spawnError = error;
      });
      serverUrl = `http://127.0.0.1:${port}`;

      try {
        const ready = await waitForServerReady({
          server,
          serverUrl,
          serverModelId,
          timeoutMs: spec.startupTimeoutMs ?? 15_000,
          fetchImpl,
          signal,
          getSpawnError: () => spawnError,
        });
        if (ready) return;
      } catch (error) {
        await stop();
        throw error;
      }

      await stop();
      throw new Error(
        `本地语音服务启动失败或超时${spawnError ? `: ${spawnError.message}` : ''}${stderr ? `: ${stderr}` : ''}`,
      );
    },
    stop,
    async synthesize(req) {
      if (!serverUrl || !server || !serverModelId) throw new Error('本地语音服务尚未启动');
      const cfg = req.providerConfig ?? {};
      const host = requireHostId(cfg);
      const files = resolveVoiceFiles(rootDir, config, cfg, host, spec.requireTranscript);
      let transcript = '';
      if (files.text) {
        transcript = (await fs.readFile(files.text, 'utf8')).trim();
      }
      if (spec.requireTranscript && !transcript) {
        throw new Error(`参考音频对应的文字为空: ${host}`);
      }

      const signal = req.signal
        ? AbortSignal.any([req.signal, AbortSignal.timeout(300_000)])
        : AbortSignal.timeout(300_000);
      const response = await fetchImpl(`${serverUrl}/v1/audio/speech`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal,
        body: JSON.stringify(
          spec.buildRequestBody({
            serverModelId,
            req,
            voiceAudioPath: files.audio,
            voiceTranscript: transcript,
          }),
        ),
      });
      if (!response.ok) {
        throw new Error(
          `本地语音合成失败 (${response.status}): ${(await response.text()).slice(0, 2000)}`,
        );
      }
      const content = new Uint8Array(await response.arrayBuffer());
      if (content.length < 44) throw new Error('本地语音服务返回空音频');

      await writeTtsFileAtomic(req.outFile, content);
    },
  };
}

/** 创建基于项目内 IndexTTS2.5 模型与参考音频的本地语音克隆引擎。 */
export function createIndexTtsProvider(
  rootDir: string,
  config: Record<string, unknown>,
  opts?: { fetchImpl?: typeof fetch },
): TtsProvider {
  return createAudiocppLocalTtsProvider(
    {
      id: 'indextts',
      family: 'index_tts2',
      task: 'tts',
      defaultBin: 'assets/tts/bin/audiocpp_server',
      defaultModel: 'assets/tts/models/IndexTTS2.5-GGUF/index-tts2_5-q8_0.gguf',
      requireTranscript: false,
      buildRequestBody: ({ serverModelId, req, voiceAudioPath }) => ({
        model: serverModelId,
        input: req.text,
        language:
          typeof req.providerConfig?.language === 'string' && req.providerConfig.language.trim()
            ? req.providerConfig.language.trim()
            : 'auto',
        voice_ref: voiceAudioPath,
        interval_silence_ms:
          typeof req.providerConfig?.intervalSilenceMs === 'number'
            ? req.providerConfig.intervalSilenceMs
            : 200,
        seed: crypto.randomInt(0, 2147483647),
      }),
    },
    rootDir,
    config,
    opts,
  );
}

/** 创建使用本机模型运行时和参考音频的 Qwen3-TTS 语音合成引擎。 */
export function createQwenLocalTtsProvider(
  rootDir: string,
  config: Record<string, unknown>,
  opts?: { fetchImpl?: typeof fetch },
): TtsProvider {
  return createAudiocppLocalTtsProvider(
    {
      id: 'qwen-local',
      family: 'qwen3_tts',
      task: 'clon',
      defaultBin: 'assets/tts/bin/audiocpp_server',
      defaultModel:
        'assets/tts/models/Qwen3-TTS-12Hz-1.7B-Base-GGUF/qwen3-tts-12hz-1.7b-base-q8_0_v2.gguf',
      requireTranscript: true,
      buildRequestBody: ({ serverModelId, req, voiceAudioPath, voiceTranscript }) => ({
        model: serverModelId,
        input: req.text,
        language: 'Chinese',
        voice_ref: voiceAudioPath,
        reference_text: voiceTranscript,
        seed: crypto.randomInt(0, 2147483647),
      }),
    },
    rootDir,
    config,
    opts,
  );
}
