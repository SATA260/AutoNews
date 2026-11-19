import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  InfoCardIconSchema,
  type NarrationSection,
  type SectionAudio,
  type Timeline,
} from '@aidaily/contracts';
import { execa } from 'execa';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildMasterAudioWav,
  buildPageTurnSfxOverlayArgs,
  computePageTurnSfxTimesMs,
} from '../src/media/ffmpeg.js';
import {
  buildTimeline,
  DEFAULT_PAGE_TURN_POST_DELAY_MS,
  quantizeTimelineToFps,
  resolvePageTurnPostDelayMs,
} from '../src/media/timeline.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
});

/** 生成一个测试用时间轴：每页给定起始时间和时长 */
function makeTimeline(pages: Array<{ startMs: number; pageMs: number }>): Timeline {
  const totalMs = pages.reduce((max, p) => Math.max(max, p.startMs + p.pageMs), 0);
  return {
    totalMs,
    sections: pages.map((p, i) => ({
      key: `sec-${i}`,
      kind: i === 0 ? 'intro' : 'item',
      audioFile: `audio/sec-${i}.wav`,
      startMs: p.startMs,
      speechMs: p.pageMs,
      pageMs: p.pageMs,
      sentences: [],
    })),
  } as unknown as Timeline;
}

/** 测量音频某一段的峰值音量（分贝），静音时返回很小的值 */
async function measurePeakDb(wav: string, startSec: number, durSec: number): Promise<number> {
  const res = await execa('ffmpeg', [
    '-hide_banner',
    '-ss',
    String(startSec),
    '-t',
    String(durSec),
    '-i',
    wav,
    '-af',
    'volumedetect',
    '-f',
    'null',
    '-',
  ]);
  const m = /max_volume:\s*(-?[\d.]+|-inf) dB/.exec(res.stderr);
  if (!m || m[1] === '-inf') {
    return -200;
  }
  return Number(m[1]);
}

