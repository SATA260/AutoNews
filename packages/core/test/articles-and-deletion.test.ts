import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  acquirePipelineLock,
  createCore,
  createRun,
  NotFoundError,
  releasePipelineLock,
  resolveTimeRangeBounds,
  writeJsonAtomic,
} from '../src/index.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

/** 创建包含默认配置和信源文件的隔离临时工作区 */
async function setupTempWorkspace(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aidaily-articles-del-'));
  tempDirs.push(dir);
  await fs.mkdir(path.join(dir, 'config'), { recursive: true });
  await fs.copyFile(
    path.join(REPO_ROOT, 'config', 'settings.yaml'),
    path.join(dir, 'config', 'settings.yaml'),
  );
  await fs.copyFile(
    path.join(REPO_ROOT, 'config', 'sources.yaml'),
    path.join(dir, 'config', 'sources.yaml'),
  );
  return dir;
}

describe('articles browse, time range filter, and selective/time-based deletion', () => {
  it('parses local time range bounds as closed intervals in configured timezone', () => {
    const dayBounds = resolveTimeRangeBounds({
      from: '2026-11-18',
      to: '2026-11-18',
      timezone: 'Asia/Shanghai',
    });
    expect(dayBounds.fromIso).toBe('2026-11-17T16:00:00.000Z');
    expect(dayBounds.toIso).toBe('2026-11-18T15:59:59.999Z');

    const minuteBounds = resolveTimeRangeBounds({
      from: '2026-11-18T09:30',
      to: '2026-11-18 10:15',
      timezone: 'Asia/Shanghai',
    });
    expect(minuteBounds.fromIso).toBe('2026-11-18T01:30:00.000Z');
    expect(minuteBounds.toIso).toBe('2026-11-18T02:15:59.999Z');

    expect(() =>
      resolveTimeRangeBounds({
        from: '2026-02-31',
        timezone: 'Asia/Shanghai',
      }),
    ).toThrow(/有效的日历时间/);

    expect(() =>
      resolveTimeRangeBounds({
        from: '2026-11-19T12:00',
        to: '2026-11-18T12:00',
        timezone: 'Asia/Shanghai',
      }),
    ).toThrow(/起始时间不能晚于截止时间/);
  });

  it('lists filtered crawled articles, loads details, and deletes by ID/time while protecting reserved and shared files', async () => {
    const rootDir = await setupTempWorkspace();
    const core = await createCore({ rootDir });

    try {
      await fs.mkdir(core.context.paths.articlesDir, { recursive: true });
      await fs.mkdir(core.context.paths.imagesDir, { recursive: true });

      const activeRunId = createRun(core.context, { itemCount: 1, trigger: 'manual-web' });

      // 构造测试缓存文件、配图、共享图片与跨目录软链接
      await writeJsonAtomic(path.join(core.context.paths.articlesDir, 'art-old.json'), {
        url: 'https://openai.com/news/old',
        title: 'GPT-5 旧闻回顾 100%',
        lang: 'en',
        publishedAt: '2026-11-10T02:00:00.000Z',
        text: '这是早期发布的模型详情正文。',
        feedContent: '<p>feed old</p>',
        mediaAssets: [
          {
            id: 'm-old-1',
            articleId: 'art-old',
            kind: 'chart',
            imagePath: 'storage/images/art-old-chart.png',
            sourceUrl: 'https://openai.com/chart.png',
            captionHint: '性能对比图',
            contextSnippet: 'benchmark score',
            score: 92,
          },
          {
            id: 'm-old-shared',
            articleId: 'art-old',
            kind: 'cover',
            imagePath: 'storage/images/shared-banner.png',
            sourceUrl: null,
            captionHint: '共享题图',
            contextSnippet: '',
            score: 50,
          },
        ],
      });
      await fs.writeFile(
        path.join(core.context.paths.imagesDir, 'art-old-chart.png'),
        Buffer.from('chart-bytes-01'),
      );
      await fs.writeFile(
        path.join(core.context.paths.imagesDir, 'shared-banner.png'),
        Buffer.from('shared-banner-bytes'),
      );

      await writeJsonAtomic(path.join(core.context.paths.articlesDir, 'art-new.json'), {
        url: 'https://deepmind.google/blog/new',
        title: 'Gemini 新多模态工具上线',
        lang: 'en',
        publishedAt: '2026-11-18T06:00:00.000Z',
        text: '这是最新抓取并提取成功的完整正文内容。',
        feedContent: null,
        mediaAssets: [],
      });

      const outsideFile = path.join(rootDir, 'config', 'settings.yaml');
      const symlinkImg = path.join(core.context.paths.imagesDir, 'sym-escape.png');
      await fs.symlink(outsideFile, symlinkImg);

      core.context.repos.articles.insertIfAbsent({
        id: 'art-old',
        sourceId: 'openai-news',
        canonicalUrl: 'https://openai.com/news/old',
        title: 'GPT-5 旧闻回顾 100%',
        titleNorm: 'gpt 5 旧闻回顾 100',
        lang: 'en',
        publishedAt: '2026-11-10T02:00:00.000Z',
        firstSeenAt: '2026-11-10T03:00:00.000Z',
        excerpt: '100% benchmark coverage',
        contentPath: 'storage/articles/art-old.json',
        contentChars: 14,
        imagePath: 'storage/images/shared-banner.png',
        extractStatus: 'ok',
      });
      core.context.repos.articles.insertIfAbsent({
        id: 'art-shared-survivor',
        sourceId: 'openai-news',
        canonicalUrl: 'https://openai.com/news/survivor',
        title: 'OpenAI 安全框架升级',
        titleNorm: 'openai 安全框架升级',
        lang: 'en',
        publishedAt: '2026-11-19T02:00:00.000Z',
        firstSeenAt: '2026-11-19T03:00:00.000Z',
        excerpt: 'Safety framework update',
        contentPath: null,
        contentChars: 0,
        imagePath: 'storage/images/shared-banner.png',
        extractStatus: 'failed',
      });
      core.context.repos.articles.insertIfAbsent({
        id: 'art-new',
        sourceId: 'deepmind-blog',
        canonicalUrl: 'https://deepmind.google/blog/new',
        title: 'Gemini 新多模态工具上线',
        titleNorm: 'gemini 新多模态工具上线',
        lang: 'en',
        publishedAt: '2026-11-18T06:00:00.000Z',
        firstSeenAt: '2026-11-18T07:00:00.000Z',
        excerpt: 'Multimodal tool release',
        contentPath: 'storage/articles/art-new.json',
        contentChars: 19,
        imagePath: 'storage/images/sym-escape.png',
        extractStatus: 'ok',
      });
      core.context.repos.articles.insertIfAbsent({
        id: 'art-reserved',
        sourceId: 'openai-news',
        canonicalUrl: 'https://openai.com/news/reserved',
        title: '正在处理中的新闻',
        titleNorm: '正在处理中的新闻',
        lang: 'en',
        publishedAt: '2026-11-10T04:00:00.000Z',
        firstSeenAt: '2026-11-10T05:00:00.000Z',
        excerpt: 'Reserved article',
        contentPath: null,
        contentChars: 200,
        imagePath: null,
        extractStatus: 'feed_only',
      });
      core.context.repos.articles.markReserved(['art-reserved'], activeRunId);

      // 验证列表分页、信源名称映射、关键词与时间筛选
      const page1 = await core.articles.list({ page: 1, pageSize: 2 });
      expect(page1.total).toBe(4);
      expect(page1.items.map((i) => i.id)).toEqual(['art-shared-survivor', 'art-new']);
      expect(page1.items[0]?.sourceName).toBe('OpenAI News');
      expect(page1.statusCounts).toEqual({
        new: 3,
        reserved: 1,
        consumed: 0,
        expired: 0,
        rejected: 0,
      });

      const escapedLikeList = await core.articles.list({ query: '100%' });
      expect(escapedLikeList.items.map((i) => i.id)).toEqual(['art-old']);

      const timeFiltered = await core.articles.list({
        timeField: 'first_seen',
        from: '2026-11-18T00:00',
        to: '2026-11-18T23:59',
      });
      expect(timeFiltered.items.map((i) => i.id)).toEqual(['art-new']);

      // 验证详情读取与缺失优雅降级
      const detailOk = await core.articles.getDetail('art-old');
      expect(detailOk.contentFileExists).toBe(true);
      expect(detailOk.contentText).toBe('这是早期发布的模型详情正文。');
      expect(detailOk.mediaAssets).toHaveLength(2);

      const detailNoFile = await core.articles.getDetail('art-shared-survivor');
      expect(detailNoFile.contentFileExists).toBe(false);
      expect(detailNoFile.contentText).toBeNull();

      await expect(core.articles.getDetail('non-existent')).rejects.toBeInstanceOf(NotFoundError);

      // 禁止没有任何条件的空删除
      await expect(core.articles.delete({})).rejects.toThrow(/至少勾选具体文章/);

      // 预演按时间删除 2026-11-10 当天的文章：命中 art-old 与 art-reserved，跳过被占用的 art-reserved
      const previewRes = await core.articles.delete({
        from: '2026-11-10',
        to: '2026-11-10',
        dryRun: true,
      });
      expect(previewRes.dryRun).toBe(true);
      expect(previewRes.matchedCount).toBe(2);
      expect(previewRes.deletableCount).toBe(1);
      expect(previewRes.skippedReservedIds).toEqual(['art-reserved']);
      // art-old.json + art-old-chart.png 可删除；shared-banner.png 因 art-shared-survivor 仍在用而保留
      expect(previewRes.deletedFileCount).toBe(2);
      expect(previewRes.reclaimedBytes).toBeGreaterThan(0);

      // 执行按时间删除
      const execTimeDel = await core.articles.delete({
        from: '2026-11-10',
        to: '2026-11-10',
      });
      expect(execTimeDel.deletedCount).toBe(1);
      expect(execTimeDel.deletedIds).toEqual(['art-old']);
      expect(execTimeDel.skippedReservedIds).toEqual(['art-reserved']);
      expect(execTimeDel.deletedFileCount).toBe(2);
      expect(core.context.repos.articles.getById('art-old')).toBeNull();
      expect(core.context.repos.articles.getById('art-reserved')).not.toBeNull();
      // 验证独占图与文章 JSON 已清理，但共享图与越界软链接目标完好无损
      await expect(
        fs.stat(path.join(core.context.paths.articlesDir, 'art-old.json')),
      ).rejects.toThrow();
      await expect(
        fs.stat(path.join(core.context.paths.imagesDir, 'art-old-chart.png')),
      ).rejects.toThrow();
      expect(
        (await fs.stat(path.join(core.context.paths.imagesDir, 'shared-banner.png'))).isFile(),
      ).toBe(true);

      // 验证选择性按 ID 删除且拒绝沿软链接删除外部文件
      const selectiveDel = await core.articles.delete({ ids: ['art-new', 'art-reserved'] });
      expect(selectiveDel.deletedIds).toEqual(['art-new']);
      expect(selectiveDel.skippedReservedIds).toEqual(['art-reserved']);
      expect((await fs.stat(outsideFile)).isFile()).toBe(true);
    } finally {
      await core.close();
    }
  });

  it('supports run time-filtering, disk usage measurement, artifacts_only clearance, and full cascade deletion', async () => {
    const rootDir = await setupTempWorkspace();
    const core = await createCore({ rootDir });
    let activeLockedId: string | null = null;

    try {
      const now = new Date('2026-11-20T04:00:00.000Z');
      core.context.now = () => now;

      const oldPublishedId = createRun(core.context, { itemCount: 1, trigger: 'manual-cli' });
      const recentFailedId = createRun(core.context, { itemCount: 1, trigger: 'manual-web' });
      activeLockedId = createRun(core.context, { itemCount: 1, trigger: 'manual-web' });
      const uncertainRunId = createRun(core.context, { itemCount: 1, trigger: 'manual-web' });

      // 调整创建时间测试区间筛选
      core.context.db
        .prepare('UPDATE runs SET created_at = ? WHERE id = ?')
        .run('2026-11-05T04:00:00.000Z', oldPublishedId);
      core.context.db
        .prepare('UPDATE runs SET created_at = ? WHERE id = ?')
        .run('2026-11-18T06:00:00.000Z', recentFailedId);
      core.context.db
        .prepare('UPDATE runs SET created_at = ? WHERE id = ?')
        .run('2026-11-18T08:00:00.000Z', activeLockedId);
      core.context.db
        .prepare('UPDATE runs SET created_at = ? WHERE id = ?')
        .run('2026-11-18T10:00:00.000Z', uncertainRunId);

      core.context.repos.runs.updateStatus(oldPublishedId, 'published');
      core.context.repos.runs.updateStatus(recentFailedId, 'failed');
      core.context.repos.runs.updateStatus(activeLockedId, 'failed');
      core.context.repos.runs.updateStatus(uncertainRunId, 'publish_uncertain');

      // 为各期任务准备磁盘文件、步骤检查点、事件、草稿及已播防重记录
      for (const id of [oldPublishedId, recentFailedId, activeLockedId, uncertainRunId]) {
        const outDir = path.join(core.context.paths.runDir(id), 'output');
        await fs.mkdir(outDir, { recursive: true });
        await fs.writeFile(path.join(outDir, 'video.mp4'), Buffer.alloc(1024, 1));
      }
      core.context.repos.runStages.markStage(oldPublishedId, 'render', 'done', {
        checkpointPath: 'output/video.mp4',
      });
      core.context.repos.history.insert({
        eventId: 'hist-keep-1',
        runId: oldPublishedId,
        title: '保留的已播新闻历史',
        titleNorm: '保留的已播新闻历史',
        entity: 'OpenAI',
        articleUrls: ['https://openai.com/news/hist-1'],
        publishedAt: '2026-11-05T05:00:00.000Z',
      });

      core.context.repos.articles.insertIfAbsent({
        id: 'art-fail-rel',
        sourceId: 'openai-news',
        canonicalUrl: 'https://openai.com/news/fail-rel',
        title: '失败任务占用的新闻',
        titleNorm: '失败任务占用的新闻',
        lang: 'en',
        publishedAt: '2026-11-18T05:00:00.000Z',
        firstSeenAt: '2026-11-18T05:10:00.000Z',
        excerpt: 'Reserved by failed run',
        contentPath: null,
        contentChars: 100,
        imagePath: null,
        extractStatus: 'ok',
      });
      core.context.repos.articles.markReserved(['art-fail-rel'], recentFailedId);
      core.context.repos.events.insertMany([
        {
          id: 'ev-fail-1',
          runId: recentFailedId,
          rank: 1,
          role: 'primary',
          refillRound: 0,
          title: '失败事件',
          category: '模型',
          entity: 'OpenAI',
          score: 8,
          publicAppeal: 7,
          reason: 'test',
          articleIds: ['art-fail-rel'],
        },
      ]);
      core.context.repos.runItems.createMany([
        {
          id: 'item-fail-1',
          runId: recentFailedId,
          eventId: 'ev-fail-1',
          position: 1,
          status: 'passed',
          revision: 0,
          dropReason: null,
          finalJson: null,
          updatedAt: '2026-11-18T06:00:00.000Z',
        },
      ]);
      const sched = await core.scheduler.create({
        name: '清理引用测试',
        time: '09:00',
        itemCount: 3,
        enabled: false,
      });
      core.context.repos.schedules.update(sched.id, {
        lastRunId: recentFailedId,
        now: now.toISOString(),
      });

      // 锁定 activeLockedId，验证锁保护机制
      acquirePipelineLock(core.context, activeLockedId, core.context.settings);

      // 查询时间筛选与磁盘占用统计
      const filteredRuns = await core.tasks.list({ from: '2026-11-18', to: '2026-11-18' });
      expect(filteredRuns.map((r) => r.id)).toEqual([
        uncertainRunId,
        activeLockedId,
        recentFailedId,
      ]);
      const usageMap = await core.tasks.listRunDiskUsage([oldPublishedId, recentFailedId]);
      expect(usageMap[oldPublishedId]).toBe(1024);
      expect(usageMap[recentFailedId]).toBe(1024);

      await expect(core.tasks.deleteRuns({ mode: 'full' })).rejects.toThrow(/至少勾选具体任务/);

      // 1. 仅清理 oldPublishedId 的本地产物，保留任务记录、文稿与检查点状态
      const clearPreview = await core.tasks.deleteRuns({
        runIds: [oldPublishedId],
        mode: 'artifacts_only',
        dryRun: true,
      });
      expect(clearPreview.reclaimedBytes).toBe(1024);
      expect(clearPreview.affectedRunIds).toEqual([oldPublishedId]);

      const clearResult = await core.tasks.deleteRuns({
        runIds: [oldPublishedId],
        mode: 'artifacts_only',
      });
      expect(clearResult.affectedRunIds).toEqual([oldPublishedId]);
      expect(clearResult.reclaimedBytes).toBe(1024);
      await expect(fs.stat(core.context.paths.runDir(oldPublishedId))).rejects.toThrow();
      expect(core.context.repos.runs.getById(oldPublishedId)).not.toBeNull();
      const clearedStage = core.context.repos.runStages
        .listByRun(oldPublishedId)
        .find((s) => s.stage === 'render');
      expect(clearedStage?.checkpointPath).toBeNull();
      const clearEvents = await core.tasks.events(oldPublishedId);
      expect(clearEvents.some((ev) => ev.type === 'artifacts_cleared')).toBe(true);

      // 2. 按创建时间区间彻底删除 2026-11-18 任务：
      //    仅删除 recentFailedId；持锁的 activeLockedId 与 publish_uncertain 的 uncertainRunId 必须跳过
      const batchFullPreview = await core.tasks.deleteRuns({
        from: '2026-11-18',
        to: '2026-11-18',
        mode: 'full',
        dryRun: true,
      });
      expect(batchFullPreview.matchedCount).toBe(3);
      expect(batchFullPreview.affectedRunIds).toEqual([recentFailedId]);
      expect(batchFullPreview.skippedProtectedRunIds).toEqual([uncertainRunId, activeLockedId]);
      expect(batchFullPreview.releasedArticlesCount).toBe(1);
      expect(batchFullPreview.reclaimedBytes).toBe(1024);

      const batchFullResult = await core.tasks.deleteRuns({
        from: '2026-11-18',
        to: '2026-11-18',
        mode: 'full',
      });
      expect(batchFullResult.affectedRunIds).toEqual([recentFailedId]);
      expect(batchFullResult.skippedProtectedRunIds).toEqual([uncertainRunId, activeLockedId]);
      expect(batchFullResult.releasedArticlesCount).toBe(1);
      expect(batchFullResult.reclaimedBytes).toBe(1024);

      expect(core.context.repos.runs.getById(recentFailedId)).toBeNull();
      expect(core.context.repos.runs.getById(activeLockedId)).not.toBeNull();
      expect(core.context.repos.runs.getById(uncertainRunId)).not.toBeNull();
      expect(core.context.repos.articles.getById('art-fail-rel')).toMatchObject({
        status: 'new',
        reservedByRun: null,
      });
      expect(core.context.repos.schedules.getById(sched.id)?.lastRunId).toBeNull();
      await expect(fs.stat(core.context.paths.runDir(recentFailedId))).rejects.toThrow();

      // 彻底删除 oldPublishedId 后，跨天防重表 published_history 仍然保留
      await core.tasks.deleteRuns({ runIds: [oldPublishedId], mode: 'full' });
      expect(core.context.repos.history.listAll(20)).toHaveLength(1);
    } finally {
      if (activeLockedId) {
        releasePipelineLock(core.context, activeLockedId);
      }
      await core.close();
    }
  });
});
