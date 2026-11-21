import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { IssuePackage, Timeline } from '@aidaily/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertSafeUploadTargetInTestEnv,
  buildBilibiliDescription,
  buildBilibiliTags,
  commitRunConsumption,
  createCore,
  createRun,
  executeBilibiliUpload,
  executeRun,
  type Notifier,
  type NotifyEvent,
  normalizeBvid,
  type PipelineError,
  parseBvidFromOutput,
  recoverStaleRuns,
  resolveBiliCookieFile,
  resumeRun,
  runNarrateStage,
  stripExternalUrlsFromDescription,
  updateSettingsFile,
  writeJsonAtomic,
} from '../src/index.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const FAKE_BILIUP_BIN = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'fake-biliup.mjs',
);

const tempDirs: string[] = [];
const envSnapshot = { ...process.env };

afterEach(async () => {
  process.env = { ...envSnapshot };
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function setupPublishWorkspace(opts?: { mode?: 'manual-review' | 'auto'; descMax?: number }) {
  await fs.chmod(FAKE_BILIUP_BIN, 0o755);
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aidaily-pub-'));
  tempDirs.push(rootDir);

  await fs.mkdir(path.join(rootDir, 'config'), { recursive: true });
  await fs.copyFile(
    path.join(REPO_ROOT, 'config', 'settings.yaml'),
    path.join(rootDir, 'config', 'settings.yaml'),
  );
  await fs.copyFile(
    path.join(REPO_ROOT, 'config', 'sources.yaml'),
    path.join(rootDir, 'config', 'sources.yaml'),
  );

  await updateSettingsFile(path.join(rootDir, 'config', 'settings.yaml'), {
    clis: {
      biliup: { adapter: 'generic', bin: FAKE_BILIUP_BIN, extraArgs: [] },
    },
    publish: {
      mode: opts?.mode ?? 'manual-review',
      bilibili: {
        tid: 231,
        cookieFile: path.join(rootDir, 'test-bili-cookies.json'),
        ...(opts?.descMax ? { descMax: opts.descMax } : {}),
      },
    },
  });

  const stateFile = path.join(rootDir, 'fake-biliup-state.json');
  await fs.writeFile(
    stateFile,
    JSON.stringify({ mode: 'ok', bvid: 'BV1NM411P7a9', calls: [] }),
    'utf8',
  );
  process.env.FAKE_BILIUP_STATE_FILE = stateFile;

  return { rootDir, stateFile };
}

async function seedCompletedRunReadyForReview(
  core: Awaited<ReturnType<typeof createCore>>,
  runId: string,
  extraReserveArticleId?: string,
) {
  const nowIso = '2026-11-16T10:00:00.000Z';
  const runDir = core.context.paths.runDir(runId);
  await fs.mkdir(path.join(runDir, 'output'), { recursive: true });
  await fs.mkdir(path.join(runDir, 'stages'), { recursive: true });
  await fs.writeFile(path.join(runDir, 'output', 'video.mp4'), 'fake-mp4-content', 'utf8');
  await fs.writeFile(path.join(runDir, 'output', 'cover.jpg'), 'fake-jpg-content', 'utf8');

  core.context.repos.articles.insertIfAbsent({
    id: 'art-used',
    sourceId: 'openai-blog',
    canonicalUrl: 'https://openai.com/news/release-one',
    title: 'OpenAI 发布全新推理架构',
    titleNorm: 'openai 发布全新推理架构',
    lang: 'en',
    publishedAt: nowIso,
    firstSeenAt: nowIso,
    excerpt: 'OpenAI introduced faster reasoning.',
    contentPath: 'storage/articles/art-used.txt',
    contentChars: 500,
    imagePath: null,
    extractStatus: 'ok',
  });
  core.context.repos.articles.markReserved(['art-used'], runId);

  if (extraReserveArticleId) {
    core.context.repos.articles.insertIfAbsent({
      id: extraReserveArticleId,
      sourceId: 'anthropic-news',
      canonicalUrl: 'https://example.com/dropped-backup',
      title: '备选被剔除或未用文章',
      titleNorm: '备选被剔除或未用文章',
      lang: 'en',
      publishedAt: nowIso,
      firstSeenAt: nowIso,
      excerpt: 'Backup story not aired.',
      contentPath: 'storage/articles/backup.txt',
      contentChars: 500,
      imagePath: null,
      extractStatus: 'ok',
    });
    core.context.repos.articles.markReserved([extraReserveArticleId], runId);
  }

  core.context.repos.events.insertMany([
    {
      id: 'ev-1',
      runId,
      rank: 1,
      role: 'primary',
      refillRound: 0,
      title: 'OpenAI 发布全新推理架构',
      category: '大模型',
      entity: 'OpenAI',
      score: 9.0,
      publicAppeal: 8.8,
      reason: '实用推理升级',
      articleIds: ['art-used'],
    },
    ...(extraReserveArticleId
      ? [
          {
            id: 'ev-2',
            runId,
            rank: 2,
            role: 'reserve' as const,
            refillRound: 0,
            title: '备选未播文章',
            category: '行业',
            entity: 'Example',
            score: 6.0,
            publicAppeal: 6.0,
            reason: '替补备用',
            articleIds: [extraReserveArticleId],
          },
        ]
      : []),
  ]);

  core.context.repos.runItems.createMany([
    {
      id: 'item-1',
      runId,
      eventId: 'ev-1',
      position: 1,
      status: 'passed',
      revision: 0,
      dropReason: null,
      finalJson: {
        title: 'OpenAI 发布全新推理架构',
        shortTitle: 'OpenAI 新推理架构',
        progressLabel: 'OpenAI新架构',
        category: '大模型',
        entity: 'OpenAI',
        summary: '今天官方上线了推理优化版本，适合日常开发场景。',
        keyPoints: ['响应提速两倍', '已对订阅用户开放'],
        detail: '开发接口已经同步上线，可直接切换模型标识调用。',
        hostComment: '非常实在的效率提升。',
        narration: ['今天来看 OpenAI 的最新推理更新。'],
        evidence: [
          {
            claim: '已上线接口',
            articleId: 'art-used',
            quote: 'OpenAI introduced faster reasoning.',
          },
        ],
      },
      updatedAt: nowIso,
    },
    ...(extraReserveArticleId
      ? [
          {
            id: 'item-2',
            runId,
            eventId: 'ev-2',
            position: null,
            status: 'queued' as const,
            revision: 0,
            dropReason: null,
            finalJson: null,
            updatedAt: nowIso,
          },
        ]
      : []),
  ]);

  const pkgData: IssuePackage = {
    order: ['item-1'],
    headlineItemId: 'item-1',
    headline: 'OpenAI 发布全新推理架构',
    leadSummary: '本期聚焦模型推理提速与实际使用门槛变化。',
    intro: { narration: ['欢迎收看今天的 AI 每日报。'], hostComment: '来看今天重点。' },
    outro: {
      narration: ['以上就是今天的全部资讯，我们下期再见。'],
      hostComment: '欢迎留言讨论。',
      cta: '欢迎在评论区聊聊你的体验！',
    },
    publish: {
      title: 'AI每日报｜OpenAI 上线全新推理架构',
      descriptionIntro: '本期为您梳理前沿人工智能研发一线核心发布。',
      tags: ['OpenAI', '大模型'],
    },
  };

  const timeline: Timeline = {
    totalMs: 25_000,
    sections: [
      {
        key: 'intro',
        kind: 'intro',
        audioFile: 'audio/intro.wav',
        startMs: 0,
        speechMs: 4000,
        pageMs: 5000,
        sentences: [],
      },
      {
        key: 'item-01',
        kind: 'item',
        itemId: 'item-1',
        audioFile: 'audio/item-01.wav',
        startMs: 5000,
        speechMs: 12000,
        pageMs: 14000,
        sentences: [],
      },
      {
        key: 'outro',
        kind: 'outro',
        audioFile: 'audio/outro.wav',
        startMs: 19000,
        speechMs: 5000,
        pageMs: 6000,
        sentences: [],
      },
    ],
  };

  await writeJsonAtomic(path.join(runDir, 'stages', 'package.json'), {
    packageData: pkgData,
    attempts: 1,
  });
  await writeJsonAtomic(path.join(runDir, 'timeline.json'), timeline);
  for (const st of ['collect', 'select', 'edit', 'package', 'narrate', 'render', 'qa'] as const) {
    core.context.repos.runStages.markStage(runId, st, 'done');
  }
  core.context.repos.runs.updateStatus(runId, 'awaiting_review', { currentStage: 'review' });
}

describe('Bilibili publishing, AI declaration, consumption, and uncertain recovery', () => {
  it('解析登录凭据路径：~ 指向家目录，绝对路径原样使用，相对路径按项目根目录', () => {
    expect(resolveBiliCookieFile('/proj', '~/cookies.json', '/home/u')).toBe(
      '/home/u/cookies.json',
    );
    expect(resolveBiliCookieFile('/proj', '  ~/a/b.json ', '/home/u')).toBe('/home/u/a/b.json');
    expect(resolveBiliCookieFile('/proj', '/abs/c.json', '/home/u')).toBe('/abs/c.json');
    expect(resolveBiliCookieFile('/proj', 'storage/secrets/c.json', '/home/u')).toBe(
      '/proj/storage/secrets/c.json',
    );
    expect(resolveBiliCookieFile('/proj', '~other/c.json', '/home/u')).toBe('/proj/~other/c.json');
  });

  it('builds Bilibili descriptions with chapters, preserves AI disclaimer on truncation, and parses BV ids', () => {
    expect(normalizeBvid('BV1NM411P7a9')).toBe('BV1NM411P7a9');
    expect(() => normalizeBvid('invalid-id')).toThrow();
    expect(parseBvidFromOutput('uploaded: BV1ab411c7mD done', '')).toBe('BV1ab411c7mD');

    const baseDescOpts = {
      packageData: {
        order: ['i1'],
        headlineItemId: 'i1',
        headline: 'H',
        leadSummary: 'L',
        intro: { narration: ['n'], hostComment: 'h' },
        outro: { narration: ['n'], hostComment: 'h', cta: 'c' },
        publish: { title: 'T', descriptionIntro: '导览简介：今日大事汇总', tags: ['A'] },
      },
      timeline: {
        totalMs: 72_000,
        sections: [
          {
            key: 'intro',
            kind: 'intro' as const,
            audioFile: 'a.wav',
            startMs: 0,
            speechMs: 3000,
            pageMs: 4000,
            sentences: [],
          },
          {
            key: 'item-01',
            kind: 'item' as const,
            itemId: 'i1',
            audioFile: 'b.wav',
            startMs: 65_000,
            speechMs: 6000,
            pageMs: 7000,
            sentences: [],
          },
        ],
      },
      items: [
        {
          id: 'i1',
          runId: 'r1',
          eventId: 'e1',
          position: 1,
          status: 'passed' as const,
          revision: 0,
          dropReason: null,
          finalJson: {
            title: 'Full',
            shortTitle: '测试新闻条目',
            progressLabel: '测试新闻条目',
            category: 'AI',
            entity: 'OpenAI',
            summary: 'S',
            keyPoints: ['K'],
            detail: 'D',
            hostComment: 'H',
            narration: ['N'],
            evidence: [{ claim: 'C', articleId: 'a1', quote: 'Q' }],
          },
          updatedAt: '2026-11-16T00:00:00.000Z',
        },
      ],
    };

    const desc = buildBilibiliDescription({
      ...baseDescOpts,
      publishConfig: {
        cli: 'biliup',
        cookieFile: 'storage/secrets/c.json',
        tid: 231,
        copyright: 1,
        titleMax: 80,
        descMax: 200,
        tagsMax: 4,
        defaultTags: ['AI', 'AI每日报'],
        aiDeclaration: true,
        aiDisclaimerText: '本视频含 AI 生成内容声明。',
      },
    });

    expect(Array.from(desc).length).toBeLessThanOrEqual(200);
    expect(desc).toContain('导览简介：今日大事汇总');
    expect(desc).toContain('00:00 开场导览');
    expect(desc).toContain('01:05 01 测试新闻条目');
    expect(desc).toContain('本视频含 AI 生成内容声明。');
    expect(desc).not.toContain('参考来源');
    expect(desc).not.toContain('https://');

    const truncatedDesc = buildBilibiliDescription({
      ...baseDescOpts,
      publishConfig: {
        cli: 'biliup',
        cookieFile: 'storage/secrets/c.json',
        tid: 231,
        copyright: 1,
        titleMax: 80,
        descMax: 52,
        tagsMax: 4,
        defaultTags: ['AI', 'AI每日报'],
        aiDeclaration: true,
        aiDisclaimerText: '本视频含 AI 生成内容声明。',
      },
    });

    expect(Array.from(truncatedDesc).length).toBeLessThanOrEqual(52);
    expect(truncatedDesc).toContain('本视频含 AI 生成内容声明。');

    const tags = buildBilibiliTags(['AI', 'OpenAI', '大模型', 'Claude', 'Gemini'], {
      cli: 'biliup',
      cookieFile: 'c.json',
      tid: 231,
      copyright: 1,
      titleMax: 80,
      descMax: 200,
      tagsMax: 4,
      defaultTags: ['AI', 'AI每日报'],
      aiDeclaration: true,
      aiDisclaimerText: 'AI 声明',
    });
    expect(tags).toEqual(['AI', 'AI每日报', 'OpenAI', '大模型']);
  });

  it('修改封面文字后只重新生成封面图片，超长文字被拒绝且不影响任务状态', async () => {
    const { rootDir } = await setupPublishWorkspace();
    await updateSettingsFile(path.join(rootDir, 'config', 'settings.yaml'), {
      template: { cover: { dir: path.join(REPO_ROOT, 'templates', 'cover-card') } },
    });
    const core = await createCore({ rootDir });
    try {
      const runId = createRun(core.context, { itemCount: 1, trigger: 'manual-cli' });
      await seedCompletedRunReadyForReview(core, runId);

      const before = await core.publish.getCover(runId);
      expect(before.source).toBe('fallback');
      expect(before.text.title.length).toBeGreaterThan(0);

      await expect(core.publish.updateCover(runId, { title: '一'.repeat(20) })).rejects.toThrow(
        /字数上限/,
      );

      const after = await core.publish.updateCover(runId, {
        title: '英伟达\n*停发*H200',
        subtitle: '成本砍到三分之一',
      });
      expect(after.source).toBe('manual');
      expect(after.text).toEqual({ title: '英伟达\n*停发*H200', subtitle: '成本砍到三分之一' });

      const jpg = await fs.readFile(
        path.join(core.context.paths.runDir(runId), 'output', 'cover.jpg'),
      );
      expect(jpg[0]).toBe(0xff);
      expect(jpg[1]).toBe(0xd8);
      expect(jpg.byteLength).toBeGreaterThan(10_000);
      expect(core.context.repos.runs.getById(runId)?.status).toBe('awaiting_review');

      const again = await core.publish.getCover(runId);
      expect(again.source).toBe('manual');

      core.context.repos.runs.updateStatus(runId, 'published');
      const republished = await core.publish.updateCover(runId, {
        title: '已发布后的*新封面*',
        subtitle: '只换封面',
      });
      expect(republished.text).toEqual({ title: '已发布后的*新封面*', subtitle: '只换封面' });
      expect(core.context.repos.runs.getById(runId)?.status).toBe('published');
    } finally {
      await core.close();
    }
  }, 60_000);

  it('阻止发布修改媒体后尚未重新合成的旧成片', async () => {
    const { rootDir, stateFile } = await setupPublishWorkspace();
    const core = await createCore({ rootDir });
    try {
      const runId = createRun(core.context, { itemCount: 1, trigger: 'manual-cli' });
      await seedCompletedRunReadyForReview(core, runId);
      await core.tasks.setItemImage(runId, 'item-1', { mode: 'none' });
      expect(
        core.context.repos.runStages.listByRun(runId).find((stage) => stage.stage === 'render')
          ?.status,
      ).toBe('stale');
      await expect(core.publish.approve(runId, { retryDelaysMs: [0] })).rejects.toThrow(/重新合成/);
      const state = JSON.parse(await fs.readFile(stateFile, 'utf8')) as { calls: unknown[] };
      expect(state.calls).toHaveLength(0);
      expect(core.context.repos.runs.getById(runId)?.status).toBe('awaiting_review');
    } finally {
      await core.close();
    }
  });

  it('publishes approved run with forced AI declaration, commits consumption transactionally, and supports scheduled dtime', async () => {
    const { rootDir, stateFile } = await setupPublishWorkspace();
    const notifications: NotifyEvent[] = [];
    const notifier: Notifier = {
      id: 'test-notifier',
      async notify(ev) {
        notifications.push(ev);
      },
    };
    const core = await createCore({ rootDir, notifier });

    const runId = createRun(core.context, { itemCount: 1, trigger: 'manual-cli' });
    await seedCompletedRunReadyForReview(core, runId, 'art-unused');

    const draft = await core.publish.getDraft(runId);
    expect(draft.aiDeclaration).toBe(true);
    expect(draft.description).toContain('00:05 01 OpenAI 新推理架构');
    expect(draft.description).not.toContain('参考来源');
    expect(draft.description).not.toContain('OpenAI 官方博客');
    expect(draft.description).not.toContain('https://openai.com/news/release-one');

    const edited = await core.publish.updateDraft(runId, {
      title: '人工修订标题：OpenAI 推理大提速',
      tags: ['OpenAI', 'AI资讯'],
    });
    expect(edited.title).toBe('人工修订标题：OpenAI 推理大提速');
    // 仅部分更新 tags 或再次读取草稿时，不应覆盖先前保存的标题修改
    const partialEdited = await core.publish.updateDraft(runId, {
      tags: ['OpenAI', '大模型'],
    });
    expect(partialEdited.title).toBe('人工修订标题：OpenAI 推理大提速');
    expect((await core.publish.getDraft(runId)).title).toBe('人工修订标题：OpenAI 推理大提速');

    // 先模拟上传失败一次，第二次自动重试成功
    await fs.writeFile(
      stateFile,
      JSON.stringify({ mode: 'fail_once_then_ok', bvid: 'BV1NM411P7a9', calls: [] }),
      'utf8',
    );

    await core.publish.approve(runId, { retryDelaysMs: [0, 0, 0], dtimeUnixSec: 1800000000 });

    const finalRun = core.context.repos.runs.getById(runId);
    expect(finalRun?.status).toBe('published');
    expect(core.context.repos.publish.getByRun(runId)).toMatchObject({
      status: 'published',
      bvid: 'BV1NM411P7a9',
      attempts: 2,
    });
    // 已播用文章标为 consumed，未入选替补文章重新回到 new
    expect(core.context.repos.articles.getById('art-used')?.status).toBe('consumed');
    expect(core.context.repos.articles.getById('art-unused')?.status).toBe('new');
    expect(core.context.repos.history.listRecent('2026-01-01T00:00:00.000Z')).toHaveLength(1);
    expect(notifications.some((n) => n.type === 'published')).toBe(true);

    // 验证传递给了 biliup 人工修订后的标题、强制开启 AI 声明参数、分区和定时参数
    const recorded = JSON.parse(await fs.readFile(stateFile, 'utf8')) as { calls: string[][] };
    const args = recorded.calls[0] ?? [];
    expect(args).toContain('人工修订标题：OpenAI 推理大提速');
    expect(args).toContain('--tid');
    expect(args).toContain('231');
    expect(args).toContain('--dtime');
    expect(args).toContain('1800000000');
    const extraIdx = args.indexOf('--extra-fields');
    expect(extraIdx).toBeGreaterThan(-1);
    expect(JSON.parse(args[extraIdx + 1] ?? '{}')).toEqual({ is_ai: 1 });

    const loginCmd = core.publish.biliLoginCommand();
    expect(loginCmd.bin).toBe(FAKE_BILIUP_BIN);
    expect(loginCmd.args).toContain('login');

    await core.close();
  });

  it('handles publish_failed retry, mid-upload publish_uncertain confirmation, reject, and markConsumed', async () => {
    const { rootDir, stateFile } = await setupPublishWorkspace();
    const core = await createCore({ rootDir });

    // 1. 测试上传全部失败进入 publish_failed，修复后再 retry 成功
    const runFailId = createRun(core.context, { itemCount: 1, trigger: 'manual-cli' });
    await seedCompletedRunReadyForReview(core, runFailId);
    await fs.writeFile(stateFile, JSON.stringify({ mode: 'fail', calls: [] }), 'utf8');

    let caughtErr: PipelineError | null = null;
    try {
      await core.publish.approve(runFailId, { retryDelaysMs: [0, 0, 0] });
    } catch (err) {
      caughtErr = err as PipelineError;
    }
    expect(caughtErr?.code).toBe('publish_failed');
    expect(core.context.repos.runs.getById(runFailId)?.status).toBe('publish_failed');
    expect(core.context.repos.articles.getById('art-used')?.status).toBe('reserved');

    await fs.writeFile(
      stateFile,
      JSON.stringify({ mode: 'ok', bvid: 'BV1RT411P7a1', calls: [] }),
      'utf8',
    );
    await core.publish.retry(runFailId, { retryDelaysMs: [0, 0, 0] });
    expect(core.context.repos.runs.getById(runFailId)?.status).toBe('published');
    expect(core.context.repos.publish.getByRun(runFailId)?.bvid).toBe('BV1RT411P7a1');

    // 2. 测试上传中途进程强杀恢复进入 publish_uncertain：禁止自动重传，需人工 confirmUncertain
    const uncertainRunId = createRun(core.context, { itemCount: 1, trigger: 'manual-cli' });
    core.context.repos.articles.insertIfAbsent({
      id: 'art-uncertain',
      sourceId: 'openai-blog',
      canonicalUrl: 'https://openai.com/news/uncertain',
      title: '测试状态不明',
      titleNorm: '测试状态不明',
      lang: 'en',
      publishedAt: '2026-11-16T10:00:00.000Z',
      firstSeenAt: '2026-11-16T10:00:00.000Z',
      excerpt: 'Uncertain.',
      contentPath: null,
      contentChars: 300,
      imagePath: null,
      extractStatus: 'ok',
    });
    core.context.repos.articles.markReserved(['art-uncertain'], uncertainRunId);
    core.context.repos.events.insertMany([
      {
        id: 'ev-unc',
        runId: uncertainRunId,
        rank: 1,
        role: 'primary',
        refillRound: 0,
        title: '测试状态不明事件',
        category: '大模型',
        entity: 'OpenAI',
        score: 8,
        publicAppeal: 8,
        reason: 'test',
        articleIds: ['art-uncertain'],
      },
    ]);
    core.context.repos.runItems.createMany([
      {
        id: 'item-unc',
        runId: uncertainRunId,
        eventId: 'ev-unc',
        position: 1,
        status: 'passed',
        revision: 0,
        dropReason: null,
        finalJson: null,
        updatedAt: '2026-11-16T10:00:00.000Z',
      },
    ]);
    core.context.repos.publish.upsertDraft({
      runId: uncertainRunId,
      title: 'Uncertain title',
      description: 'Uncertain desc',
      tags: ['AI'],
      updatedAt: '2026-11-16T10:00:00.000Z',
    });
    core.context.repos.publish.updateStatus(uncertainRunId, 'publishing', {
      incrementAttempts: true,
      updatedAt: '2026-11-16T10:00:00.000Z',
    });
    core.context.repos.runs.updateStatus(uncertainRunId, 'publishing', {
      currentStage: 'publish',
      pid: 999997,
      heartbeatAt: '2026-11-16T08:00:00.000Z',
    });

    const rec = recoverStaleRuns(core.context);
    expect(rec.uncertainPublishRunIds).toContain(uncertainRunId);
    expect(core.context.repos.runs.getById(uncertainRunId)?.status).toBe('publish_uncertain');
    expect(core.context.repos.publish.getByRun(uncertainRunId)?.status).toBe('uncertain');

    // 直接 retry 必须被拒绝
    await expect(core.publish.retry(uncertainRunId)).rejects.toThrow(/禁止自动重传/);

    // 确认未发布 -> 回退 publish_failed；再测试另一分支 confirmUncertain(published: true)
    await core.publish.confirmUncertain(uncertainRunId, { published: false });
    expect(core.context.repos.runs.getById(uncertainRunId)?.status).toBe('publish_failed');

    core.context.repos.runs.updateStatus(uncertainRunId, 'publish_uncertain');
    core.context.repos.publish.updateStatus(uncertainRunId, 'uncertain', {
      updatedAt: '2026-11-16T11:00:00.000Z',
    });
    await core.publish.confirmUncertain(uncertainRunId, {
      published: true,
      bvid: 'BV1MN411P7a8',
    });
    expect(core.context.repos.runs.getById(uncertainRunId)?.status).toBe('published');
    expect(core.context.repos.publish.getByRun(uncertainRunId)?.bvid).toBe('BV1MN411P7a8');
    expect(core.context.repos.articles.getById('art-uncertain')?.status).toBe('consumed');

    // 3. 验证消费事务遇到失败时的完整回滚保护
    expect(() =>
      commitRunConsumption(core.context, uncertainRunId, '2026-11-16T12:00:00.000Z', () => {
        throw new Error('simulated commit tx rollback');
      }),
    ).toThrow('simulated commit tx rollback');

    // 4. 验证 markConsumed 与 reject 各自处理文章释放和消费
    const consumedOnlyRun = createRun(core.context, { itemCount: 1, trigger: 'manual-cli' });
    core.context.repos.articles.insertIfAbsent({
      id: 'art-co',
      sourceId: 'openai-blog',
      canonicalUrl: 'https://openai.com/news/consumed-only',
      title: '仅本地消费',
      titleNorm: '仅本地消费',
      lang: 'en',
      publishedAt: '2026-11-16T10:00:00.000Z',
      firstSeenAt: '2026-11-16T10:00:00.000Z',
      excerpt: 'Consumed only.',
      contentPath: null,
      contentChars: 300,
      imagePath: null,
      extractStatus: 'ok',
    });
    core.context.repos.articles.markReserved(['art-co'], consumedOnlyRun);
    core.context.repos.events.insertMany([
      {
        id: 'ev-co',
        runId: consumedOnlyRun,
        rank: 1,
        role: 'primary',
        refillRound: 0,
        title: '仅本地消费事件',
        category: 'AI',
        entity: 'OpenAI',
        score: 8,
        publicAppeal: 8,
        reason: 'r',
        articleIds: ['art-co'],
      },
    ]);
    core.context.repos.runItems.createMany([
      {
        id: 'item-co',
        runId: consumedOnlyRun,
        eventId: 'ev-co',
        position: 1,
        status: 'passed',
        revision: 0,
        dropReason: null,
        finalJson: null,
        updatedAt: '2026-11-16T10:00:00.000Z',
      },
    ]);
    core.context.repos.runs.updateStatus(consumedOnlyRun, 'awaiting_review');
    await core.publish.markConsumed(consumedOnlyRun);
    expect(core.context.repos.runs.getById(consumedOnlyRun)?.status).toBe('published');
    expect(core.context.repos.publish.getByRun(consumedOnlyRun)?.status).toBe('consumed_only');
    expect(core.context.repos.articles.getById('art-co')?.status).toBe('consumed');

    const rejectedRun = createRun(core.context, { itemCount: 1, trigger: 'manual-cli' });
    core.context.repos.articles.insertIfAbsent({
      id: 'art-rej',
      sourceId: 'openai-blog',
      canonicalUrl: 'https://openai.com/news/rejected',
      title: '审核驳回释放',
      titleNorm: '审核驳回释放',
      lang: 'en',
      publishedAt: '2026-11-16T10:00:00.000Z',
      firstSeenAt: '2026-11-16T10:00:00.000Z',
      excerpt: 'Rejected.',
      contentPath: null,
      contentChars: 300,
      imagePath: null,
      extractStatus: 'ok',
    });
    core.context.repos.articles.markReserved(['art-rej'], rejectedRun);
    core.context.repos.runs.updateStatus(rejectedRun, 'awaiting_review');
    await core.publish.reject(rejectedRun, '内容需重新排版');
    expect(core.context.repos.runs.getById(rejectedRun)?.status).toBe('rejected');
    expect(core.context.repos.articles.getById('art-rej')?.status).toBe('new');

    await core.close();
  });

  it('automatically invokes upload flow when publish.mode is auto', async () => {
    const { rootDir } = await setupPublishWorkspace({ mode: 'auto' });
    const core = await createCore({ rootDir });
    const runId = createRun(core.context, { itemCount: 1, trigger: 'manual-cli' });
    await seedCompletedRunReadyForReview(core, runId);

    // 仅从最后一步 qa 执行，完成后因 publish.mode === 'auto' 自动上传并提交消费
    core.context.repos.runStages.markStaleFrom(runId, ['qa']);
    const runDir = core.context.paths.runDir(runId);
    await writeJsonAtomic(path.join(runDir, 'qa.json'), {
      passed: true,
      videoPath: 'output/video.mp4',
      width: 1920,
      height: 1080,
      fps: 30,
      videoDurationSec: 25,
      audioDurationSec: 25,
      meanVolumeDb: null,
      blackRatio: 0,
      checks: [],
      checkedAt: '2026-11-16T10:00:00.000Z',
    });

    await executeRun(core.context, runId, {
      startStage: 'qa',
      stageOverrides: {
        async qa() {
          return {
            passed: true,
            videoPath: 'output/video.mp4',
            width: 1920,
            height: 1080,
            fps: 30,
            videoDurationSec: 25,
            audioDurationSec: 25,
            meanVolumeDb: null,
            blackRatio: 0,
            checks: [],
            checkedAt: '2026-11-16T10:00:00.000Z',
          };
        },
      },
      onAwaitingReview: async ({ ctx, runId: rid, settings }) => {
        await executeBilibiliUpload({
          ctx,
          runId: rid,
          settings,
          allowedRunStatuses: ['awaiting_review'],
          alreadyLocked: true,
          retryDelaysMs: [0, 0, 0],
        });
      },
    });

    expect(core.context.repos.runs.getById(runId)?.status).toBe('published');
    expect(core.context.repos.publish.getByRun(runId)?.bvid).toBe('BV1NM411P7a9');
    expect(core.context.repos.articles.getById('art-used')?.status).toBe('consumed');

    await core.close();
  });

  it('marks exit-0 missing BV output as publish_uncertain without duplicate retry uploads', async () => {
    const { rootDir, stateFile } = await setupPublishWorkspace();
    const core = await createCore({ rootDir });
    const runId = createRun(core.context, { itemCount: 1, trigger: 'manual-cli' });
    await seedCompletedRunReadyForReview(core, runId);

    await fs.writeFile(stateFile, JSON.stringify({ mode: 'missing_bvid', calls: [] }), 'utf8');

    let caughtErr: PipelineError | null = null;
    try {
      await core.publish.approve(runId, { retryDelaysMs: [0, 0, 0] });
    } catch (err) {
      caughtErr = err as PipelineError;
    }

    expect(caughtErr?.code).toBe('publish_uncertain');
    expect(core.context.repos.runs.getById(runId)?.status).toBe('publish_uncertain');
    expect(core.context.repos.publish.getByRun(runId)?.status).toBe('uncertain');
    const recorded = JSON.parse(await fs.readFile(stateFile, 'utf8')) as { calls: string[][] };
    expect(recorded.calls).toHaveLength(1);

    await core.close();
  });

  it('reopens a published run from render, keeps the old video, and requires a manual second upload', async () => {
    const { rootDir, stateFile } = await setupPublishWorkspace({ mode: 'auto' });
    await updateSettingsFile(path.join(rootDir, 'config', 'settings.yaml'), {
      tts: { provider: 'silent' },
    });
    const core = await createCore({ rootDir, now: () => new Date('2026-11-18T08:00:00.000Z') });
    const runId = createRun(core.context, { itemCount: 1, trigger: 'manual-web' });
    await seedCompletedRunReadyForReview(core, runId, 'art-unused');
    const packageCheckpoint = JSON.parse(
      await fs.readFile(
        path.join(core.context.paths.runDir(runId), 'stages', 'package.json'),
        'utf8',
      ),
    ) as { packageData: import('@aidaily/contracts').IssuePackage };
    const packageData = packageCheckpoint.packageData;
    await runNarrateStage({
      ctx: core.context,
      runId,
      settings: core.context.settings,
      packageData,
    });
    for (const [stage, rel] of [
      ['collect', 'stages/collect.json'],
      ['select', 'stages/select.json'],
      ['edit', 'stages/edit.json'],
      ['package', 'stages/package.json'],
      ['narrate', 'stages/narrate.json'],
    ] as const) {
      const abs = path.join(core.context.paths.runDir(runId), rel);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      try {
        await fs.access(abs);
      } catch {
        await fs.writeFile(abs, '{}\n');
      }
      core.context.repos.runStages.markStage(runId, stage, 'done', { checkpointPath: rel });
    }

    await core.publish.approve(runId, { retryDelaysMs: [0] });
    expect(core.context.repos.runs.getById(runId)?.status).toBe('published');
    expect(core.context.repos.publish.getByRun(runId)?.bvid).toBe('BV1NM411P7a9');
    expect(core.context.repos.articles.getById('art-used')?.status).toBe('consumed');
    expect(core.context.repos.history.listRecent('2020-01-01T00:00:00.000Z')).toHaveLength(1);
    await expect(core.publish.updateDraft(runId, { description: '还不能改' })).rejects.toThrow(
      /不允许修改/,
    );

    const nowIso = '2026-11-18T09:00:00.000Z';
    core.context.repos.articles.insertIfAbsent({
      id: 'art-locked',
      sourceId: 'openai-blog',
      canonicalUrl: 'https://openai.com/news/locked-by-other',
      title: '被其他任务占用的文章',
      titleNorm: '被其他任务占用的文章',
      lang: 'en',
      publishedAt: nowIso,
      firstSeenAt: nowIso,
      excerpt: 'Locked elsewhere.',
      contentPath: 'storage/articles/art-locked.txt',
      contentChars: 120,
      imagePath: null,
      extractStatus: 'ok',
    });
    core.context.repos.articles.markReserved(['art-locked'], 'other-run');
    core.context.repos.events.insertMany([
      {
        id: 'ev-locked',
        runId,
        rank: 9,
        role: 'reserve',
        refillRound: 0,
        title: '被其他任务占用的文章',
        category: '行业',
        entity: 'Other',
        score: 5,
        publicAppeal: 5,
        reason: '用来确认不会抢走别人的文章',
        articleIds: ['art-locked'],
      },
    ]);

    const introWav = path.join(core.context.paths.runDir(runId), 'audio', 'intro.wav');
    const wavBefore = await fs.readFile(introWav);
    await core.tasks.updateSectionNarration(runId, 'intro', {
      ttsText: '欢迎收看今天的 AI 每日报。',
      subtitleText: '只改画面字幕',
      regenerateAudio: false,
    });
    expect(await fs.readFile(introWav)).toEqual(wavBefore);
    const timeline = JSON.parse(
      await fs.readFile(path.join(core.context.paths.runDir(runId), 'timeline.json'), 'utf8'),
    ) as import('@aidaily/contracts').Timeline;
    expect(timeline.sections[0]?.sentences[0]?.text).toBe('只改画面字幕');
    expect(
      core.context.repos.runStages.listByRun(runId).find((s) => s.stage === 'render')?.status,
    ).toBe('stale');

    const callsBeforeResume = JSON.parse(await fs.readFile(stateFile, 'utf8')) as {
      calls: string[][];
    };
    await resumeRun(core.context, runId, {
      stageOverrides: {
        render: async ({ ctx, runId: currentId }) => {
          const outputDir = path.join(ctx.paths.runDir(currentId), 'output');
          await fs.mkdir(outputDir, { recursive: true });
          await fs.writeFile(path.join(outputDir, 'video.mp4'), 'revived-mp4');
          await fs.writeFile(path.join(outputDir, 'cover.jpg'), 'revived-jpg');
          return { rendered: true };
        },
        qa: async () => ({ passed: true }),
      },
    });

    const callsAfterResume = JSON.parse(await fs.readFile(stateFile, 'utf8')) as {
      calls: string[][];
    };
    expect(callsAfterResume.calls).toHaveLength(callsBeforeResume.calls.length);
    expect(core.context.repos.runs.getById(runId)?.status).toBe('awaiting_review');
    expect(core.context.repos.publish.getByRun(runId)).toMatchObject({
      status: 'draft',
      bvid: null,
    });
    expect(
      core.context.repos.runEvents
        .listAfter(runId, 0, 500)
        .some(
          (event) =>
            event.type === 'run_revived' &&
            typeof event.data === 'object' &&
            event.data !== null &&
            (event.data as { bvid?: string }).bvid === 'BV1NM411P7a9',
        ),
    ).toBe(true);
    expect(core.context.repos.history.listRecent('2020-01-01T00:00:00.000Z')).toHaveLength(0);
    expect(core.context.repos.articles.getById('art-used')).toMatchObject({
      status: 'reserved',
      reservedByRun: runId,
    });
    expect(core.context.repos.articles.getById('art-locked')).toMatchObject({
      status: 'reserved',
      reservedByRun: 'other-run',
    });
    const archived = await fs.readdir(path.join(core.context.paths.runDir(runId), 'archive'), {
      recursive: true,
    });
    const archivedVideo = archived
      .map((entry) => String(entry))
      .find((entry) => entry.endsWith('video.mp4'));
    expect(archivedVideo).toBeTruthy();
    expect(
      await fs.readFile(
        path.join(core.context.paths.runDir(runId), 'archive', archivedVideo ?? ''),
      ),
    ).toEqual(Buffer.from('fake-mp4-content'));

    const revised = await core.publish.updateDraft(runId, {
      description: '重做后的简介，加入新的章节说明。',
    });
    expect(revised.description).toContain('重做后的简介');
    await fs.writeFile(
      stateFile,
      JSON.stringify({ mode: 'ok', bvid: 'BV1CL411P7a2', calls: callsAfterResume.calls }),
      'utf8',
    );
    await core.publish.approve(runId, { retryDelaysMs: [0] });
    expect(core.context.repos.runs.getById(runId)?.status).toBe('published');
    expect(core.context.repos.publish.getByRun(runId)?.bvid).toBe('BV1CL411P7a2');
    expect(core.context.repos.articles.getById('art-used')?.status).toBe('consumed');

    await core.close();
  }, 60_000);

  it('biliup 返回 BV 号后若消费提交失败必须转入状态不明保护并禁止重传', async () => {
    const { rootDir } = await setupPublishWorkspace({ mode: 'manual-review' });
    const cookieFile = path.join(rootDir, 'cookies.json');
    await updateSettingsFile(path.join(rootDir, 'config', 'settings.yaml'), {
      publish: { bilibili: { cookieFile } },
    });
    const stateFile = path.join(rootDir, 'biliup-commit-fail-state.json');
    process.env.FAKE_BILIUP_STATE_FILE = stateFile;
    await fs.writeFile(
      stateFile,
      JSON.stringify({ mode: 'ok', bvid: 'BV1CL411P7a3', calls: [] }),
      'utf8',
    );

    const core = await createCore({ rootDir });
    const runId = createRun(core.context, { itemCount: 1, trigger: 'manual-cli' });
    const runDir = core.context.paths.runDir(runId);
    await fs.mkdir(path.join(runDir, 'output'), { recursive: true });
    await fs.writeFile(path.join(runDir, 'output', 'video.mp4'), 'fake-mp4');
    await fs.writeFile(path.join(runDir, 'output', 'cover.jpg'), 'fake-jpg');
    await fs.writeFile(cookieFile, '{}');

    core.context.repos.articles.insertIfAbsent({
      id: 'art-h1-1',
      sourceId: 'openai-blog',
      canonicalUrl: 'https://openai.com/news/post-commit-fail',
      title: 'Post-upload Commit Failure Regression',
      titleNorm: 'post-upload commit failure regression',
      lang: 'en',
      publishedAt: '2026-11-16T10:00:00.000Z',
      firstSeenAt: '2026-11-16T10:00:00.000Z',
      excerpt: 'Body',
      contentPath: null,
      contentChars: 300,
      imagePath: null,
      extractStatus: 'ok',
    });
    core.context.repos.articles.markReserved(['art-h1-1'], runId);
    core.context.repos.events.insertMany([
      {
        id: 'ev-h1-1',
        runId,
        rank: 1,
        role: 'primary',
        refillRound: 0,
        title: '提交落盘失败事件',
        category: '大模型',
        entity: 'OpenAI',
        score: 8,
        publicAppeal: 8,
        reason: 'r',
        articleIds: ['art-h1-1'],
      },
    ]);
    core.context.repos.runItems.createMany([
      {
        id: 'item-h1-1',
        runId,
        eventId: 'ev-h1-1',
        position: 1,
        status: 'passed',
        revision: 0,
        dropReason: null,
        finalJson: null,
        updatedAt: '2026-11-16T10:00:00.000Z',
      },
    ]);
    core.context.repos.runs.updateStatus(runId, 'awaiting_review', {
      currentStage: 'qa',
    });
    core.context.repos.publish.upsertDraft({
      runId,
      title: '上传提交失败回归测试标题',
      description: '上传提交失败回归测试简介',
      tags: ['AI'],
      updatedAt: '2026-11-16T10:00:00.000Z',
    });

    const originalMarkConsumed = core.context.repos.articles.markConsumed.bind(
      core.context.repos.articles,
    );
    core.context.repos.articles.markConsumed = () => {
      throw new Error('simulated post-upload commit failure');
    };

    await expect(core.publish.approve(runId, { retryDelaysMs: [0] })).rejects.toThrow(
      /状态不明保护/,
    );
    expect(core.context.repos.runs.getById(runId)?.status).toBe('publish_uncertain');
    expect(core.context.repos.publish.getByRun(runId)).toMatchObject({
      status: 'uncertain',
      bvid: 'BV1CL411P7a3',
    });

    // 状态不明下严禁再次上传
    await expect(core.publish.retry(runId, { retryDelaysMs: [0] })).rejects.toThrow(/禁止自动重传/);
    const stateAfter = JSON.parse(await fs.readFile(stateFile, 'utf8')) as { calls: string[][] };
    expect(stateAfter.calls).toHaveLength(1);

    // 恢复正常仓储方法后，人工核对定案可以顺利闭合
    core.context.repos.articles.markConsumed = originalMarkConsumed;
    await core.publish.confirmUncertain(runId, { published: true, bvid: 'BV1CL411P7a3' });
    expect(core.context.repos.runs.getById(runId)?.status).toBe('published');
    expect(core.context.repos.articles.getById('art-h1-1')?.status).toBe('consumed');

    await core.close();
  }, 60_000);

  it('测试环境下强制拦截真实投稿命令和临时目录外的凭据路径', async () => {
    const { rootDir, stateFile } = await setupPublishWorkspace({ mode: 'manual-review' });
    const isolatedCookie = path.join(rootDir, 'test-bili-cookies.json');
    const externalCookie = path.join(REPO_ROOT, 'forbidden-real-cookies.json');

    expect(() =>
      assertSafeUploadTargetInTestEnv({
        rootDir,
        configuredBin: 'biliup',
        cookieFile: isolatedCookie,
      }),
    ).toThrow(/测试环境禁止调用真实投稿工具/);

    expect(() =>
      assertSafeUploadTargetInTestEnv({
        rootDir,
        configuredBin: '/opt/homebrew/bin/biliup',
        cookieFile: isolatedCookie,
      }),
    ).toThrow(/测试环境禁止调用真实投稿工具/);

    expect(() =>
      assertSafeUploadTargetInTestEnv({
        rootDir,
        configuredBin: 'fixture-disabled-biliup',
        cookieFile: isolatedCookie,
      }),
    ).toThrow(/测试环境禁止调用真实投稿工具/);

    expect(() =>
      assertSafeUploadTargetInTestEnv({
        rootDir,
        configuredBin: FAKE_BILIUP_BIN,
        cookieFile: externalCookie,
      }),
    ).toThrow(/测试环境禁止使用临时目录之外/);

    expect(() =>
      assertSafeUploadTargetInTestEnv({
        rootDir,
        configuredBin: FAKE_BILIUP_BIN,
        cookieFile: isolatedCookie,
      }),
    ).not.toThrow();

    // 真实批准流程误配真实 biliup 命令时必须在改变状态和执行命令前直接拦截
    await updateSettingsFile(path.join(rootDir, 'config', 'settings.yaml'), {
      clis: {
        biliup: { adapter: 'generic', bin: 'biliup', extraArgs: [] },
      },
    });
    const core = await createCore({ rootDir });
    try {
      const runId = createRun(core.context, { itemCount: 1, trigger: 'manual-cli' });
      await seedCompletedRunReadyForReview(core, runId);

      await expect(core.publish.approve(runId, { retryDelaysMs: [0] })).rejects.toThrow(
        /测试环境禁止调用真实投稿工具/,
      );
      expect(core.context.repos.runs.getById(runId)?.status).toBe('awaiting_review');

      // 即使换回假投稿脚本，若凭据指向工作区和临时目录外部也必须被拦截且不触发调用
      await core.config.updateSettings({
        clis: {
          biliup: { adapter: 'generic', bin: FAKE_BILIUP_BIN, extraArgs: [] },
        },
        publish: {
          bilibili: { cookieFile: externalCookie },
        },
      });
      await expect(core.publish.approve(runId, { retryDelaysMs: [0] })).rejects.toThrow(
        /测试环境禁止使用临时目录之外/,
      );
      expect(core.context.repos.runs.getById(runId)?.status).toBe('awaiting_review');
      const recorded = JSON.parse(await fs.readFile(stateFile, 'utf8')) as { calls: string[][] };
      expect(recorded.calls).toHaveLength(0);
    } finally {
      await core.close();
    }
  });

  it('strips external URLs from Bilibili descriptions and enforces daily maxDailyUploads guardrail', async () => {
    expect(
      stripExternalUrlsFromDescription(
        '本期导览见 https://example.com/demo 或 www.github.com/org/repo，详情见 github.com/foo/bar',
      ),
    ).not.toMatch(/https?:\/\/|www\.|github\.com/i);

    const { rootDir } = await setupPublishWorkspace({ mode: 'manual-review' });
    await updateSettingsFile(path.join(rootDir, 'config', 'settings.yaml'), {
      publish: {
        bilibili: {
          maxDailyUploads: 2,
        },
      },
    });
    const fixedNow = () => new Date('2026-11-21T10:00:00.000Z');
    const core = await createCore({ rootDir, now: fixedNow });
    try {
      const r1 = createRun(core.context, { itemCount: 1, trigger: 'manual-cli' });
      await seedCompletedRunReadyForReview(core, r1);
      await core.publish.approve(r1, { retryDelaysMs: [0] });
      expect(core.context.repos.runs.getById(r1)?.status).toBe('published');

      core.context.db.prepare("DELETE FROM run_items WHERE id = 'item-1'").run();
      core.context.db.prepare("DELETE FROM events WHERE id = 'ev-1'").run();
      core.context.db
        .prepare("UPDATE articles SET status = 'new', reserved_by_run = NULL WHERE id = 'art-used'")
        .run();
      const r2 = createRun(core.context, { itemCount: 1, trigger: 'manual-cli' });
      await seedCompletedRunReadyForReview(core, r2);
      await core.publish.approve(r2, { retryDelaysMs: [0] });
      expect(core.context.repos.runs.getById(r2)?.status).toBe('published');

      core.context.db.prepare("DELETE FROM run_items WHERE id = 'item-1'").run();
      core.context.db.prepare("DELETE FROM events WHERE id = 'ev-1'").run();
      core.context.db
        .prepare("UPDATE articles SET status = 'new', reserved_by_run = NULL WHERE id = 'art-used'")
        .run();
      const r3 = createRun(core.context, { itemCount: 1, trigger: 'manual-cli' });
      await seedCompletedRunReadyForReview(core, r3);
      await expect(core.publish.approve(r3, { retryDelaysMs: [0] })).rejects.toThrow(/已发布 2 期/);
      expect(core.context.repos.runs.getById(r3)?.status).toBe('awaiting_review');

      await executeBilibiliUpload({
        ctx: core.context,
        runId: r3,
        settings: core.context.settings,
        allowedRunStatuses: ['awaiting_review'],
        retryDelaysMs: [0],
        bypassDailyLimit: true,
      });
      expect(core.context.repos.runs.getById(r3)?.status).toBe('published');
    } finally {
      await core.close();
    }
  });
});
