import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { IssuePackage } from '@aidaily/contracts';
import type { TtsProvider } from '@aidaily/tts';
import { execa } from 'execa';
import { afterEach, describe, expect, it } from 'vitest';
import { createCore, createRun, runNarrateStage, updateSettingsFile } from '../src/index.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function setupCore() {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aidaily-narration-'));
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
      biliup: { adapter: 'generic', bin: 'fixture-disabled-biliup', extraArgs: [] },
    },
    publish: {
      mode: 'manual-review',
      bilibili: { cookieFile: path.join(rootDir, 'test-bili-cookies.json') },
    },
    tts: { provider: 'silent' },
  });
  const core = await createCore({
    rootDir,
    now: () => new Date('2026-11-18T08:00:00.000Z'),
  });
  return core;
}

function packageData(): IssuePackage {
  return {
    order: ['item-1'],
    headlineItemId: 'item-1',
    headline: '开源模型可以离线试听',
    leadSummary: '本期看一段可以分开调整的配音。',
    intro: { narration: ['欢迎收看今天的节目。'], hostComment: '先听这一段。' },
    outro: { narration: ['今天先到这里。'], hostComment: '下期再见。', cta: '欢迎留言。' },
    publish: { title: '试听配音', descriptionIntro: '简介', tags: ['AI'] },
  };
}

