import {
  type CoverCardTone,
  type ResolvedCompanyVisual,
  resolveItemCompany,
} from '../logos/companyRegistry';
import type { SanitizedNewsItem } from '../schema/newsSchema';

/** 瀑布流卡片内部的单条新闻展示项 */
export interface CoverWaterfallEntry {
  item: SanitizedNewsItem;
  originalIndex: number;
  company: ResolvedCompanyVisual;
}

/** 瀑布流中的单个分组卡片（要闻置顶卡、单公司卡或混合其他动态卡） */
export interface CoverWaterfallGroup {
  key: string;
  kind: 'featured' | 'company' | 'other';
  title: string;
  tone: CoverCardTone;
  accentColor: string;
  headerCompany: ResolvedCompanyVisual | null;
  showItemLogos: boolean;
  items: CoverWaterfallEntry[];
}

/** 双列瀑布流排布后的列结构 */
export interface CoverWaterfallColumns {
  singleColumn: boolean;
  left: CoverWaterfallGroup[];
  right: CoverWaterfallGroup[];
}

const CARD_TONE_CYCLE: readonly Exclude<CoverCardTone, 'featured'>[] = [
  'amber',
  'emerald',
  'violet',
  'rose',
  'olive',
  'cyan',
];

const ACCENT_BY_TONE: Record<CoverCardTone, string> = {
  featured: '#1F84B5',
  amber: '#C76B38',
  emerald: '#208B82',
  violet: '#6D5CC4',
  rose: '#C25474',
  olive: '#6B8F38',
  cyan: '#2E76B8',
};

/** 将期次日期格式化为居中的“YYYY-MM-DD 资讯概览”主标题 */
export function formatOverviewDateTitle(rawDate: string): string {
  const trimmed = rawDate.trim();
  const isoMatch = /^(\d{4})[./-](\d{1,2})[./-](\d{1,2})$/.exec(trimmed);
  if (isoMatch) {
    const year = isoMatch[1];
    const month = isoMatch[2]!.padStart(2, '0');
    const day = isoMatch[3]!.padStart(2, '0');
    return `${year}-${month}-${day} 资讯概览`;
  }
  return trimmed ? `${trimmed} 资讯概览` : '今日资讯概览';
}

/** 估算单个瀑布流卡片在双列布局中的相对视觉高度，用于确定性均衡分列 */
function estimateGroupHeightWeight(group: { items: readonly CoverWaterfallEntry[] }): number {
  let weight = 108;
  for (const entry of group.items) {
    const charLen = Array.from(entry.item.shortTitle).length;
    const estLines = charLen > 24 ? 2 : 1;
    weight += estLines * 34 + 10;
  }
  return weight;
}

/** 为公司或混合卡片挑选色调：避开全局上一张卡片与同列上一张卡片的色调，并与要闻蓝青色拉开区分 */
function pickCardTone(
  preferred: Exclude<CoverCardTone, 'featured'>,
  avoidTones: ReadonlySet<CoverCardTone>,
): Exclude<CoverCardTone, 'featured'> {
  const isConflicting = (candidate: Exclude<CoverCardTone, 'featured'>): boolean =>
    avoidTones.has(candidate) || (avoidTones.has('featured') && candidate === 'cyan');

  if (!isConflicting(preferred)) {
    return preferred;
  }
  const startIdx = Math.max(0, CARD_TONE_CYCLE.indexOf(preferred));
  for (let offset = 1; offset < CARD_TONE_CYCLE.length; offset++) {
    const candidate = CARD_TONE_CYCLE[(startIdx + offset) % CARD_TONE_CYCLE.length]!;
    if (!isConflicting(candidate)) {
      return candidate;
    }
  }
  return preferred;
}

/**
 * 将本期新闻分组组装为瀑布流卡片序列：
 * - 总条数 >= 5 时取前 2 条进左上角「★ 要闻」，2~4 条时取第 1 条进「★ 要闻」；
 * - 其余条目按规范公司聚类成卡，与编排后的播出顺序完全一致；
 * - 既非内置厂商又无本地 Logo 的单条长尾实体，若有 2 条及以上则合并为末尾「其他动态」。
 */
