import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

/** 内置公司或机构的基础识别信息与别名配置 */
export interface BuiltinCompanyEntry {
  id: string;
  displayName: string;
  aliases: readonly string[];
}

/** 扫描本地 Logo 目录后生成的索引信息 */
export interface LogoCatalog {
  rootDir: string;
  filesByStem: Map<string, string>;
  aliases: Map<string, string>;
}

/** 根据新闻主体识别出的公司规范标识、展示名称与 Logo 路径 */
export interface ResolvedCompanyIdentity {
  id: string;
  displayName: string;
  isKnown: boolean;
  isBuiltin: boolean;
  rawEntityKey: string;
  logoUrl?: string;
}

/** 用于整期节目编排顺序对齐的新闻条目元信息 */
export interface OrderAlignmentItemMeta {
  entity?: string | null;
  title?: string | null;
}

const AliasMapSchema = z.record(z.string(), z.string());

const LOGO_EXTENSION_PRIORITY = ['.svg', '.png', '.webp', '.jpg', '.jpeg'] as const;
const MULTI_ENTITY_SPLIT_RE = /(?:[、,，/&+]+|\s+(?:and|with)\s+)/i;

/** 预置的 54 家主流国内外人工智能与科技厂商规范列表 */
export const BUILTIN_COMPANIES: readonly BuiltinCompanyEntry[] = [
  {
    id: 'openai',
    displayName: 'OpenAI',
    aliases: ['openai', 'chatgpt', 'gpt', 'sora', 'dall-e', 'dalle', 'whisper', 'o1', 'o3'],
  },
  {
    id: 'google',
    displayName: 'Google',
    aliases: [
      'google',
      '谷歌',
      'deepmind',
      'google deepmind',
      'gemini',
      'genie',
      'veo',
      'imagen',
      'notebooklm',
      'ai studio',
      'android',
      'alphabet',
    ],
  },
  {
    id: 'anthropic',
    displayName: 'Anthropic',
    aliases: ['anthropic', 'claude'],
  },
  {
    id: 'meta',
    displayName: 'Meta',
    aliases: ['meta', 'meta ai', 'facebook', 'instagram', 'whatsapp', 'llama', 'muse spark'],
  },
  {
    id: 'nvidia',
    displayName: '英伟达',
    aliases: ['nvidia', '英伟达', 'geforce', 'cuda', 'blackwell', 'rubin', 'h100', 'h200', 'b200'],
  },
  {
    id: 'microsoft',
    displayName: '微软',
    aliases: ['microsoft', '微软', 'azure', 'copilot', 'bing'],
  },
  {
    id: 'apple',
    displayName: 'Apple',
    aliases: ['apple', '苹果', 'siri', 'apple intelligence'],
  },
  {
    id: 'xai',
    displayName: 'xAI',
    aliases: ['xai', 'grok'],
  },
  {
    id: 'mistral',
    displayName: 'Mistral',
    aliases: ['mistral', 'mistral ai', 'le chat'],
  },
  {
    id: 'huggingface',
    displayName: 'Hugging Face',
    aliases: ['huggingface', 'hugging face', '抱抱脸'],
  },
  {
    id: 'deepseek',
    displayName: 'DeepSeek',
    aliases: ['deepseek', '深度求索'],
  },
  {
    id: 'alibaba',
    displayName: '阿里巴巴',
    aliases: [
      'alibaba',
      '阿里巴巴',
      '阿里',
      '阿里云',
      '通义',
      '通义千问',
      '千问',
      'qwen',
      'qoder',
      '万相',
      'wanx',
      '夸克',
      '达摩院',
    ],
  },
  {
    id: 'tencent',
    displayName: '腾讯',
    aliases: [
      'tencent',
      '腾讯',
      '腾讯混元',
      '混元',
      'hunyuan',
      'hy4',
      '元宝',
      'yuanbao',
      'workbuddy',
    ],
  },
  {
    id: 'bytedance',
    displayName: '字节跳动',
    aliases: [
      'bytedance',
      '字节跳动',
      '字节',
      '豆包',
      'doubao',
      '火山引擎',
      'volcengine',
      'coze',
      '扣子',
      'seedance',
      'seedream',
      'trae',
      '即梦',
    ],
  },
  {
    id: 'kuaishou',
    displayName: '快手',
    aliases: ['kuaishou', '快手', '可灵', 'kling'],
  },
  {
    id: 'baidu',
    displayName: '百度',
    aliases: ['baidu', '百度', '文心', '文心一言', 'ernie', '飞桨', 'paddlepaddle', '昆仑芯'],
  },
  {
    id: 'huawei',
    displayName: '华为',
    aliases: ['huawei', '华为', '盘古', '昇腾', 'ascend', '鸿蒙', 'harmonyos'],
  },
  {
    id: 'xiaomi',
    displayName: '小米',
    aliases: ['xiaomi', '小米', 'mimo', '小爱同学'],
  },
  {
    id: 'zhipu',
    displayName: '智谱',
    aliases: ['zhipu', '智谱', '智谱ai', '智谱清言', 'chatglm', 'glm'],
  },
  {
    id: 'moonshot',
    displayName: '月之暗面',
    aliases: ['moonshot', '月之暗面', 'kimi'],
  },
  {
    id: 'minimax',
    displayName: 'MiniMax',
    aliases: ['minimax', '稀宇科技', '海螺ai'],
  },
  {
    id: 'stepfun',
    displayName: '阶跃星辰',
    aliases: ['stepfun', '阶跃星辰'],
  },
  {
    id: 'baichuan',
    displayName: '百川智能',
    aliases: ['baichuan', '百川', '百川智能'],
  },
  {
    id: 'zeroone',
    displayName: '零一万物',
    aliases: ['zeroone', '零一万物', '01.ai', '01ai', 'yi-lightning', 'yi-large'],
  },
  {
    id: 'sensetime',
    displayName: '商汤',
    aliases: ['sensetime', '商汤', '商汤科技', '日日新', 'sensenova'],
  },
  {
    id: 'iflytek',
    displayName: '科大讯飞',
    aliases: ['iflytek', '科大讯飞', '讯飞', '讯飞星火', '星火大模型'],
  },
  {
    id: 'meituan',
    displayName: '美团',
    aliases: ['meituan', '美团', 'longcat'],
  },
  {
    id: 'amazon',
    displayName: 'Amazon',
    aliases: ['amazon', '亚马逊', 'aws', 'bedrock', 'amazon nova'],
  },
  {
    id: 'tesla',
    displayName: 'Tesla',
    aliases: ['tesla', '特斯拉'],
  },
  {
    id: 'amd',
    displayName: 'AMD',
    aliases: ['amd', '超威半导体'],
  },
  {
    id: 'intel',
    displayName: 'Intel',
    aliases: ['intel', '英特尔'],
  },
  {
    id: 'qualcomm',
    displayName: 'Qualcomm',
    aliases: ['qualcomm', '高通', '骁龙', 'snapdragon'],
  },
  {
    id: 'perplexity',
    displayName: 'Perplexity',
    aliases: ['perplexity'],
  },
  {
    id: 'cursor',
    displayName: 'Cursor',
    aliases: ['cursor', 'anysphere'],
  },
  {
    id: 'cohere',
    displayName: 'Cohere',
    aliases: ['cohere'],
  },
  {
    id: 'stability',
    displayName: 'Stability AI',
    aliases: ['stability', 'stability ai', 'stable diffusion'],
  },
  {
    id: 'midjourney',
    displayName: 'Midjourney',
    aliases: ['midjourney'],
  },
  {
    id: 'runway',
    displayName: 'Runway',
    aliases: ['runway'],
  },
  {
    id: 'suno',
    displayName: 'Suno',
    aliases: ['suno'],
  },
  {
    id: 'elevenlabs',
    displayName: 'ElevenLabs',
    aliases: ['elevenlabs', 'eleven labs'],
  },
  {
    id: 'github',
    displayName: 'GitHub',
    aliases: ['github', 'github copilot'],
  },
  {
    id: 'vercel',
    displayName: 'Vercel',
    aliases: ['vercel', 'v0.dev'],
  },
  {
    id: 'cloudflare',
    displayName: 'Cloudflare',
    aliases: ['cloudflare'],
  },
  {
    id: 'mozilla',
    displayName: 'Mozilla',
    aliases: ['mozilla', 'firefox'],
  },
  {
    id: 'ibm',
    displayName: 'IBM',
    aliases: ['ibm', 'granite'],
  },
  {
    id: 'adobe',
    displayName: 'Adobe',
    aliases: ['adobe', 'firefly'],
  },
  {
    id: 'figma',
    displayName: 'Figma',
    aliases: ['figma'],
  },
  {
    id: 'notion',
    displayName: 'Notion',
    aliases: ['notion'],
  },
  {
    id: 'databricks',
    displayName: 'Databricks',
    aliases: ['databricks'],
  },
  {
    id: 'snowflake',
    displayName: 'Snowflake',
    aliases: ['snowflake'],
  },
  {
    id: 'groq',
    displayName: 'Groq',
    aliases: ['groq'],
  },
  {
    id: 'ollama',
    displayName: 'Ollama',
    aliases: ['ollama'],
  },
  {
    id: 'manus',
    displayName: 'Manus',
    aliases: ['manus'],
  },
  {
    id: 'cerebras',
    displayName: 'Cerebras',
    aliases: ['cerebras'],
  },
];

