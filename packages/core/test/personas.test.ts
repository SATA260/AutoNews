import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { type EventRecord, PersonasFileSchema, type Timeline } from '@aidaily/contracts';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { chooseHost, deriveMascotMood } from '../src/editorial/personas.js';
import { precheckIssuePackage } from '../src/editorial/prechecks.js';
import { computeLipSyncFramesFromWavBuffer } from '../src/media/lipsync.js';
import { quantizeTimelineToFps } from '../src/media/timeline.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

/** 创建用于选角测试的新闻事件。 */
function event(entity: string, category: string): EventRecord {
  return {
    id: entity,
    runId: 'run',
    rank: 1,
    role: 'primary',
    title: entity,
    articleIds: ['article'],
    category,
    entity,
    score: 9,
    publicAppeal: 9,
    reason: '重要',
    refillRound: 0,
  };
}

/** 构造一段带可选自定义头部子块的单声道 16 位 PCM WAV 内存字节流用于口型提取单测 */
function createTestPcmWavBuffer(samples: readonly number[], sampleRate = 24000): Buffer {
  const junkPayload = Buffer.from('Lavf61.1.100', 'ascii');
  const junkChunkSize = junkPayload.length;
  const junkPadded = junkChunkSize + (junkChunkSize % 2);
  const dataByteLen = samples.length * 2;
  const totalRiffPayload = 4 + (8 + 16) + (8 + junkPadded) + (8 + dataByteLen);
  const buf = Buffer.alloc(8 + totalRiffPayload);

  let offset = 0;
  buf.write('RIFF', offset, 'ascii');
  buf.writeUInt32LE(totalRiffPayload, offset + 4);
  buf.write('WAVE', offset + 8, 'ascii');
  offset += 12;

  buf.write('fmt ', offset, 'ascii');
  buf.writeUInt32LE(16, offset + 4);
  buf.writeUInt16LE(1, offset + 8); // PCM
  buf.writeUInt16LE(1, offset + 10); // mono
  buf.writeUInt32LE(sampleRate, offset + 12);
  buf.writeUInt32LE(sampleRate * 2, offset + 16);
  buf.writeUInt16LE(2, offset + 20);
  buf.writeUInt16LE(16, offset + 22);
  offset += 24;

  buf.write('LIST', offset, 'ascii');
  buf.writeUInt32LE(junkChunkSize, offset + 4);
  junkPayload.copy(buf, offset + 8);
  offset += 8 + junkPadded;

  buf.write('data', offset, 'ascii');
  buf.writeUInt32LE(dataByteLen, offset + 4);
  offset += 8;

  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i] ?? 0));
    buf.writeInt16LE(Math.round(clamped * 32767), offset + i * 2);
  }
  return buf;
}

