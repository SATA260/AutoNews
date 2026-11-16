import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { IssuePackage, Timeline } from '@aidaily/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import {
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
  it('builds Bilibili descriptions with chapters, preserves AI disclaimer on truncation, and parses BV ids', () => {
    expect(normalizeBvid('BV1NM411P7a9')).toBe('BV1NM411P7a9');
    expect(() => normalizeBvid('invalid-id')).toThrow();
    expect(parseBvidFromOutput('uploaded: BV1ab411c7mD done', '')).toBe('BV1ab411c7mD');

    const desc = buildBilibiliDescription({
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
            kind: 'intro',
            audioFile: 'a.wav',
            startMs: 0,
            speechMs: 3000,
            pageMs: 4000,
            sentences: [],
          },
          {
            key: 'item-01',
            kind: 'item',
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
          status: 'passed',
          revision: 0,
          dropReason: null,
          finalJson: {
            title: 'Full',
            shortTitle: '测试新闻条目',
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
      articlesById: new Map([
        [
          'a1',
          {
            id: 'a1',
            sourceId: 's1',
            canonicalUrl: 'https://example.com/very-long-source-url-that-gets-trimmed-first',
            title: 'Source',
            titleNorm: 'source',
            lang: 'en',
            publishedAt: null,
            firstSeenAt: '2026-11-16T00:00:00.000Z',
            excerpt: null,
            contentPath: null,
            contentChars: 500,
            imagePath: null,
            extractStatus: 'ok',
            status: 'reserved',
            reservedByRun: 'r1',
          },
        ],
      ]),
      eventsArticleIdsByEventId: new Map([['e1', ['a1']]]),
      sourceNameById: new Map([['s1', '测试信源']]),
      publishConfig: {
        cli: 'biliup',
        cookieFile: 'storage/secrets/c.json',
        tid: 231,
        copyright: 1,
        titleMax: 80,
        descMax: 120,
        tagsMax: 4,
        defaultTags: ['AI', 'AI每日报'],
        aiDeclaration: true,
        aiDisclaimerText: '本视频含 AI 生成内容声明。',
      },
    });

    expect(Array.from(desc).length).toBeLessThanOrEqual(120);
    expect(desc).toContain('00:00 开场导览');
    expect(desc).toContain('01:05 01 测试新闻条目');
    expect(desc).toContain('本视频含 AI 生成内容声明。');
    expect(desc).not.toContain('https://example.com/');

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
    expect(draft.description).toContain('https://openai.com/news/release-one');

    const edited = await core.publish.updateDraft(runId, {
      title: '人工修订标题：OpenAI 推理大提速',
      tags: ['OpenAI', 'AI资讯'],
    });
    expect(edited.title).toBe('人工修订标题：OpenAI 推理大提速');

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

    // 验证传递给了 biliup 强制开启 AI 声明参数、分区和定时参数
    const recorded = JSON.parse(await fs.readFile(stateFile, 'utf8')) as { calls: string[][] };
    const args = recorded.calls[0] ?? [];
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
});
