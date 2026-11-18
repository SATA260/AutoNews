import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { TtsSettings } from '@aidaily/contracts';
import { execa } from 'execa';
import { afterEach, describe, expect, it } from 'vitest';
import {
  alignSentencesToWav,
  computeTtsCacheKey,
  createIndexTtsProvider,
  createQwenLocalTtsProvider,
  normalizeSegmentToWav,
  probeAudioDurationMs,
  type TtsProvider,
  TtsService,
} from '../src/index.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

function baseSettings(provider = 'silent'): TtsSettings {
  return {
    provider,
    providers: {
      silent: { charsPerSecond: 10 },
    },
    postprocess: {
      sampleRate: 48000,
      loudnessLUFS: -16,
      trimSilence: true,
      sentenceGapMs: 250,
      sectionGapMs: 600,
    },
  };
}

describe('@aidaily/tts', () => {
  it('synthesizes multiple sections with silent provider and accurate ffprobe duration', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aidaily-tts-'));
    tempDirs.push(tmpDir);
    const cacheDir = path.join(tmpDir, 'cache');
    const outDir = path.join(tmpDir, 'out');

    const service = new TtsService({ settings: baseSettings('silent'), cacheDir });
    expect(service.listProviders()).toEqual(
      expect.arrayContaining(['silent', 'indextts', 'qwen-local']),
    );

    const sections = await service.synthesizeSections(
      [
        {
          key: 'intro',
          kind: 'intro',
          sentences: ['欢迎收看今天的人工智能快报。', '马上来看重点。'],
        },
        { key: 'item-01', kind: 'item', itemId: 'i1', sentences: ['第一条新闻来自开源社区。'] },
      ],
      outDir,
    );

    expect(sections).toHaveLength(2);
    const intro = sections[0];
    expect(intro).toBeDefined();
    if (!intro) {
      return;
    }

    expect(intro.sentences).toHaveLength(2);
    expect(intro.sentences[0]?.text).toBe('欢迎收看今天的人工智能快报。');
    expect(intro.sentences[1]?.text).toBe('马上来看重点。');
    expect(intro.sentences[0]?.offsetMs).toBe(0);
    expect(intro.sentences[1]?.offsetMs).toBeGreaterThan(0);
    expect((intro.sentences[0]?.durationMs ?? 0) + (intro.sentences[1]?.durationMs ?? 0)).toBe(
      intro.speechMs,
    );

    const probedMs = await probeAudioDurationMs(intro.file);
    expect(Math.abs(intro.speechMs - probedMs)).toBeLessThan(50);

    // 验证多句段落在整段合成模式下只触发一次引擎调用
    let synthCalls = 0;
    const spyProvider: TtsProvider = {
      id: 'spy-paragraph',
      async healthcheck() {
        return { ok: true, detail: 'ok' };
      },
      async synthesize(req) {
        synthCalls += 1;
        await execa('ffmpeg', [
          '-y',
          '-f',
          'lavfi',
          '-i',
          'sine=frequency=440:duration=0.4',
          '-ar',
          '48000',
          '-ac',
          '1',
          req.outFile,
        ]);
      },
    };
    const spyService = new TtsService({
      settings: baseSettings('spy-paragraph'),
      cacheDir: path.join(tmpDir, 'spy-cache'),
    });
    spyService.register(spyProvider);
    await spyService.synthesizeSections(
      [
        {
          key: 'intro',
          kind: 'intro',
          sentences: ['欢迎收看。', '第二句话。'],
        },
        {
          key: 'item-01',
          kind: 'item',
          itemId: 'i1',
          sentences: ['新闻第一句。', '新闻第二句。'],
        },
      ],
      path.join(tmpDir, 'spy-out'),
    );
    expect(synthCalls).toBe(2);
  });

  it('aligns sentence subtitle boundaries to pause valleys inside synthesized WAV', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aidaily-tts-subtitles-'));
    tempDirs.push(tmpDir);
    const wavPath = path.join(tmpDir, 'two-sentences.wav');

    // 构造 0.60s 语音 + 0.30s 静音停顿低谷 + 0.60s 语音 + 0.16s 尾静音（总计 1.66s）
    await execa('ffmpeg', [
      '-y',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:sample_rate=48000:duration=1.66',
      '-af',
      'volume=0.45:enable=between(t\\,0\\,0.60),volume=0.0:enable=between(t\\,0.60\\,0.90),volume=0.45:enable=between(t\\,0.90\\,1.50),volume=0.0:enable=between(t\\,1.50\\,1.66)',
      '-ar',
      '48000',
      '-ac',
      '1',
      '-c:a',
      'pcm_s16le',
      wavPath,
    ]);

    const aligned = await alignSentencesToWav(
      wavPath,
      ['第一句故意写得稍微短一些。', '第二句在后面包含稍微多一点的内容用来检验停顿低谷吸附。'],
      1660,
    );

    expect(aligned).toHaveLength(2);
    const first = aligned[0];
    const second = aligned[1];
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    if (!first || !second) return;

    expect(first.offsetMs).toBe(0);
    // 吸附低谷后，第二句起点应精准落在 600ms～900ms 停顿窗口附近
    expect(second.offsetMs).toBeGreaterThanOrEqual(550);
    expect(second.offsetMs).toBeLessThanOrEqual(920);
    expect(second.offsetMs + second.durationMs).toBeLessThanOrEqual(1660);
    expect(second.offsetMs + second.durationMs).toBeGreaterThanOrEqual(1480);
  });

  it('keeps aligned sentence boundaries monotonic and within totalDurationMs on ultra-short WAV', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aidaily-tts-short-subtitles-'));
    tempDirs.push(tmpDir);
    const wavPath = path.join(tmpDir, 'ultra-short.wav');

    await execa('ffmpeg', [
      '-y',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:sample_rate=48000:duration=0.40',
      '-ar',
      '48000',
      '-ac',
      '1',
      '-c:a',
      'pcm_s16le',
      wavPath,
    ]);

    const sentences = [
      '第一句很短。',
      '第二句很短。',
      '第三句很短。',
      '第四句很短。',
      '第五句很短。',
    ];
    const aligned = await alignSentencesToWav(wavPath, sentences, 400);

    expect(aligned).toHaveLength(sentences.length);
    let prevEndMs = 0;
    for (const cue of aligned) {
      expect(cue.offsetMs).toBeGreaterThanOrEqual(prevEndMs);
      expect(cue.durationMs).toBeGreaterThan(0);
      expect(cue.offsetMs + cue.durationMs).toBeLessThanOrEqual(400);
      prevEndMs = cue.offsetMs + cue.durationMs;
    }
    expect(prevEndMs).toBeLessThanOrEqual(400);
  });

  it('hits cache on repeat synthesis without re-invoking provider', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aidaily-tts-cache-'));
    tempDirs.push(tmpDir);
    const cacheDir = path.join(tmpDir, 'cache');

    let synthCount = 0;
    const customProvider: TtsProvider = {
      id: 'mock-tone',
      async healthcheck() {
        return { ok: true, detail: 'ok' };
      },
      async synthesize(req) {
        synthCount += 1;
        await execa('ffmpeg', [
          '-y',
          '-f',
          'lavfi',
          '-i',
          'sine=frequency=440:duration=0.5',
          '-ar',
          '48000',
          '-ac',
          '1',
          req.outFile,
        ]);
      },
    };

    const service = new TtsService({ settings: baseSettings('mock-tone'), cacheDir });
    service.register(customProvider);

    await service.synthesizeSections(
      [{ key: 's1', kind: 'intro', sentences: ['缓存命中测试句子一'] }],
      path.join(tmpDir, 'run1'),
    );
    expect(synthCount).toBe(1);

    await service.synthesizeSections(
      [{ key: 's1', kind: 'intro', sentences: ['缓存命中测试句子一'] }],
      path.join(tmpDir, 'run2'),
    );
    expect(synthCount).toBe(1);
  });

  it('invokes start/stop lifecycle hooks and trims leading/trailing silence on custom provider', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aidaily-tts-trim-'));
    tempDirs.push(tmpDir);
    const cacheDir = path.join(tmpDir, 'cache');

    let started = 0;
    let stopped = 0;
    const paddedProvider: TtsProvider = {
      id: 'padded-tone',
      async start() {
        started += 1;
      },
      async stop() {
        stopped += 1;
      },
      async healthcheck() {
        return { ok: true, detail: 'ok' };
      },
      async synthesize(req) {
        // 生成前 0.5s 静音 + 中间 0.6s 声音 + 后 0.5s 静音（总计 1.6s）
        await execa('ffmpeg', [
          '-y',
          '-f',
          'lavfi',
          '-i',
          'sine=frequency=440:duration=0.6',
          '-af',
          'adelay=500|500,apad=pad_dur=0.5',
          '-ar',
          '48000',
          '-ac',
          '1',
          req.outFile,
        ]);
      },
    };

    const service = new TtsService({ settings: baseSettings('padded-tone'), cacheDir });
    service.register(paddedProvider);

    const out = await service.synthesizeSections(
      [{ key: 'item-01', kind: 'item', sentences: ['测试首尾静音裁剪效果'] }],
      path.join(tmpDir, 'out'),
    );

    expect(started).toBe(1);
    expect(stopped).toBe(1);
    const first = out[0];
    expect(first).toBeDefined();
    // 裁剪首尾 1.0s 静音后，实测时长应接近 600ms 而不是 1600ms
    expect(first?.speechMs).toBeGreaterThan(450);
    expect(first?.speechMs).toBeLessThan(950);
  });

  it('recovers from corrupted cache and rejects invalid or duplicate section keys', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aidaily-tts-corrupt-'));
    tempDirs.push(tmpDir);
    const cacheDir = path.join(tmpDir, 'cache');

    const service = new TtsService({ settings: baseSettings('silent'), cacheDir });

    await expect(
      service.synthesizeSections(
        [{ key: '../escape', kind: 'intro', sentences: ['非法键测试'] }],
        path.join(tmpDir, 'out-bad'),
      ),
    ).rejects.toThrow(/非法的口播段落标识/);

    await expect(
      service.synthesizeSections(
        [
          { key: 'intro', kind: 'intro', sentences: ['句子一'] },
          { key: 'intro', kind: 'intro', sentences: ['句子二'] },
        ],
        path.join(tmpDir, 'out-dup'),
      ),
    ).rejects.toThrow(/重复的口播段落标识/);

    // 首次合成生成缓存
    const firstOut = await service.synthesizeSections(
      [{ key: 'intro', kind: 'intro', sentences: ['缓存损坏自愈测试'] }],
      path.join(tmpDir, 'out1'),
    );
    expect(firstOut[0]?.speechMs).toBeGreaterThan(0);

    // 破坏缓存目录里的 wav 文件后再次合成，应自动重建缓存而非整体报错
    const cachedFiles = await fs.readdir(cacheDir);
    expect(cachedFiles.length).toBeGreaterThan(0);
    for (const file of cachedFiles) {
      if (file.endsWith('.wav')) {
        await fs.writeFile(path.join(cacheDir, file), 'NOT_A_WAV');
      }
    }

    const healedOut = await service.synthesizeSections(
      [{ key: 'intro', kind: 'intro', sentences: ['缓存损坏自愈测试'] }],
      path.join(tmpDir, 'out2'),
    );
    expect(healedOut[0]?.speechMs).toBeGreaterThan(0);
  });
});