describe('主播配置、情绪推导、口型包络提取与帧时间轴量化', () => {
  it('验证四位主播配置，并按阵营和话题选择主播及情绪状态', async () => {
    const personas = PersonasFileSchema.parse(
      parse(await fs.readFile(path.join(root, 'config/personas.yaml'), 'utf8')),
    ).personas;
    expect(chooseHost([event('OpenAI', '产品'), event('Anthropic', '编程')], personas, null)).toBe(
      'gpt',
    );
    expect(chooseHost([event('第三方', '多模态硬件')], personas, null)).toBe('gemini');
    expect(
      chooseHost([{ ...event('第三方', '新闻'), title: 'OpenAI 发布新模型' }], personas, null),
    ).toBe('gpt');
    expect(
      chooseHost(
        [
          { ...event('OpenAI', '新闻'), title: 'OpenAI 更新' },
          { ...event('Anthropic', '多模态'), title: 'Anthropic 更新' },
          { ...event('Anthropic', '多模态'), title: 'Anthropic 发布视频模型' },
        ],
        personas,
        null,
      ),
    ).not.toBe('gemini');
    expect(chooseHost([event('第三方', '新闻')], personas, 'gpt')).not.toBe('gpt');

    expect(deriveMascotMood('deepseek', 'DeepSeek 开源推理引擎', personas)).toBe('proud');
    expect(deriveMascotMood('deepseek', '多名用户反馈DeepSeek算力不足出现限流', personas)).toBe(
      'thinking',
    );
    expect(deriveMascotMood('gemini', 'Google宣布Gemini免费开放新功能', personas)).toBe('proud');
    expect(deriveMascotMood('deepseek', 'OpenAI 发布新模型', personas)).toBe('surprised');
    expect(deriveMascotMood('deepseek', '新一代稀疏推理基准评测', personas)).toBe('thinking');
    expect(deriveMascotMood('deepseek', '科技展会今日开幕', personas)).toBe('neutral');

    expect(chooseHost([event('Antigravity', '产品')], personas, null)).toBe('gemini');
    expect(chooseHost([event('Claude Code', '产品')], personas, null)).toBe('claude');

    expect(() =>
      PersonasFileSchema.parse({ personas: [personas[0], personas[0], personas[1], personas[2]] }),
    ).toThrow();

    const byId = new Map(personas.map((persona) => [persona.id, persona]));
    expect(byId.get('deepseek')?.selfName).toBe('聪明的大肥鱼');
    expect(byId.get('gemini')?.selfName).toBe('哈基米');
    expect(byId.get('gpt')?.selfName).toBe('gpt');
    expect(byId.get('claude')?.selfName).toBe('小克');
    for (const persona of personas) {
      expect(persona.affiliation.length).toBeGreaterThan(0);
      expect(persona.identityBio.length).toBeGreaterThan(10);
      expect(persona.ownGoodReaction.length).toBeGreaterThan(10);
      expect(persona.ownFlawReaction.length).toBeGreaterThan(10);
      expect(persona.rivalReaction.length).toBeGreaterThan(5);
      expect(persona.introExamples[0]).toContain(persona.selfName);
      expect(persona.introExamples[0]).not.toMatch(/公司的/);
    }

    const gemini = byId.get('gemini');
    const rejected = precheckIssuePackage({
      pkg: {
        order: ['item-1'],
        headlineItemId: 'item-1',
        headline: '谷歌发布多模态新进展',
        leadSummary: '今天一起来看看重点更新。',
        intro: {
          narration: ['大家好，我是Gemini娘，欢迎收看今天的AI每日报。'],
          hostComment: '今天看点很足。',
        },
        outro: {
          narration: ['感谢收看，我们下期再见。'],
          hostComment: '欢迎留言讨论。',
          cta: '你最看好哪项新功能？',
        },
        publish: {
          title: 'AI每日报｜谷歌发布多模态新进展',
          descriptionIntro: '本期梳理重点动态。',
          tags: ['Gemini'],
        },
      },
      expectedItemIds: ['item-1'],
      limits: {
        headline: 42,
        leadSummary: 84,
        title: 48,
        shortTitle: 16,
        progressLabel: 10,
        category: 8,
        summary: 90,
        keyPointsMax: 3,
        keyPoint: 28,
        detail: 200,
        hostComment: 46,
        narrationSentence: 40,
      },
      publishConfig: {
        cli: 'biliup',
        cookieFile: 'storage/secrets/bilibili-cookies.json',
        tid: 231,
        copyright: 1 as const,
        titleMax: 80,
        descMax: 2000,
        tagsMax: 12,
        defaultTags: ['AI'],
        aiDeclaration: true as const,
        aiDisclaimerText: '本视频由 AI 辅助制作。',
      },
      metaTextBlacklist: ['以下是'],
      forbiddenTokens: gemini?.forbiddenTokens,
      hostSelfName: gemini?.selfName,
    });
    expect(rejected.passed).toBe(false);
    expect(rejected.errors.some((err) => err.includes('哈基米'))).toBe(true);

    const compactBasePkg = {
      order: ['item-1'],
      headlineItemId: 'item-1',
      headline: '谷歌发布多模态新进展',
      leadSummary: '今天一起来看看重点更新。',
      outro: {
        narration: ['今天的资讯播送完了，我是哈基米，明天见。'],
        hostComment: '欢迎留言讨论。',
        cta: '你最看好哪项新功能？',
      },
      publish: {
        title:
          'AI圈炸裂！Google重磅发布多模态新进展，核心交互体验大幅升级，免费名额正式向用户开放！',
        descriptionIntro: '本期梳理重点动态。',
        tags: ['Gemini'],
      },
    };
    const commonCompactOpts = {
      expectedItemIds: ['item-1'],
      limits: {
        headline: 42,
        leadSummary: 84,
        title: 48,
        shortTitle: 16,
        progressLabel: 10,
        category: 8,
        summary: 90,
        keyPointsMax: 3,
        keyPoint: 28,
        detail: 200,
        hostComment: 46,
        narrationSentence: 48,
      },
      publishConfig: {
        cli: 'biliup',
        cookieFile: 'storage/secrets/bilibili-cookies.json',
        tid: 231,
        copyright: 1 as const,
        titleMax: 80,
        descMax: 2000,
        tagsMax: 12,
        defaultTags: ['AI'],
        aiDeclaration: true as const,
        aiDisclaimerText: '本视频由 AI 辅助制作。',
      },
      metaTextBlacklist: ['以下是'],
      compact: true,
      forbiddenTokens: gemini?.forbiddenTokens,
      hostSelfName: gemini?.selfName,
    };

    const missingSelfIntro = precheckIssuePackage({
      pkg: {
        ...compactBasePkg,
        intro: {
          narration: ['大家好，欢迎收看今天的AI每日报，接下来请看详细报道。'],
          hostComment: '直接进入今天的内容。',
        },
      },
      ...commonCompactOpts,
    });
    expect(missingSelfIntro.passed).toBe(false);
    expect(missingSelfIntro.errors.some((e) => e.includes('自我介绍'))).toBe(true);

    const companyMentionIntro = precheckIssuePackage({
      pkg: {
        ...compactBasePkg,
        intro: {
          narration: ['大家好，我是谷歌公司的哈基米，欢迎收看今天的AI每日报。'],
          hostComment: '直接进入今天的内容。',
        },
      },
      ...commonCompactOpts,
    });
    expect(companyMentionIntro.passed).toBe(false);
    expect(companyMentionIntro.errors.some((e) => e.includes('不用说自己是哪个公司的'))).toBe(true);

    const cleanIntro = precheckIssuePackage({
      pkg: {
        ...compactBasePkg,
        intro: {
          narration: [
            '大家好，我是哈基米，欢迎收看今天的AI每日报。',
            '屏幕上是今天的主要内容，接下来请看详细报道。',
          ],
          hostComment: '直接进入今天的内容。',
        },
      },
      ...commonCompactOpts,
    });
    expect(cleanIntro.errors).toEqual([]);
    expect(cleanIntro.passed).toBe(true);
  });

  it('从含扩展元数据块的 WAV 字节流中提取纯响度决定的口型开合序列', () => {
    const sampleRate = 24000;
    const totalSamples = sampleRate * 1;
    const samples: number[] = [];
    for (let i = 0; i < totalSamples; i++) {
      if (i < sampleRate * 0.5) {
        samples.push(0.45 * Math.sin((2 * Math.PI * 220 * i) / sampleRate));
      } else {
        samples.push(0);
      }
    }

    const wavBuf = createTestPcmWavBuffer(samples, sampleRate);
    const frames = computeLipSyncFramesFromWavBuffer(wavBuf, {
      fps: 30,
      totalDurationMs: 1400,
    });

    expect(frames).toHaveLength(42);
    // 恒定振幅正弦波稳定收敛后不再随帧号正弦起伏
    expect(frames[10]).toBeCloseTo(frames[11] ?? 0, 2);
    expect(Math.max(...frames.slice(2, 14))).toBeGreaterThan(0.5);
    expect(frames.slice(30).every((v) => v === 0)).toBe(true);
  });

  it('将非帧边界毫秒时间轴统一量化为无重叠全局帧区间并对齐主音轨起点', () => {
    const rawTimeline: Timeline = {
      totalMs: 8002,
      sections: [
        {
          key: 'intro',
          kind: 'intro',
          audioFile: 'audio/intro.wav',
          startMs: 0,
          speechMs: 3200,
          pageMs: 4001,
          sentences: [],
        },
        {
          key: 'outro',
          kind: 'outro',
          audioFile: 'audio/outro.wav',
          startMs: 4001,
          speechMs: 3200,
          pageMs: 4001,
          sentences: [],
        },
      ],
    };

    const q = quantizeTimelineToFps(rawTimeline, 30);
    expect(q.totalFrames).toBe(240);
    // 4000ms (第 120 帧) < 4001ms 严格归入首章，首章共 121 帧，次章从第 121 帧 (4033.33ms) 起算
    expect(q.sections[0]).toMatchObject({ startFrame: 0, frameCount: 121 });
    expect(q.sections[1]).toMatchObject({ startFrame: 121, frameCount: 119 });
    expect(q.audioTimeline.sections[0]?.startMs).toBe(0);
    expect(q.audioTimeline.sections[1]?.startMs).toBe(4033);
    expect(q.audioTimeline.totalMs).toBe(8000);
  });
});
