import { type ChildProcess, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { TtsProvider } from '../types.js';

/** 创建使用本机 BaoCut 运行时和参考音频的语音合成引擎。 */
export function createQwenLocalTtsProvider(
  rootDir: string,
  config: Record<string, unknown>,
): TtsProvider {
  /** 将配置中的用户目录和相对路径转换为绝对路径。 */
  const resolveConfig = (key: string, fallback: string, source = config) => {
    const value = typeof source[key] === 'string' ? String(source[key]) : fallback;
    return path.resolve(value.replace(/^~(?=\/)/, os.homedir()));
  };
  const bin = resolveConfig(
    'bin',
    '~/Applications/BaoCut.app/Contents/Resources/bin/audiocpp/audiocpp_server',
  );
  const model = resolveConfig(
    'model',
    '~/.baocut/models/audio-cpp/audio.cpp-gguf-qwen3-tts-1.7b-base/Qwen3-TTS-12Hz-1.7B-Base-GGUF/qwen3-tts-12hz-1.7b-base-q8_0_v2.gguf',
  );
  /** 根据主播标识读取参考音频和对应文本的位置。 */
  const voicePaths = (host: string, providerConfig: Record<string, unknown>) => {
    const voices = providerConfig.voices ?? config.voices;
    if (!voices || typeof voices !== 'object' || Array.isArray(voices))
      throw new Error('请在语音配置中填写各主播的参考音频与文字路径');
    const voice = (voices as Record<string, unknown>)[host];
    if (!voice || typeof voice !== 'object' || Array.isArray(voice))
      throw new Error(`未配置主播音色: ${host}`);
    const fields = voice as Record<string, unknown>;
    if (typeof fields.audio !== 'string' || typeof fields.text !== 'string')
      throw new Error(`主播音色路径无效: ${host}`);
    return { audio: path.resolve(rootDir, fields.audio), text: path.resolve(rootDir, fields.text) };
  };
  let server: ChildProcess | undefined;
  let serverDir: string | undefined;
  let serverUrl: string | undefined;
  return {
    id: 'qwen-local',
    async healthcheck() {
      try {
        const files = ['deepseek', 'gpt', 'gemini', 'claude'].flatMap((host) => {
          const voice = voicePaths(host, config);
          return [voice.audio, voice.text];
        });
        await Promise.all([bin, model, ...files].map((file) => fs.access(file)));
        return { ok: true, detail: '本地语音运行时与模型文件可用' };
      } catch (error) {
        return { ok: false, detail: `本地语音运行时或模型文件不可用: ${String(error)}` };
      }
    },
    async cacheIdentity(providerConfig) {
      const host = typeof providerConfig.hostId === 'string' ? providerConfig.hostId : 'deepseek';
      const files = voicePaths(host, providerConfig);
      const [audio, text] = await Promise.all([fs.readFile(files.audio), fs.readFile(files.text)]);
      return crypto.createHash('sha256').update(host).update(audio).update(text).digest('hex');
    },
    async start(providerConfig = config) {
      const selectedBin = resolveConfig('bin', bin, providerConfig);
      const selectedModel = resolveConfig('model', model, providerConfig);
      const backend = typeof providerConfig.backend === 'string' ? providerConfig.backend : 'metal';
      if (server) throw new Error('语音服务已经启动');
      const listener = net.createServer();
      const port = await new Promise<number>((resolve, reject) => {
        listener.once('error', reject);
        listener.listen(0, '127.0.0.1', () => {
          const address = listener.address();
          if (!address || typeof address === 'string') return reject(new Error('无法分配本地端口'));
          const selected = address.port;
          listener.close((error) => (error ? reject(error) : resolve(selected)));
        });
      });
      serverDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aidaily-qwen-'));
      const configFile = path.join(serverDir, 'server.json');
      await fs.writeFile(
        configFile,
        JSON.stringify({
          host: '127.0.0.1',
          port,
          backend,
          lazy_load: true,
          models: [
            { id: 'qwen', family: 'qwen3_tts', path: selectedModel, task: 'clon', mode: 'offline' },
          ],
        }),
      );
      server = spawn(selectedBin, ['--config', configFile, '--no-ui'], { stdio: 'ignore' });
      let spawnError: Error | undefined;
      server.on('error', (error) => {
        spawnError = error;
      });
      serverUrl = `http://127.0.0.1:${port}`;
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        if (spawnError || server.exitCode !== null || server.signalCode !== null) break;
        try {
          const response = await fetch(`${serverUrl}/health`, { signal: AbortSignal.timeout(500) });
          if (response.ok) return;
        } catch {
          /* 等待本机服务开始监听。 */
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      await this.stop?.();
      throw new Error(`本地语音服务启动失败或超时${spawnError ? `: ${spawnError.message}` : ''}`);
    },
    async stop() {
      const child = server;
      server = undefined;
      serverUrl = undefined;
      if (child?.pid && child.exitCode === null && child.signalCode === null) {
        const ended = new Promise<void>((resolve) => child.once('exit', () => resolve()));
        child.kill('SIGTERM');
        const timeout = setTimeout(() => child.kill('SIGKILL'), 3000);
        await ended;
        clearTimeout(timeout);
      }
      if (serverDir) await fs.rm(serverDir, { recursive: true, force: true });
      serverDir = undefined;
    },
    async synthesize(req) {
      if (!serverUrl || !server) throw new Error('本地语音服务尚未启动');
      const host =
        typeof req.providerConfig?.hostId === 'string' ? req.providerConfig.hostId : 'deepseek';
      const files = voicePaths(host, req.providerConfig ?? {});
      const transcript = (await fs.readFile(files.text, 'utf8')).trim();
      if (!transcript) throw new Error(`参考音频对应的文字为空: ${host}`);
      const signal = req.signal
        ? AbortSignal.any([req.signal, AbortSignal.timeout(300_000)])
        : AbortSignal.timeout(300_000);
      const response = await fetch(`${serverUrl}/v1/audio/speech`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal,
        body: JSON.stringify({
          model: 'qwen',
          input: req.text,
          language: 'Chinese',
          voice_ref: files.audio,
          reference_text: transcript,
          seed: crypto.randomInt(0, 2147483647),
        }),
      });
      if (!response.ok)
        throw new Error(
          `本地语音合成失败 (${response.status}): ${(await response.text()).slice(0, 2000)}`,
        );
      const content = new Uint8Array(await response.arrayBuffer());
      if (content.length < 44) throw new Error('本地语音服务返回空音频');
      const tempFile = `${req.outFile}.${crypto.randomBytes(4).toString('hex')}.tmp`;
      try {
        await fs.writeFile(tempFile, content);
        await fs.rename(tempFile, req.outFile);
      } catch (error) {
        await fs.rm(tempFile, { force: true });
        throw error;
      }
    },
  };
}
