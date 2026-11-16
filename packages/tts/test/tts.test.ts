import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { TtsSettings } from '@aidaily/contracts';
import { execa } from 'execa';
import { afterEach, describe, expect, it } from 'vitest';
import { probeAudioDurationMs, type TtsProvider, TtsService } from '../src/index.js';

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
    expect(service.listProviders()).toContain('silent');

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
    expect(intro.sentences[1]?.offsetMs).toBe((intro.sentences[0]?.durationMs ?? 0) + 250);

    const probedMs = await probeAudioDurationMs(intro.file);
    expect(Math.abs(intro.speechMs - probedMs)).toBeLessThan(50);
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
