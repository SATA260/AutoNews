import {
  Banknote,
  BrainCircuit,
  Building2,
  CalendarDays,
  ChartCandlestick,
  Cloud,
  Code2,
  Coins,
  Cpu,
  Database,
  FlaskConical,
  Gauge,
  Gavel,
  Gift,
  Globe,
  Handshake,
  Landmark,
  LockOpen,
  type LucideIcon,
  Quote,
  Rocket,
  ShieldCheck,
  Smartphone,
  Sparkles,
  TrendingDown,
  TrendingUp,
  TriangleAlert,
  Trophy,
  UserMinus,
  Users,
  Zap,
} from 'lucide-react';

/** 单个预置卡片图标的登记信息：画面上用的图标组件、中文含义、自动匹配用的关键词 */
export interface CardIconEntry {
  /** 实际渲染的线条图标组件 */
  component: LucideIcon;
  /** 图标代表的事实类型（中文），同时用于提示词里的对照说明 */
  meaning: string;
  /** 卡片标题或正文命中这些关键词时自动选用该图标；为空表示只作兜底，不参与自动匹配 */
  keywords: RegExp | null;
}

/**
 * 全部预置卡片图标（键名就是数据里 cards[].icon 的取值）。
 * 排列顺序就是自动匹配的优先级：越具体的类型越靠前，越宽泛的越靠后，最后一项是兜底图标。
 */
export const CARD_ICON_SET = {
  'user-minus': {
    component: UserMinus,
    meaning: '裁员/离职/人事变动',
    keywords: /裁员|离职|买断|解雇|辞职|出走|离任|卸任/,
  },
  gavel: {
    component: Gavel,
    meaning: '诉讼/法律',
    keywords: /诉讼|起诉|判决|法院|官司|侵权|罚款|罚金|和解|法律/,
  },
  landmark: {
    component: Landmark,
    meaning: '政策/监管',
    keywords: /监管|政策|法案|政府|立法|禁令|管制|审查|牌照|备案/,
  },
  handshake: {
    component: Handshake,
    meaning: '合作/收购',
    keywords: /合作|收购|并购|伙伴|联手|签约|结盟|携手/,
  },
  candlestick: {
    component: ChartCandlestick,
    meaning: '上市/股价/市值',
    keywords: /上市|IPO|股价|市值|股票|挂牌|纳斯达克|纽交所|港交所|持股|股东|股权/i,
  },
  coins: {
    component: Coins,
    meaning: '融资/估值',
    keywords: /融资|估值|投资|募资|私募|认购|注资|套现|[A-H天种]轮/,
  },
  gift: {
    component: Gift,
    meaning: '免费/优惠/配额',
    keywords: /免费|优惠|折扣|限时|福利|配额|赠送|额度|试用/,
  },
  'trending-down': {
    component: TrendingDown,
    meaning: '降价/下降',
    keywords: /降价|下降|降低|减少|下滑|下跌|降至|直降|降幅|缩水|砍半/,
  },
  'trending-up': {
    component: TrendingUp,
    meaning: '增长/上涨',
    keywords: /增长|上涨|翻倍|增至|涨价|涨幅|新高|激增|飙升|提升至/,
  },
  banknote: {
    component: Banknote,
    meaning: '价格/收入/金额',
    keywords: /价格|定价|收费|售价|计费|收入|营收|利润|订阅|付费|成本|美元|元/,
  },
  trophy: {
    component: Trophy,
    meaning: '评测/榜单/排名',
    keywords: /评测|基准|榜单|排名|跑分|第一|夺冠|SOTA|击败|超越|测试|得分/i,
  },
  unlock: {
    component: LockOpen,
    meaning: '开源/开放权重',
    keywords: /开源|开放权重|权重|MIT|Apache|许可证/i,
  },
  code: {
    component: Code2,
    meaning: '开发者/API/代码',
    keywords: /代码|编程|开发者|API|SDK|接口|工程师|编码|Copilot|IDE/i,
  },
  cpu: {
    component: Cpu,
    meaning: '芯片/算力/硬件规格',
    keywords: /芯片|GPU|TPU|NPU|算力|显卡|晶圆|英伟达|Nvidia|服务器|数据中心/i,
  },
  zap: {
    component: Zap,
    meaning: '速度/延迟',
    keywords: /延迟|速度|响应|毫秒|加速|提速|秒级|实时/,
  },
  gauge: {
    component: Gauge,
    meaning: '性能/吞吐/效率',
    keywords: /性能|吞吐|效率|能耗|功耗|能效/,
  },
  shield: {
    component: ShieldCheck,
    meaning: '安全/隐私',
    keywords: /安全|隐私|防护|加密|合规|对齐|护栏|防御/,
  },
  flask: {
    component: FlaskConical,
    meaning: '研究/论文/实验',
    keywords: /研究|论文|实验|科学|实验室|研究院/,
  },
  database: {
    component: Database,
    meaning: '数据/上下文',
    keywords: /数据|上下文|Tokens?|训练集|语料|存储|记忆|检索/i,
  },
  rocket: {
    component: Rocket,
    meaning: '发布上线',
    keywords: /发布|推出|上线|亮相|首发|新版|升级|更新|问世/,
  },
  brain: {
    component: BrainCircuit,
    meaning: '模型能力',
    keywords: /模型|推理|参数|智能体|Agent|多模态|能力/i,
  },
  smartphone: {
    component: Smartphone,
    meaning: '产品/应用/终端',
    keywords: /手机|应用|App|终端|设备|眼镜|耳机|硬件|产品|功能/i,
  },
  cloud: {
    component: Cloud,
    meaning: '云服务/平台接入',
    keywords: /云|平台|接入|部署|集成|上架|生态|浏览器|渠道/,
  },
  users: {
    component: Users,
    meaning: '用户/团队规模',
    keywords: /用户|团队|员工|成员|社区|月活|日活|人数|规模/,
  },
  quote: {
    component: Quote,
    meaning: '官方表态/人物原话',
    keywords: /表示|回应|表态|否认|声明|原话|采访|透露|强调|称/,
  },
  alert: {
    component: TriangleAlert,
    meaning: '风险/争议/未证实',
    keywords: /风险|争议|质疑|未证实|未确认|传闻|漏洞|事故|故障|批评|担忧|隐患/,
  },
  building: {
    component: Building2,
    meaning: '公司/业务调整',
    keywords: /公司|业务|部门|组织|重组|转型|战略|总部/,
  },
  globe: {
    component: Globe,
    meaning: '地区/国际',
    keywords: /全球|国际|海外|欧洲|欧盟|美国|中国|日本|韩国|印度|地区|多语言|国家/,
  },
  calendar: {
    component: CalendarDays,
    meaning: '时间/日程',
    keywords: /时间|日期|周[一二三四五六日]|日起|将于|截止|发布会|年底|季度/,
  },
  sparkles: {
    component: Sparkles,
    meaning: '其他亮点（兜底）',
    keywords: null,
  },
} as const satisfies Record<string, CardIconEntry>;

