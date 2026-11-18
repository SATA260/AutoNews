import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import {
  PolishedItemSchema,
  ScheduleTimeSchema,
  SettingsSchema,
  SourcesFileSchema,
  TimelineSchema,
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
