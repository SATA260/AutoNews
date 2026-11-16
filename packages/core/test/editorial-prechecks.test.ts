import type { ContentLimits, IssuePackage, PolishedItem, Settings } from '@aidaily/contracts';
import { describe, expect, it } from 'vitest';
import {
  buildArticlesXml,
  enforceFactCheckConsistency,
  extractArabicNumbers,
  isDuplicateOfHistory,
  longestCommonSubstringLength,
  precheckIssuePackage,
  precheckPolishedItem,
  renderPromptTemplate,
  titleJaccardSimilarity,
} from '../src/index.js';

const DEFAULT_LIMITS: ContentLimits = {
  headline: 42,
  leadSummary: 84,
  title: 48,
  shortTitle: 16,
  category: 8,
  summary: 90,
  keyPointsMax: 3,
  keyPoint: 28,
  detail: 200,
  hostComment: 46,
  narrationSentence: 40,
};

const BLACKLIST = ['已依据', '以下是', '根据您提供', '作为AI', '总结如下', '```'];

function makeValidPolishedItem(): PolishedItem {
  return {
    title: 'OpenAI 发布新模型，推理速度提升 2 倍',
    shortTitle: 'OpenAI 发布新模型',
    category: '大模型',
    entity: 'OpenAI',
    summary: 'OpenAI 正式推出新款推理模型，响应速度提升约 2 倍，现已向付费用户开放。',
    keyPoints: ['推理速度比上一代快 2 倍', '定价为每百万 tokens 15 美元'],
    detail: '新模型面向日常编码与复杂问答优化，目前向月费会员开放使用，官方表示延迟大幅降低。',
    hostComment: '推理加快对日常写代码和问答最实用。',
    narration: ['今天来看第一条重磅消息。', '新模型推理速度提升 2 倍，目前已向付费用户开放。'],
    evidence: [
      {
        claim: '新模型推理速度提升 2 倍，定价每百万 tokens 15 美元。',
        articleId: 'art-1',
        quote: 'The new model runs 2x faster at $15 per 1,000,000 tokens for paid subscribers.',
      },
    ],
  };
}

