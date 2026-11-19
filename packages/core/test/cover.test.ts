import type { ContentLimits, IssuePackage, Settings } from '@aidaily/contracts';
import { COVER_TEXT_LIMITS } from '@aidaily/contracts';
import { describe, expect, it } from 'vitest';
import {
  checkCoverText,
  clipAtPause,
  coverTextLength,
  deriveFallbackCoverText,
  normalizeCoverText,
  precheckIssuePackage,
} from '../src/index.js';

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
  narrationSentence: 40,
};

const PUBLISH_CONFIG: Settings['publish']['bilibili'] = {
  cli: 'biliup',
  cookieFile: '~/cookies.json',
  tid: 231,
  copyright: 1,
  titleMax: 80,
  descMax: 2000,
  tagsMax: 6,
  defaultTags: ['AI', '人工智能', '科技资讯', 'AI每日报'],
  aiDeclaration: true,
  aiDisclaimerText: 'AI 生成声明',
};

/** 构造一份能通过基础预检的整期编排结果 */
function makePackage(cover?: IssuePackage['cover']): IssuePackage {
  return {
    order: ['item-1'],
    headlineItemId: 'item-1',
    headline: 'OpenAI发布GPT-6.2双模型，Astra高难任务跑分提升5.2分',
    leadSummary: 'OpenAI推出GPT-6.2双模型，成本大幅下降但用户评价两极分化。',
    intro: { narration: ['大家好，欢迎收看今天的AI每日报。'], hostComment: '今天看点很集中。' },
    outro: {
      narration: ['以上就是本期的全部内容。'],
      hostComment: '欢迎留言聊聊。',
      cta: '你平时最常用哪款模型？评论区聊聊。',
    },
    publish: {
      title: '史诗级翻车！OpenAI砸出GPT-6.2双模型，成本砍到三分之一！',
      descriptionIntro: '本期聚焦 GPT-6.2。',
      tags: ['GPT'],
    },
    ...(cover ? { cover } : {}),
  };
}

describe('封面文字规则', () => {
  it('统计字数时不计高亮星号与换行符', () => {
    expect(coverTextLength('GPT-6.2 *翻车了*')).toBe(11);
    expect(coverTextLength('英伟达\n*停发*H200')).toBe(9);
    expect(coverTextLength('英伟达\\n*停发*H200')).toBe(9);
  });

  it('检查字数上限、行数上限、空标题与星号配对', () => {
    expect(checkCoverText({ title: 'GPT-6.2 *翻车了*', subtitle: '成本砍到三分之一' })).toEqual([]);
    expect(
      checkCoverText({ title: '英伟达\n*停发*H200', subtitle: '六十万颗芯片滞留香港' }),
    ).toEqual([]);
    expect(
      checkCoverText({ title: '*英伟达\n停发*H200', subtitle: '六十万颗芯片滞留香港' }),
    ).toEqual([]);
    expect(
      checkCoverText({ title: '第一行\n第二行\n第三行\n第四行', subtitle: '' }).some((e) =>
        e.includes('最多分 3 行'),
      ),
    ).toBe(true);
    const tooLong = checkCoverText({
      title: '一'.repeat(COVER_TEXT_LIMITS.titleMax + 1),
      subtitle: '二'.repeat(COVER_TEXT_LIMITS.subtitleMax + 1),
    });
    expect(tooLong.some((e) => e.includes('主标题超出字数上限'))).toBe(true);
    expect(tooLong.some((e) => e.includes('副标题超出字数上限'))).toBe(true);
    expect(checkCoverText({ title: '**', subtitle: '' }).some((e) => e.includes('不能为空'))).toBe(
      true,
    );
    expect(
      checkCoverText({ title: 'GPT *翻车', subtitle: '' }).some((e) => e.includes('成对')),
    ).toBe(true);
    expect(
      checkCoverText({ title: 'GPT', subtitle: '*高亮*' }).some((e) => e.includes('不支持星号')),
    ).toBe(true);
  });

  it('整理多余空白并保留手动换行', () => {
    expect(normalizeCoverText({ title: '  GPT-6.2   翻车 ', subtitle: '\u3000一句话 ' })).toEqual({
      title: 'GPT-6.2 翻车',
      subtitle: '一句话',
    });
    expect(
      normalizeCoverText({ title: '  英伟达 \r\n\n *停发*H200  ', subtitle: '副标题\n第二行' }),
    ).toEqual({
      title: '英伟达\n*停发*H200',
      subtitle: '副标题 第二行',
    });
    expect(normalizeCoverText({ title: '英伟达\\n停发H200', subtitle: '' })).toEqual({
      title: '英伟达\n停发H200',
      subtitle: '',
    });
  });

  it('截断时优先停在逗号处，且不把英文词切成两半', () => {
    expect(clipAtPause('大模型推理提速，开源工具上线了很多', 10)).toBe('大模型推理提速');
    expect(clipAtPause('OpenAI发布GPT-6.2双模型', 14)).toBe('OpenAI发布');
    expect(clipAtPause('短标题。', 14)).toBe('短标题');
  });

  it('编排没给封面文字时，优先用头条短标题，放不下再截取导语', () => {
    const pkg = makePackage();
    expect(deriveFallbackCoverText(pkg, 'GPT-6.2双模型发布').title).toBe('GPT-6.2双模型发布');
    expect(deriveFallbackCoverText(pkg, '这是一个明显超过十四个字上限的超长短标题').title).toBe(
      'OpenAI发布',
    );
    const fallback = deriveFallbackCoverText(pkg);
    expect(coverTextLength(fallback.subtitle)).toBeLessThanOrEqual(COVER_TEXT_LIMITS.subtitleMax);
  });
});

describe('整期编排预检中的封面文字', () => {
  it('漏填封面文字只提醒，不打回', () => {
    const res = precheckIssuePackage({
      pkg: makePackage(),
      expectedItemIds: ['item-1'],
      limits: LIMITS,
      publishConfig: PUBLISH_CONFIG,
      metaTextBlacklist: [],
    });
    expect(res.passed).toBe(true);
    expect(res.warnings.some((w) => w.includes('封面文字'))).toBe(true);
  });

  it('封面文字超长或含自我描述用语时打回重写', () => {
    const res = precheckIssuePackage({
      pkg: makePackage({ title: '一'.repeat(20), subtitle: '以下是本期封面' }),
      expectedItemIds: ['item-1'],
      limits: LIMITS,
      publishConfig: PUBLISH_CONFIG,
      metaTextBlacklist: ['以下是'],
    });
    expect(res.passed).toBe(false);
    expect(res.errors.some((e) => e.includes('封面主标题超出字数上限'))).toBe(true);
    expect(res.errors.some((e) => e.includes('cover.subtitle'))).toBe(true);
  });

  it('合规的封面文字顺利通过', () => {
    const res = precheckIssuePackage({
      pkg: makePackage({ title: 'GPT-6.2 *翻车了*', subtitle: '成本砍到三分之一，却被差评淹没' }),
      expectedItemIds: ['item-1'],
      limits: LIMITS,
      publishConfig: PUBLISH_CONFIG,
      metaTextBlacklist: [],
    });
    expect(res.passed).toBe(true);
    expect(res.warnings.some((w) => w.includes('封面文字'))).toBe(false);
  });
});
