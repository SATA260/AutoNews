import type { SanitizedNewsItem } from '../schema/newsSchema';

/** 封面瀑布流卡片支持的低饱和度色调标识 */
export type CoverCardTone = 'featured' | 'amber' | 'emerald' | 'violet' | 'rose' | 'olive' | 'cyan';

/** 内置公司或机构的视觉档案配置 */
export interface BuiltinCompanyProfile {
  id: string;
  displayName: string;
  aliases: readonly string[];
  tone: Exclude<CoverCardTone, 'featured'>;
  accentColor: string;
}

/** 单条新闻解析后得到的公司展示信息、Logo 地址与首字母徽章 */
export interface ResolvedCompanyVisual {
  id: string;
  displayName: string;
  isKnown: boolean;
  isBuiltin: boolean;
  rawEntityKey: string;
  logoUrl: string | null;
  tone: Exclude<CoverCardTone, 'featured'>;
  accentColor: string;
  monogram: string;
}

const MULTI_ENTITY_SPLIT_RE = /(?:[、,，/&+]+|\s+(?:and|with)\s+)/i;

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

const FALLBACK_TONES: readonly Exclude<CoverCardTone, 'featured'>[] = [
  'emerald',
  'amber',
  'violet',
  'rose',
  'olive',
  'cyan',
];

const FALLBACK_ACCENTS: readonly string[] = [
  '#1C7C74',
  '#B86535',
  '#705FC6',
  '#C25472',
  '#5E8030',
  '#2E7FB8',
];

