import type { PresetMascotId } from '../schema/newsSchema';

/** 单个角色形象的显示名称、缩写与图片路径定义 */
export interface MascotProfile {
  id: PresetMascotId;
  name: string;
  monogram: string;
  assetUrl: string | null;
}

/** 模板内置的 AI 角色立绘注册表 */
export const MASCOT_REGISTRY: Record<PresetMascotId, MascotProfile> = {
  deepseek: {
    id: 'deepseek',
    name: 'DeepSeek娘',
    monogram: 'DS',
    assetUrl: '/mascots/deepseek.png',
  },
  gpt: {
    id: 'gpt',
    name: 'GPT娘',
    monogram: 'GPT',
    assetUrl: '/mascots/gpt.png',
  },
  claude: {
    id: 'claude',
    name: 'Claude娘',
    monogram: 'CL',
    assetUrl: '/mascots/claude.png',
  },
  gemini: {
    id: 'gemini',
    name: 'Gemini娘',
    monogram: 'GM',
    assetUrl: '/mascots/gemini.png',
  },
  grok: {
    id: 'grok',
    name: 'Grok娘',
    monogram: 'GK',
    assetUrl: '/mascots/grok.png',
  },
  none: {
    id: 'none',
    name: '不显示角色',
    monogram: '',
    assetUrl: null,
  },
};

/** 根据角色标识读取形象资料，未找到时默认回退到 DeepSeek 娘 */
export function getMascotProfile(id: PresetMascotId): MascotProfile {
  return MASCOT_REGISTRY[id] ?? MASCOT_REGISTRY.deepseek;
}
