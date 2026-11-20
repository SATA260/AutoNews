import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  type EventRecord,
  type HostMascotId,
  HostMascotIdSchema,
  type MascotMood,
  type PersonaProfile,
  PersonasFileSchema,
} from '@aidaily/contracts';
import { parse } from 'yaml';
import type { CoreContext } from '../context.js';

const UNCONFIRMED_RUMOR_PATTERN = /(猜测|传闻|未获官方确认|尚未确认|尚未证实|流传|爆料|疑似)/i;
const BENIGN_SECURITY_BENCH_PATTERN = /漏洞(?:发现|检测|识别|挖掘|验证|修复|扫描|评估|赏金)/g;
const NEGATIVE_NEWS_PATTERN =
  /(限流|故障|致歉|差评|起诉|诉讼|调查|裁撤|裁员|涨价|不能支付|受限|报错|困境|宕机|封禁|封号|禁用|断供|翻车|争议|侵权|缩水|下架|漏洞|投诉|抗议|抵制|勒索|罚款|风波|停服|停摆|违约|索赔|败诉|批评|指责)/i;

/** 剔除安全能力评测里的正向防御术语后再判断是否属于负面故障或争议动态 */
function hasNegativeNewsSignal(text: string): boolean {
  const sanitized = text.replace(BENIGN_SECURITY_BENCH_PATTERN, '');
  return NEGATIVE_NEWS_PATTERN.test(sanitized);
}

/** 序列化主播人设提示词时的可选项，用于在已注入单条专属指引时隐藏无关场景模板。 */
export interface FormatPersonaPromptOptions {
  includeReactions?: boolean;
}

