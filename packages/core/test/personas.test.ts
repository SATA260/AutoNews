import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { type EventRecord, PersonasFileSchema } from '@aidaily/contracts';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { chooseHost } from '../src/editorial/personas.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

/** 创建用于选角测试的新闻事件。 */
function event(entity: string, category: string): EventRecord {
  return {
    id: entity,
    runId: 'run',
    rank: 1,
    role: 'primary',
    title: entity,
    articleIds: ['article'],
    category,
    entity,
    score: 9,
    publicAppeal: 9,
    reason: '重要',
    refillRound: 0,
  };
}

describe('主播配置与选择', () => {
  it('验证四位主播配置，并按阵营和话题选择主播', async () => {
    const personas = PersonasFileSchema.parse(
      parse(await fs.readFile(path.join(root, 'config/personas.yaml'), 'utf8')),
    ).personas;
    expect(chooseHost([event('OpenAI', '产品'), event('Anthropic', '编程')], personas, null)).toBe(
      'gpt',
    );
    expect(chooseHost([event('第三方', '多模态硬件')], personas, null)).toBe('gemini');
    expect(
      chooseHost([{ ...event('第三方', '新闻'), title: 'OpenAI 发布新模型' }], personas, null),
    ).toBe('gpt');
    expect(
      chooseHost(
        [
          { ...event('OpenAI', '新闻'), title: 'OpenAI 更新' },
          { ...event('Anthropic', '多模态'), title: 'Anthropic 更新' },
          { ...event('Anthropic', '多模态'), title: 'Anthropic 发布视频模型' },
        ],
        personas,
        null,
      ),
    ).not.toBe('gemini');
    expect(chooseHost([event('第三方', '新闻')], personas, 'gpt')).not.toBe('gpt');
    expect(() =>
      PersonasFileSchema.parse({ personas: [personas[0], personas[0], personas[1], personas[2]] }),
    ).toThrow();
  });
});
