import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { IssuePackage, Timeline } from '@aidaily/contracts';
import { createRun, emitRunEvent, writeJsonAtomic } from '@aidaily/core';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createScheduleAction,
  removeModelApiConnectionAction,
  saveModelApiConnectionAction,
  startRunAction,
  updateDraftAction,
  updateStageRoutingAction,
} from '@/app/actions';
import { GET as getArtifactRoute } from '@/app/api/runs/[id]/artifacts/[...path]/route';
import { GET as getEventsRoute } from '@/app/api/runs/[id]/events/route';
import { closeCoreSingleton, getCore } from '@/lib/core';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const tempDirs: string[] = [];
const envSnapshot = { ...process.env };

afterEach(async () => {
  await closeCoreSingleton();
  process.env = { ...envSnapshot };
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

/** 创建隔离的临时测试工作区并将全局核心引擎指向该目录 */
async function setupWebTestWorkspace(): Promise<string> {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aidaily-web-test-'));
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
  process.env.AIDAILY_ROOT = rootDir;
  return rootDir;
}

/** 生成自定义 API 连接的提交表单 */
function apiConnectionForm(name: string, fields: Record<string, string> = {}): FormData {
  const form = new FormData();
  for (const [key, value] of Object.entries({
    name,
    baseUrl: 'https://model-gateway.test/v1',
    protocol: 'chat-completions',
    ...fields,
  })) {
    form.set(key, value);
  }
  return form;
}

/** 构造一条处于待人工审核状态的测试任务与对应产物文件 */
async function seedReviewReadyRun(): Promise<{ runId: string; mp4Bytes: Uint8Array }> {
  const core = await getCore();
  const nowIso = '2026-11-16T12:00:00.000Z';
  const runId = createRun(core.context, {
    itemCount: 1,
    trigger: 'manual-web',
  });

  const runDir = core.context.paths.runDir(runId);
  await fs.mkdir(path.join(runDir, 'output'), { recursive: true });
  await fs.mkdir(path.join(runDir, 'stages'), { recursive: true });

  const mp4Bytes = Buffer.from(
    '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ',
    'utf8',
  );
  await fs.writeFile(path.join(runDir, 'output', 'video.mp4'), mp4Bytes);
  await fs.writeFile(path.join(runDir, 'output', 'cover.jpg'), 'fake-cover-jpg', 'utf8');

  core.context.repos.articles.insertIfAbsent({
    id: 'art-web-1',
    sourceId: 'openai-blog',
    canonicalUrl: 'https://openai.com/news/web-test',
    title: '模型工具调用速度升级',
    titleNorm: '模型工具调用速度升级',
    lang: 'en',
    publishedAt: nowIso,
    firstSeenAt: nowIso,
    excerpt: 'Faster tool execution.',
    contentPath: null,
    contentChars: 120,
    imagePath: null,
    extractStatus: 'feed_only',
  });
  core.context.repos.articles.markReserved(['art-web-1'], runId);

  core.context.repos.events.insertMany([
    {
      id: 'ev-web-1',
      runId,
      rank: 1,
      role: 'primary',
      refillRound: 0,
      title: '模型工具调用速度升级',
      category: '开发工具',
      entity: 'OpenAI',
      score: 8.9,
      publicAppeal: 8.5,
      reason: '日常实用更新',
      articleIds: ['art-web-1'],
    },
  ]);

  core.context.repos.runItems.createMany([
    {
      id: 'item-web-1',
      runId,
      eventId: 'ev-web-1',
      position: 1,
      status: 'passed',
      revision: 0,
      dropReason: null,
      finalJson: {
        title: '模型工具调用速度升级',
        shortTitle: '工具调用提速',
        category: '开发工具',
        entity: 'OpenAI',
        summary: '工具调用响应延迟显著下降。',
        keyPoints: ['延迟降低一半'],
        detail: '开发者无需改动现有代码即可体验更快响应。',
        hostComment: '体验提升明显。',
        narration: ['今天来看工具调用提速消息。'],
        evidence: [
          {
            claim: '工具调用更快',
            articleId: 'art-web-1',
            quote: 'Faster tool execution.',
          },
        ],
      },
      updatedAt: nowIso,
    },
  ]);

  const pkgData: IssuePackage = {
    order: ['item-web-1'],
    headlineItemId: 'item-web-1',
    headline: '模型工具调用速度升级',
    leadSummary: '本期关注开发工具响应提速。',
    intro: { narration: ['大家好，欢迎收看 AI 每日报。'], hostComment: '来看重点。' },
    outro: {
      narration: ['感谢收看，明天见。'],
      hostComment: '下期再会。',
      cta: '欢迎点赞关注。',
    },
    publish: {
      title: 'AI每日报｜模型工具调用速度升级',
      descriptionIntro: '今日焦点资讯速览。',
      tags: ['AI', 'OpenAI'],
    },
  };

  const timeline: Timeline = {
    totalMs: 12_000,
    sections: [
      {
        key: 'intro',
        kind: 'intro',
        audioFile: 'audio/intro.wav',
        startMs: 0,
        speechMs: 3000,
        pageMs: 4000,
        sentences: [],
      },
      {
        key: 'item-01',
        kind: 'item',
        itemId: 'item-web-1',
        audioFile: 'audio/item-01.wav',
        startMs: 4000,
        speechMs: 7000,
        pageMs: 8000,
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

  return { runId, mp4Bytes: new Uint8Array(mp4Bytes) };
}

describe('apps/web routes and Server Actions', () => {
  it('serves artifact MP4 full stream, HTTP Range slices (206), 416 invalid range, 403 traversal, and 404 missing', async () => {
    const rootDir = await setupWebTestWorkspace();
    const { runId, mp4Bytes: expectedBytes } = await seedReviewReadyRun();
    const fullText = Buffer.from(expectedBytes).toString('utf8');

    const fullRes = await getArtifactRoute(
      new Request(`http://127.0.0.1:3000/api/runs/${runId}/artifacts/output/video.mp4`),
      { params: Promise.resolve({ id: runId, path: ['output', 'video.mp4'] }) },
    );
    expect(fullRes.status).toBe(200);
    expect(fullRes.headers.get('content-type')).toBe('video/mp4');
    expect(fullRes.headers.get('accept-ranges')).toBe('bytes');
    expect(fullRes.headers.get('content-length')).toBe(String(expectedBytes.byteLength));
    expect(await fullRes.text()).toBe(fullText);

    const prefixRes = await getArtifactRoute(
      new Request(`http://127.0.0.1:3000/api/runs/${runId}/artifacts/output/video.mp4`, {
        headers: { Range: 'bytes=0-15' },
      }),
      { params: Promise.resolve({ id: runId, path: ['output', 'video.mp4'] }) },
    );
    expect(prefixRes.status).toBe(206);
    expect(prefixRes.headers.get('content-range')).toBe(`bytes 0-15/${expectedBytes.byteLength}`);
    expect(await prefixRes.text()).toBe(fullText.slice(0, 16));

    const openEndRes = await getArtifactRoute(
      new Request(`http://127.0.0.1:3000/api/runs/${runId}/artifacts/output/video.mp4`, {
        headers: { Range: 'bytes=16-' },
      }),
      { params: Promise.resolve({ id: runId, path: ['output', 'video.mp4'] }) },
    );
    expect(openEndRes.status).toBe(206);
    expect(await openEndRes.text()).toBe(fullText.slice(16));

    const suffixRes = await getArtifactRoute(
      new Request(`http://127.0.0.1:3000/api/runs/${runId}/artifacts/output/video.mp4`, {
        headers: { Range: 'bytes=-8' },
      }),
      { params: Promise.resolve({ id: runId, path: ['output', 'video.mp4'] }) },
    );
    expect(suffixRes.status).toBe(206);
    expect(await suffixRes.text()).toBe(fullText.slice(-8));

    const outOfBoundsRes = await getArtifactRoute(
      new Request(`http://127.0.0.1:3000/api/runs/${runId}/artifacts/output/video.mp4`, {
        headers: { Range: 'bytes=9999-10000' },
      }),
      { params: Promise.resolve({ id: runId, path: ['output', 'video.mp4'] }) },
    );
    expect(outOfBoundsRes.status).toBe(416);

    const badRangeRes = await getArtifactRoute(
      new Request(`http://127.0.0.1:3000/api/runs/${runId}/artifacts/output/video.mp4`, {
        headers: { Range: 'bytes=abc-def' },
      }),
      { params: Promise.resolve({ id: runId, path: ['output', 'video.mp4'] }) },
    );
    expect(badRangeRes.status).toBe(416);

    const traversalRes = await getArtifactRoute(
      new Request(`http://127.0.0.1:3000/api/runs/${runId}/artifacts/../../state.sqlite`),
      { params: Promise.resolve({ id: runId, path: ['..', '..', 'state.sqlite'] }) },
    );
    expect(traversalRes.status).toBe(403);

    const badIdRes = await getArtifactRoute(
      new Request('http://127.0.0.1:3000/api/runs/../artifacts/state.sqlite'),
      { params: Promise.resolve({ id: '..', path: ['state.sqlite'] }) },
    );
    expect(badIdRes.status).toBe(403);

    const multipartRangeRes = await getArtifactRoute(
      new Request(`http://127.0.0.1:3000/api/runs/${runId}/artifacts/output/video.mp4`, {
        headers: { Range: 'bytes=0-1, 8-9' },
      }),
      { params: Promise.resolve({ id: runId, path: ['output', 'video.mp4'] }) },
    );
    expect(multipartRangeRes.status).toBe(200);
    expect(await multipartRangeRes.text()).toBe(fullText);

    const symlinkTarget = path.join(rootDir, 'storage', 'runs', runId, 'output', 'video.mp4');
    const symlinkPath = path.join(rootDir, 'storage', 'runs', runId, 'output', 'sym.mp4');
    await fs.symlink(symlinkTarget, symlinkPath);
    const symlinkRes = await getArtifactRoute(
      new Request(`http://127.0.0.1:3000/api/runs/${runId}/artifacts/output/sym.mp4`),
      { params: Promise.resolve({ id: runId, path: ['output', 'sym.mp4'] }) },
    );
    expect(symlinkRes.status).toBe(403);

    const missingRes = await getArtifactRoute(
      new Request(`http://127.0.0.1:3000/api/runs/${runId}/artifacts/output/nope.mp4`),
      { params: Promise.resolve({ id: runId, path: ['output', 'nope.mp4'] }) },
    );
    expect(missingRes.status).toBe(404);
  });

  it('opens idle SSE streams immediately, streams new events, and resumes from Last-Event-ID', async () => {
    await setupWebTestWorkspace();
    const core = await getCore();
    const runId = createRun(core.context, {
      itemCount: 2,
      trigger: 'manual-web',
    });

    const ev1Id = emitRunEvent(core.context, {
      runId,
      level: 'info',
      stage: 'collect',
      type: 'stage_started',
      message: '开始抓取信源',
    });
    core.context.repos.runs.updateStatus(runId, 'running', { currentStage: 'collect' });
    const eventsUrl = `http://127.0.0.1:3000/api/runs/${runId}/events`;
    const params = Promise.resolve({ id: runId });
    const activeSseRes = await getEventsRoute(
      new Request(`${eventsUrl}?afterId=${ev1Id}`, { signal: AbortSignal.timeout(2_000) }),
      { params },
    );
    expect(activeSseRes.status).toBe(200);
    const reader = activeSseRes.body?.getReader();
    if (!reader) {
      throw new Error('实时日志响应缺少可读取的数据流');
    }
    const decoder = new TextDecoder();
    let ev2Id: number;
    try {
      const firstChunk = await reader.read();
      expect(firstChunk.done).toBe(false);
      expect(decoder.decode(firstChunk.value)).toBe(': connected\n\n');
      expect(activeSseRes.headers.get('x-accel-buffering')).toBe('no');

      ev2Id = emitRunEvent(core.context, {
        runId,
        level: 'warn',
        stage: 'collect',
        type: 'source_collect_failed',
        message: '单个源超时已跳过',
      });
      const nextChunk = decoder.decode((await reader.read()).value);
      expect(nextChunk).toContain(`id: ${ev2Id}\nevent: run_event\n`);
      expect(nextChunk).toContain('单个源超时已跳过');
    } finally {
      await reader.cancel();
    }
    const ev3Id = emitRunEvent(core.context, {
      runId,
      level: 'error',
      stage: 'collect',
      type: 'stage_failed',
      message: '全部信源抓取失败',
    });
    core.context.repos.runs.updateStatus(runId, 'failed', {
      currentStage: 'collect',
      errorCode: 'collect_all_failed',
      error: '全部抓取失败',
    });

    const fullSseRes = await getEventsRoute(new Request(eventsUrl), { params });
    expect(fullSseRes.status).toBe(200);
    expect(fullSseRes.headers.get('content-type')).toContain('text/event-stream');
    const fullBody = await fullSseRes.text();
    expect(fullBody).toContain(`id: ${ev1Id}`);
    expect(fullBody).toContain(`id: ${ev2Id}`);
    expect(fullBody).toContain(`id: ${ev3Id}`);
    expect(fullBody).toContain(': done');

    const resumedSseRes = await getEventsRoute(
      new Request(`${eventsUrl}?afterId=${ev1Id}`, {
        headers: { 'Last-Event-ID': String(ev2Id) },
      }),
      { params },
    );
    expect(resumedSseRes.status).toBe(200);
    const resumedBody = await resumedSseRes.text();
    expect(resumedBody).not.toContain(`id: ${ev1Id}\n`);
    expect(resumedBody).not.toContain(`id: ${ev2Id}\n`);
    expect(resumedBody).toContain(`id: ${ev3Id}\n`);

    const badCursorRes = await getEventsRoute(
      new Request(`http://127.0.0.1:3000/api/runs/${runId}/events?afterId=abc`),
      { params: Promise.resolve({ id: runId }) },
    );
    expect(badCursorRes.status).toBe(400);

    const unsafeCursorRes = await getEventsRoute(
      new Request(`http://127.0.0.1:3000/api/runs/${runId}/events?afterId=9007199254740993`),
      { params: Promise.resolve({ id: runId }) },
    );
    expect(unsafeCursorRes.status).toBe(400);

    const notFoundRes = await getEventsRoute(
      new Request('http://127.0.0.1:3000/api/runs/unknown-run/events'),
      { params: Promise.resolve({ id: 'unknown-run' }) },
    );
    expect(notFoundRes.status).toBe(404);
  });

  it('manages named API connections and stores credentials without putting keys in settings or snapshots', async () => {
    const root = await setupWebTestWorkspace();
    const core = await getCore();
    expect(core.system.getModelRoutes()).not.toContain('deepseek');

    const originalKey = 'fixture-gateway-key-a';
    const replacementKey = 'fixture-gateway-key-b';
    const saves = await Promise.all([
      saveModelApiConnectionAction(apiConnectionForm(' 团队网关 ', { apiKey: originalKey })),
      saveModelApiConnectionAction(apiConnectionForm('团队网关')),
    ]);
    expect(saves).toEqual([
      expect.objectContaining({ ok: true }),
      expect.objectContaining({ ok: false, error: expect.stringContaining('已存在') }),
    ]);
    expect(await saveModelApiConnectionAction(apiConnectionForm('CoDeX'))).toMatchObject({
      ok: false,
      error: expect.stringContaining('已存在'),
    });
    expect(
      await saveModelApiConnectionAction(
        apiConnectionForm('备用网关', {
          protocol: 'responses',
          baseUrl: 'http://127.0.0.1:8080/v1',
        }),
      ),
    ).toMatchObject({ ok: true });
    expect(core.system.getModelRoutes()).toEqual(expect.arrayContaining(['团队网关', '备用网关']));

    const secrets = core.context.paths.secretsDir;
    const settingsFile = path.join(root, 'config', 'settings.yaml');
    const first = core.config.getSettings().ai.providers?.['团队网关'];
    const firstKeyPath = path.join(secrets, first?.apiKeyFile ?? '');
    expect(await fs.readFile(firstKeyPath, 'utf8')).toBe(originalKey);
    expect((await fs.stat(firstKeyPath)).mode & 0o777).toBe(0o600);
    expect(await fs.readFile(settingsFile, 'utf8')).not.toContain(originalKey);

    const { maxConcurrentCalls, stages } = core.config.getSettings().ai;
    await core.config.updateStageRouting({
      maxConcurrentCalls,
      stages: {
        ...stages,
        select: { ...stages.select, cli: '团队网关', model: 'manual-model-id' },
      },
    });
    const runId = createRun(core.context, { itemCount: 1, trigger: 'manual-web' });
    const snapshot = core.context.repos.runs.getById(runId)?.configSnapshotJson ?? '';
    expect(snapshot).toContain(first?.apiKeyFile);
    expect(snapshot).not.toContain(originalKey);

    expect(await removeModelApiConnectionAction(apiConnectionForm('团队网关'))).toMatchObject({
      ok: false,
      error: expect.stringContaining('正在使用'),
    });
    const changedOrigin = { previousName: '团队网关', baseUrl: 'https://other-gateway.test/v1' };
    expect(
      await saveModelApiConnectionAction(apiConnectionForm('新网关', changedOrigin)),
    ).toMatchObject({
      ok: false,
      error: expect.stringContaining('新密钥'),
    });
    expect(
      await saveModelApiConnectionAction(
        apiConnectionForm('新网关', {
          ...changedOrigin,
          apiKey: replacementKey,
        }),
      ),
    ).toMatchObject({ ok: true });

    const updated = core.config.getSettings().ai;
    expect(updated.stages.select).toMatchObject({ cli: '新网关', model: 'manual-model-id' });
    expect(core.system.getModelRoutes()).not.toContain('团队网关');
    const nextKeyPath = path.join(secrets, updated.providers?.['新网关']?.apiKeyFile ?? '');
    expect(nextKeyPath).not.toBe(firstKeyPath);
    expect(await fs.readFile(firstKeyPath, 'utf8')).toBe(originalKey);
    expect(await fs.readFile(nextKeyPath, 'utf8')).toBe(replacementKey);
    expect(await fs.readFile(settingsFile, 'utf8')).not.toContain(replacementKey);
    expect(core.context.repos.runs.getById(runId)?.configSnapshotJson).toBe(snapshot);

    expect(
      await saveModelApiConnectionAction(
        apiConnectionForm('新网关', {
          previousName: '新网关',
          baseUrl: changedOrigin.baseUrl,
          clearApiKey: 'on',
        }),
      ),
    ).toMatchObject({ ok: true });
    expect(core.config.getSettings().ai.providers?.['新网关']?.apiKeyFile).toBeUndefined();
    expect(await removeModelApiConnectionAction(apiConnectionForm('备用网关'))).toMatchObject({
      ok: true,
    });
    expect(core.system.getModelRoutes()).not.toContain('备用网关');
  });

  it('enforces explicit itemCount/time without defaults, dynamic stage model routing, and draft bounds in Server Actions', async () => {
    await setupWebTestWorkspace();

    for (const badCount of ['', '0', '-2']) {
      const fd = new FormData();
      fd.set('itemCount', badCount);
      const res = await startRunAction(fd);
      expect(res.ok).toBe(false);
    }

    const missingTimeFd = new FormData();
    missingTimeFd.set('time', '');
    missingTimeFd.set('itemCount', '5');
    expect((await createScheduleAction(missingTimeFd)).ok).toBe(false);

    const missingScheduleCountFd = new FormData();
    missingScheduleCountFd.set('time', '08:30');
    missingScheduleCountFd.set('itemCount', '');
    expect((await createScheduleAction(missingScheduleCountFd)).ok).toBe(false);

    const blankRetriesFd = new FormData();
    for (const key of ['select', 'summarize', 'polish', 'factcheck', 'package']) {
      blankRetriesFd.set(`stage_${key}_cli`, 'agy');
      blankRetriesFd.set(`stage_${key}_model`, 'gemini-2.5-pro');
      blankRetriesFd.set(`stage_${key}_timeoutSec`, '120');
      blankRetriesFd.set(`stage_${key}_retries`, key === 'polish' ? '' : '1');
    }
    blankRetriesFd.set('maxConcurrentCalls', '2');
    expect((await updateStageRoutingAction(blankRetriesFd)).ok).toBe(false);

    const sciNotationFd = new FormData();
    for (const key of ['select', 'summarize', 'polish', 'factcheck', 'package']) {
      sciNotationFd.set(`stage_${key}_cli`, 'agy');
      sciNotationFd.set(`stage_${key}_model`, 'gemini-2.5-pro');
      sciNotationFd.set(`stage_${key}_timeoutSec`, key === 'select' ? '1e2' : '120');
      sciNotationFd.set(`stage_${key}_retries`, '0');
    }
    sciNotationFd.set('maxConcurrentCalls', '2');
    expect((await updateStageRoutingAction(sciNotationFd)).ok).toBe(false);

    const unknownCliFd = new FormData();
    for (const key of ['select', 'summarize', 'polish', 'factcheck', 'package']) {
      unknownCliFd.set(`stage_${key}_cli`, key === 'select' ? 'unknown-cli' : 'agy');
      unknownCliFd.set(`stage_${key}_model`, 'gemini-2.5-pro');
      unknownCliFd.set(`stage_${key}_timeoutSec`, '120');
      unknownCliFd.set(`stage_${key}_retries`, '0');
    }
    unknownCliFd.set('maxConcurrentCalls', '2');
    expect((await updateStageRoutingAction(unknownCliFd)).ok).toBe(false);

    expect(await saveModelApiConnectionAction(apiConnectionForm('编辑网关'))).toMatchObject({
      ok: true,
    });
    const validRoutingFd = new FormData();
    for (const key of ['select', 'summarize', 'polish', 'factcheck', 'package']) {
      validRoutingFd.set(`stage_${key}_cli`, key === 'select' ? '编辑网关' : 'agy');
      validRoutingFd.set(
        `stage_${key}_model`,
        key === 'select'
          ? 'gateway/editor-model'
          : key === 'polish'
            ? 'claude-sonnet-4-5'
            : 'gemini-2.5-pro',
      );
      validRoutingFd.set(`stage_${key}_timeoutSec`, '150');
      validRoutingFd.set(`stage_${key}_retries`, '0');
    }
    validRoutingFd.set('maxConcurrentCalls', '3');
    const routeRes = await updateStageRoutingAction(validRoutingFd);
    expect(routeRes.ok).toBe(true);

    const core = await getCore();
    expect(core.config.getSettings().ai.stages.select).toMatchObject({
      cli: '编辑网关',
      model: 'gateway/editor-model',
    });
    expect(core.config.getSettings().ai.stages.polish.model).toBe('claude-sonnet-4-5');
    expect(core.config.getSettings().ai.stages.polish.retries).toBe(0);

    const { runId: draftRunId } = await seedReviewReadyRun();
    const validDraftFd = new FormData();
    validDraftFd.set('runId', draftRunId);
    validDraftFd.set('title', 'AI每日报｜更新后的审核标题');
    validDraftFd.set('description', '人工复核后的视频简介正文\n本视频由 AI 辅助生成');
    validDraftFd.set('tags', 'AI, 科技资讯, 人工智能');
    const draftOk = await updateDraftAction(validDraftFd);
    expect(draftOk.ok).toBe(true);
    const updatedDraft = await core.publish.getDraft(draftRunId);
    expect(updatedDraft.title).toBe('AI每日报｜更新后的审核标题');

    const overlongDraftFd = new FormData();
    overlongDraftFd.set('runId', draftRunId);
    overlongDraftFd.set(
      'title',
      '超'.repeat(core.config.getSettings().publish.bilibili.titleMax + 5),
    );
    overlongDraftFd.set('description', '简介');
    overlongDraftFd.set('tags', 'AI');
    const draftTooLong = await updateDraftAction(overlongDraftFd);
    expect(draftTooLong.ok).toBe(false);
  });
});