describe('editorial foundation: prompts, similarity, and deterministic prechecks', () => {
  it('renders prompt templates single-pass without expanding nested {{}} in articles', async () => {
    const rendered = await renderPromptTemplate('s3-summarize.md', {
      eventTitle: '测试主题',
      articlesXml: '<article id="a1">原文含 {{eventTitle}} 模板标记</article>',
    });
    expect(rendered.startsWith('<!--stage:summarize-->')).toBe(true);
    expect(rendered).toContain('原文含 {{eventTitle}} 模板标记');

    const xml = buildArticlesXml(
      [
        {
          id: 'low-tier',
          lang: 'en',
          sourceName: 'Blog C',
          tier: 3,
          publishedAt: '2026-11-16T08:00:00.000Z',
          text: 'C'.repeat(400),
        },
        {
          id: 'top-tier',
          lang: 'zh',
          sourceName: 'Official A',
          tier: 1,
          publishedAt: '2026-11-16T09:00:00.000Z',
          text: 'A'.repeat(200),
        },
      ],
      340,
    );
    expect(xml).toContain('id="top-tier"');
    expect(xml).toContain('A'.repeat(180));
    expect(xml.length).toBeLessThanOrEqual(340);
  });

  it('computes bigram Jaccard similarity and detects historical duplicates', () => {
    const high = titleJaccardSimilarity(
      'OpenAI 正式推出全新推理模型',
      'OpenAI 正式发布全新推理模型',
    );
    expect(high).toBeGreaterThan(0.6);

    const low = titleJaccardSimilarity('OpenAI 发布推理模型', '谷歌推出新版机器人控制算法');
    expect(low).toBeLessThan(0.3);

    const dup = isDuplicateOfHistory(
      'OpenAI 推出全新推理模型',
      [{ title: 'OpenAI 发布全新推理模型' }],
      0.6,
    );
    expect(dup.duplicate).toBe(true);
  });

  it('passes precheck for valid quotes (including 90% LCS) and normalized comma/full-width numbers', () => {
    const articlesById = new Map([
      [
        'art-1',
        {
          text: 'OpenAI announced today: “The new model runs 2x faster at $15 per 1,000,000 tokens for paid subscribers.” Additional details follow.',
          publishedAt: '2026-11-16T08:00:00.000Z',
        },
      ],
    ]);

    const item = makeValidPolishedItem();
    item.summary = '新模型面向会员开放，每百万 tokens 价格为 １５ 美元。';
    item.narration = [
      '每百万个词元的价格为 15 美元，速度提升 2 倍。',
      '一共 1000000 个词元计费一次。',
    ];
    const ok = precheckPolishedItem({
      item,
      articlesById,
      limits: DEFAULT_LIMITS,
      metaTextBlacklist: BLACKLIST,
    });
    expect(ok.errors).toEqual([]);
    expect(ok.passed).toBe(true);

    // 验证 90% 最长公共子串宽松容错匹配（末尾标点或缩写略有差异）
    const fuzzyItem = makeValidPolishedItem();
    fuzzyItem.evidence[0] = {
      claim: '推理速度翻倍',
      articleId: 'art-1',
      quote: 'The new model runs 2x faster at $15 per 1,000,000 tokens for paid!',
    };
    expect(longestCommonSubstringLength('The new model runs', 'The new model runs 2x faster')).toBe(
      18,
    );
    expect(extractArabicNumbers('１，０００，０００ 次调用约 3.5 秒')).toEqual(['1000000', '3.5']);
    const fuzzyRes = precheckPolishedItem({
      item: fuzzyItem,
      articlesById,
      limits: DEFAULT_LIMITS,
      metaTextBlacklist: BLACKLIST,
    });
    expect(fuzzyRes.passed).toBe(true);
  });

  it('rejects fabricated numbers, weak quotes, over-length fields, meta-text, and invalid narration', () => {
    const articlesById = new Map([
      [
        'art-1',
        {
          text: 'The new model runs 2x faster for paid users.',
          publishedAt: '2026-11-16T08:00:00.000Z',
        },
      ],
    ]);

    const bad = makeValidPolishedItem();
    bad.title = '标题'.repeat(30); // 超出 48 字
    bad.summary = '以下是根据您提供的资料整理：准确率高达 99.8%。'; // 黑名单 + 编造数字
    bad.narration = ['Only English sentence with https://example.com and **bold**'];
    bad.evidence[0] = {
      claim: '完全编造',
      articleId: 'art-1',
      quote: 'This completely unrelated quote never appears anywhere in the source text.',
    };

    const res = precheckPolishedItem({
      item: bad,
      articlesById,
      limits: DEFAULT_LIMITS,
      metaTextBlacklist: BLACKLIST,
    });
    expect(res.passed).toBe(false);
    expect(res.errors.some((e) => e.includes('90%'))).toBe(true);
    expect(res.errors.some((e) => e.includes('99.8'))).toBe(true);
    expect(res.errors.some((e) => e.includes('超出字数上限'))).toBe(true);
    expect(res.errors.some((e) => e.includes('以下是'))).toBe(true);
    expect(res.errors.some((e) => e.includes('缺少中文内容'))).toBe(true);
    expect(res.errors.some((e) => e.includes('网址链接'))).toBe(true);
    expect(res.errors.some((e) => e.includes('Markdown'))).toBe(true);
  });

  it('validates IssuePackage ordering, headline match, tag quota, and narration rules', () => {
    const publishConfig: Settings['publish']['bilibili'] = {
      cli: 'biliup',
      cookieFile: 'storage/secrets/bilibili-cookies.json',
      tid: 0,
      copyright: 1,
      titleMax: 80,
      descMax: 2000,
      tagsMax: 6,
      defaultTags: ['AI', '人工智能', '科技资讯', 'AI每日报'],
      aiDeclaration: true,
      aiDisclaimerText: 'AI 生成声明',
    };

    const validPkg: IssuePackage = {
      order: ['item-2', 'item-1'],
      headlineItemId: 'item-2',
      headline: '今日头条看点：大模型推理大幅提速',
      leadSummary: '今天重点带来大模型推理加速和开源工具更新两条重磅动态。',
      intro: {
        narration: ['大家好，欢迎收看今天的 AI 每日报。'],
        hostComment: '今天的两条动态非常实用。',
      },
      outro: {
        narration: ['以上就是本期的全部内容。'],
        hostComment: '欢迎在评论区留下你的看法。',
        cta: '你平时最常用哪款模型？评论区聊聊。',
      },
      publish: {
        title: 'AI每日报｜大模型推理提速两倍，新开源工具上线',
        descriptionIntro: '本期聚焦推理加速与开源生态新工具。',
        tags: ['大模型', '开源工具'],
      },
    };

    const ok = precheckIssuePackage({
      pkg: validPkg,
      expectedItemIds: ['item-1', 'item-2'],
      limits: DEFAULT_LIMITS,
      publishConfig,
      metaTextBlacklist: BLACKLIST,
    });
    expect(ok.passed).toBe(true);

    const badPkg: IssuePackage = {
      ...validPkg,
      headlineItemId: 'item-1', // 不等于 order[0]
      publish: {
        ...validPkg.publish,
        tags: ['标签一', '标签二', '标签三'], // 超出 6 - 4 = 2 个配额
      },
    };
    const bad = precheckIssuePackage({
      pkg: badPkg,
      expectedItemIds: ['item-1', 'item-2'],
      limits: DEFAULT_LIMITS,
      publishConfig,
      metaTextBlacklist: BLACKLIST,
    });
    expect(bad.passed).toBe(false);
    expect(bad.errors.some((e) => e.includes('headlineItemId'))).toBe(true);
    expect(bad.errors.some((e) => e.includes('额外投稿标签数量'))).toBe(true);
  });

  it('does not ground numbers via publishedAt or unverified fuzzy quotes and requires non-empty claims for pass', () => {
    const articlesById = new Map([
      [
        'art-1',
        {
          text: 'OpenAI announced a faster model update today for paying subscribers across all tiers.',
          publishedAt: '2026-11-16T08:00:00.000Z',
        },
      ],
    ]);

    const item = makeValidPolishedItem();
    item.title = '2026 年模型迎来三十项重大升级';
    item.summary = '发布日 16 号公布新计划，价格约为 99 元，覆盖两千家商户。';
    item.narration = ['本次模型面向付费会员开放。'];
    item.evidence = [
      {
        claim: '速度提升',
        articleId: 'art-1',
        // 超过 90% 相似但篡改了一个数字“99”的引语不应放行该数字
        quote:
          'OpenAI announced a faster model update 99 today for paying subscribers across all tiers.',
      },
    ];

    const res = precheckPolishedItem({
      item,
      articlesById,
      limits: DEFAULT_LIMITS,
      metaTextBlacklist: BLACKLIST,
    });
    expect(res.passed).toBe(false);
    expect(res.errors.some((e) => e.includes('2026'))).toBe(true);
    expect(res.errors.some((e) => e.includes('16'))).toBe(true);
    expect(res.errors.some((e) => e.includes('99'))).toBe(true);
    expect(res.warnings.some((w) => w.includes('三十') || w.includes('两千'))).toBe(true);

    const emptyClaimsFc = enforceFactCheckConsistency({
      verdict: 'pass',
      claims: [],
      revisionNotes: [],
    });
    expect(emptyClaimsFc.verdict).toBe('revise');
    expect(emptyClaimsFc.revisionNotes.length).toBeGreaterThan(0);
  });
});