export function buildCoverWaterfallGroups(
  items: readonly SanitizedNewsItem[],
): CoverWaterfallGroup[] {
  if (items.length === 0) {
    return [];
  }

  const resolvedAll: CoverWaterfallEntry[] = items.map((item, idx) => ({
    item,
    originalIndex: idx,
    company: resolveItemCompany(item),
  }));

  if (resolvedAll.length === 1) {
    const only = resolvedAll[0]!;
    return [
      {
        key: 'featured',
        kind: 'featured',
        title: '要闻',
        tone: 'featured',
        accentColor: ACCENT_BY_TONE.featured,
        headerCompany: null,
        showItemLogos: true,
        items: [only],
      },
    ];
  }

  const featuredCount = resolvedAll.length >= 5 ? 2 : 1;
  const featuredEntries = resolvedAll.slice(0, featuredCount);
  const restEntries = resolvedAll.slice(featuredCount);

  interface ClassifiedRest {
    entry: CoverWaterfallEntry;
    groupKey: string;
    isStandaloneCandidate: boolean;
  }

  const classified: ClassifiedRest[] = [];
  const rawCounts = new Map<string, number>();

  for (const entry of restEntries) {
    const isDirectKnown = entry.company.isKnown || Boolean(entry.company.logoUrl);
    const groupKey = isDirectKnown
      ? `company:${entry.company.id}`
      : entry.company.rawEntityKey
        ? `raw:${entry.company.rawEntityKey}`
        : '__none__';

    if (!isDirectKnown && entry.company.rawEntityKey) {
      rawCounts.set(groupKey, (rawCounts.get(groupKey) ?? 0) + 1);
    }

    classified.push({
      entry,
      groupKey,
      isStandaloneCandidate: isDirectKnown,
    });
  }

  let singleUnlistedNamedCount = 0;
  for (const c of classified) {
    if (!c.isStandaloneCandidate && c.groupKey !== '__none__') {
      if ((rawCounts.get(c.groupKey) ?? 0) === 1) {
        singleUnlistedNamedCount += 1;
      }
    }
  }

  const standaloneGroupsMap = new Map<string, CoverWaterfallEntry[]>();
  const standaloneOrder: string[] = [];
  const otherEntries: CoverWaterfallEntry[] = [];

  for (const c of classified) {
    const count = rawCounts.get(c.groupKey) ?? 0;
    const shouldMergeIntoOther =
      c.groupKey === '__none__' ||
      (!c.isStandaloneCandidate && count === 1 && singleUnlistedNamedCount >= 2);

    if (shouldMergeIntoOther) {
      otherEntries.push(c.entry);
      continue;
    }

    const bucket = standaloneGroupsMap.get(c.groupKey);
    if (bucket) {
      bucket.push(c.entry);
    } else {
      standaloneGroupsMap.set(c.groupKey, [c.entry]);
      standaloneOrder.push(c.groupKey);
    }
  }

  const featuredGroup: CoverWaterfallGroup = {
    key: 'featured',
    kind: 'featured',
    title: '要闻',
    tone: 'featured',
    accentColor: ACCENT_BY_TONE.featured,
    headerCompany: null,
    showItemLogos: true,
    items: featuredEntries,
  };

  const groups: CoverWaterfallGroup[] = [featuredGroup];
  let leftWeight = estimateGroupHeightWeight(featuredGroup);
  let rightWeight = 0;
  let lastLeftTone: CoverCardTone = 'featured';
  let lastRightTone: CoverCardTone | null = null;
  let prevTone: CoverCardTone = 'featured';

  const assignTargetColumnAndTone = (
    entries: readonly CoverWaterfallEntry[],
    preferredTone: Exclude<CoverCardTone, 'featured'>,
  ): CoverCardTone => {
    const goLeft = groups.length === 1 ? false : leftWeight <= rightWeight;
    const colLastTone = goLeft ? lastLeftTone : lastRightTone;
    const avoid = new Set<CoverCardTone>([prevTone]);
    if (colLastTone) {
      avoid.add(colLastTone);
    }
    const tone = pickCardTone(preferredTone, avoid);
    const weight = estimateGroupHeightWeight({ items: entries });
    if (goLeft) {
      leftWeight += weight;
      lastLeftTone = tone;
    } else {
      rightWeight += weight;
      lastRightTone = tone;
    }
    prevTone = tone;
    return tone;
  };

  for (const key of standaloneOrder) {
    const entries = standaloneGroupsMap.get(key) ?? [];
    const leadCompany = entries[0]?.company;
    if (!leadCompany) {
      continue;
    }
    const tone = assignTargetColumnAndTone(entries, leadCompany.tone);
    groups.push({
      key,
      kind: 'company',
      title: leadCompany.displayName,
      tone,
      accentColor: ACCENT_BY_TONE[tone],
      headerCompany: leadCompany,
      showItemLogos: false,
      items: entries,
    });
  }

  if (otherEntries.length > 0) {
    const tone = assignTargetColumnAndTone(otherEntries, 'cyan');
    groups.push({
      key: 'other',
      kind: 'other',
      title: '其他动态',
      tone,
      accentColor: ACCENT_BY_TONE[tone],
      headerCompany: null,
      showItemLogos: true,
      items: otherEntries,
    });
  }

  return groups;
}

/**
 * 将瀑布流分组分配到左右两列：
 * 首张卡固定在左上，第二张卡固定在右上，后续卡片依次放入当前估算高度较矮的一列。
 */
export function assignMasonryColumns(
  groups: readonly CoverWaterfallGroup[],
): CoverWaterfallColumns {
  if (groups.length <= 1) {
    return {
      singleColumn: true,
      left: [...groups],
      right: [],
    };
  }

  const left: CoverWaterfallGroup[] = [];
  const right: CoverWaterfallGroup[] = [];
  let leftWeight = 0;
  let rightWeight = 0;

  groups.forEach((group, idx) => {
    const w = estimateGroupHeightWeight(group);
    if (idx === 0) {
      left.push(group);
      leftWeight += w;
    } else if (idx === 1) {
      right.push(group);
      rightWeight += w;
    } else if (leftWeight <= rightWeight) {
      left.push(group);
      leftWeight += w;
    } else {
      right.push(group);
      rightWeight += w;
    }
  });

  return {
    singleColumn: false,
    left,
    right,
  };
}
