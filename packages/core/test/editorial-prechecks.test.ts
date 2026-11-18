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
  selectGroundedEvidence,
  titleJaccardSimilarity,
} from '../src/index.js';

const DEFAULT_LIMITS: ContentLimits = {
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

const BLACKLIST = ['已依据', '以下是', '根据您提供', '作为AI', '总结如下', '```'];

function makeValidPolishedItem(): PolishedItem {
  return {
    title: 'OpenAI 发布新模型，推理速度提升 2 倍',
    shortTitle: 'OpenAI 发布新模型',
    progressLabel: 'OpenAI推理提速',
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
    item.cards = [
      {
        icon: 'rocket',
        title: '核心发布',
        body: 'OpenAI 宣布推出全新推理模型，整体响应速度提升 2 倍。',
      },
      {
        icon: 'trending-down',
        title: '定价与档位',
        body: '每 1000000 tokens 定价 15 美元，现已向付费订阅用户开放。',
      },
      {
        icon: 'zap',
        title: '工程体验',
        body: '主要面向日常编码、逻辑推理与复杂问答场景提供更低延迟。',
      },
      {
        icon: 'shield',
        title: '可用范围',
        body: '目前仅面向付费订阅用户开放使用，免费档位暂未包含本次更新。',
      },
    ];
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
    bad.progressLabel = '太短'; // 少于 4 字
    bad.summary = '以下是根据您提供的资料整理：准确率高达 99.8%。'; // 黑名单 + 编造数字
    bad.cards = [
      {
        icon: 'cpu',
        title: '虚假性能对比卡片',
        body: '总结如下：跑分提升高达 77.7%，建议立即升级体验。',
      },
    ];
    bad.narration = [
      'Only English sentence with https://example.com and **bold**',
      '今天 用空格 断句',
    ];
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
    expect(res.errors.some((e) => e.includes('77.7'))).toBe(true);
    expect(res.errors.some((e) => e.includes('总结如下'))).toBe(true);
    expect(res.errors.some((e) => e.includes('超出字数上限'))).toBe(true);
    expect(res.errors.some((e) => e.includes('progressLabel'))).toBe(true);
    expect(res.errors.some((e) => e.includes('以下是'))).toBe(true);
    expect(res.errors.some((e) => e.includes('缺少中文内容'))).toBe(true);
    expect(res.errors.some((e) => e.includes('网址链接'))).toBe(true);
    expect(res.errors.some((e) => e.includes('Markdown'))).toBe(true);
    expect(res.errors.some((e) => e.includes('多余空格或使用空格断句'))).toBe(true);
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

    const compactValidPkg: IssuePackage = {
      ...validPkg,
      intro: {
        narration: [
          '大家好，我是哈基米，欢迎收看今天的AI每日报。',
          '屏幕上是今天的主要内容，接下来请看详细报道。',
        ],
        hostComment: '今天看点很集中。',
      },
      outro: {
        narration: ['今天的资讯播送完了，我是哈基米，明天见。'],
        hostComment: '欢迎留言聊聊。',
        cta: '你平时最常用哪款模型？评论区聊聊。',
      },
      publish: {
        title:
          'AI圈大地震！OpenAI发布新推理模型，速度翻倍定价每百万15美元，付费会员现已可直接体验！',
        descriptionIntro: '本期聚焦推理加速与新开放方案。',
        tags: ['大模型', '开源工具'],
      },
    };
    const compactTitleOk = precheckIssuePackage({
      pkg: compactValidPkg,
      expectedItemIds: ['item-1', 'item-2'],
      limits: DEFAULT_LIMITS,
      publishConfig,
      metaTextBlacklist: BLACKLIST,
      compact: true,
      hostSelfName: '哈基米',
    });
    expect(compactTitleOk.errors).toEqual([]);
    expect(compactTitleOk.passed).toBe(true);

    const badColumnTitle = precheckIssuePackage({
      pkg: {
        ...compactValidPkg,
        publish: {
          ...compactValidPkg.publish,
          title: 'AI每日报｜新模型发布速度翻倍并开启体验',
        },
      },
      expectedItemIds: ['item-1', 'item-2'],
      limits: DEFAULT_LIMITS,
      publishConfig,
      metaTextBlacklist: BLACKLIST,
      compact: true,
      hostSelfName: '哈基米',
    });
    expect(badColumnTitle.passed).toBe(false);
    expect(badColumnTitle.errors.some((e) => e.includes('死板栏目名开头'))).toBe(true);

    const badUnderscoreAndShortTitle = precheckIssuePackage({
      pkg: {
        ...compactValidPkg,
        publish: {
          ...compactValidPkg.publish,
          title: '模型炸裂_新版本上线速度翻倍',
        },
      },
      expectedItemIds: ['item-1', 'item-2'],
      limits: DEFAULT_LIMITS,
      publishConfig,
      metaTextBlacklist: BLACKLIST,
      compact: true,
      hostSelfName: '哈基米',
    });
    expect(badUnderscoreAndShortTitle.passed).toBe(false);
    expect(badUnderscoreAndShortTitle.errors.some((e) => e.includes('三十二字'))).toBe(true);
    expect(badUnderscoreAndShortTitle.errors.some((e) => e.includes('情绪张力钩子'))).toBe(true);
    expect(badUnderscoreAndShortTitle.errors.some((e) => e.includes('下划线'))).toBe(true);
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

  it('normalizes Unicode hyphens, grounded magnitude/month conversions, evidence fallback recovery, and minor severity convergence', () => {
    const articlesById = new Map([
      [
        'art-en',
        {
          text: [
            'On November 17, OpenAI unveiled GPT\u20116 with a 12 million context index and $44 billion–$62 billion annualized run rate alongside $8.2B quarterly revenue across six countries.',
            'Independent benchmarks tested 185,000 real-world prompts.',
          ].join(' '),
          publishedAt: '2026-11-18T00:00:00.000Z',
        },
      ],
    ]);

    const item = makeValidPolishedItem();
    item.title = 'GPT-6 于 11 月 17 日发布，覆盖 6 国市场';
    item.shortTitle = 'GPT-6 最新进展发布';
    item.summary = '新版本营收年化约 440 亿至 620 亿美元，季度营收 82 亿美元。';
    item.keyPoints = ['累计测试 18.5 万条样本', '上下文索引规模达 1200 万'];
    item.detail = '据原文披露，相关能力已在 6 个国家落地，经过 18.5 万次基准测试验证。';
    item.hostComment = '这次指标换算和数据规模都相当直观。';
    item.narration = [
      '这次发布的版本在 11 月 17 日亮相，覆盖 6 个国家。',
      '年化营收在 440 亿到 620 亿美元之间，测试样本 18.5 万条。',
    ];
    item.evidence = [
      {
        claim: '版本与收入规模',
        // 使用普通连字符与原文不换行连字符比对，同时包含省略拼接片段
        articleId: 'art-en',
        quote: 'unveiled GPT-6 with a 12 million context index ... across six countries.',
      },
    ];

    const convertedRes = precheckPolishedItem({
      item,
      articlesById,
      limits: DEFAULT_LIMITS,
      metaTextBlacklist: BLACKLIST,
    });
    expect(convertedRes.errors).toEqual([]);
    expect(convertedRes.passed).toBe(true);

    // 验证当旧引文失效而修订后提供了有效新引文时，selectGroundedEvidence 会采纳新引文而非被损坏旧引文锁死
    const recovered = selectGroundedEvidence(
      [{ claim: '旧损坏引文', articleId: 'art-en', quote: 'completely broken non-existent quote' }],
      [
        {
          claim: '修正引文',
          articleId: 'art-en',
          quote: 'OpenAI unveiled GPT-6 with a 12 million context index',
        },
      ],
      articlesById,
    );
    expect(recovered).toHaveLength(1);
    expect(recovered[0]?.claim).toBe('修正引文');

    // 验证仅存在 severity='minor' 的核查意见不阻断通过，而 major 或未标严重程度的异常陈述仍必须打回
    const minorOnlyConverged = enforceFactCheckConsistency({
      verdict: 'revise',
      claims: [
        {
          text: '年化规模 440 亿至 620 亿美元',
          status: 'supported',
          severity: 'major',
          note: '一致',
        },
        {
          text: '卡片短句略去了前缀说明',
          status: 'unsupported',
          severity: 'minor',
          note: '正文已说明',
        },
      ],
      revisionNotes: ['建议卡片补上前缀'],
    });
    expect(minorOnlyConverged.verdict).toBe('pass');
    expect(minorOnlyConverged.revisionNotes).toEqual([]);

    const majorBlocked = enforceFactCheckConsistency({
      verdict: 'pass',
      claims: [{ text: '写错了参数', status: 'exaggerated', severity: 'major', note: '数字偏高' }],
      revisionNotes: [],
    });
    expect(majorBlocked.verdict).toBe('revise');
    expect(majorBlocked.revisionNotes.length).toBeGreaterThan(0);

    const legacyUnmarkedBlocked = enforceFactCheckConsistency({
      verdict: 'pass',
      claims: [{ text: '传统输出未标严重程度', status: 'distorted', note: '曲解范围' }],
      revisionNotes: [],
    });
    expect(legacyUnmarkedBlocked.verdict).toBe('revise');
  });

  it('allows natural short transition cues in compact mode while rejecting vague references and card-title reading', () => {
    const baseItem = makeValidPolishedItem();
    const articlesById = new Map([
      [
        'art-1',
        {
          text: 'The new model runs 2x faster at $15 per 1,000,000 tokens for paid subscribers.',
          publishedAt: '2026-11-18T00:00:00.000Z',
        },
      ],
    ]);
    baseItem.title = '新推理模型速度翻倍，每百万词元十五美元';
    baseItem.shortTitle = '新推理模型提速两倍';
    baseItem.progressLabel = '新推理模型提速';
    baseItem.highlight = '速度比前代快两倍，每百万词元十五美元';
    baseItem.keyPoints = ['速度比前代快两倍', '每百万词元定价十五美元', '已向付费订阅会员开放'];
    baseItem.cards = [
      {
        title: '推理速度明显翻倍',
        body: '新推理模型面向日常编程和复杂问答场景做了专门优化，实测推理速度比前代快了两倍，等待显著缩短。',
        icon: 'zap',
      },
      {
        title: '收费定价公开透明',
        body: '官方公布的新模型接口收费标准为每百万词元十五美元，让需要高频调用推理能力的团队更容易核算成本。',
        icon: 'trending-down',
      },
      {
        title: '面向付费会员开放',
        body: '这次能力更新已正式向平台的付费订阅会员开放体验，用户登录账号即可在日常工作流中直接切换试用。',
        icon: 'clipboard-check',
      },
      {
        title: '聚焦编码复杂问答',
        body: '相比单一评测分数，这次更新更加关注编程开发和多轮推理问答体验，帮助开发者更快完成复杂任务拆解。',
        icon: 'code',
      },
    ];
    baseItem.narration = [
      '官方正式推出全新推理模型，编码与问答速度比前代快了两倍。',
      '接口定价控制到每百万词元十五美元。',
      '目前这套能力已经向付费会员开放使用。',
    ];

    const compactValid = precheckPolishedItem({
      item: baseItem,
      articlesById,
      limits: DEFAULT_LIMITS,
      metaTextBlacklist: BLACKLIST,
      compact: true,
    });
    expect(compactValid.errors).toEqual([]);
    expect(compactValid.passed).toBe(true);

    const clicheOpeningRejected = precheckPolishedItem({
      item: {
        ...baseItem,
        narration: [
          '今天先来看一条模型重磅更新。',
          '全新推理模型速度比前代快了两倍，每百万词元定价十五美元。',
          '目前已向付费会员正式开放使用。',
        ],
      },
      articlesById,
      limits: DEFAULT_LIMITS,
      metaTextBlacklist: BLACKLIST,
      compact: true,
    });
    expect(clicheOpeningRejected.passed).toBe(false);
    expect(clicheOpeningRejected.errors.some((e) => e.includes('铺垫套话'))).toBe(true);

    const clicheClosingRejected = precheckPolishedItem({
      item: {
        ...baseItem,
        narration: [
          '官方正式推出全新推理模型，速度比前代快了两倍。',
          '每百万词元接口定价控制到十五美元，值得我们持续关注。',
        ],
      },
      articlesById,
      limits: DEFAULT_LIMITS,
      metaTextBlacklist: BLACKLIST,
      compact: true,
    });
    expect(clicheClosingRejected.passed).toBe(false);
    expect(clicheClosingRejected.errors.some((e) => e.includes('拔高套话'))).toBe(true);

    const vagueRefRejected = precheckPolishedItem({
      item: {
        ...baseItem,
        narration: [
          '官方正式推出全新推理模型，该公司加快了编码推理速度。',
          '同时该公司把每百万词元定价定在十五美元，速度比前代快两倍。',
          '目前后者已经正式向付费会员开放体验。',
        ],
      },
      articlesById,
      limits: DEFAULT_LIMITS,
      metaTextBlacklist: BLACKLIST,
      compact: true,
    });
    expect(vagueRefRejected.passed).toBe(false);
    expect(vagueRefRejected.errors.some((e) => e.includes('模糊指代'))).toBe(true);

    const cardReadingRejected = precheckPolishedItem({
      item: {
        ...baseItem,
        narration: [
          '官方正式推出全新推理模型，每百万词元定价十五美元。',
          '推理速度明显翻倍。',
          '目前已面向付费会员直接开放体验。',
        ],
      },
      articlesById,
      limits: DEFAULT_LIMITS,
      metaTextBlacklist: BLACKLIST,
      compact: true,
    });
    expect(cardReadingRejected.passed).toBe(false);
    expect(cardReadingRejected.errors.some((e) => e.includes('直接念卡片小标题'))).toBe(true);
  });
});