describe('single-section narration edits and published-run bookkeeping', () => {
  it('regenerates one section with another engine and can save subtitles without new audio', async () => {
    const core = await setupCore();
    try {
      const spoken: string[] = [];
      const spy: TtsProvider = {
        id: 'spy-engine',
        async healthcheck() {
          return { ok: true, detail: 'ok' };
        },
        async synthesize(req) {
          spoken.push(req.text);
          await execa('ffmpeg', [
            '-y',
            '-f',
            'lavfi',
            '-i',
            'sine=frequency=523:duration=0.35',
            '-ar',
            '48000',
            '-ac',
            '1',
            req.outFile,
          ]);
        },
      };
      core.context.tts.register(spy);
      const runId = createRun(core.context, { itemCount: 1, trigger: 'manual-web' });
      const nowIso = '2026-11-18T08:00:00.000Z';
      const settings = structuredClone(core.context.settings);
      settings.tts.providers['spy-engine'] = { charsPerSecond: 8 };
      core.context.repos.runs.updateStatus(runId, 'awaiting_audio_review', {
        configSnapshotJson: JSON.stringify(settings),
      });
      core.context.repos.articles.insertIfAbsent({
        id: 'art-1',
        sourceId: 'openai-blog',
        canonicalUrl: 'https://example.com/narration',
        title: '开源模型可以离线试听',
        titleNorm: '开源模型可以离线试听',
        lang: 'zh',
        publishedAt: nowIso,
        firstSeenAt: nowIso,
        excerpt: '可以先试听。',
        contentPath: 'storage/articles/art-1.txt',
        contentChars: 80,
        imagePath: null,
        extractStatus: 'ok',
      });
      core.context.repos.events.insertMany([
        {
          id: 'ev-1',
          runId,
          rank: 1,
          role: 'primary',
          refillRound: 0,
          title: '开源模型可以离线试听',
          category: '模型',
          entity: '开源',
          score: 8,
          publicAppeal: 8,
          reason: '适合试听',
          articleIds: ['art-1'],
        },
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
            title: '开源模型可以离线试听',
            shortTitle: '离线试听',
            progressLabel: '离线试听',
            category: '模型',
            entity: '开源',
            summary: '可以先听再决定要不要做视频。',
            keyPoints: ['本地运行'],
            detail: '音频和字幕可以分开改。',
            hostComment: '很实用。',
            narration: ['今天的新闻是离线试听。'],
            evidence: [{ claim: '可以试听', articleId: 'art-1', quote: '可以先试听。' }],
          },
          updatedAt: nowIso,
        },
      ]);
      const runDir = core.context.paths.runDir(runId);
      await fs.mkdir(path.join(runDir, 'stages'), { recursive: true });
      await fs.writeFile(
        path.join(runDir, 'stages', 'package.json'),
        JSON.stringify({ packageData: packageData() }),
      );

      await expect(
        core.tasks.updateSectionNarration(runId, 'intro', {
          ttsText: '欢迎收看今天的节目。',
          subtitleText: '还没有音频',
          regenerateAudio: false,
        }),
      ).rejects.toThrow(/还没有配音/);
      await expect(
        core.tasks.updateSectionNarration(runId, 'intro', {
          ttsText: '   ',
          subtitleText: '字幕',
        }),
      ).rejects.toThrow(/语音/);
      await expect(
        core.tasks.updateSectionNarration(runId, 'missing', {
          ttsText: '有声音。',
          subtitleText: '有字幕',
        }),
      ).rejects.toThrow(/未找到口播段落/);
      await expect(
        core.tasks.updateSectionNarration(runId, 'intro', {
          ttsText: '有声音。',
          subtitleText: '有字幕',
          provider: 'missing-engine',
        }),
      ).rejects.toThrow(/未配置语音合成引擎/);

      core.context.repos.runStages.markStage(runId, 'render', 'done', {
        checkpointPath: 'stages/render.json',
      });
      core.context.repos.runStages.markStage(runId, 'qa', 'done', { checkpointPath: 'qa.json' });
      await runNarrateStage({
        ctx: core.context,
        runId,
        settings,
        packageData: packageData(),
      });
      const updated = await core.tasks.updateSectionNarration(runId, 'intro', {
        ttsText: '语音甲。',
        subtitleText: '字幕甲\n字幕乙',
        provider: 'spy-engine',
        regenerateAudio: true,
      });
      expect(spoken).toEqual(['语音甲。']);
      expect(updated.subtitleText).toBe('字幕甲\n字幕乙');
      expect(updated.provider).toBe('spy-engine');
      const timeline = JSON.parse(
        await fs.readFile(path.join(runDir, 'timeline.json'), 'utf8'),
      ) as { sections: Array<{ key: string; sentences: Array<{ text: string }> }> };
      expect(timeline.sections[0]?.sentences.map((sentence) => sentence.text)).toEqual([
        '字幕甲',
        '字幕乙',
      ]);
      const wavPath = path.join(runDir, 'audio', 'intro.wav');
      const wavHash = crypto
        .createHash('sha1')
        .update(await fs.readFile(wavPath))
        .digest('hex');

      const saved = await core.tasks.updateSectionNarration(runId, 'intro', {
        ttsText: '语音甲。',
        subtitleText: '只改字幕',
        provider: 'spy-engine',
        regenerateAudio: false,
      });
      expect(spoken).toEqual(['语音甲。']);
      expect(saved.subtitleText).toBe('只改字幕');
      expect(saved.ttsText).toBe('语音甲。');
      expect(
        crypto
          .createHash('sha1')
          .update(await fs.readFile(wavPath))
          .digest('hex'),
      ).toBe(wavHash);
      await expect(
        core.tasks.updateSectionNarration(runId, 'intro', {
          ttsText: '换成另一句语音。',
          subtitleText: '字幕也想一起改',
          provider: 'spy-engine',
          regenerateAudio: false,
        }),
      ).rejects.toThrow(/不能修改语音文本或语音引擎/);
      await expect(
        core.tasks.updateSectionNarration(runId, 'intro', {
          ttsText: '语音甲。',
          subtitleText: '只改字幕',
          provider: 'silent',
          regenerateAudio: false,
        }),
      ).rejects.toThrow(/不能修改语音文本或语音引擎/);
      expect(spoken).toEqual(['语音甲。']);
      expect(
        crypto
          .createHash('sha1')
          .update(await fs.readFile(wavPath))
          .digest('hex'),
      ).toBe(wavHash);

      const reset = await core.tasks.resetSectionNarration(runId, 'intro');
      expect(reset.hasOverride).toBe(false);
      expect(reset.ttsText).toContain('欢迎收看今天的节目');
      expect(reset.provider).toBe('silent');
      expect(
        core.context.repos.runStages.listByRun(runId).find((stage) => stage.stage === 'render')
          ?.status,
      ).toBe('stale');

      // 只读获取口播段落列表时绝不篡改任务历史配置快照
      const snapshotBeforeView = core.context.repos.runs.getById(runId)?.configSnapshotJson;
      await updateSettingsFile(path.join(core.context.paths.rootDir, 'config', 'settings.yaml'), {
        render: { pagePaddingSec: 1.5 },
      });
      const sectionsView = await core.tasks.getNarrationSections(runId);
      expect(sectionsView.length).toBeGreaterThan(0);
      expect(core.context.repos.runs.getById(runId)?.configSnapshotJson).toBe(snapshotBeforeView);
    } finally {
      await core.close();
    }
  }, 60_000);

  it('returns consumed articles without taking one locked by another run, and keeps upload attempts', async () => {
    const core = await setupCore();
    try {
      const runId = createRun(core.context, { itemCount: 1, trigger: 'manual-web' });
      const nowIso = '2026-11-18T08:00:00.000Z';
      for (const id of ['art-free', 'art-held']) {
        core.context.repos.articles.insertIfAbsent({
          id,
          sourceId: 'openai-blog',
          canonicalUrl: `https://example.com/${id}`,
          title: id,
          titleNorm: id,
          lang: 'zh',
          publishedAt: nowIso,
          firstSeenAt: nowIso,
          excerpt: id,
          contentPath: `storage/articles/${id}.txt`,
          contentChars: 20,
          imagePath: null,
          extractStatus: 'ok',
        });
      }
      core.context.repos.articles.markReserved(['art-free', 'art-held'], runId);
      core.context.db
        .prepare("UPDATE articles SET status = 'consumed', reserved_by_run = NULL WHERE id = ?")
        .run('art-free');
      core.context.db
        .prepare('UPDATE articles SET reserved_by_run = ? WHERE id = ?')
        .run('other-run', 'art-held');
      const changed = core.context.repos.articles.reviveArticlesForRun(
        ['art-free', 'art-held'],
        runId,
        'rereserve',
      );
      expect(changed).toBe(1);
      expect(core.context.repos.articles.getById('art-free')).toMatchObject({
        status: 'reserved',
        reservedByRun: runId,
      });
      expect(core.context.repos.articles.getById('art-held')).toMatchObject({
        status: 'reserved',
        reservedByRun: 'other-run',
      });
      expect(
        core.context.repos.articles.reviveArticlesForRun(['art-free'], runId, 'release_to_new'),
      ).toBe(1);
      expect(core.context.repos.articles.getById('art-free')?.status).toBe('new');

      core.context.repos.history.insert({
        eventId: 'ev-old',
        runId,
        title: '旧标题',
        titleNorm: '旧标题',
        entity: null,
        articleUrls: ['https://example.com/art-free'],
        publishedAt: nowIso,
      });
      expect(core.context.repos.history.deleteByRun(runId)).toBe(1);
      expect(
        core.context.repos.history
          .listRecent('2020-01-01T00:00:00.000Z')
          .filter((record) => record.runId === runId),
      ).toHaveLength(0);

      core.context.repos.publish.upsertDraft({
        runId,
        title: '旧标题',
        description: '旧简介',
        tags: ['AI'],
        updatedAt: nowIso,
      });
      core.context.repos.publish.updateStatus(runId, 'published', {
        bvid: 'BV1NM411P7a9',
        incrementAttempts: true,
        updatedAt: nowIso,
      });
      expect(core.context.repos.publish.resetForRevive(runId, nowIso)).toMatchObject({
        status: 'draft',
        bvid: null,
        attempts: 1,
        error: null,
      });
      core.context.repos.publish.updateStatus(runId, 'publishing', { updatedAt: nowIso });
      expect(core.context.repos.publish.resetForRevive(runId, nowIso)).toBeNull();
      expect(core.context.repos.publish.getByRun(runId)?.status).toBe('publishing');
      expect(() =>
        core.context.repos.publish.upsertDraft({
          runId,
          title: '不能覆盖',
          description: '不能覆盖',
          tags: ['AI'],
          updatedAt: nowIso,
        }),
      ).toThrow(/publishing/);
    } finally {
      await core.close();
    }
  });
});
