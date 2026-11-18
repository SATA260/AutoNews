import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import {
  PolishedItemSchema,
  RETRYABLE_RUN_STATUSES,
  RunStatusSchema,
  ScheduleTimeSchema,
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
  });

  it('validates config/sources.yaml', () => {
    const raw = fs.readFileSync(path.join(REPO_ROOT, 'config', 'sources.yaml'), 'utf8');
    const parsed = SourcesFileSchema.parse(parse(raw));
    expect(parsed.sources.length).toBeGreaterThanOrEqual(10);
    expect(parsed.sources.some((s) => s.lang === 'zh')).toBe(true);
    expect(parsed.sources.some((s) => s.lang === 'en')).toBe(true);
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
});