/** 模板内置的 54 家主流国内外人工智能与科技厂商视觉档案 */
export const BUILTIN_COMPANY_PROFILES: readonly BuiltinCompanyProfile[] = [
  {
    id: 'openai',
    displayName: 'OpenAI',
    aliases: ['openai', 'chatgpt', 'gpt', 'sora', 'dall-e', 'dalle', 'whisper', 'o1', 'o3'],
    tone: 'amber',
    accentColor: '#B86535',
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
    tone: 'emerald',
    accentColor: '#1C7C74',
  },
  {
    id: 'anthropic',
    displayName: 'Anthropic',
    aliases: ['anthropic', 'claude'],
    tone: 'amber',
    accentColor: '#B86535',
  },
  {
    id: 'meta',
    displayName: 'Meta',
    aliases: ['meta', 'meta ai', 'facebook', 'instagram', 'whatsapp', 'llama', 'muse spark'],
    tone: 'cyan',
    accentColor: '#2E7FB8',
  },
  {
    id: 'nvidia',
    displayName: '英伟达',
    aliases: ['nvidia', '英伟达', 'geforce', 'cuda', 'blackwell', 'rubin', 'h100', 'h200', 'b200'],
    tone: 'emerald',
    accentColor: '#1C7C74',
  },
  {
    id: 'microsoft',
    displayName: '微软',
    aliases: ['microsoft', '微软', 'azure', 'copilot', 'bing'],
    tone: 'cyan',
    accentColor: '#2E7FB8',
  },
  {
    id: 'apple',
    displayName: 'Apple',
    aliases: ['apple', '苹果', 'siri', 'apple intelligence'],
    tone: 'violet',
    accentColor: '#705FC6',
  },
  {
    id: 'xai',
    displayName: 'xAI',
    aliases: ['xai', 'grok'],
    tone: 'rose',
    accentColor: '#C25472',
  },
  {
    id: 'mistral',
    displayName: 'Mistral',
    aliases: ['mistral', 'mistral ai', 'le chat'],
    tone: 'amber',
    accentColor: '#B86535',
  },
  {
    id: 'huggingface',
    displayName: 'Hugging Face',
    aliases: ['huggingface', 'hugging face', '抱抱脸'],
    tone: 'olive',
    accentColor: '#5E8030',
  },
  {
    id: 'deepseek',
    displayName: 'DeepSeek',
    aliases: ['deepseek', '深度求索'],
    tone: 'cyan',
    accentColor: '#2E7FB8',
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
    tone: 'violet',
    accentColor: '#705FC6',
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
    tone: 'rose',
    accentColor: '#C25472',
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
    tone: 'olive',
    accentColor: '#5E8030',
  },
  {
    id: 'kuaishou',
    displayName: '快手',
    aliases: ['kuaishou', '快手', '可灵', 'kling'],
    tone: 'amber',
    accentColor: '#B86535',
  },
  {
    id: 'baidu',
    displayName: '百度',
    aliases: ['baidu', '百度', '文心', '文心一言', 'ernie', '飞桨', 'paddlepaddle', '昆仑芯'],
    tone: 'cyan',
    accentColor: '#2E7FB8',
  },
  {
    id: 'huawei',
    displayName: '华为',
    aliases: ['huawei', '华为', '盘古', '昇腾', 'ascend', '鸿蒙', 'harmonyos'],
    tone: 'rose',
    accentColor: '#C25472',
  },
  {
    id: 'xiaomi',
    displayName: '小米',
    aliases: ['xiaomi', '小米', 'mimo', '小爱同学'],
    tone: 'amber',
    accentColor: '#B86535',
  },
  {
    id: 'zhipu',
    displayName: '智谱',
    aliases: ['zhipu', '智谱', '智谱ai', '智谱清言', 'chatglm', 'glm'],
    tone: 'violet',
    accentColor: '#705FC6',
  },
  {
    id: 'moonshot',
    displayName: '月之暗面',
    aliases: ['moonshot', '月之暗面', 'kimi'],
    tone: 'cyan',
    accentColor: '#2E7FB8',
  },
  {
    id: 'minimax',
    displayName: 'MiniMax',
    aliases: ['minimax', '稀宇科技', '海螺ai'],
    tone: 'rose',
    accentColor: '#C25472',
  },
  {
    id: 'stepfun',
    displayName: '阶跃星辰',
    aliases: ['stepfun', '阶跃星辰'],
    tone: 'emerald',
    accentColor: '#1C7C74',
  },
  {
    id: 'baichuan',
    displayName: '百川智能',
    aliases: ['baichuan', '百川', '百川智能'],
    tone: 'amber',
    accentColor: '#B86535',
  },
  {
    id: 'zeroone',
    displayName: '零一万物',
    aliases: ['zeroone', '零一万物', '01.ai', '01ai', 'yi-lightning', 'yi-large'],
    tone: 'emerald',
    accentColor: '#1C7C74',
  },
  {
    id: 'sensetime',
    displayName: '商汤',
    aliases: ['sensetime', '商汤', '商汤科技', '日日新', 'sensenova'],
    tone: 'violet',
    accentColor: '#705FC6',
  },
  {
    id: 'iflytek',
    displayName: '科大讯飞',
    aliases: ['iflytek', '科大讯飞', '讯飞', '讯飞星火', '星火大模型'],
    tone: 'cyan',
    accentColor: '#2E7FB8',
  },
  {
    id: 'meituan',
    displayName: '美团',
    aliases: ['meituan', '美团', 'longcat'],
    tone: 'olive',
    accentColor: '#5E8030',
  },
  {
    id: 'amazon',
    displayName: 'Amazon',
    aliases: ['amazon', '亚马逊', 'aws', 'bedrock', 'amazon nova'],
    tone: 'amber',
    accentColor: '#B86535',
  },
  {
    id: 'tesla',
    displayName: 'Tesla',
    aliases: ['tesla', '特斯拉'],
    tone: 'rose',
    accentColor: '#C25472',
  },
  {
    id: 'amd',
    displayName: 'AMD',
    aliases: ['amd', '超威半导体'],
    tone: 'rose',
    accentColor: '#C25472',
  },
  {
    id: 'intel',
    displayName: 'Intel',
    aliases: ['intel', '英特尔'],
    tone: 'cyan',
    accentColor: '#2E7FB8',
  },
  {
    id: 'qualcomm',
    displayName: 'Qualcomm',
    aliases: ['qualcomm', '高通', '骁龙', 'snapdragon'],
    tone: 'violet',
    accentColor: '#705FC6',
  },
  {
    id: 'perplexity',
    displayName: 'Perplexity',
    aliases: ['perplexity'],
    tone: 'emerald',
    accentColor: '#1C7C74',
  },
  {
    id: 'cursor',
    displayName: 'Cursor',
    aliases: ['cursor', 'anysphere'],
    tone: 'violet',
    accentColor: '#705FC6',
  },
  {
    id: 'cohere',
    displayName: 'Cohere',
    aliases: ['cohere'],
    tone: 'olive',
    accentColor: '#5E8030',
  },
  {
    id: 'stability',
    displayName: 'Stability AI',
    aliases: ['stability', 'stability ai', 'stable diffusion'],
    tone: 'violet',
    accentColor: '#705FC6',
  },
  {
    id: 'midjourney',
    displayName: 'Midjourney',
    aliases: ['midjourney'],
    tone: 'cyan',
    accentColor: '#2E7FB8',
  },
  {
    id: 'runway',
    displayName: 'Runway',
    aliases: ['runway'],
    tone: 'emerald',
    accentColor: '#1C7C74',
  },
  {
    id: 'suno',
    displayName: 'Suno',
    aliases: ['suno'],
    tone: 'amber',
    accentColor: '#B86535',
  },
  {
    id: 'elevenlabs',
    displayName: 'ElevenLabs',
    aliases: ['elevenlabs', 'eleven labs'],
    tone: 'violet',
    accentColor: '#705FC6',
  },
  {
    id: 'github',
    displayName: 'GitHub',
    aliases: ['github', 'github copilot'],
    tone: 'cyan',
    accentColor: '#2E7FB8',
  },
  {
    id: 'vercel',
    displayName: 'Vercel',
    aliases: ['vercel', 'v0.dev'],
    tone: 'olive',
    accentColor: '#5E8030',
  },
  {
    id: 'cloudflare',
    displayName: 'Cloudflare',
    aliases: ['cloudflare'],
    tone: 'amber',
    accentColor: '#B86535',
  },
  {
    id: 'mozilla',
    displayName: 'Mozilla',
    aliases: ['mozilla', 'firefox'],
    tone: 'rose',
    accentColor: '#C25472',
  },
  {
    id: 'ibm',
    displayName: 'IBM',
    aliases: ['ibm', 'granite'],
    tone: 'cyan',
    accentColor: '#2E7FB8',
  },
  {
    id: 'adobe',
    displayName: 'Adobe',
    aliases: ['adobe', 'firefly'],
    tone: 'rose',
    accentColor: '#C25472',
  },
  {
    id: 'figma',
    displayName: 'Figma',
    aliases: ['figma'],
    tone: 'violet',
    accentColor: '#705FC6',
  },
  {
    id: 'notion',
    displayName: 'Notion',
    aliases: ['notion'],
    tone: 'olive',
    accentColor: '#5E8030',
  },
  {
    id: 'databricks',
    displayName: 'Databricks',
    aliases: ['databricks'],
    tone: 'amber',
    accentColor: '#B86535',
  },
  {
    id: 'snowflake',
    displayName: 'Snowflake',
    aliases: ['snowflake'],
    tone: 'cyan',
    accentColor: '#2E7FB8',
  },
  {
    id: 'groq',
    displayName: 'Groq',
    aliases: ['groq'],
    tone: 'rose',
    accentColor: '#C25472',
  },
  {
    id: 'ollama',
    displayName: 'Ollama',
    aliases: ['ollama'],
    tone: 'emerald',
    accentColor: '#1C7C74',
  },
  {
    id: 'manus',
    displayName: 'Manus',
    aliases: ['manus'],
    tone: 'amber',
    accentColor: '#B86535',
  },
  {
    id: 'cerebras',
    displayName: 'Cerebras',
    aliases: ['cerebras'],
    tone: 'amber',
    accentColor: '#B86535',
  },
];