describe('口播文字清洗', () => {
  it('保留英文词组空格，清除句内中文、数字与标点间多余空格，并以单个空格逐句分隔', async () => {
    const { sanitizeNarrationSentence, buildNarrationParagraph } = await import('../src/index.js');
    expect(sanitizeNarrationSentence('今天 Open AI 发布了 新模型（注释）～ ♪')).toBe(
      '今天Open AI发布了新模型。',
    );
    expect(sanitizeNarrationSentence('这是测试！')).toBe('这是测试!');
    expect(sanitizeNarrationSentence('阿里巴巴在 11 月 16 日发布了 Qwen 4-Max ， 降本 58 %')).toBe(
      '阿里巴巴在11月16日发布了Qwen4-Max，降本58%。',
    );
    expect(
      buildNarrationParagraph([
        'Hugging Face 上线 新模型 — 效率翻倍 ',
        '每百万 Tokens 只需 5 元（内部口径）',
      ]),
    ).toBe('Hugging Face上线新模型，效率翻倍。 每百万Tokens只需5元。');
    expect(buildNarrationParagraph(['第一句平均耗时 3.5 秒。第二句已支持 5.5 万人！'])).toBe(
      '第一句平均耗时3.5秒。 第二句已支持5.5万人!',
    );
  });
});

