import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import {
  ModelApiProviderSchema,
  PolishedItemSchema,
  RETRYABLE_RUN_STATUSES,
  RunStatusSchema,
  ScheduleJobSchema,
  ScheduleTimeSchema,
  SelectedEventCandidateSchema,
  SelectionResultSchema,
  SettingsSchema,
  SourcesFileSchema,
  TimelineSchema,
  UpdateSectionNarrationInputSchema,
  zodToJsonSchema,
} from '../src/index.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

describe('@aidaily/contracts', () => {
  it('validates config/settings.yaml and ensures no default itemCount or schedule', () => {
    const raw = fs.readFileSync(path.join(REPO_ROOT, 'config', 'settings.yaml'), 'utf8');
    const parsed = SettingsSchema.parse(parse(raw));
    expect(parsed.version).toBe(1);
    expect(Object.keys(parsed.tts.providers)).toContain(parsed.tts.provider);
    expect(parsed.tts.providers.indextts).toBeDefined();
    expect(parsed.tts.providers['qwen-local']).toBeDefined();
    expect(parsed.issue.minScore).toBe(7.5);
    expect(parsed.publish.bilibili.aiDeclaration).toBe(true);
    expect(parsed.tts.pauseAfterNarrate).toBe(false);
    expect(RETRYABLE_RUN_STATUSES).toEqual([
      'failed',
      'cancelled',
      'interrupted',
      'awaiting_audio_review',
      'awaiting_review',
      'rejected',
      'publish_failed',
      'published',
    ]);
    expect(RunStatusSchema.safeParse('awaiting_audio_review').success).toBe(true);
    expect(RunStatusSchema.safeParse('published').success).toBe(true);
    expect('itemCount' in parsed.issue).toBe(false);
    expect('schedule' in parsed).toBe(false);
    expect(parsed.editorial.titleSimilarityThreshold).toBeUndefined();

    const legacySnapshot = {
      ...parsed,
      editorial: {
        ...parsed.editorial,
        titleSimilarityThreshold: 0.6,
      },
    };
    expect(SettingsSchema.parse(legacySnapshot).editorial.titleSimilarityThreshold).toBe(0.6);
  });

  it('validates config/sources.yaml across rss, html-list, and x-timeline sources', () => {
    const raw = fs.readFileSync(path.join(REPO_ROOT, 'config', 'sources.yaml'), 'utf8');
    const parsed = SourcesFileSchema.parse(parse(raw));
    expect(parsed.sources.length).toBeGreaterThanOrEqual(35);
    expect(parsed.sources.some((s) => s.lang === 'zh')).toBe(true);
    expect(parsed.sources.some((s) => s.lang === 'en')).toBe(true);
    expect(parsed.sources.some((s) => s.kind === 'rss')).toBe(true);
    expect(parsed.sources.some((s) => s.kind === 'html-list')).toBe(true);
    expect(parsed.sources.some((s) => s.kind === 'x-timeline')).toBe(true);
  });

  it('backfills collector defaults and supports dual-image / schedule cutoff schemas', () => {
    const rawSettings = fs.readFileSync(path.join(REPO_ROOT, 'config', 'settings.yaml'), 'utf8');
    const withoutCollector = parse(rawSettings) as Record<string, unknown>;
    delete withoutCollector.collector;
    const settingsParsed = SettingsSchema.parse(withoutCollector);
    expect(settingsParsed.collector.captureWebTables).toBe(true);
    expect(settingsParsed.collector.captureTweetScreenshots).toBe(true);

    const scheduleParsed = ScheduleJobSchema.parse({
      id: 'sched-1',
      name: '每日早报',
      time: '08:30',
      itemCount: 5,
      cutoffMode: 'hours',
      maxAgeHours: 24,
      enabled: true,
      installed: false,
      lastRunId: null,
      lastTriggeredAt: null,
      nextRunAt: null,
      createdAt: '2026-11-16T00:00:00.000Z',
      updatedAt: '2026-11-16T00:00:00.000Z',
    });
    expect(scheduleParsed.cutoffMode).toBe('hours');
    expect(scheduleParsed.maxAgeHours).toBe(24);

    const polishedParsed = PolishedItemSchema.parse({
      title: '测试标题',
      shortTitle: '测试短题',
      progressLabel: '模型进展',
      category: '大模型',
      entity: 'OpenAI',
      summary: '摘要说明',
      primaryMediaId: 'art1-img0',
      secondaryMediaId: 'art1-tbl0',
      imageCaption: '来自官方发布页与评测基准表的实测跑分对比结果记录图',
      keyPoints: ['要点一'],
      detail: '详细说明',
      hostComment: '点评',
      narration: ['第一句测试。'],
      evidence: [{ claim: '事实', articleId: 'art-1', quote: '原文' }],
    });
    expect(polishedParsed.primaryMediaId).toBe('art1-img0');
    expect(polishedParsed.secondaryMediaId).toBe('art1-tbl0');
  });

  it('enforces ScheduleTimeSchema HH:mm boundaries', () => {
    expect(ScheduleTimeSchema.safeParse('08:30').success).toBe(true);
    expect(ScheduleTimeSchema.safeParse('23:59').success).toBe(true);
    expect(ScheduleTimeSchema.safeParse('24:00').success).toBe(false);
    expect(ScheduleTimeSchema.safeParse('8:30').success).toBe(false);
  });

  it('converts schemas to Draft-07 JSON Schema without unsupported constraint keywords', () => {
    const jsonSchema = zodToJsonSchema(PolishedItemSchema);
    expect(jsonSchema.$schema).toBeUndefined();
    expect(jsonSchema.additionalProperties).toBeUndefined();
    expect(jsonSchema.type).toBe('object');
    expect(jsonSchema.properties).toBeDefined();
    const serialized = JSON.stringify(jsonSchema);
    expect(serialized).not.toContain('minLength');
    expect(serialized).not.toContain('maxLength');
    expect(serialized).not.toContain('maxItems');
    expect(serialized).not.toContain('additionalProperties');
  });

  it('keeps selection scores and article ids representable when building a model schema', () => {
    const jsonSchema = zodToJsonSchema(SelectionResultSchema);
    const events = (
      jsonSchema.properties as {
        events: { type: string; items: { properties: Record<string, { type?: string }> } };
      }
    ).events;
    expect(events.type).toBe('array');
    expect(events.items.properties.score?.type).toBe('number');
    expect(events.items.properties.publicAppeal?.type).toBe('number');
    expect(events.items.properties.articleIds?.type).toBe('array');
  });

  it('accepts separate speech and subtitle text and does not regenerate audio unless asked', () => {
    const parsed = UpdateSectionNarrationInputSchema.parse({
      ttsText: ' 欢迎收看。 ',
      subtitleText: '欢迎收看今天的节目。',
    });
    expect(parsed).toEqual({
      ttsText: '欢迎收看。',
      subtitleText: '欢迎收看今天的节目。',
      regenerateAudio: false,
    });
    expect(
      UpdateSectionNarrationInputSchema.safeParse({ ttsText: '   ', subtitleText: '字幕' }).success,
    ).toBe(false);
    expect(
      UpdateSectionNarrationInputSchema.safeParse({
        ttsText: '语音',
        subtitleText: '字幕',
        regenerateAudio: false,
        provider: 'qwen-local',
      }).data,
    ).toMatchObject({ regenerateAudio: false, provider: 'qwen-local' });
  });

  it('folds hundred-point selection scores back into the 1 to 10 scale', () => {
    const parsed = SelectionResultSchema.parse({
      events: [
        {
          title: '英伟达停止向中国销售芯片',
          articleIds: 'art-1',
          category: '芯片',
          entity: '英伟达',
          score: 95,
          publicAppeal: 80,
          reason: '影响算力供应',
          duplicateOfHistory: false,
        },
      ],
    });
    expect(parsed.events[0]).toMatchObject({
      articleIds: ['art-1'],
      score: 9.5,
      publicAppeal: 8,
    });
    const slightlyOver = SelectedEventCandidateSchema.parse({
      title: '略微超分',
      articleIds: ['art-2'],
      category: '产品',
      entity: 'OpenAI',
      score: 10.4,
      publicAppeal: 11,
      reason: '刚刚超出上限',
      duplicateOfHistory: false,
    });
    expect(slightlyOver.score).toBe(10);
    expect(slightlyOver.publicAppeal).toBe(10);
  });

  it('validates TimelineSchema', () => {
    const parsed = TimelineSchema.parse({
      totalMs: 12000,
      sections: [
        {
          key: 'intro',
          kind: 'intro',
          audioFile: 'audio/intro.wav',
          startMs: 0,
          speechMs: 4400,
          pageMs: 5000,
          sentences: [{ text: '欢迎来到本期 AI 每日报。', startMs: 0, durationMs: 4400 }],
        },
      ],
    });
    expect(parsed.totalMs).toBe(12000);
  });

  it('blocks private, loopback, and metadata URLs in ModelApiProviderSchema by default', () => {
    const prev = process.env.AIDAILY_ALLOW_LOCAL_MODEL_API;
    delete process.env.AIDAILY_ALLOW_LOCAL_MODEL_API;
    try {
      const blockedByDefault = [
        'http://127.0.0.1:8080/v1',
        'http://localhost:11434/v1',
        'http://[::1]:11434/v1',
        'http://[::ffff:127.0.0.1]:8080/v1',
        'http://169.254.169.254/latest/meta-data',
        'http://metadata.google.internal/v1',
        'http://100.100.100.200/latest/meta-data',
        'http://[fd00:ec2::254]/v1',
        'http://10.0.0.5:8080/v1',
        'http://172.16.10.1:8080/v1',
        'http://192.168.1.2:8080/v1',
      ];
      for (const baseUrl of blockedByDefault) {
        expect(
          ModelApiProviderSchema.safeParse({
            adapter: 'openai-compatible',
            protocol: 'chat-completions',
            baseUrl,
          }).success,
        ).toBe(false);
      }

      process.env.AIDAILY_ALLOW_LOCAL_MODEL_API = '1';
      // 显式允许本机回环时放行 localhost/127.0.0.1，但云元数据与局域私网仍必须严格拦截
      expect(
        ModelApiProviderSchema.safeParse({
          adapter: 'openai-compatible',
          protocol: 'chat-completions',
          baseUrl: 'http://127.0.0.1:11434/v1',
        }).success,
      ).toBe(true);
      expect(
        ModelApiProviderSchema.safeParse({
          adapter: 'openai-compatible',
          protocol: 'chat-completions',
          baseUrl: 'http://169.254.169.254/latest/meta-data',
        }).success,
      ).toBe(false);
      expect(
        ModelApiProviderSchema.safeParse({
          adapter: 'openai-compatible',
          protocol: 'chat-completions',
          baseUrl: 'http://10.0.0.5:8080/v1',
        }).success,
      ).toBe(false);
    } finally {
      if (prev === undefined) {
        delete process.env.AIDAILY_ALLOW_LOCAL_MODEL_API;
      } else {
        process.env.AIDAILY_ALLOW_LOCAL_MODEL_API = prev;
      }
    }
  });
});
