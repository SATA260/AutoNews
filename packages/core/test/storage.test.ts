import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  archiveRunArtifacts,
  createCore,
  inTransaction,
  resolveSafeArtifactPath,
  writeJsonAtomic,
} from '../src/index.js';

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
      enabled: true,
      now,
    });
    expect(sched.time).toBe('08:00');
    expect(repos.schedules.list()).toHaveLength(1);
    expect(repos.schedules.remove('sched-1')).toBe(true);

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

    await core.close();
  });
});