describe('本地语音重试与取消', () => {
  it('区分响度配置的缓存，并在异常时长重试后保留有效音频', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aidaily-tts-duration-'));
    tempDirs.push(tmpDir);
    const settings = baseSettings('qwen-local');
    settings.providers['qwen-local'] = {};
    let calls = 0;
    const service = new TtsService({ settings, cacheDir: path.join(tmpDir, 'cache') });
    service.register({
      id: 'qwen-local',
      async healthcheck() {
        return { ok: true, detail: 'ok' };
      },
      async synthesize(req) {
        calls++;
        await execa('ffmpeg', [
          '-y',
          '-f',
          'lavfi',
          '-i',
          'sine=frequency=440:duration=1',
          req.outFile,
        ]);
      },
    });
    const warnings: string[] = [];
    const result = await service.synthesizeSections(
      [{ key: 'item', kind: 'item', itemId: 'i', sentences: ['测试'.repeat(50)] }],
      path.join(tmpDir, 'out'),
      {
        onWarning: (message) => {
          warnings.push(message);
        },
      },
    );
    expect(calls).toBe(3);
    expect(result[0]?.speechMs).toBeGreaterThan(0);
    expect(warnings).toHaveLength(1);
    const common = { sampleRate: 48000, trimSilence: true, fadeInMs: 15, fadeOutMs: 20 };
    expect(computeTtsCacheKey('qwen-local', {}, { ...common, loudnessLUFS: -16 }, '句子')).not.toBe(
      computeTtsCacheKey('qwen-local', {}, { ...common, loudnessLUFS: -18 }, '句子'),
    );
    expect(computeTtsCacheKey('indextts', {}, { ...common, loudnessLUFS: -16 }, '句子')).not.toBe(
      computeTtsCacheKey('indextts', {}, { ...common, loudnessLUFS: -18 }, '句子'),
    );
  });

  it('保留段落末尾轻声尾音且不在句尾压低音量，仅追加极短静音缓冲防截断', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aidaily-tts-tail-'));
    tempDirs.push(tmpDir);
    const rawWav = path.join(tmpDir, 'raw-tail.wav');
    const outWav = path.join(tmpDir, 'polished-tail.wav');

    // 构造 0.55s 主语音 + 0.03s 辅音间隙 + 0.05s 轻声尾音(-50dB) + 0.20s 末尾空白（总计 0.83s）
    await execa('ffmpeg', [
      '-y',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:sample_rate=48000:duration=0.83',
      '-af',
      'volume=0.8:enable=between(t\\,0\\,0.55),volume=0.0:enable=between(t\\,0.55\\,0.58),volume=0.035:enable=between(t\\,0.58\\,0.63),volume=0.0:enable=between(t\\,0.63\\,0.83)',
      '-ar',
      '48000',
      '-ac',
      '1',
      rawWav,
    ]);

    await normalizeSegmentToWav({
      inFile: rawWav,
      outFile: outWav,
      sampleRate: 48000,
      trimSilence: true,
      normalizeLoudness: true,
      loudnessLUFS: -16,
    });

    const outMs = await probeAudioDurationMs(outWav);
    // 完整保留 0.63s 含轻声尾音的语音及尾垫，确保不会因闭塞间隙或轻声而被提前截断
    expect(outMs).toBeGreaterThanOrEqual(700);

    // 验证 0.58s~0.63s 的短促轻声尾音未被裁剪掉且保持清晰可闻
    const whisperRes = await execa('ffmpeg', [
      '-hide_banner',
      '-ss',
      '0.58',
      '-t',
      '0.045',
      '-i',
      outWav,
      '-af',
      'volumedetect',
      '-f',
      'null',
      '-',
    ]);
    const whisperMatch = /mean_volume: ([\d.-]+) dB/.exec(whisperRes.stderr);
    expect(whisperMatch).not.toBeNull();
    expect(Number(whisperMatch?.[1] ?? '-100')).toBeGreaterThan(-45);

    const tailRes = await execa('ffmpeg', [
      '-hide_banner',
      '-sseof',
      '-0.06',
      '-i',
      outWav,
      '-af',
      'astats=metadata=0:reset=1',
      '-f',
      'null',
      '-',
    ]);
    const rmsMatches = Array.from(tailRes.stderr.matchAll(/RMS level dB:\s*([-\d.inf]+)/g));
    const overallRmsStr = rmsMatches[rmsMatches.length - 1]?.[1] ?? '-100';
    const overallRms = overallRmsStr === '-inf' ? -120 : Number(overallRmsStr);
    expect(overallRms).toBeLessThan(-50);
  });

  it('将同一段落中过响与过轻的句子均衡到一致响度并保持结尾平直、停顿区安静', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aidaily-tts-level-'));
    tempDirs.push(tmpDir);
    const rawWav = path.join(tmpDir, 'uneven.wav');
    const outWav = path.join(tmpDir, 'leveled.wav');

    await execa('ffmpeg', [
      '-y',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:sample_rate=48000:duration=4.4',
      '-af',
      'volume=5.0:enable=between(t\\,0\\,1.8),volume=0.0:enable=between(t\\,1.8\\,2.2),volume=0.8:enable=between(t\\,2.2\\,4.4)',
      rawWav,
    ]);

    await normalizeSegmentToWav({
      inFile: rawWav,
      outFile: outWav,
      sampleRate: 48000,
      trimSilence: true,
      normalizeLoudness: true,
      loudnessLUFS: -16,
    });

    const readSliceMean = async (startSec: number, durSec: number) => {
      const res = await execa('ffmpeg', [
        '-hide_banner',
        '-ss',
        String(startSec),
        '-t',
        String(durSec),
        '-i',
        outWav,
        '-af',
        'volumedetect',
        '-f',
        'null',
        '-',
      ]);
      const match = /mean_volume: ([\d.-]+) dB/.exec(res.stderr);
      if (!match) throw new Error('未能测量片段音量');
      return Number(match[1]);
    };

    const loudHalf = await readSliceMean(0.3, 1.2);
    const pauseGap = await readSliceMean(1.85, 0.3);
    const quietHalf = await readSliceMean(2.5, 1.2);
    const quietTailLast200ms = await readSliceMean(4.15, 0.2);
    expect(Math.abs(loudHalf - quietHalf)).toBeLessThan(2.5);
    expect(Math.abs(quietHalf - quietTailLast200ms)).toBeLessThan(1.2);
    expect(pauseGap).toBeLessThan(-60);
  });

  it('indextts 引擎启动等待期间收到取消后清理本地服务', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aidaily-indextts-cancel-'));
    tempDirs.push(tmpDir);
    const script = path.join(tmpDir, 'server.mjs');
    await fs.writeFile(script, '#!/usr/bin/env node\nsetInterval(() => {}, 1000);\n', {
      mode: 0o755,
    });
    const provider = createIndexTtsProvider(tmpDir, {
      bin: script,
      model: path.join(tmpDir, 'model'),
    });
    expect(provider.id).toBe('indextts');
    const controller = new AbortController();
    const starting = provider.start?.(undefined, controller.signal);
    setTimeout(() => controller.abort(), 200);
    await expect(starting).rejects.toMatchObject({ name: 'AbortError' });
    await provider.stop?.();
  });

  it('启动等待期间收到取消后清理本地服务', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aidaily-tts-cancel-'));
    tempDirs.push(tmpDir);
    const script = path.join(tmpDir, 'server.mjs');
    await fs.writeFile(script, '#!/usr/bin/env node\nsetInterval(() => {}, 1000);\n', {
      mode: 0o755,
    });
    const provider = createQwenLocalTtsProvider(tmpDir, {
      bin: script,
      model: path.join(tmpDir, 'model'),
    });
    const controller = new AbortController();
    const starting = provider.start?.(undefined, controller.signal);
    setTimeout(() => controller.abort(), 200);
    await expect(starting).rejects.toMatchObject({ name: 'AbortError' });
    await provider.stop?.();
  });

  it('工作进程被强制结束后回收本地语音服务', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aidaily-tts-orphan-'));
    tempDirs.push(tmpDir);
    const pidFile = path.join(tmpDir, 'server.pid');
    const script = path.join(tmpDir, 'server.mjs');
    await fs.writeFile(
      script,
      `#!/usr/bin/env node\nimport fs from 'node:fs';\nfs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));\nsetInterval(() => {}, 1000);\n`,
      { mode: 0o755 },
    );
    const providerPath = pathToFileURL(
      path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/providers/qwen-local.ts'),
    ).href;
    const code = `import { createQwenLocalTtsProvider } from ${JSON.stringify(providerPath)}; const provider = createQwenLocalTtsProvider(${JSON.stringify(tmpDir)}, { bin: ${JSON.stringify(script)}, model: 'unused' }); await provider.start();`;
    const parent = spawn(process.execPath, ['--input-type=module', '-e', code], {
      stdio: 'ignore',
    });
    let serverPid = 0;
    try {
      for (let attempt = 0; attempt < 100; attempt++) {
        try {
          serverPid = Number(await fs.readFile(pidFile, 'utf8'));
          break;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      }
      expect(serverPid).toBeGreaterThan(0);
      const ended = new Promise<void>((resolve) => parent.once('exit', () => resolve()));
      parent.kill('SIGKILL');
      await ended;
      let alive = true;
      for (let attempt = 0; attempt < 100; attempt++) {
        try {
          process.kill(serverPid, 0);
        } catch {
          alive = false;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(alive).toBe(false);
    } finally {
      parent.kill('SIGKILL');
      if (serverPid) {
        try {
          process.kill(serverPid, 'SIGKILL');
        } catch {}
      }
    }
  }, 15_000);
});
