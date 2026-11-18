import fs from 'node:fs/promises';
import path from 'node:path';
import {
  type EventRecord,
  type HostMascotId,
  type MascotMood,
  type PersonaProfile,
  PersonasFileSchema,
} from '@aidaily/contracts';
import { parse } from 'yaml';
import type { CoreContext } from '../context.js';

const UNCONFIRMED_RUMOR_PATTERN = /(猜测|传闻|未获官方确认|尚未确认|尚未证实|流传|爆料|疑似)/i;
const NEGATIVE_NEWS_PATTERN =
  /(限流|故障|致歉|差评|起诉|调查|裁撤|裁员|涨价|不能支付|受限|报错|困境|宕机)/i;

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

/** 判断新闻主体与本期主播属于自家（含好消息/负面争议/未证实传闻）、友商或第三方，返回自然人设语气引导。 */
export async function describePersonaRelation(
  ctx: CoreContext,
  runId: string,
  itemId: string,
  extraText?: string,
): Promise<string> {
  const persona = await getRunPersona(ctx, runId);
  const item = ctx.repos.runItems.getById(itemId);
  const event = item
    ? ctx.repos.events.listByRun(runId).find((entry) => entry.id === item.eventId)
    : undefined;
  if (!persona || !event) return '未指定主播或新闻主体';
  const subject = `${event.entity ?? ''} ${event.title} ${extraText ?? ''}`.toLowerCase();
  const personas = await loadPersonas(ctx);
  const matched = personas.filter((profile) =>
    profile.campKeywords.some((keyword) => subject.includes(keyword.toLowerCase())),
  );
  const isOwnCamp = matched.some((profile) => profile.id === persona.id);
  const isRivalCamp = !isOwnCamp && matched.length > 0;
  const fullText = `${event.title} ${extraText ?? ''}`;

  let relationLabel = '第三方行业动态';
  let reactionHint = persona.topicKeywords.some((keyword) =>
    `${subject} ${event.category ?? ''}`.toLowerCase().includes(keyword.toLowerCase()),
  )
    ? '该话题是你平时很感兴趣的领域，可按自身说话习惯利落播报，最多顺带半句极短反应，不强行加戏。'
    : '保持你日常干脆自然的真人口语把核心事实交代清楚即止，不要强行自报家门或硬加感慨。';

  if (isOwnCamp) {
    if (UNCONFIRMED_RUMOR_PATTERN.test(fullText)) {
      relationLabel = '自家相关未证实传闻';
      reactionHint = `你心里清楚这和${persona.affiliation}相关，但目前官方尚未确认；保持清醒客观播报传闻线索，并顺口自然点明官方还没确认，不替官方认领。`;
    } else if (NEGATIVE_NEWS_PATTERN.test(fullText)) {
      relationLabel = '自家受限或争议动态';
      reactionHint = persona.ownFlawReaction;
    } else {
      relationLabel = '自家好消息或新进展';
      reactionHint = persona.ownGoodReaction;
    }
  } else if (isRivalCamp) {
    relationLabel = '友商动态';
    reactionHint = persona.rivalReaction;
  }

  return [
    `主播自称：${persona.selfName}（内部身份认知归属：${persona.affiliation}）；新闻主体：${event.entity ?? event.title}；关系判定：${relationLabel}。`,
    `具体反应指引：${reactionHint}`,
    '约束提醒：通过自然口吻和态度流露角色感即可，不要生硬说出“我是某公司的”，且一切情绪反应必须严格建立在原文已核实事实之上，绝不脑补原文未提及的功能。',
  ].join('\n');
}

/** 根据新闻主体与当期主播的阵营归属及新闻正负向/技术议题属性，推导看板娘对应的表情状态 */
export function deriveMascotMood(
  hostId: HostMascotId | null | undefined,
  subjectText: string,
  personas: readonly PersonaProfile[],
): MascotMood {
  const lower = subjectText.toLowerCase();
  if (hostId && personas.length > 0) {
    const matched = personas.filter((profile) =>
      profile.campKeywords.some((keyword) => lower.includes(keyword.toLowerCase())),
    );
    if (matched.some((profile) => profile.id === hostId)) {
      if (NEGATIVE_NEWS_PATTERN.test(subjectText)) {
        return 'thinking';
      }
      return 'proud';
    }
    if (matched.length > 0) {
      return 'surprised';
    }
  }

  if (/(架构|推理|论文|评测|基准|代码|开源|benchmark|reasoning|agent)/i.test(subjectText)) {
    return 'thinking';
  }
  return 'neutral';
}