describe('翻页咔嗒音效', () => {
  it('从第二页起，每页开始时间减去提前量就是发声时刻，且不早于 0', () => {
    const timeline = makeTimeline([
      { startMs: 0, pageMs: 5000 },
      { startMs: 5000, pageMs: 20_000 },
      { startMs: 25_000, pageMs: 4000 },
      { startMs: 40, pageMs: 100 },
    ]);
    expect(computePageTurnSfxTimesMs(timeline, 60)).toEqual([4940, 24_940, 0]);
    expect(computePageTurnSfxTimesMs(timeline, Number.NaN)).toEqual([5000, 25_000, 40]);
  });

  it('生成的混音参数把音效拆成多份并分别延后到各个时间点', () => {
    const args = buildPageTurnSfxOverlayArgs({
      inWav: 'in.wav',
      sfxFile: 'click.wav',
      outWav: 'out.wav',
      atMs: [940, 4940],
      volumeDb: -14,
      sampleRate: 48_000,
    });
    const filter = args[args.indexOf('-filter_complex') + 1] ?? '';
    expect(filter).toContain('volume=-14dB');
    expect(filter).toContain('asplit=2[c0][c1]');
    expect(filter).toContain('[c0]adelay=940|940[d0]');
    expect(filter).toContain('[c1]adelay=4940|4940[d1]');
    expect(filter).toContain('amix=inputs=3:duration=first');
    expect(args.at(-1)).toBe('out.wav');
  });

  it('真实混音：翻页时刻附近有咔嗒声，其余静音段保持安静；不配置音效时不额外加声音', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aidaily-sfx-'));
    tempDirs.push(root);
    const runDir = path.join(root, 'run');
    await fs.mkdir(path.join(runDir, 'audio'), { recursive: true });
    for (const i of [0, 1]) {
      await execa('ffmpeg', [
        '-y',
        '-f',
        'lavfi',
        '-i',
        'anullsrc=r=48000:cl=stereo',
        '-t',
        '1',
        path.join(runDir, 'audio', `sec-${i}.wav`),
      ]);
    }
    const clickFile = path.join(root, 'click.wav');
    await execa('ffmpeg', [
      '-y',
      '-f',
      'lavfi',
      '-i',
      'sine=f=2000:d=0.05:sample_rate=48000',
      '-ac',
      '2',
      clickFile,
    ]);

    const timeline = makeTimeline([
      { startMs: 0, pageMs: 1000 },
      { startMs: 1000, pageMs: 1000 },
    ]);
    const common = {
      timeline,
      runDir,
      sampleRate: 48_000,
      loudnessLUFS: -16,
      isSilentProvider: true,
      bgm: { file: '', volumeDb: -12, duckDb: -5 },
      rootDir: root,
    };

    const withSfx = path.join(root, 'with-sfx.wav');
    await buildMasterAudioWav({
      ...common,
      outWav: withSfx,
      pageTurnSfx: {
        file: clickFile,
        volumeDb: -6,
        atMs: computePageTurnSfxTimesMs(timeline, 60),
      },
    });
    // 测试音效本身峰值约 -18 dB，再降 6 dB 后应约为 -24～-28 dB，明显高于静音段
    expect(await measurePeakDb(withSfx, 0.92, 0.1)).toBeGreaterThan(-35);
    expect(await measurePeakDb(withSfx, 0.2, 0.5)).toBeLessThan(-60);

    const withoutSfx = path.join(root, 'without-sfx.wav');
    await buildMasterAudioWav({ ...common, outWav: withoutSfx });
    expect(await measurePeakDb(withoutSfx, 0.92, 0.1)).toBeLessThan(-60);
  });

  it('开关与等待时间解析：关闭音效返回 0，启用时默认 1000ms', () => {
    expect(resolvePageTurnPostDelayMs(undefined)).toBe(0);
    expect(resolvePageTurnPostDelayMs({ file: '   ' })).toBe(0);
    expect(resolvePageTurnPostDelayMs({ file: 'assets/sfx/page-click.wav' })).toBe(
      DEFAULT_PAGE_TURN_POST_DELAY_MS,
    );
    expect(
      resolvePageTurnPostDelayMs({ file: 'assets/sfx/page-click.wav', postDelayMs: 750 }),
    ).toBe(750);
  });

  it('切页等待 1 秒时，首页不变、其余页的口播与字幕顺延 1 秒，且经过帧网格量化后完整保留', () => {
    const sections: NarrationSection[] = [
      { key: 'intro', kind: 'intro', sentences: ['导语'] },
      {
        key: 'item-01',
        kind: 'item',
        itemId: 'i1',
        sentences: ['第一句', '第二句'],
      },
    ];
    const audioSections: SectionAudio[] = [
      {
        key: 'intro',
        file: '/tmp/run/audio/intro.wav',
        speechMs: 3000,
        sentences: [{ text: '导语', offsetMs: 0, durationMs: 3000 }],
      },
      {
        key: 'item-01',
        file: '/tmp/run/audio/item-01.wav',
        speechMs: 4000,
        sentences: [
          { text: '第一句', offsetMs: 0, durationMs: 2000 },
          { text: '第二句', offsetMs: 2000, durationMs: 2000 },
        ],
      },
    ];
    const tl = buildTimeline({
      sections,
      audioSections,
      runDir: '/tmp/run',
      pagePaddingSec: 1.0,
      sectionGapMs: 0,
      sectionLeadSilenceMs: 1000,
    });

    expect(tl.sections[0]?.speechOffsetMs).toBeUndefined();
    expect(tl.sections[0]?.pageMs).toBe(4000);
    expect(tl.sections[1]?.startMs).toBe(4000);
    expect(tl.sections[1]?.speechOffsetMs).toBe(1000);
    expect(tl.sections[1]?.pageMs).toBe(6000);
    expect(tl.sections[1]?.sentences[0]?.startMs).toBe(5000);
    expect(tl.sections[1]?.sentences[1]?.startMs).toBe(7000);
    expect(tl.totalMs).toBe(10_000);

    const q = quantizeTimelineToFps(tl, 30);
    expect(q.sections[0]?.speechOffsetMs).toBe(0);
    expect(q.sections[1]?.speechOffsetMs).toBe(1000);
    expect(q.sections[1]?.speechMs).toBe(4000);
    expect(q.audioTimeline.sections[1]?.speechOffsetMs).toBe(1000);
    expect(q.audioTimeline.sections[1]?.sentences[0]?.startMs).toBe(5000);
  });

  it('真实混音：点击音效响在切页前，之后整整 1 秒保持安静，再开始下一段口播', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aidaily-post-delay-'));
    tempDirs.push(root);
    const runDir = path.join(root, 'run');
    await fs.mkdir(path.join(runDir, 'audio'), { recursive: true });
    await execa('ffmpeg', [
      '-y',
      '-f',
      'lavfi',
      '-i',
      'anullsrc=r=48000:cl=stereo',
      '-t',
      '1',
      path.join(runDir, 'audio', 'sec-0.wav'),
    ]);
    await execa('ffmpeg', [
      '-y',
      '-f',
      'lavfi',
      '-i',
      'sine=f=440:d=1.2:sample_rate=48000',
      '-ac',
      '2',
      path.join(runDir, 'audio', 'sec-1.wav'),
    ]);
    const clickFile = path.join(root, 'click.wav');
    await execa('ffmpeg', [
      '-y',
      '-f',
      'lavfi',
      '-i',
      'sine=f=3000:d=0.05:sample_rate=48000',
      '-ac',
      '2',
      clickFile,
    ]);

    const timeline: Timeline = {
      totalMs: 3200,
      sections: [
        {
          key: 'sec-0',
          kind: 'intro',
          audioFile: 'audio/sec-0.wav',
          startMs: 0,
          speechMs: 1000,
          pageMs: 1000,
          sentences: [],
        },
        {
          key: 'sec-1',
          kind: 'item',
          itemId: 'item-1',
          audioFile: 'audio/sec-1.wav',
          startMs: 1000,
          speechOffsetMs: 1000,
          speechMs: 1200,
          pageMs: 2200,
          sentences: [],
        },
      ],
    };

    const outWav = path.join(root, 'master.wav');
    await buildMasterAudioWav({
      timeline,
      runDir,
      outWav,
      sampleRate: 48_000,
      loudnessLUFS: -16,
      isSilentProvider: true,
      bgm: { file: '', volumeDb: -12, duckDb: -5 },
      pageTurnSfx: {
        file: clickFile,
        volumeDb: -6,
        atMs: computePageTurnSfxTimesMs(timeline, 60),
      },
      rootDir: root,
    });

    // startMs = 1000ms，点击在 940ms，1120~1900ms 应完全安静，2000ms 起人声开始响起
    expect(await measurePeakDb(outWav, 0.92, 0.1)).toBeGreaterThan(-35);
    expect(await measurePeakDb(outWav, 1.12, 0.78)).toBeLessThan(-60);
    expect(await measurePeakDb(outWav, 2.05, 0.45)).toBeGreaterThan(-35);
  });
});

describe('信息卡片图标清单', () => {
  it('合同里的图标清单包含新增图标和旧版兼容名', () => {
    const options = InfoCardIconSchema.options;
    expect(options).toHaveLength(32);
    for (const name of ['coins', 'candlestick', 'user-minus', 'quote', 'alert', 'grid']) {
      expect(options).toContain(name);
    }
    expect(InfoCardIconSchema.safeParse('not-an-icon').success).toBe(false);
  });
});