/** 预置卡片图标的标识名称 */
export type PresetCardIconName = keyof typeof CARD_ICON_SET;

/** 旧版图标名到新图标的映射，保证历史数据照常显示 */
export const LEGACY_ICON_ALIASES = {
  grid: 'cloud',
  'clipboard-check': 'trophy',
} as const satisfies Record<string, PresetCardIconName>;

/** 卡片数据里允许出现的全部图标名（预置图标 + 旧版兼容名） */
export type CardIconName = PresetCardIconName | keyof typeof LEGACY_ICON_ALIASES;

/** 全部预置图标名，按自动匹配优先级排列 */
export const PRESET_CARD_ICON_NAMES = Object.keys(CARD_ICON_SET) as PresetCardIconName[];

/** 没有任何关键词命中时使用的兜底图标 */
export const FALLBACK_CARD_ICON: PresetCardIconName = 'sparkles';

/** 把图标名（含旧版名）换算成实际要画的预置图标；不认识的名字返回空 */
export function resolvePresetIconName(raw: string): PresetCardIconName | null {
  const key = raw.trim().toLowerCase();
  if (Object.hasOwn(CARD_ICON_SET, key)) {
    return key as PresetCardIconName;
  }
  if (Object.hasOwn(LEGACY_ICON_ALIASES, key)) {
    return LEGACY_ICON_ALIASES[key as keyof typeof LEGACY_ICON_ALIASES];
  }
  return null;
}

/** 在一段文字里按优先级找出第一个关键词命中的图标，都没命中时返回空 */
function matchIconByKeywords(text: string): PresetCardIconName | null {
  if (!text.trim()) {
    return null;
  }
  for (const name of PRESET_CARD_ICON_NAMES) {
    const keywords = CARD_ICON_SET[name].keywords;
    if (keywords?.test(text)) {
      return name;
    }
  }
  return null;
}

/** 根据卡片标题和正文推断最贴切的图标：先只看标题，标题没命中再看正文，都没命中用兜底图标 */
export function inferCardIconFromText(title: string, body: string): PresetCardIconName {
  return matchIconByKeywords(title) ?? matchIconByKeywords(body) ?? FALLBACK_CARD_ICON;
}

/** 按图标名取出对应的线条图标组件，不认识的名字使用兜底图标 */
export function getCardIconComponent(name: string): LucideIcon {
  const preset = resolvePresetIconName(name) ?? FALLBACK_CARD_ICON;
  return CARD_ICON_SET[preset].component;
}