const PROFILE_BY_ID = new Map<string, BuiltinCompanyProfile>(
  BUILTIN_COMPANY_PROFILES.map((p) => [p.id, p]),
);

/** 转义正则表达式中的特殊字符 */
function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 归一化文本用于安全查表与公司名比对 */
function normalizeKey(value: string): string {
  return value.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** 计算简单确定性哈希值，用于为未收录公司分配稳定的默认色调 */
function hashString(text: string): number {
  let hash = 0;
  for (const ch of text) {
    hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  }
  return hash;
}

/** 根据公司展示名生成简洁的圆角首字母或双字缩略徽章文本 */
export function buildCompanyMonogram(displayName: string): string {
  const clean = displayName.trim();
  if (!clean) {
    return 'AI';
  }
  const hasCjk = /[\u4e00-\u9fff]/.test(clean);
  if (hasCjk) {
    const cjkChars = Array.from(clean.replace(/[^\u4e00-\u9fffA-Za-z0-9]/g, ''));
    return cjkChars.slice(0, 2).join('') || 'AI';
  }
  const words = clean.split(/[\s._-]+/).filter(Boolean);
  if (words.length >= 2) {
    const first = words[0]?.[0] ?? '';
    const second = words[1]?.[0] ?? '';
    return `${first}${second}`.toUpperCase() || 'AI';
  }
  const single = words[0] ?? clean;
  if (/^[A-Z0-9]{2,3}$/.test(single)) {
    return single;
  }
  const upperChars = single.replace(/[^A-Z]/g, '');
  if (upperChars.length >= 2 && upperChars.length <= 3) {
    return upperChars;
  }
  return Array.from(single).slice(0, 2).join('').toUpperCase() || 'AI';
}

/** 在文本中查找指定公司别名的首个命中偏移；纯英文缩写强制要求前后词边界 */
function findAliasMatchOffset(text: string, alias: string): number {
  const normText = normalizeKey(text);
  const normAlias = normalizeKey(alias);
  if (!normText || !normAlias) {
    return -1;
  }

  const isPureAscii = /^[\u0020-\u007e]+$/.test(normAlias);
  if (!isPureAscii) {
    return normText.indexOf(normAlias);
  }

  const rightBoundary = DIGIT_SUFFIX_ALLOWED_ALIASES.has(normAlias) ? '(?![a-z])' : '(?![a-z0-9])';
  const pattern = new RegExp(`(?<![a-z0-9])${escapeRegex(normAlias)}${rightBoundary}`, 'i');
  const match = pattern.exec(normText);
  return match ? match.index : -1;
}

/** 从一段文本中选出最匹配的内建公司档案 */
function matchProfileInText(text: string): BuiltinCompanyProfile | undefined {
  let best: BuiltinCompanyProfile | undefined;
  let bestOffset = Number.POSITIVE_INFINITY;
  let bestLen = -1;

  for (const profile of BUILTIN_COMPANY_PROFILES) {
    for (const alias of profile.aliases) {
      const offset = findAliasMatchOffset(text, alias);
      if (offset < 0) {
        continue;
      }
      if (offset < bestOffset || (offset === bestOffset && alias.length > bestLen)) {
        best = profile;
        bestOffset = offset;
        bestLen = alias.length;
      }
    }
  }
  return best;
}

/** 从 Logo 服务路径中安全提取文件名主干，用于自定义 Logo 的分组归并 */
function extractLogoStemFromUrl(url: string | null): string {
  if (!url) {
    return '';
  }
  const noQuery = url.split('?')[0] ?? url;
  const lastSegment = noQuery.split('/').pop() ?? '';
  let decoded = lastSegment;
  try {
    decoded = decodeURIComponent(lastSegment);
  } catch {
    decoded = lastSegment;
  }
  const dotIdx = decoded.lastIndexOf('.');
  const stem = dotIdx > 0 ? decoded.slice(0, dotIdx) : decoded;
  return normalizeKey(stem);
}

/**
 * 解析单条新闻所属的规范公司视觉档案与 Logo 地址。
 * 优先使用明确传入的 `entity` 和后端匹配好的 `companyLogoUrl`，缺失时回退标题与信源推断。
 */
export function resolveItemCompany(item: SanitizedNewsItem): ResolvedCompanyVisual {
  const rawEntity = item.entity.normalize('NFKC').trim();
  const segments = rawEntity
    ? rawEntity
        .split(MULTI_ENTITY_SPLIT_RE)
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
    : [];
  const primarySegment = segments[0] ?? rawEntity;

  // 1. 优先从实体名称匹配预置公司清单
  let matchedProfile: BuiltinCompanyProfile | undefined;
  for (const candidate of [...segments, rawEntity]) {
    if (!candidate) {
      continue;
    }
    matchedProfile = matchProfileInText(candidate);
    if (matchedProfile) {
      break;
    }
  }

  // 2. 若后端已传回定制 Logo 链接且主干命中预置公司，也关联对应档案
  const urlStem = extractLogoStemFromUrl(item.companyLogoUrl);
  if (!matchedProfile && urlStem) {
    matchedProfile = PROFILE_BY_ID.get(urlStem);
  }

  // 3. 当实体字段留空时（例如兼容历史期次数据），从短标题、主标题和信源推断公司
  if (!matchedProfile && !rawEntity) {
    matchedProfile = matchProfileInText(`${item.shortTitle} ${item.title} ${item.source}`);
  }

  if (matchedProfile) {
    return {
      id: matchedProfile.id,
      displayName: matchedProfile.displayName,
      isKnown: true,
      isBuiltin: true,
      rawEntityKey: normalizeKey(rawEntity),
      logoUrl: item.companyLogoUrl || `/logos/${matchedProfile.id}.svg`,
      tone: matchedProfile.tone,
      accentColor: matchedProfile.accentColor,
      monogram: buildCompanyMonogram(matchedProfile.displayName),
    };
  }

  // 4. 若用户通过本地 Logo 目录配置了非内置公司图标，按文件主干独立成组
  if (item.companyLogoUrl) {
    const stemKey = urlStem || normalizeKey(primarySegment || rawEntity);
    const displayName = primarySegment || rawEntity || stemKey || '相关机构';
    const hash = hashString(stemKey || displayName);
    return {
      id: `custom:${stemKey || displayName}`,
      displayName,
      isKnown: true,
      isBuiltin: false,
      rawEntityKey: stemKey,
      logoUrl: item.companyLogoUrl,
      tone: FALLBACK_TONES[hash % FALLBACK_TONES.length] ?? 'cyan',
      accentColor: FALLBACK_ACCENTS[hash % FALLBACK_ACCENTS.length] ?? '#2E7FB8',
      monogram: buildCompanyMonogram(displayName),
    };
  }

  const rawKey = normalizeKey(primarySegment || rawEntity);
  const displayName = primarySegment || rawEntity || '其他动态';
  const hash = hashString(rawKey || displayName);
  return {
    id: rawKey ? `raw:${rawKey}` : 'other',
    displayName,
    isKnown: false,
    isBuiltin: false,
    rawEntityKey: rawKey,
    logoUrl: null,
    tone: FALLBACK_TONES[hash % FALLBACK_TONES.length] ?? 'cyan',
    accentColor: FALLBACK_ACCENTS[hash % FALLBACK_ACCENTS.length] ?? '#2E7FB8',
    monogram: buildCompanyMonogram(displayName),
  };
}