const BUILTIN_BY_ID = new Map<string, BuiltinCompanyEntry>(
  BUILTIN_COMPANIES.map((entry) => [entry.id, entry]),
);

const DIGIT_SUFFIX_ALLOWED_ALIASES = new Set<string>([
  'gpt',
  'gemini',
  'claude',
  'deepseek',
  'grok',
  'llama',
  'qwen',
  'glm',
  'sora',
  'veo',
  'ernie',
]);

/** 对字符串中的正则元字符进行转义 */
function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 标准化用于查找和归组的实体文本（统一全角半角、小写并压缩空白） */
function normalizeKey(value: string): string {
  return value.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** 在文本中查找指定公司别名的首个命中位置；纯英文缩写强制校验前后词边界，防止子串误判 */
function findAliasMatchOffset(text: string, alias: string): number {
  const normText = normalizeKey(text);
  const normAlias = normalizeKey(alias);
  if (!normText || !normAlias) {
    return -1;
  }

  const isPureAscii = /^[\x20-\x7e]+$/.test(normAlias);
  if (!isPureAscii) {
    return normText.indexOf(normAlias);
  }

  const rightBoundary = DIGIT_SUFFIX_ALLOWED_ALIASES.has(normAlias) ? '(?![a-z])' : '(?![a-z0-9])';
  const pattern = new RegExp(`(?<![a-z0-9])${escapeRegex(normAlias)}${rightBoundary}`, 'i');
  const match = pattern.exec(normText);
  return match ? match.index : -1;
}

/** 从一段文本中选出最匹配的内建公司（最靠前命中优先，其次更长别名优先） */
function matchBuiltinCompanyInText(text: string): BuiltinCompanyEntry | undefined {
  let bestEntry: BuiltinCompanyEntry | undefined;
  let bestOffset = Number.POSITIVE_INFINITY;
  let bestAliasLen = -1;

  for (const entry of BUILTIN_COMPANIES) {
    for (const alias of entry.aliases) {
      const offset = findAliasMatchOffset(text, alias);
      if (offset < 0) {
        continue;
      }
      if (offset < bestOffset || (offset === bestOffset && alias.length > bestAliasLen)) {
        bestEntry = entry;
        bestOffset = offset;
        bestAliasLen = alias.length;
      }
    }
  }
  return bestEntry;
}

/** 根据文件路径主干和别名目录构造本地服务可访问的 Logo URL */
function buildLogoUrl(fileName: string): string {
  return `/__logo_assets__/${encodeURIComponent(fileName)}`;
}

/** 定位工作区或共享资源目录下可用的公司 Logo 目录，不存在时返回空 */
export async function resolveLogoAssetsRoot(
  rootDir: string,
  templateDir?: string,
): Promise<string | undefined> {
  const candidates = [path.join(rootDir, 'assets', 'logos')];
  if (templateDir) {
    candidates.push(path.resolve(templateDir, '..', '..', 'assets', 'logos'));
  }
  for (const dir of candidates) {
    try {
      const st = await fs.stat(dir);
      if (st.isDirectory()) {
        return dir;
      }
    } catch {
      // 当前候选目录不可用时继续探测回退路径
    }
  }
  return undefined;
}

/** 扫描指定目录中的公司 Logo 文件并读取可选别名映射表（同一主干优先选用矢量 SVG） */
export async function loadLogoCatalog(logosDir: string): Promise<LogoCatalog> {
  const filesByStem = new Map<string, string>();
  const stemExtRank = new Map<string, number>();
  const aliases = new Map<string, string>();

  const entries = await fs.readdir(logosDir, { withFileTypes: true }).catch(() => []);
  for (const ent of entries) {
    if (!ent.isFile() && !ent.isSymbolicLink()) {
      continue;
    }
    const ext = path.extname(ent.name).toLowerCase();
    const rank = LOGO_EXTENSION_PRIORITY.indexOf(ext as (typeof LOGO_EXTENSION_PRIORITY)[number]);
    if (rank < 0) {
      continue;
    }
    const stem = normalizeKey(path.basename(ent.name, path.extname(ent.name)));
    if (!stem) {
      continue;
    }
    const prevRank = stemExtRank.get(stem);
    if (prevRank === undefined || rank < prevRank) {
      stemExtRank.set(stem, rank);
      filesByStem.set(stem, ent.name);
    }
  }

  try {
    const rawAliases = await fs.readFile(path.join(logosDir, 'aliases.json'), 'utf8');
    const parsed = AliasMapSchema.safeParse(JSON.parse(rawAliases));
    if (parsed.success) {
      for (const [rawAlias, rawStem] of Object.entries(parsed.data)) {
        const aliasKey = normalizeKey(rawAlias);
        const stemKey = normalizeKey(rawStem);
        if (aliasKey && stemKey) {
          aliases.set(aliasKey, stemKey);
        }
      }
    }
  } catch {
    // 缺少 aliases.json 或格式无效时忽略，继续使用目录文件名匹配
  }

  return {
    rootDir: logosDir,
    filesByStem,
    aliases,
  };
}

/** 尝试在本地 Logo 目录中按精确主干或别名映射查找自定义 Logo */
function lookupCustomCatalogEntry(
  segment: string,
  catalog: LogoCatalog | null | undefined,
): { stem: string; fileName: string } | undefined {
  if (!catalog) {
    return undefined;
  }
  const key = normalizeKey(segment);
  if (!key) {
    return undefined;
  }
  const directFile = catalog.filesByStem.get(key);
  if (directFile) {
    return { stem: key, fileName: directFile };
  }
  const mappedStem = catalog.aliases.get(key);
  if (mappedStem) {
    const aliasedFile = catalog.filesByStem.get(mappedStem);
    if (aliasedFile) {
      return { stem: mappedStem, fileName: aliasedFile };
    }
  }
  return undefined;
}

/**
 * 综合新闻主体字段、兜底文本与本地 Logo 目录解析规范公司标识。
 * 匹配优先级：自定义别名或文件名 -> 内置厂商别名 -> 仅当实体字段为空时回退标题/摘要匹配。
 */
export function resolveCompanyIdentity(opts: {
  entity?: string | null;
  fallbackText?: string | null;
  catalog?: LogoCatalog | null;
}): ResolvedCompanyIdentity {
  const rawEntity = (opts.entity ?? '').normalize('NFKC').trim();
  const segments = rawEntity
    ? rawEntity
        .split(MULTI_ENTITY_SPLIT_RE)
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
    : [];
  const primarySegment = segments[0] ?? rawEntity;

  // 1. 先检查主实体或各分段是否直接命中用户在 assets/logos 放的文件或 aliases.json
  for (const candidate of [rawEntity, ...segments]) {
    if (!candidate) {
      continue;
    }
    const customHit = lookupCustomCatalogEntry(candidate, opts.catalog);
    if (customHit) {
      const builtin = BUILTIN_BY_ID.get(customHit.stem);
      if (builtin) {
        return {
          id: builtin.id,
          displayName: builtin.displayName,
          isKnown: true,
          isBuiltin: true,
          rawEntityKey: normalizeKey(rawEntity),
          logoUrl: buildLogoUrl(customHit.fileName),
        };
      }
      return {
        id: `custom:${customHit.stem}`,
        displayName: primarySegment || candidate,
        isKnown: true,
        isBuiltin: false,
        rawEntityKey: customHit.stem,
        logoUrl: buildLogoUrl(customHit.fileName),
      };
    }
  }

  // 2. 按主实体分段依次匹配预置公司表
  for (const candidate of [...segments, rawEntity]) {
    if (!candidate) {
      continue;
    }
    const builtin = matchBuiltinCompanyInText(candidate);
    if (builtin) {
      const logoFile = opts.catalog?.filesByStem.get(builtin.id);
      return {
        id: builtin.id,
        displayName: builtin.displayName,
        isKnown: true,
        isBuiltin: true,
        rawEntityKey: normalizeKey(rawEntity),
        ...(logoFile ? { logoUrl: buildLogoUrl(logoFile) } : {}),
      };
    }
  }

  // 3. 当主实体字段缺失时，从标题或来源兜底推断公司
  if (!rawEntity && opts.fallbackText) {
    const builtin = matchBuiltinCompanyInText(opts.fallbackText);
    if (builtin) {
      const logoFile = opts.catalog?.filesByStem.get(builtin.id);
      return {
        id: builtin.id,
        displayName: builtin.displayName,
        isKnown: true,
        isBuiltin: true,
        rawEntityKey: '',
        ...(logoFile ? { logoUrl: buildLogoUrl(logoFile) } : {}),
      };
    }
  }

  const rawKey = normalizeKey(primarySegment || rawEntity);
  return {
    id: rawKey ? `raw:${rawKey}` : 'other',
    displayName: primarySegment || rawEntity || '其他动态',
    isKnown: false,
    isBuiltin: false,
    rawEntityKey: rawKey,
  };
}

/**
 * 按「开头要闻（1～2 条）+ 其余按公司聚类」的规则对齐整期播出顺序，
 * 确保开头瀑布流导览、顶部章节进度条、正片播报与简介时间轴顺序完全一致。
 */
export function alignOrderByCompanyOverview(
  order: readonly string[],
  metaById: ReadonlyMap<string, OrderAlignmentItemMeta>,
  catalog?: LogoCatalog | null,
): string[] {
  if (order.length <= 2) {
    return [...order];
  }

  const featuredCount = order.length >= 5 ? 2 : 1;
  const featuredIds = order.slice(0, featuredCount);
  const restIds = order.slice(featuredCount);

  interface ClassifiedEntry {
    id: string;
    groupKey: string;
    isStandaloneCandidate: boolean;
  }

  const classified: ClassifiedEntry[] = [];
  const rawCounts = new Map<string, number>();

  for (const id of restIds) {
    const meta = metaById.get(id);
    const identity = resolveCompanyIdentity({
      entity: meta?.entity,
      fallbackText: meta?.title,
      catalog,
    });
    const isDirectKnown = identity.isKnown || Boolean(identity.logoUrl);
    const groupKey = isDirectKnown
      ? `company:${identity.id}`
      : identity.rawEntityKey
        ? `raw:${identity.rawEntityKey}`
        : '__none__';

    if (!isDirectKnown && identity.rawEntityKey) {
      rawCounts.set(groupKey, (rawCounts.get(groupKey) ?? 0) + 1);
    }

    classified.push({
      id,
      groupKey,
      isStandaloneCandidate: isDirectKnown,
    });
  }

  // 统计既非内置大厂、也未配置本地 Logo、且只出现 1 次的具名长尾实体数量
  let singleUnlistedNamedCount = 0;
  for (const entry of classified) {
    if (!entry.isStandaloneCandidate && entry.groupKey !== '__none__') {
      if ((rawCounts.get(entry.groupKey) ?? 0) === 1) {
        singleUnlistedNamedCount += 1;
      }
    }
  }

  const standaloneGroups: string[][] = [];
  const groupIndexByKey = new Map<string, number>();
  const otherGroupIds: string[] = [];

  for (const entry of classified) {
    const count = rawCounts.get(entry.groupKey) ?? 0;
    const shouldMergeIntoOther =
      entry.groupKey === '__none__' ||
      (!entry.isStandaloneCandidate && count === 1 && singleUnlistedNamedCount >= 2);

    if (shouldMergeIntoOther) {
      otherGroupIds.push(entry.id);
      continue;
    }

    const existingIdx = groupIndexByKey.get(entry.groupKey);
    if (existingIdx !== undefined) {
      standaloneGroups[existingIdx]?.push(entry.id);
    } else {
      groupIndexByKey.set(entry.groupKey, standaloneGroups.length);
      standaloneGroups.push([entry.id]);
    }
  }

  return [...featuredIds, ...standaloneGroups.flat(), ...otherGroupIds];
}
