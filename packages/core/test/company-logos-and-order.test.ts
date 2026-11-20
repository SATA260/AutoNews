import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SummaryDraft } from '@aidaily/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import {
  alignOrderByCompanyOverview,
  BUILTIN_COMPANIES,
  createCore,
  createRun,
  loadLogoCatalog,
  type OrderAlignmentItemMeta,
  resolveCompanyIdentity,
  runPackageStage,
  startTemplateHttpServer,
  updateSettingsFile,
  writeJsonAtomic,
} from '../src/index.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const FAKE_AGY_BIN = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'fake-agy.mjs',
);

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('Company logos registry, HTTP mount & order clustering', () => {
  it('stores valid standalone SVG logos for all built-in companies in both assets and template public', async () => {
    const assetsLogos = path.join(REPO_ROOT, 'assets', 'logos');
    const publicLogos = path.join(REPO_ROOT, 'templates', 'daily-deck', 'public', 'logos');

    expect(BUILTIN_COMPANIES.length).toBeGreaterThanOrEqual(50);

    for (const entry of BUILTIN_COMPANIES) {
      const assetSvg = await fs.readFile(path.join(assetsLogos, `${entry.id}.svg`), 'utf8');
      const publicSvg = await fs.readFile(path.join(publicLogos, `${entry.id}.svg`), 'utf8');
      expect(assetSvg.startsWith('<svg')).toBe(true);
      expect(assetSvg).toContain('viewBox=');
      expect(assetSvg).not.toContain('currentColor');
      expect(publicSvg).toBe(assetSvg);
    }
  });

  it('enforces word boundaries and resolves custom assets/logos files and aliases.json', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aidaily-logos-'));
    tempDirs.push(tmpDir);

    await fs.writeFile(path.join(tmpDir, 'openai.png'), Buffer.from('fake-png'));
    await fs.writeFile(path.join(tmpDir, '4paradigm.svg'), '<svg viewBox="0 0 24 24"></svg>');
    await fs.writeFile(
      path.join(tmpDir, 'aliases.json'),
      JSON.stringify({ 范式智能: '4paradigm', 第四范式: '4paradigm' }),
    );

    const catalog = await loadLogoCatalog(tmpDir);
    const metaSpark = resolveCompanyIdentity({
      entity: '',
      fallbackText: 'Meta 发布 Muse Spark 模型家族',
      catalog,
    });
    expect(metaSpark.id).toBe('meta');

    const aiOnly = resolveCompanyIdentity({
      entity: '',
      fallbackText: 'Artificial Intelligence metadata benchmark update',
      catalog,
    });
    expect(aiOnly.isKnown).toBe(false);

    const customHit = resolveCompanyIdentity({
      entity: '范式智能',
      catalog,
    });
    expect(customHit.isKnown).toBe(true);
    expect(customHit.id).toBe('custom:4paradigm');
    expect(customHit.logoUrl).toBe('/__logo_assets__/4paradigm.svg');

    const builtinCustomImg = resolveCompanyIdentity({
      entity: 'OpenAI',
      catalog,
    });
    expect(builtinCustomImg.logoUrl).toBe('/__logo_assets__/openai.png');
  });

  it('serves /__logo_assets__/ safely and blocks directory traversal or escaping symlinks', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aidaily-logo-srv-'));
    tempDirs.push(tmpDir);

    const logosDir = path.join(tmpDir, 'logos');
    const outsideFile = path.join(tmpDir, 'secret.txt');
    await fs.mkdir(logosDir, { recursive: true });
    await fs.writeFile(path.join(logosDir, 'test.svg'), '<svg viewBox="0 0 10 10"></svg>');
    await fs.writeFile(outsideFile, 'do-not-leak');
    await fs.symlink(outsideFile, path.join(logosDir, 'escape.svg'));

    const server = await startTemplateHttpServer({
      htmlContent: '<html><body>ok</body></html>',
      logosDir,
    });

    try {
      const okRes = await fetch(`${server.baseUrl}/__logo_assets__/test.svg`);
      expect(okRes.status).toBe(200);
      expect(okRes.headers.get('content-type')).toContain('image/svg+xml');
      expect(await okRes.text()).toContain('<svg');

      const symlinkRes = await fetch(`${server.baseUrl}/__logo_assets__/escape.svg`);
      expect(symlinkRes.status).toBe(403);

      const traversalRes = await fetch(`${server.baseUrl}/__logo_assets__/../secret.txt`);
      expect([400, 403, 404]).toContain(traversalRes.status);
    } finally {
      await server.close();
    }
  });

  it('clusters remaining items by company, merges unlisted singletons, and stays idempotent', () => {
    const rawOrder = ['lead-google', 'lead-meta', 'g2', 'u1', 'm2', 'o1', 'u2', 'g3', 'o2', 'm3'];
    const meta = new Map<string, OrderAlignmentItemMeta>([
      ['lead-google', { entity: 'Google DeepMind', title: 'Gemini 4 Neon' }],
      ['lead-meta', { entity: 'Meta', title: 'Muse Spark' }],
      ['g2', { entity: 'Google', title: 'Genie 4' }],
      ['u1', { entity: '范式智能', title: 'Phai 模型' }],
      ['m2', { entity: 'Meta AI', title: 'Muse 视觉' }],
      ['o1', { entity: 'OpenAI', title: 'GPT 更新' }],
      ['u2', { entity: '花旗银行', title: 'AI 条款' }],
      ['g3', { entity: '谷歌', title: 'Android Go Gemini' }],
      ['o2', { entity: 'ChatGPT', title: '桌面助手' }],
      ['m3', { entity: 'Meta', title: 'Llama 工具' }],
    ]);

    const aligned = alignOrderByCompanyOverview(rawOrder, meta, null);
    expect(aligned).toEqual([
      'lead-google',
      'lead-meta',
      'g2',
      'g3',
      'm2',
      'm3',
      'o1',
      'o2',
      'u1',
      'u2',
    ]);
    // 幂等性校验：重复执行对齐结果完全不变
    expect(alignOrderByCompanyOverview(aligned, meta, null)).toEqual(aligned);
  });

  it('aligns runPackageStage output order by company clustering and persists aligned DB positions', async () => {
    await fs.chmod(FAKE_AGY_BIN, 0o755);
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aidaily-pkg-align-'));
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
    await fs.copyFile(
      path.join(REPO_ROOT, 'config', 'personas.yaml'),
      path.join(rootDir, 'config', 'personas.yaml'),
    );
    await updateSettingsFile(path.join(rootDir, 'config', 'settings.yaml'), {
      clis: {
        agy: { adapter: 'agy', bin: FAKE_AGY_BIN, extraArgs: [] },
        biliup: { adapter: 'generic', bin: 'fixture-disabled-biliup', extraArgs: [] },
      },
      publish: {
        mode: 'manual-review',
        bilibili: { cookieFile: path.join(rootDir, 'test-bili-cookies.json') },
      },
      ai: {
        stages: {
          select: { cli: 'agy', model: 'gemini-3.8-flash-high', retries: 0 },
          summarize: { cli: 'agy', model: 'gemini-3.8-flash-high', retries: 0 },
          polish: { cli: 'agy', model: 'gemini-3.8-flash-high', retries: 0 },
          factcheck: { cli: 'agy', model: 'gemini-3.8-flash-high', retries: 0 },
          package: { cli: 'agy', model: 'gemini-3.8-flash-high', retries: 0 },
        },
      },
    });

    const core = await createCore({ rootDir });
    try {
      const nowIso = new Date().toISOString();
      const runId = createRun(core.context, {
        itemCount: 5,
        trigger: 'manual-cli',
        hostId: 'deepseek',
      });
      await writeJsonAtomic(path.join(core.context.paths.runDir(runId), 'persona.json'), {
        hostId: 'deepseek',
      });

      const itemsSpec = [
        { id: 'i-1', rank: 1, entity: 'Google DeepMind', shortTitle: 'Gemini 4 发布' },
        { id: 'i-2', rank: 2, entity: 'Meta', shortTitle: 'Meta Muse 发布' },
        { id: 'i-3', rank: 3, entity: 'OpenAI', shortTitle: 'OpenAI 工具升级' },
        { id: 'i-4', rank: 4, entity: 'Google', shortTitle: 'Google Genie 开放' },
        { id: 'i-5', rank: 5, entity: 'OpenAI', shortTitle: 'OpenAI 风险框架' },
      ];

      const summaryDraft: SummaryDraft = {
        facts: ['测试事实'],
        relevance: '测试关联',
        availability: 'available_now',
        availabilityNote: '已可用',
        evidence: [{ claim: 'c1', articleId: 'art-1', quote: 'quote' }],
      };

      core.context.repos.events.insertMany(
        itemsSpec.map((spec) => ({
          id: `ev-${spec.id}`,
          runId,
          rank: spec.rank,
          role: 'primary' as const,
          title: spec.shortTitle,
          articleIds: ['art-1'],
          category: '模型发布',
          entity: spec.entity,
          score: 10 - spec.rank * 0.2,
          publicAppeal: 9,
          reason: '重要更新',
          refillRound: 0,
        })),
      );
      core.context.repos.runItems.createMany(
        itemsSpec.map((spec) => ({
          id: spec.id,
          runId,
          eventId: `ev-${spec.id}`,
          position: null,
          status: 'passed' as const,
          revision: 0,
          dropReason: null,
          finalJson: {
            title: `${spec.shortTitle}详情`,
            shortTitle: spec.shortTitle,
            progressLabel: spec.shortTitle,
            category: '模型发布',
            entity: spec.entity,
            summary: `${spec.shortTitle}核心事实说明。`,
            keyPoints: ['要点一', '要点二'],
            detail: `${spec.shortTitle}细节内容。`,
            hostComment: '很值得留意。',
            narration: [`${spec.shortTitle}最新消息来了。`, '各项能力已经开放测试。'],
            evidence: summaryDraft.evidence,
          },
          updatedAt: nowIso,
        })),
      );

      const ckpt = await runPackageStage(core.context, runId, core.context.settings);
      // 前 2 条进要闻（i-1, i-2），其余 OpenAI（i-3, i-5）应紧邻聚类在一起，Google（i-4）成组
      expect(ckpt.packageData.order).toEqual(['i-1', 'i-2', 'i-3', 'i-5', 'i-4']);
      expect(ckpt.packageData.headlineItemId).toBe('i-1');

      const dbItems = core.context.repos.runItems.listByRun(runId);
      const posById = new Map(dbItems.map((it) => [it.id, it.position]));
      expect(posById.get('i-1')).toBe(1);
      expect(posById.get('i-2')).toBe(2);
      expect(posById.get('i-3')).toBe(3);
      expect(posById.get('i-5')).toBe(4);
      expect(posById.get('i-4')).toBe(5);
    } finally {
      await core.close();
    }
  });
});
