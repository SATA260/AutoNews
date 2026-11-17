import fs from 'node:fs/promises';
import path from 'node:path';
import {
  type EventRecord,
  type HostMascotId,
  type PersonaProfile,
  PersonasFileSchema,
} from '@aidaily/contracts';
import { parse } from 'yaml';
import type { CoreContext } from '../context.js';

/** 加载并校验主播配置；旧项目没有配置时保留原有行为。 */
export async function loadPersonas(ctx: CoreContext): Promise<PersonaProfile[]> {
  try {
    const text = await fs.readFile(path.join(ctx.paths.rootDir, 'config', 'personas.yaml'), 'utf8');
    return PersonasFileSchema.parse(parse(text)).personas;
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code === 'ENOENT' &&
      ctx.settings.issue.minScore === undefined
    )
      return [];
    throw error;
  }
}

/** 根据事件阵营与话题计算主播，并在同分时优先避开上一期。 */
export function chooseHost(
  events: readonly EventRecord[],
  personas: readonly PersonaProfile[],
  previous: string | null,
): HostMascotId | null {
  if (!events.length || !personas.length) return null;
  const candidates = personas.map((persona) => {
    let camp = 0;
    let topic = 0;
    events.forEach((event, index) => {
      const text = `${event.entity ?? ''} ${event.title}`.toLowerCase();
      if (persona.campKeywords.some((keyword) => text.includes(keyword.toLowerCase())))
        camp += index === 0 ? 2 : 1;
      if (
        persona.topicKeywords.some((keyword) =>
          `${text} ${event.category ?? ''}`.toLowerCase().includes(keyword.toLowerCase()),
        )
      )
        topic += index === 0 ? 2 : 1;
    });
    return { persona, camp, topic };
  });
  const highestCamp = Math.max(...candidates.map((candidate) => candidate.camp));
  const leaders = candidates.filter((candidate) => candidate.camp === highestCamp);
  if (highestCamp > 0 && leaders.length === 1) return leaders[0]?.persona.id ?? null;
  const pool = highestCamp > 0 ? leaders : candidates;
  const bestTopic = Math.max(...pool.map((candidate) => candidate.topic));
  const alternative = pool.filter(
    (candidate) => candidate.persona.id !== previous && candidate.topic >= bestTopic - 1,
  );
  const eligible = alternative.length ? alternative : pool;
  eligible.sort((a, b) => b.topic - a.topic);
  return eligible[0]?.persona.id ?? null;
}

/** 读取本期主播的人设资料，供写稿与编排使用。 */
export async function getRunPersona(
  ctx: CoreContext,
  runId: string,
): Promise<PersonaProfile | null> {
  const row = ctx.db.prepare('SELECT host_id FROM runs WHERE id = ?').get(runId) as
    | { host_id: string | null }
    | undefined;
  if (!row?.host_id) return null;
  return (await loadPersonas(ctx)).find((persona) => persona.id === row.host_id) ?? null;
}

/** 判断新闻主体与本期主播属于同一家、其他主播阵营或第三方。 */
export async function describePersonaRelation(
  ctx: CoreContext,
  runId: string,
  itemId: string,
): Promise<string> {
  const persona = await getRunPersona(ctx, runId);
  const item = ctx.repos.runItems.getById(itemId);
  const event = item
    ? ctx.repos.events.listByRun(runId).find((entry) => entry.id === item.eventId)
    : undefined;
  if (!persona || !event) return '未指定主播或新闻主体';
  const subject = `${event.entity ?? ''} ${event.title}`.toLowerCase();
  const matched = (await loadPersonas(ctx)).filter((profile) =>
    profile.campKeywords.some((keyword) => subject.includes(keyword.toLowerCase())),
  );
  const relation = matched.some((profile) => profile.id === persona.id)
    ? '自家'
    : matched.length
      ? '友商'
      : '第三方';
  return `主播：${persona.displayName}；新闻主体：${event.entity ?? event.title}；关系：${relation}。`;
}
