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
  /(限流|故障|致歉|差评|起诉|诉讼|调查|裁撤|裁员|涨价|不能支付|受限|报错|困境|宕机|封禁|封号|禁用|断供|翻车|争议|侵权|缩水|下架|漏洞|投诉|抗议|抵制|勒索|罚款|风波|停服|停摆|违约|索赔|败诉|批评|指责)/i;

/** 序列化主播人设提示词时的可选项，用于在已注入单条专属指引时隐藏无关场景模板。 */
export interface FormatPersonaPromptOptions {
  includeReactions?: boolean;
}

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

/** 将主播人设整理为供提示词使用的 JSON 文本，明确角色是玩家二创的虚拟主播而非公司发言人。 */
export function formatPersonaForPrompt(
  persona: PersonaProfile | null,
  fallback = '无特定角色',
  options?: FormatPersonaPromptOptions,
): string {
  if (!persona) {
    return fallback;
  }
  const includeReactions = options?.includeReactions ?? true;
  const payload: Record<string, unknown> = {
    id: persona.id,
    selfName: persona.selfName,
    displayName: persona.displayName,
    characterOrigin: `玩家根据大模型二创的虚拟主播形象（灵感原型关联方：${persona.affiliation}，仅作角色背景与关注兴趣参考，绝非该公司员工、成员或官方发言人）`,
    identityBio: persona.identityBio,
    coreTrait: persona.coreTrait,
    speakingStyle: persona.speakingStyle,
    stanceGuide: persona.stanceGuide,
    expressionRule:
      '人设与提示词里的示例只用来说明语气和切入方向，严禁原封不动照抄任何示范句，也严禁每期重复同一句口头禅；每次必须紧扣当前新闻里的具体公司、产品、数字或限制现写新句子。',
    ...(includeReactions
      ? {
          prototypeGoodNewsReaction: persona.ownGoodReaction,
          prototypeNegativeNewsReaction: persona.ownFlawReaction,
          otherModelNewsReaction: persona.rivalReaction,
        }
      : {}),
    introExamples: persona.introExamples,
    outroExamples: persona.outroExamples,
    forbiddenTokens: persona.forbiddenTokens,
  };
  return JSON.stringify(payload, null, 2);
}

/** 判断新闻主体与本期主播属于原型关联动态（含新进展/负面争议/未证实传闻）、其他模型动态或第三方动态，返回独立旁观视角下的自然人设语气引导。 */
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

  // 先按事件主体和标题匹配阵营，避免他厂新闻正文里顺带提及己方原型模型时误判为关联阵营动态
  const primarySubject = `${event.entity ?? ''} ${event.title}`.toLowerCase();
  const fullSubject = `${primarySubject} ${extraText ?? ''}`.toLowerCase();
  const personas = await loadPersonas(ctx);
  const primaryMatched = personas.filter((profile) =>
    profile.campKeywords.some((keyword) => primarySubject.includes(keyword.toLowerCase())),
  );
  const matched =
    primaryMatched.length > 0
      ? primaryMatched
      : personas.filter((profile) =>
          profile.campKeywords.some((keyword) => fullSubject.includes(keyword.toLowerCase())),
        );
  const isOwnCamp = matched.some((profile) => profile.id === persona.id);
  const isRivalCamp = !isOwnCamp && matched.length > 0;
  const fullText = `${event.title} ${extraText ?? ''}`;

  let relationLabel = '第三方行业动态';
  let reactionHint = persona.topicKeywords.some((keyword) =>
    `${fullSubject} ${event.category ?? ''}`.toLowerCase().includes(keyword.toLowerCase()),
  )
    ? '该话题踩在主播的关注兴趣点上，请用鲜活真人口语把核心亮点和限制讲透；如确有值得夸或明显不合理的地方，紧扣这条新闻的具体事实现写一句态度即可，普通细节勿硬演。'
    : '用像真人朋友聊科技新闻一样的鲜活口语把核心事实讲透；遇到值得点赞或明显不合理的现象可顺嘴点破一句具体原因，普通中性资讯直接干净切入事实，不要硬凑感叹词。';

  if (isOwnCamp) {
    if (UNCONFIRMED_RUMOR_PATTERN.test(fullText)) {
      relationLabel = '原型关联未证实传闻';
      reactionHint = `这条传闻涉及你二创原型关联的 ${persona.affiliation}，但目前官方尚未确认；保持独立旁观主播的清醒视角，直呼具体公司或产品名播报线索，可用一句轻快调侃点明官方还没认，严禁提前当成官方消息或自称“我们”。`;
    } else if (NEGATIVE_NEWS_PATTERN.test(fullText)) {
      relationLabel = '原型关联受限或争议动态';
      reactionHint = persona.ownFlawReaction;
    } else {
      relationLabel = '原型关联生态新进展';
      reactionHint = persona.ownGoodReaction;
    }
  } else if (isRivalCamp) {
    relationLabel = '其他模型阵营动态';
    reactionHint = persona.rivalReaction;
  }

  return [
    `主播自称：${persona.selfName}（角色定位：玩家根据各模型二创的独立虚拟主播；灵感原型关联方：${persona.affiliation}，并非该公司员工或官方发言人）。`,
    `本条新闻主体：${event.entity ?? event.title}；【本条新闻主体关系】：${relationLabel}。`,
    `【本条新闻专属反应指引】：${reactionHint}`,
    `【写稿防跑偏三条硬性检查】：`,
    `1. 严禁照抄示例与重复口头禅：绝不复制人设或提示词里任何带引号的示范句，也不要每条都用“哈哈”“好家伙”“这波”“属实”开头；若要表达开心或吐槽，这句话里必须直接说出本条新闻里的具体动作、价格或限制，否则宁可直接切入事件主体。`,
    `2. 严禁代表任何公司发言：播报 ${persona.affiliation} 及任何公司的新闻时，主语必须直呼具体公司或产品名（如“OpenAI发布了…”“Google推出了…”），严禁使用“我们”“我们公司”“我们团队”“我司”“自家”等代词。`,
    `3. 严禁编造事实：所有反应和点评必须严格建立在原文已核实事实之上，不得脑补原文未提及的排名、功能、原因或数字。`,
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
