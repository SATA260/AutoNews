import path from 'node:path';
import type {
  ContentLimits,
  IssuePackage,
  NarrationSection,
  SectionAudio,
  Settings,
} from '@aidaily/contracts';
import { describe, expect, it } from 'vitest';
import { precheckIssuePackage } from '../src/index.js';
import { buildTimeline, quantizeTimelineToFps } from '../src/media/timeline.js';

const LIMITS: ContentLimits = {
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
};

const PUBLISH_CONFIG: Settings['publish']['bilibili'] = {
  cli: 'biliup',
  cookieFile: '~/cookies.json',
  tid: 231,
  copyright: 1,
  titleMax: 80,
  descMax: 2000,
  tagsMax: 12,
  defaultTags: ['AI', '人工智能', '科技资讯', 'AI每日报'],
  aiDeclaration: true,
  aiDisclaimerText: 'AI 生成免责声明',
};

function makePackage(guestReactions?: IssuePackage['guestReactions']): IssuePackage {
  return {
    order: ['item-1'],
    headlineItemId: 'item-1',
    headline: 'OpenAI把ChatGPT和Codex合并计费，免费额度翻倍',
    leadSummary: 'OpenAI合并订阅体系并提高免费额度。',
    intro: {
      narration: ['免费额度翻倍，OpenAI把ChatGPT和Codex合并计费了，直接看细则。'],
      hostComment: '算力账越算越精。',
    },
    outro: {
      narration: ['今天的账先算到这儿，我是聪明的大肥鱼，咱们下期见。'],
      hostComment: '下期继续看热闹。',
      cta: '哪一条最戳中你？欢迎在评论区聊聊。',
    },
    publish: {
      title: '白嫖额度直接翻倍！OpenAI合并ChatGPT与Codex计费，背后算盘打响',
      descriptionIntro: '本期聚焦OpenAI计费体系调整。',
      tags: ['OpenAI'],
    },
    cover: { title: 'OpenAI\n*额度翻倍*', subtitle: 'ChatGPT与Codex合并计费' },
    ...(guestReactions ? { guestReactions } : {}),
  };
}

describe('M4：四阵营跨阵营互怼与时间轴内嵌窗口', () => {
  it('预检允许合法的异阵营插嘴吐槽，并拦截同阵营自怼或未知条目', () => {
    const okRes = precheckIssuePackage({
      pkg: makePackage([
        {
          itemId: 'item-1',
          hostId: 'claude',
          line: '额度给得挺大方，就是不知道高峰期稳不稳。',
          mood: 'thinking',
        },
      ]),
      expectedItemIds: ['item-1'],
      limits: LIMITS,
      publishConfig: PUBLISH_CONFIG,
      metaTextBlacklist: [],
      compact: true,
      hostSelfName: '聪明的大肥鱼',
      activeHostId: 'deepseek',
    });
    expect(okRes.passed).toBe(true);

    const selfRoastRes = precheckIssuePackage({
      pkg: makePackage([
        {
          itemId: 'item-1',
          hostId: 'deepseek',
          line: '我自己吐槽一下自己，看看能不能通过。',
        },
      ]),
      expectedItemIds: ['item-1'],
      limits: LIMITS,
      publishConfig: PUBLISH_CONFIG,
      metaTextBlacklist: [],
      compact: true,
      hostSelfName: '聪明的大肥鱼',
      activeHostId: 'deepseek',
    });
    expect(selfRoastRes.passed).toBe(false);
    expect(selfRoastRes.errors.some((e) => e.includes('不能与当期主讲主播相同'))).toBe(true);
  });

  it('时间轴在原条目末尾内嵌嘉宾插嘴窗口，不增加额外翻页并在帧率量化后保持对齐', () => {
    const runDir = '/tmp/run-m4-test';
    const sections: NarrationSection[] = [
      { key: 'intro', kind: 'intro', sentences: ['开场一句。'] },
      { key: 'item-01', kind: 'item', itemId: 'item-1', sentences: ['主讲正文一句。'] },
      { key: 'outro', kind: 'outro', sentences: ['结尾报名字道别。'] },
    ];
    const audioSections: SectionAudio[] = [
      {
        key: 'intro',
        file: path.join(runDir, 'audio', 'intro.wav'),
        speechMs: 2000,
        sentences: [{ text: '开场一句。', offsetMs: 0, durationMs: 2000 }],
      },
      {
        key: 'item-01',
        file: path.join(runDir, 'audio', 'item-01.wav'),
        speechMs: 4000,
        sentences: [{ text: '主讲正文一句。', offsetMs: 0, durationMs: 4000 }],
      },
      {
        key: 'outro',
        file: path.join(runDir, 'audio', 'outro.wav'),
        speechMs: 2000,
        sentences: [{ text: '结尾报名字道别。', offsetMs: 0, durationMs: 2000 }],
      },
    ];
    const guestMap = new Map([
      [
        'item-1',
        {
          hostId: 'claude' as const,
          hostName: '小克',
          line: '额度给得挺大方，高峰期别掉链子就行。',
          mood: 'thinking' as const,
          audio: {
            key: 'guest-item-01',
            file: path.join(runDir, 'audio', 'guest-item-01.wav'),
            speechMs: 2200,
            sentences: [
              { text: '额度给得挺大方，高峰期别掉链子就行。', offsetMs: 0, durationMs: 2200 },
            ],
          },
        },
      ],
    ]);

    const timeline = buildTimeline({
      sections,
      audioSections,
      runDir,
      pagePaddingSec: 1,
      sectionGapMs: 0,
      sectionLeadSilenceMs: 1000,
      guestAudiosByItemId: guestMap,
    });

    // 章节总数保持 3 页（不额外触发切页音效）
    expect(timeline.sections).toHaveLength(3);
    const itemSec = timeline.sections[1];
    expect(itemSec?.guestWindow).toBeDefined();
    expect(itemSec?.guestWindow?.hostId).toBe('claude');
    expect(itemSec?.guestWindow?.offsetInSectionMs).toBe(1000 + 4000 + 260);
    expect(itemSec?.guestWindow?.durationMs).toBe(2200);
    expect(itemSec?.pageMs).toBe(1000 + 4000 + 260 + 2200 + 1000);

    const quantized = quantizeTimelineToFps(timeline, 30);
    const qItemSec = quantized.audioTimeline.sections[1];
    expect(qItemSec?.guestWindow?.hostId).toBe('claude');
    expect(qItemSec?.guestWindow?.startMs).toBeGreaterThanOrEqual(qItemSec?.startMs ?? 0);
  });
});