/** 同步加载并校验主播人设配置；当配置文件不存在时返回空列表 */
export function loadPersonasSync(rootDir: string): PersonaProfile[] {
  try {
    const text = fsSync.readFileSync(path.join(rootDir, 'config', 'personas.yaml'), 'utf8');
    return PersonasFileSchema.parse(parse(text)).personas;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

/** 加载并校验主播人设配置；当配置文件不存在时返回空列表 */
export async function loadPersonas(ctx: CoreContext): Promise<PersonaProfile[]> {
  try {
    const text = await fs.readFile(path.join(ctx.paths.rootDir, 'config', 'personas.yaml'), 'utf8');
    return PersonasFileSchema.parse(parse(text)).personas;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

/** 根据事件关联的文章标题与摘要构建额外的文本线索，供主播形象规则匹配复用 */
export function buildExtraTextByEventId(
  ctx: CoreContext,
  events: readonly EventRecord[],
): Map<string, string> {
  const extraTextByEventId = new Map<string, string>();
  const allArticleIds = Array.from(new Set(events.flatMap((event) => event.articleIds)));
  if (allArticleIds.length === 0) {
    return extraTextByEventId;
  }
  const articles = ctx.repos.articles.getByIds(allArticleIds);
  const articleMap = new Map(articles.map((article) => [article.id, article]));
  for (const event of events) {
    const joined = event.articleIds
      .map((id) => articleMap.get(id))
      .filter((article): article is NonNullable<typeof article> => Boolean(article))
      .map((article) => `${article.title} ${article.excerpt ?? ''}`)
      .join(' ');
    if (joined) {
      extraTextByEventId.set(event.id, joined);
    }
  }
  return extraTextByEventId;
}

/** 查询最近一次有效任务所使用的主播标识，可按任务编号排除且已放弃或跳过的任务不参与避重 */
export function findPreviousHostId(
  ctx: CoreContext,
  excludeRunId?: string,
  notAfterIso?: string,
): HostMascotId | null {
  const row = ctx.db
    .prepare(
      `SELECT host_id FROM runs
       WHERE (? IS NULL OR id != ?)
         AND host_id IS NOT NULL
         AND status NOT IN ('abandoned', 'skipped')
         AND (? IS NULL OR created_at <= ?)
       ORDER BY created_at DESC
       LIMIT 1`,
    )
    .get(excludeRunId ?? null, excludeRunId ?? null, notAfterIso ?? null, notAfterIso ?? null) as
    | { host_id: string }
    | undefined;
  const parsed = HostMascotIdSchema.safeParse(row?.host_id);
  return parsed.success ? parsed.data : null;
}

/** 将本期允许自动选用的主播形象整理为提示词说明文本，并明确标注须避开的上一期形象 */
export function formatEligibleHostCandidatesForPrompt(
  personas: readonly PersonaProfile[],
  previousHostId: HostMascotId | null,
): string {
  const eligible =
    previousHostId && personas.length > 1
      ? personas.filter((persona) => persona.id !== previousHostId)
      : personas;
  if (eligible.length === 0) return '';
  const excludedNote = previousHostId
    ? `上一期已使用主播形象「${previousHostId}」，本期自动选择严禁再次选用「${previousHostId}」。`
    : '当前无上一期连续避重限制。';
  const profiles = eligible.map((persona) => ({
    id: persona.id,
    displayName: persona.displayName,
    affiliation: persona.affiliation,
    coreTrait: persona.coreTrait,
    campKeywords: persona.campKeywords,
    topicKeywords: persona.topicKeywords,
  }));
  return `## 本期主播形象选择要求\n请根据你最终选中的核心新闻主题与阵营分布，从下方可选主播中挑选最适合播报本期的形象填入 \`hostId\`，并用一句话在 \`hostReason\` 中说明选择理由。\n${excludedNote}\n可选主播形象（\`hostId\` 仅可取自下列 \`id\`）：\n${JSON.stringify(profiles, null, 2)}`;
}

/** 根据事件阵营、话题及正文线索从可用主播中匹配最契合的形象，存在备选时严格避开上一期主播。 */
export function chooseHost(
  events: readonly EventRecord[],
  personas: readonly PersonaProfile[],
  previous: string | null,
  extraTextByEventId?: ReadonlyMap<string, string>,
): HostMascotId | null {
  if (!events.length || !personas.length) return null;
  const eligiblePersonas =
    previous && personas.length > 1
      ? personas.filter((persona) => persona.id !== previous)
      : personas;
  const candidates = eligiblePersonas.map((persona) => {
    let camp = 0;
    let topic = 0;
    events.forEach((event, index) => {
      const weight = index === 0 ? 2 : 1;
      const extraText = extraTextByEventId?.get(event.id) ?? '';
      const campText = `${event.entity ?? ''} ${event.title} ${extraText}`.toLowerCase();
      if (persona.campKeywords.some((keyword) => campText.includes(keyword.toLowerCase()))) {
        camp += weight;
      }
      const topicText =
        `${event.entity ?? ''} ${event.title} ${event.category ?? ''} ${event.reason ?? ''} ${extraText}`.toLowerCase();
      if (persona.topicKeywords.some((keyword) => topicText.includes(keyword.toLowerCase()))) {
        topic += weight;
      }
    });
    return { persona, camp, topic };
  });
  const highestCamp = Math.max(...candidates.map((candidate) => candidate.camp));
  const pool =
    highestCamp > 0 ? candidates.filter((candidate) => candidate.camp === highestCamp) : candidates;
  pool.sort((a, b) => b.topic - a.topic || b.camp - a.camp);
  return pool[0]?.persona.id ?? null;
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
    ...(persona.roastStyle ? { roastStyle: persona.roastStyle } : {}),
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

  const roastLens = persona.roastStyle ?? persona.coreTrait;
  let relationLabel = '第三方行业动态';
  let reactionHint = persona.topicKeywords.some((keyword) =>
    `${fullSubject} ${event.category ?? ''}`.toLowerCase().includes(keyword.toLowerCase()),
  )
    ? `该话题踩在主播的关注兴趣点上，请用自然直白的真人口语把核心事实讲清；只有当新闻确实存在高付费门槛、翻车短板、隐私争议或明显反差时，才按主播性格视角（${roastLens}）顺嘴吐槽一句，没槽点就干净说完收尾，别每条都在最后硬转折，更绝不说“原帖没写”。`
    : `用像真人朋友聊科技新闻一样的自然口语把核心事实讲清；如果新闻本身确实有高门槛、明显短板、翻车争议或强反差，按主播性格视角（${roastLens}）自然吐槽一句即可，普通正常更新说完事实就直接收尾，切忌每条结尾都硬接一句转折俏皮话，也绝不说“原帖没写”或“一边……一边……”。`;

  if (isOwnCamp) {
    if (UNCONFIRMED_RUMOR_PATTERN.test(fullText)) {
      relationLabel = '原型关联未证实传闻';
      reactionHint = `这条传闻涉及你二创原型关联的 ${persona.affiliation}，但目前官方尚未确认；保持独立旁观主播的清醒视角，直呼具体公司或产品名播报线索，可用一句轻快调侃点明官方还没认，严禁提前当成官方消息或自称“我们”。`;
    } else if (hasNegativeNewsSignal(fullText)) {
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
    `【主播性格与专属吐槽视角】：${roastLens}`,
    `【本条新闻专属反应指引】：${reactionHint}`,
    `【写稿防跑偏三条硬性检查】：`,
    `1. 严禁照抄示例与 AI 味语癖：绝不复制人设或提示词里任何带引号的示范句，不要每条用“哈哈/好家伙/这波”开头，也不要每条都在最后硬塞转折俏皮话；绝不说“原帖没写/原文未透露”，避开“一边……一边……”“……的恰恰是……”“……倒是挺……”等书面 AI 句式。`,
    `2. 严禁代表任何公司发言：播报 ${persona.affiliation} 及任何公司的新闻时，主语必须直呼具体公司或产品名（如“OpenAI发布了…”“Google推出了…”），严禁使用“我们”“我们公司”“我们团队”“我司”“自家”等代词。`,
    `3. 严禁编造事实：所有反应和吐槽必须严格建立在原文已核实事实之上，不得脑补原文未提及的排名、功能、原因或数字。`,
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
      if (hasNegativeNewsSignal(subjectText)) {
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
