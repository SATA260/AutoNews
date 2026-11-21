import type { ContentLimits, IssuePackage, PolishedItem, Settings } from '@aidaily/contracts';
import { describe, expect, it } from 'vitest';
import {
  buildArticlesXml,
  enforceFactCheckConsistency,
  extractArabicNumbers,
  isDuplicateOfHistory,
  isExactTitleMatch,
  loadPromptSkill,
  longestCommonSubstringLength,
  normalizeTitleForExactMatch,
  precheckIssuePackage,
  precheckPolishedItem,
  renderPromptTemplate,
  selectGroundedEvidence,
  selectRelevantOriginReferences,
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

  it('deduplicates only exact normalized titles without dropping different codenames/versions or reworded titles, and recalls relevant origin references', async () => {
    expect(
      isDuplicateOfHistory('Introducing Gemini 4 Neon', [
        { title: 'Introducing Gemini 4 Hydrogen' },
      ]),
    ).toEqual({ duplicate: false });

    expect(isDuplicateOfHistory('Introducing X 5 BBB', [{ title: 'Introducing X 5 AAA' }])).toEqual(
      { duplicate: false },
    );

    expect(isDuplicateOfHistory('OpenAI 发布 GPT-6.2', [{ title: 'OpenAI 发布 GPT-6.1' }])).toEqual(
      { duplicate: false },
    );

    expect(
      isDuplicateOfHistory('OpenAI 正式推出全新推理模型', [
        { title: 'OpenAI 正式发布全新推理模型' },
      ]),
    ).toEqual({ duplicate: false });

    expect(isExactTitleMatch('OpenAI 发布新模型', 'openai发布新模型！')).toBe(true);
    expect(
      isExactTitleMatch(
        'Introducing GPT\u20116.2 Astra and Sol!',
        'introducing gpt-6.2 astra and sol',
      ),
    ).toBe(true);
    expect(normalizeTitleForExactMatch('“AI” 时代来了')).toBe(
      normalizeTitleForExactMatch('"ai"时代来了'),
    );
    expect(isDuplicateOfHistory('OpenAI 发布新模型！', [{ title: 'OpenAI发布新模型' }])).toEqual({
      duplicate: true,
      matchedTitle: 'OpenAI发布新模型',
    });

    const recalled = selectRelevantOriginReferences(
      [{ title: 'DeepSeek 正式发布开源新一代推理优化框架实测' }],
      [
        { title: '其他公司例行季报电话会纪要', publishedAt: '2026-11-15T12:00:00.000Z' },
        {
          title: 'DeepSeek 正式发布开源新一代推理优化框架',
          publishedAt: '2026-11-15T10:00:00.000Z',
        },
        { title: '欧洲人工智能监管会议闭幕', publishedAt: '2026-11-15T08:00:00.000Z' },
      ],
      2,
    );
    expect(recalled).toHaveLength(2);
    expect(recalled[0]?.title).toBe('DeepSeek 正式发布开源新一代推理优化框架');

    const selectPrompt = await renderPromptTemplate('s2-select.md', {
      targetCount: '10',
      itemCount: '5',
      historyDedupDays: '14',
      timeCutoffRule: '',
      historyTitles: '（近期暂无已播事件）',
      candidates: '[]',
    });
    expect(selectPrompt).toContain('GPT');
    expect(selectPrompt).toContain('Claude');
    expect(selectPrompt).toContain('Gemini');
    expect(selectPrompt).toContain('DeepSeek');
    expect(selectPrompt).toContain('GLM');
    expect(selectPrompt).toContain('Qwen');
    expect(selectPrompt).toContain('业内顶尖');
    expect(selectPrompt).toContain('订阅额度');
    expect(selectPrompt).toContain('招聘启事');
    expect(selectPrompt).toContain('能力一般或受众面窄的新模型降低优先级');
    expect(selectPrompt).toContain('Gemini 4 Neon');
    expect(selectPrompt).toContain('同一具体事件');

    const titleSkillRules = await loadPromptSkill('skills/heiya-title.md');
    const packagePrompt = await renderPromptTemplate('s6-package.md', {
      personaJson: '无特定角色',
      date: '2026-11-19',
      dateDisplay: '11月19日周四',
      issueNumber: 'VOL.2026.11.19',
      issueMode: 'digest',
      passedItemsJson: '[]',
      recentTitles: '- AI圈大地震！上期示例标题',
      titleSkillRules,
      contentLimitsJson: '{}',
      publishLimitsJson: '{}',
      coverTitleMax: '14',
      coverSubtitleMax: '22',
    });
    expect(packagePrompt).toContain('重磅主流模型、顶尖突破或全局大事优先头条');
    expect(packagePrompt).toContain('直给干货的钩子开场');
    expect(packagePrompt).toContain('把“我是谁”放在结尾');
    expect(packagePrompt).toContain('AI圈大地震！上期示例标题');
    expect(packagePrompt).toContain('黑鸦爆款标题 Skill');
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
        body: 'OpenAI 推出新推理模型，速度提升 2 倍',
      },
      {
        icon: 'banknote',
        title: '定价与档位',
        body: '每 1000000 tokens 定价 15 美元',
      },
      {
        icon: 'zap',
        title: '工程体验',
        body: '面向编码、推理与复杂问答降低延迟',
      },
      {
        icon: 'shield',
        title: '可用范围',
        body: '目前仅向付费订阅用户开放',
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
        title: 'OpenAI 12月起ChatGPT与Codex共享额度；新推理模型速度翻倍',
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

    const badDescWithSources = precheckIssuePackage({
      pkg: {
        ...compactValidPkg,
        publish: {
          ...compactValidPkg.publish,
          descriptionIntro: '本期要点汇总，参考来源：https://example.com/news',
        },
      },
      expectedItemIds: ['item-1', 'item-2'],
      limits: DEFAULT_LIMITS,
      publishConfig,
      metaTextBlacklist: BLACKLIST,
      compact: true,
      hostSelfName: '哈基米',
    });
    expect(badDescWithSources.passed).toBe(false);
    expect(badDescWithSources.errors.some((e) => e.includes('不要包含信息来源'))).toBe(true);

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
    expect(badUnderscoreAndShortTitle.errors.some((e) => e.includes('十八字'))).toBe(true);
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
        body: '编程与复杂问答速度比前代快两倍',
        icon: 'zap',
      },
      {
        title: '收费定价公开透明',
        body: '接口定价为每百万词元十五美元',
        icon: 'banknote',
      },
      {
        title: '面向付费会员开放',
        body: '付费订阅会员登录后即可切换试用',
        icon: 'users',
      },
      {
        title: '聚焦编码复杂问答',
        body: '更关注编程开发与多轮推理问答体验',
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

    const fourthWallPostRejected = precheckPolishedItem({
      item: {
        ...baseItem,
        narration: [
          '官方正式推出全新推理模型，速度比前代快了两倍。',
          '只是原帖没写免费额度，每百万词元接口定价十五美元。',
        ],
      },
      articlesById,
      limits: DEFAULT_LIMITS,
      metaTextBlacklist: BLACKLIST,
      compact: true,
    });
    expect(fourthWallPostRejected.passed).toBe(false);
    expect(fourthWallPostRejected.errors.some((e) => e.includes('原帖没写'))).toBe(true);

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

    const firstPersonCompanyRejected = precheckPolishedItem({
      item: {
        ...baseItem,
        hostComment: '自家这次被加州起诉了，OpenAI官方回应也摆在屏幕上。',
        narration: [
          '我们发布了一款全新推理模型，编码与问答速度比前代快了两倍。',
          '每百万词元接口定价控制到十五美元。',
          '目前这套能力已经向付费会员开放使用。',
        ],
      },
      articlesById,
      limits: DEFAULT_LIMITS,
      metaTextBlacklist: BLACKLIST,
      compact: true,
      hostSelfName: 'gpt',
    });
    expect(firstPersonCompanyRejected.passed).toBe(false);
    expect(
      firstPersonCompanyRejected.errors.some(
        (e) => e.includes('hostComment') && e.includes('不能代表任何公司发言'),
      ),
    ).toBe(true);
    expect(
      firstPersonCompanyRejected.errors.some(
        (e) => e.includes('narration[0]') && e.includes('我们发布'),
      ),
    ).toBe(true);

    const nonSpokespersonWeAllowed = precheckPolishedItem({
      item: {
        ...baseItem,
        hostComment: 'OpenAI把新能力接进自家桌面工具后，确实能帮我们省不少写代码时间。',
        narration: [
          'OpenAI正式推出全新推理模型，能帮我们把编码速度比前代提高两倍。',
          '接口定价控制到每百万词元十五美元，OpenAI称“我们正在继续优化体验”。',
          '目前付费会员已经可以直接体验这项新能力。',
        ],
      },
      articlesById,
      limits: DEFAULT_LIMITS,
      metaTextBlacklist: BLACKLIST,
      compact: true,
      hostSelfName: 'gpt',
    });
    expect(nonSpokespersonWeAllowed.errors).toEqual([]);
    expect(nonSpokespersonWeAllowed.passed).toBe(true);

    const livelyBanterAndRoastAllowed = precheckPolishedItem({
      item: {
        ...baseItem,
        hostComment: '不愧是你啊，Anthropic，一刀切封账号还觉得挺合理。',
        narration: [
          '哈哈，我Gemini又站起来了！',
          '新模型速度比前代快了两倍，每百万词元接口定价控制到十五美元。',
          '目前已向付费会员分批开放体验。',
        ],
      },
      articlesById,
      limits: DEFAULT_LIMITS,
      metaTextBlacklist: BLACKLIST,
      compact: true,
      hostSelfName: '哈基米',
    });
    expect(livelyBanterAndRoastAllowed.errors).toEqual([]);
    expect(livelyBanterAndRoastAllowed.passed).toBe(true);
  });

  it('rejects >4 cards, >8-char card titles, and >28-char card bodies in both default and compact modes', () => {
    const articlesById = new Map([
      [
        'art-1',
        {
          text: 'The new model runs 2x faster at $15 per 1,000,000 tokens for paid subscribers.',
          publishedAt: '2026-11-18T00:00:00.000Z',
        },
      ],
    ]);

    const makeCompactBase = (): PolishedItem => ({
      ...makeValidPolishedItem(),
      title: '新推理模型速度翻倍，每百万词元十五美元',
      shortTitle: '新推理模型提速两倍',
      progressLabel: '新推理模型提速',
      highlight: '速度比前代快两倍，每百万词元十五美元',
      keyPoints: ['速度比前代快两倍', '每百万词元定价十五美元', '已向付费订阅会员开放'],
      narration: [
        '官方正式推出全新推理模型，编码与问答速度比前代快了两倍。',
        '接口定价控制到每百万词元十五美元。',
        '目前这套能力已经向付费会员开放使用。',
      ],
      cards: [
        { icon: 'zap', title: '推理提速', body: '编程与复杂问答速度比前代快两倍' },
        { icon: 'banknote', title: '接口定价', body: '每百万词元接口定价控制到十五美元' },
      ],
    });

    const fiveCards = makeCompactBase();
    fiveCards.cards = [
      { icon: 'zap', title: '卡片一', body: '编程与复杂问答速度比前代快两倍' },
      { icon: 'banknote', title: '卡片二', body: '每百万词元接口定价控制到十五美元' },
      { icon: 'users', title: '卡片三', body: '目前这套能力已向付费会员开放使用' },
      { icon: 'code', title: '卡片四', body: '主要面向日常编码与复杂问答优化' },
      { icon: 'shield', title: '卡片五', body: '付费会员登录后即可直接切换试用' },
    ];

    const overTitle = makeCompactBase();
    overTitle.cards = [
      { icon: 'zap', title: '九个字的小标题名字', body: '编程与复杂问答速度比前代快两倍' },
      { icon: 'banknote', title: '接口定价', body: '每百万词元接口定价控制到十五美元' },
    ];

    const overBody = makeCompactBase();
    overBody.cards = [
      {
        icon: 'zap',
        title: '推理提速',
        body: '编程与复杂问答速度比前代整整快了两倍且目前已全部开放测试体验',
      },
      { icon: 'banknote', title: '接口定价', body: '每百万词元接口定价控制到十五美元' },
    ];

    for (const compact of [false, true]) {
      const resFive = precheckPolishedItem({
        item: fiveCards,
        articlesById,
        limits: DEFAULT_LIMITS,
        metaTextBlacklist: BLACKLIST,
        compact,
      });
      expect(resFive.passed).toBe(false);
      expect(resFive.errors.some((e) => e.includes('5 > 4 张'))).toBe(true);

      const resTitle = precheckPolishedItem({
        item: overTitle,
        articlesById,
        limits: DEFAULT_LIMITS,
        metaTextBlacklist: BLACKLIST,
        compact,
      });
      expect(resTitle.passed).toBe(false);
      expect(resTitle.errors.some((e) => e.includes('> 8 字'))).toBe(true);

      const resBody = precheckPolishedItem({
        item: overBody,
        articlesById,
        limits: DEFAULT_LIMITS,
        metaTextBlacklist: BLACKLIST,
        compact,
      });
      expect(resBody.passed).toBe(false);
      expect(resBody.errors.some((e) => e.includes('> 28 字'))).toBe(true);
    }
  });

  it('enforces M1 outro selfName, direct hook intro, actionHint safety, dynamic narration caps, and titleCandidates validation', () => {
    const articlesById = new Map([
      [
        'art-1',
        {
          text: 'The new model runs 2x faster at $15 per 1,000,000 tokens for paid subscribers.',
          publishedAt: '2026-11-19T08:00:00.000Z',
        },
      ],
    ]);
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

    const hookIntroPkg: IssuePackage = {
      order: ['item-1'],
      headlineItemId: 'item-1',
      headline: '推理速度翻倍，每百万词元十五美元',
      leadSummary: '今天重点看新款推理模型提速与定价细节。',
      intro: {
        narration: ['推理速度直接翻倍，OpenAI刚把新模型放出来，咱们直接看细则。'],
        hostComment: '今天这条真干货。',
      },
      outro: {
        narration: ['今天的AI账先算到这儿，我是聪明的大肥鱼，咱们下期见。'],
        hostComment: '欢迎评论区聊聊。',
        cta: '哪一条最戳中你？欢迎留言。',
      },
      publish: {
        title: '推理速度直接翻倍？OpenAI新模型每百万词元只要十五美元',
        titleCandidates: [
          '每百万词元十五美元！OpenAI新推理模型速度翻倍正式开放',
          '付费会员直接能用，OpenAI新款推理模型速度较前代翻倍',
          '写代码更快了？OpenAI新推理模型提速两倍细节一览',
        ],
        descriptionIntro: '本期聚焦最新推理模型提速与定价细节。',
        tags: ['OpenAI', '大模型'],
      },
    };
    const hookOk = precheckIssuePackage({
      pkg: hookIntroPkg,
      expectedItemIds: ['item-1'],
      limits: DEFAULT_LIMITS,
      publishConfig,
      metaTextBlacklist: BLACKLIST,
      compact: true,
      hostSelfName: '聪明的大肥鱼',
    });
    expect(hookOk.errors).toEqual([]);
    expect(hookOk.passed).toBe(true);

    const missingOutroSelfName = precheckIssuePackage({
      pkg: {
        ...hookIntroPkg,
        outro: {
          ...hookIntroPkg.outro,
          narration: ['今天的资讯就播到这里，咱们明天见。'],
        },
      },
      expectedItemIds: ['item-1'],
      limits: DEFAULT_LIMITS,
      publishConfig,
      metaTextBlacklist: BLACKLIST,
      compact: true,
      hostSelfName: '聪明的大肥鱼',
    });
    expect(missingOutroSelfName.passed).toBe(false);
    expect(missingOutroSelfName.errors.some((e) => e.includes('结尾口播'))).toBe(true);

    const badCandidate = precheckIssuePackage({
      pkg: {
        ...hookIntroPkg,
        publish: {
          ...hookIntroPkg.publish,
          titleCandidates: ['AI每日报｜新模型发布速度翻倍并开启体验'],
        },
      },
      expectedItemIds: ['item-1'],
      limits: DEFAULT_LIMITS,
      publishConfig,
      metaTextBlacklist: BLACKLIST,
      compact: true,
      hostSelfName: '聪明的大肥鱼',
    });
    expect(badCandidate.passed).toBe(false);
    expect(badCandidate.errors.some((e) => e.includes('候选标题[1]'))).toBe(true);

    const itemWithUrlHint: PolishedItem = {
      ...makeValidPolishedItem(),
      actionHint: '访问 https://openai.com/models 体验',
    };
    const hintUrlRes = precheckPolishedItem({
      item: itemWithUrlHint,
      articlesById,
      limits: DEFAULT_LIMITS,
      metaTextBlacklist: BLACKLIST,
    });
    expect(hintUrlRes.passed).toBe(false);
    expect(hintUrlRes.errors.some((e) => e.includes('actionHint'))).toBe(true);

    const briefOverCap: PolishedItem = {
      ...makeValidPolishedItem(),
      title: '新推理模型速度翻倍，每百万词元十五美元',
      shortTitle: '新推理模型提速两倍',
      progressLabel: '新推理模型提速',
      highlight: '速度比前代快两倍，每百万词元十五美元',
      keyPoints: ['速度比前代快两倍', '每百万词元定价十五美元'],
      cards: [
        { icon: 'zap', title: '推理提速', body: '编程与复杂问答速度比前代快两倍' },
        { icon: 'banknote', title: '接口定价', body: '每百万词元接口定价控制到十五美元' },
      ],
      actionHint: '搜 OpenAI Reasoning 体验',
      narration: [
        '官方正式推出全新推理模型，编码与复杂问答速度比前代快两倍。',
        '每百万词元接口定价控制到十五美元，目前已面向付费会员开放。',
        '这项更新专门面向日常高频开发与长程问答场景大幅降低响应延迟。',
        '付费订阅会员登录后台即可直接切换体验这项全新推理能力。',
      ],
    };
    const briefRes = precheckPolishedItem({
      item: briefOverCap,
      articlesById,
      limits: DEFAULT_LIMITS,
      metaTextBlacklist: BLACKLIST,
      compact: true,
      isHeadline: false,
      briefNarrationMaxChars: 95,
    });
    expect(briefRes.passed).toBe(false);
    expect(briefRes.errors.some((e) => e.includes('总长四十到95字'))).toBe(true);

    const headlineRes = precheckPolishedItem({
      item: briefOverCap,
      articlesById,
      limits: DEFAULT_LIMITS,
      metaTextBlacklist: BLACKLIST,
      compact: true,
      isHeadline: true,
      headlineNarrationMaxChars: 180,
    });
    expect(headlineRes.errors).toEqual([]);
    expect(headlineRes.passed).toBe(true);
  });
});
