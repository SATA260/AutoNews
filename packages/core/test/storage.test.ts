import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  archiveRunArtifacts,
  createCore,
  createRun,
  inTransaction,
  resolveSafeArtifactPath,
  writeJsonAtomic,
} from '../src/index.js';
import { runMigrations } from '../src/storage/migrate.js';
import { MIGRATION_001 } from '../src/storage/migrations/001_init.js';
import { MIGRATION_002 } from '../src/storage/migrations/002_workflow.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function setupTempWorkspace(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aidaily-core-'));
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

describe('M1 sqlite storage, paths, and transactions', () => {
  it('initializes state.sqlite in WAL mode with all 14 tables', async () => {
    const rootDir = await setupTempWorkspace();
    const core = await createCore({ rootDir });

    const modeRow = core.context.db.prepare('PRAGMA journal_mode').get() as {
      journal_mode: string;
    };
    expect(modeRow.journal_mode.toLowerCase()).toBe('wal');
    expect(() => createRun(core.context, { itemCount: 13 })).toThrow(/最多支持 12 条/);

    const tables = core.context.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as Array<{ name: string }>;
    const tableNames = new Set(tables.map((t) => t.name));

    for (const expected of [
      'schema_migrations',
      'source_state',
      'articles',
      'runs',
      'run_stages',
      'run_events',
      'events',
      'run_items',
      'item_versions',
      'llm_calls',
      'published_history',
      'publish_records',
      'schedules',
      'locks',
    ]) {
      expect(tableNames.has(expected)).toBe(true);
    }

    await core.close();
  });

  it('升级已有数据库时保留主播和任务记录', () => {
    const db = new DatabaseSync(':memory:');
    try {
      db.exec(MIGRATION_001.sql);
      db.exec(MIGRATION_002.sql);
      db.exec(
        "CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL); INSERT INTO schema_migrations VALUES (1, '2026-01-01'), (2, '2026-01-01');",
      );
      db.prepare(
        "INSERT INTO runs (id, trigger, status, item_count, config_snapshot, created_at, host_id) VALUES (?, 'manual-cli', 'awaiting_review', 1, '{}', ?, 'gpt')",
      ).run('old-run', '2026-01-01T00:00:00.000Z');
      runMigrations(db);
      runMigrations(db);
      expect(
        db
          .prepare('SELECT host_id, host_manual, media_dirty, not_before_at FROM runs WHERE id = ?')
          .get('old-run'),
      ).toMatchObject({ host_id: 'gpt', host_manual: 0, media_dirty: 0, not_before_at: null });
      expect(
        db.prepare('SELECT version FROM schema_migrations ORDER BY version').all(),
      ).toHaveLength(4);
    } finally {
      db.close();
    }
  });

  it('supports article reservation, consumption, schedule CRUD, and rollback', async () => {
    const rootDir = await setupTempWorkspace();
    const core = await createCore({ rootDir });
    const { repos, db } = core.context;
    const now = '2026-11-16T02:00:00.000Z';

    const inserted = repos.articles.insertIfAbsent({
      id: 'art-1',
      sourceId: 'openai-news',
      canonicalUrl: 'https://openai.com/news/test-1',
      title: 'OpenAI Test Release',
      titleNorm: 'openai test release',
      lang: 'en',
      publishedAt: now,
      firstSeenAt: now,
      excerpt: 'Summary',
      contentPath: 'storage/articles/art-1.json',
      contentChars: 500,
      imagePath: null,
      extractStatus: 'ok',
    });
    expect(inserted).toBe(true);

    repos.runs.create({
      id: 'run-1',
      trigger: 'manual-cli',
      itemCount: 6,
      configSnapshotJson: JSON.stringify(core.context.settings),
      createdAt: now,
    });
    repos.runStages.initStages('run-1');
    expect(repos.runStages.listByRun('run-1')).toHaveLength(7);

    repos.articles.markReserved(['art-1'], 'run-1');
    expect(repos.articles.getById('art-1')?.status).toBe('reserved');

    expect(() =>
      inTransaction(db, () => {
        repos.articles.markConsumed(['art-1'], 'run-1');
        throw new Error('simulated failure');
      }),
    ).toThrow('simulated failure');
    expect(repos.articles.getById('art-1')?.status).toBe('reserved');

    repos.articles.markConsumed(['art-1'], 'run-1');
    expect(repos.articles.getById('art-1')?.status).toBe('consumed');

    const sched = repos.schedules.create({
      id: 'sched-1',
      name: '早报任务',
      time: '08:00',
      itemCount: 6,
      cutoffMode: 'hours',
      maxAgeHours: 24,
      enabled: true,
      now,
    });
    expect(sched.time).toBe('08:00');
    expect(sched.cutoffMode).toBe('hours');
    expect(sched.maxAgeHours).toBe(24);
    expect(repos.schedules.list()).toHaveLength(1);
    expect(repos.schedules.remove('sched-1')).toBe(true);

    // 验证严格最早时间过滤：即使晚于下限才初次抓到，明确发布时间更早的文章也必须被排除
    repos.articles.insertIfAbsent({
      id: 'art-old',
      sourceId: 'openai-news',
      canonicalUrl: 'https://openai.com/news/old',
      title: 'Old Post',
      titleNorm: 'old post',
      lang: 'en',
      publishedAt: '2026-11-15T10:00:00.000Z',
      firstSeenAt: '2026-11-16T02:00:00.000Z',
      excerpt: 'Old',
      contentPath: 'storage/articles/art-old.json',
      contentChars: 500,
      imagePath: null,
      extractStatus: 'ok',
    });
    repos.articles.insertIfAbsent({
      id: 'art-undated-old',
      sourceId: 'openai-news',
      canonicalUrl: 'https://openai.com/news/undated-old',
      title: 'Undated Old Post',
      titleNorm: 'undated old post',
      lang: 'en',
      publishedAt: null,
      firstSeenAt: '2026-11-15T22:00:00.000Z',
      excerpt: 'Undated old',
      contentPath: 'storage/articles/art-undated-old.json',
      contentChars: 500,
      imagePath: null,
      extractStatus: 'ok',
    });
    repos.articles.insertIfAbsent({
      id: 'art-fresh',
      sourceId: 'openai-news',
      canonicalUrl: 'https://openai.com/news/fresh',
      title: 'Fresh Post',
      titleNorm: 'fresh post',
      lang: 'en',
      publishedAt: '2026-11-16T04:00:00.000Z',
      firstSeenAt: '2026-11-16T04:05:00.000Z',
      excerpt: 'Fresh',
      contentPath: 'storage/articles/art-fresh.json',
      contentChars: 500,
      imagePath: null,
      extractStatus: 'ok',
    });

    const strictList = repos.articles.listCandidates('2026-11-16T00:00:00.000Z', false, {
      strictNotBefore: true,
    });
    expect(strictList.map((a) => a.id)).toEqual(['art-fresh']);

    const recentOrigins = repos.articles.listRecentForOriginCheck(
      '2026-11-01T00:00:00.000Z',
      '2026-11-16T00:00:00.000Z',
      10,
    );
    expect(recentOrigins.map((a) => a.id)).toContain('art-old');

    await core.close();
  });

  it('blocks directory traversal and archives invalidated stage files', async () => {
    const rootDir = await setupTempWorkspace();
    const core = await createCore({ rootDir });

    expect(() =>
      resolveSafeArtifactPath(core.context.paths.runsDir, 'run-1', '../state.sqlite'),
    ).toThrow(/禁止访问/);
    expect(() => resolveSafeArtifactPath(core.context.paths.runsDir, '../etc', 'qa.json')).toThrow(
      /非法的任务 ID/,
    );

    const safePath = resolveSafeArtifactPath(
      core.context.paths.runsDir,
      'run-1',
      'stages/package.json',
    );
    await writeJsonAtomic(safePath, { ok: true });

    const runDir = core.context.paths.runDir('run-1');
    const moved = await archiveRunArtifacts(runDir, 'attempt-1-package', ['stages/package.json']);
    expect(moved).toEqual(['stages/package.json']);

    await expect(fs.access(safePath)).rejects.toThrow();
    await expect(
      fs.access(path.join(runDir, 'archive', 'attempt-1-package', 'stages', 'package.json')),
    ).resolves.toBeUndefined();

    // 验证软链接越界拦截与嵌套事务保存点
    const outsideSecret = path.join(core.context.paths.storageDir, 'secret.txt');
    await fs.writeFile(outsideSecret, 'top-secret');
    await fs.symlink(outsideSecret, path.join(runDir, 'leak.txt'));
    expect(() => resolveSafeArtifactPath(core.context.paths.runsDir, 'run-1', 'leak.txt')).toThrow(
      /软链接/,
    );

    inTransaction(core.context.db, () => {
      core.context.repos.schedules.create({
        id: 'sched-outer',
        name: '外层任务',
        time: '07:00',
        itemCount: 3,
        enabled: true,
        now: '2026-11-16T01:00:00.000Z',
      });
      expect(() =>
        inTransaction(core.context.db, () => {
          core.context.repos.schedules.create({
            id: 'sched-inner',
            name: '内层回滚',
            time: '08:00',
            itemCount: 3,
            enabled: true,
            now: '2026-11-16T01:00:00.000Z',
          });
          throw new Error('inner rollback');
        }),
      ).toThrow('inner rollback');
    });
    expect(core.context.repos.schedules.getById('sched-outer')).not.toBeNull();
    expect(core.context.repos.schedules.getById('sched-inner')).toBeNull();

    // 验证互斥锁原子抢占与 ISO 毫秒时间戳对比
    const lock1 = core.context.repos.locks.tryAcquire({
      name: 'pipeline',
      ownerRun: 'run-a',
      pid: process.pid,
      now: '2026-11-16T02:00:00.000Z',
      staleMs: 60_000,
      isProcessAlive: () => true,
    });
    expect(lock1.acquired).toBe(true);
    const lock2 = core.context.repos.locks.tryAcquire({
      name: 'pipeline',
      ownerRun: 'run-b',
      pid: process.pid + 1,
      now: '2026-11-16T02:00:10.000Z',
      staleMs: 60_000,
      isProcessAlive: () => true,
    });
    expect(lock2.acquired).toBe(false);

    core.context.repos.sourceState.upsertSuccess({
      sourceId: 'src-1',
      lastFetchedAt: '2026-11-16T02:00:00.000Z',
      lastItemPublishedAt: '2026-11-16T10:00:00.500Z',
      etag: '"v1"',
      lastModified: null,
    });
    core.context.repos.sourceState.upsertSuccess({
      sourceId: 'src-1',
      lastFetchedAt: '2026-11-16T02:05:00.000Z',
      lastItemPublishedAt: '2026-11-16T10:00:00Z',
      etag: null,
      lastModified: null,
    });
    const srcState = core.context.repos.sourceState.get('src-1');
    expect(srcState?.lastItemPublishedAt).toBe('2026-11-16T10:00:00.500Z');
    expect(srcState?.etag).toBeNull();

    await core.close();
  });
});
