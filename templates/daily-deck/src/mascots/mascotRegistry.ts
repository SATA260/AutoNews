import type { PresetMascotId } from '../schema/newsSchema';

export interface MascotProfile {
  id: PresetMascotId;
  name: string;
  monogram: string;
  assetUrl: string | null;
}

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

export function getMascotProfile(id: PresetMascotId): MascotProfile {
  return MASCOT_REGISTRY[id] ?? MASCOT_REGISTRY.deepseek;
}
