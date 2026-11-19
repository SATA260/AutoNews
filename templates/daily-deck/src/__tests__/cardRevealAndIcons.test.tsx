import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NewsDeck } from '../components/deck/NewsDeck';
import { easeInOutSine } from '../components/deck/PageTransitionStage';
import {
  CARD_ICON_SET,
  FALLBACK_CARD_ICON,
  getCardIconComponent,
  inferCardIconFromText,
  PRESET_CARD_ICON_NAMES,
  resolvePresetIconName,
} from '../icons/cardIconSet';
import { sanitizeCardIcon, sanitizeDailyIssue } from '../schema/newsSchema';
import {
  CARD_REVEAL_DEADLINE_RATIO,
  CARD_REVEAL_FADE_MS,
  CARD_REVEAL_MIN_GAP_MS,
  computeCardRevealTimesMs,
  resolveCardRevealStates,
} from '../utils/cardReveal';
import { splitCardBody, trimCardTerminalPeriod } from '../utils/cardTypography';
import { mediaReadyTracker, transitionTiming } from '../utils/mediaReadyTracker';

beforeEach(() => {
  vi.spyOn(mediaReadyTracker, 'waitForAll').mockResolvedValue(undefined);
  vi.spyOn(transitionTiming, 'wait').mockResolvedValue(undefined);
});

describe('预置卡片图标', () => {
  it('预置 30 个图标，每个都能渲染出 SVG，兜底图标排在最后', () => {
    expect(PRESET_CARD_ICON_NAMES).toHaveLength(30);
    for (const name of PRESET_CARD_ICON_NAMES) {
      const Icon = CARD_ICON_SET[name].component;
      expect(Icon).toBeTruthy();
      expect(CARD_ICON_SET[name].meaning.length).toBeGreaterThan(0);
      const { container, unmount } = render(<Icon size={24} />);
      expect(container.querySelector('svg')).toBeInTheDocument();
      unmount();
    }
    expect(PRESET_CARD_ICON_NAMES.at(-1)).toBe(FALLBACK_CARD_ICON);
    expect(CARD_ICON_SET[FALLBACK_CARD_ICON].keywords).toBeNull();
  });

  it('旧版图标名映射到新图标，不认识的名字返回空', () => {
    expect(resolvePresetIconName('grid')).toBe('cloud');
    expect(resolvePresetIconName('clipboard-check')).toBe('trophy');
    expect(resolvePresetIconName(' Coins ')).toBe('coins');
    expect(resolvePresetIconName('not-an-icon')).toBeNull();
    expect(getCardIconComponent('not-an-icon')).toBe(CARD_ICON_SET.sparkles.component);
  });

  it('按标题优先、正文其次的顺序推断图标，修正原来常见的错配', () => {
    expect(inferCardIconFromText('估值对比', '高于5月私募轮的9650亿美元')).toBe('coins');
    expect(inferCardIconFromText('', '估值约1.5万亿美元')).toBe('coins');
    expect(inferCardIconFromText('API 降价七成', '百万输出价格降至0.65美元')).toBe('trending-down');
    expect(inferCardIconFromText('创始人套现', '七位联合创始人各套现约2.82亿美元')).toBe('coins');
    expect(inferCardIconFromText('11人团队', '微软365的AI代理由11名开发者打造')).toBe('users');
    expect(inferCardIconFromText('官方否认', '纳德拉称这不是用AI替代员工')).toBe('quote');
    expect(inferCardIconFromText('挂牌信息', '周四在纳斯达克开始交易')).toBe('candlestick');
    expect(inferCardIconFromText('买断规模', '向6万名员工提供买断方案')).toBe('user-minus');
    expect(inferCardIconFromText('一些说明', '没有任何可匹配的词')).toBe(FALLBACK_CARD_ICON);
  });

  it('数据清洗时保留合法图标、换算旧名、非法值按文案推断', () => {
    expect(sanitizeCardIcon('trophy', '任意', '任意')).toBe('trophy');
    expect(sanitizeCardIcon('grid', '任意', '任意')).toBe('cloud');
    expect(sanitizeCardIcon('bogus', '开源协议', 'MIT 协议开源')).toBe('unlock');
    expect(sanitizeCardIcon(undefined, '', '')).toBe(FALLBACK_CARD_ICON);
  });
});

describe('卡片正文排版', () => {
  it('去掉末尾句号，保留问号和叹号', () => {
    expect(trimCardTerminalPeriod('IPO定价每股83美元。')).toBe('IPO定价每股83美元');
    expect(trimCardTerminalPeriod('真的能降这么多？')).toBe('真的能降这么多？');
    expect(trimCardTerminalPeriod('直接冲榜第一！')).toBe('直接冲榜第一！');
  });

  it('把数字和单位识别成一个整体，每张卡最多强调两处', () => {
    const segs = splitCardBody('估值约1.5万亿美元，亚马逊持股14.7%，另有6万名员工');
    const figures = segs.filter((s) => s.kind === 'figure').map((s) => s.value);
    expect(figures).toEqual(['约1.5万亿美元', '14.7%']);
    expect(segs.map((s) => s.value).join('')).toBe(
      '估值约1.5万亿美元，亚马逊持股14.7%，另有6万名员工',
    );
  });

  it('不把型号、年份、月份日期和光秃秃的数字当作重点', () => {
    const figures = (text: string) =>
      splitCardBody(text)
        .filter((s) => s.kind === 'figure')
        .map((s) => s.value);
    expect(figures('GPT-5 与 H100 集群')).toEqual([]);
    expect(figures('2026年10月发布')).toEqual([]);
    expect(figures('区间为70至78美元')).toEqual(['78美元']);
    expect(figures('首字延迟仅220ms')).toEqual(['仅220ms']);
  });
});

describe('卡片跟着口播逐张出现', () => {
  const cues = [{ startSec: 0 }, { startSec: 6.8 }, { startSec: 15.2 }, { startSec: 23.9 }];

  it('有字幕时对齐句首，且不晚于口播 70% 处', () => {
    const speechMs = 28_000;
    const times = computeCardRevealTimesMs(3, cues, speechMs);
    expect(times).toEqual([0, 6800, 15_200]);
    expect(Math.max(...times)).toBeLessThanOrEqual(speechMs * CARD_REVEAL_DEADLINE_RATIO);
  });

  it('卡片比句子多时保持最小间隔，最晚时刻被截在口播 70% 处', () => {
    const times = computeCardRevealTimesMs(4, [{ startSec: 0 }, { startSec: 2 }], 10_000);
    for (let i = 1; i < times.length; i++) {
      expect(times[i]!).toBeGreaterThanOrEqual(times[i - 1]!);
    }
    expect(times[1]! - times[0]!).toBeGreaterThanOrEqual(CARD_REVEAL_MIN_GAP_MS);
    expect(Math.max(...times)).toBeLessThanOrEqual(10_000 * CARD_REVEAL_DEADLINE_RATIO);
  });

  it('没有字幕时在口播前 70% 均匀分布；0 张和 1 张卡的边界情况', () => {
    expect(computeCardRevealTimesMs(3, [], 20_000)).toEqual([0, 7000, 14_000]);
    expect(computeCardRevealTimesMs(0, cues, 20_000)).toEqual([]);
    expect(computeCardRevealTimesMs(1, cues, 20_000)).toEqual([0]);
  });

  it('第一张随页面出现，后续卡片淡入；高亮在新旧两张之间交接，口播结束后取消', () => {
    const times = [0, 6800, 15_200];
    const speechMs = 28_000;

    const atStart = resolveCardRevealStates(times, 0, speechMs);
    expect(atStart.map((s) => s.progress)).toEqual([1, 0, 0]);
    expect(atStart[0]!.isCurrent).toBe(true);

    const midFade = resolveCardRevealStates(times, 6800 + CARD_REVEAL_FADE_MS / 2, speechMs);
    expect(midFade[1]!.progress).toBeGreaterThan(0);
    expect(midFade[1]!.progress).toBeLessThan(1);
    expect(midFade[0]!.focus + midFade[1]!.focus).toBeCloseTo(1, 3);

    const later = resolveCardRevealStates(times, 20_000, speechMs);
    expect(later.map((s) => s.progress)).toEqual([1, 1, 1]);
    expect(later.map((s) => s.isCurrent)).toEqual([false, false, true]);

    const afterSpeech = resolveCardRevealStates(times, speechMs + 1000, speechMs);
    expect(afterSpeech.every((s) => s.focus === 0 && !s.isCurrent)).toBe(true);
  });

  it('只有一张卡时不做高亮', () => {
    const states = resolveCardRevealStates([0], 1000, 5000);
    expect(states).toEqual([{ progress: 1, focus: 0, isCurrent: false }]);
  });
});

describe('翻页渐变', () => {
  it('渐变曲线两端平缓、中点为一半', () => {
    expect(easeInOutSine(0)).toBe(0);
    expect(easeInOutSine(0.5)).toBeCloseTo(0.5, 6);
    expect(easeInOutSine(1)).toBe(1);
    expect(easeInOutSine(-1)).toBe(0);
  });
});

describe('逐帧渲染下的卡片显示', () => {
  const originalUrl = window.location.href;

  afterEach(() => {
    window.history.replaceState({}, '', originalUrl);
  });

  /** 构造一条或两条带多张卡片与字幕时间表的测试数据 */
  const buildIssue = (twoItems = false) => ({
    fps: 30,
    coverFrameCount: 60,
    outroFrameCount: 60,
    items: [
      {
        title: '逐张出现验证新闻',
        progressLabel: '逐张出现',
        summary: '验证卡片在逐帧渲染时跟着口播逐张出现。',
        frameCount: 600,
        speechDurationSec: 18,
        mascotId: 'none',
        cards: [
          { icon: 'candlestick', title: '定价', body: 'IPO定价每股83美元。' },
          { icon: 'coins', title: '估值', body: '估值约1.5万亿美元' },
          { icon: 'user-minus', title: '买断', body: '向6万名员工提供买断' },
        ],
        subtitles: [
          { text: '第一句', startSec: 0, endSec: 5 },
          { text: '第二句', startSec: 5, endSec: 10 },
          { text: '第三句', startSec: 10, endSec: 17 },
        ],
      },
      ...(twoItems
        ? [
            {
              title: '第二条验证新闻',
              progressLabel: '第二条',
              summary: '验证从第一条新闻渐变到第二条新闻时离场页卡片保持完整。',
              frameCount: 600,
              speechDurationSec: 18,
              mascotId: 'none',
              cards: [
                { icon: 'rocket', title: '发布', body: '新品正式发布上线' },
                { icon: 'zap', title: '提速', body: '端到端延迟降至 220ms' },
                { icon: 'gift', title: '配额', body: '面向开发者开放试用' },
              ],
              subtitles: [
                { text: '第一句', startSec: 0, endSec: 5 },
                { text: '第二句', startSec: 5, endSec: 10 },
                { text: '第三句', startSec: 10, endSec: 17 },
              ],
            },
          ]
        : []),
    ],
  });

  /** 读取当前页每张卡片的透明度 */
  const readCardOpacities = (container: HTMLElement): number[] =>
    Array.from(
      container.querySelectorAll<HTMLElement>('.page-sheet.is-active .news-info-card'),
    ).map((el) => Number(el.style.opacity || '1'));

  /** 读取离场页每张卡片的透明度 */
  const readExitingCardOpacities = (container: HTMLElement): number[] =>
    Array.from(
      container.querySelectorAll<HTMLElement>('.page-sheet.is-exiting .news-info-card'),
    ).map((el) => Number(el.style.opacity || '1'));

  it('翻页后只显示第一张卡，播到后段全部出齐；离场页保持完整；数字被强调且去掉句号', async () => {
    window.history.replaceState({}, '', '/?clock=manual&clean=1');
    const { container } = render(<NewsDeck initialData={buildIssue(true)} />);
    expect(sanitizeDailyIssue(buildIssue()).issue.items[0]!.cards).toHaveLength(3);

    const page1StartMs = 2000;
    // 翻页渐变进行到一半：新页只有第一张卡
    await act(async () => {
      await window.__NEWS_DECK__!.seekTo(page1StartMs + 300, 1000 / 30);
    });
    expect(readCardOpacities(container)).toEqual([1, 0, 0]);
    const entering = container.querySelector<HTMLElement>('.page-sheet.is-entering');
    expect(Number(entering!.style.opacity)).toBeCloseTo(0.5, 2);
    expect(entering!.style.transform).toBe('none');

    // 播到第三句之后：三张卡全部显示，最后一张高亮
    await act(async () => {
      await window.__NEWS_DECK__!.seekTo(page1StartMs + 12_000, 1000 / 30);
    });
    expect(readCardOpacities(container)).toEqual([1, 1, 1]);
    const cards = container.querySelectorAll('.page-sheet.is-active .news-info-card');
    expect(cards[2]).toHaveClass('is-current');
    expect(cards[0]!.querySelector('.info-card-icon svg')).toBeTruthy();
    expect(cards[0]!.querySelector('.card-figure')?.textContent).toBe('83美元');
    expect(cards[0]!.querySelector('.info-card-body')?.textContent).toBe('IPO定价每股83美元');

    // 第 1 条渐变切到第 2 条新闻的中间时刻：离场页（第 1 条）三张卡片保持全部可见，入场页（第 2 条）只有第 1 张可见
    const page2StartMs = 22_000;
    await act(async () => {
      await window.__NEWS_DECK__!.seekTo(page2StartMs + 300, 1000 / 30);
    });
    expect(readExitingCardOpacities(container)).toEqual([1, 1, 1]);
    expect(readCardOpacities(container)).toEqual([1, 0, 0]);
  });

  it('网址指定 reveal=all 时所有卡片一开始就全部显示', async () => {
    window.history.replaceState({}, '', '/?clock=manual&clean=1&reveal=all');
    const { container } = render(<NewsDeck initialData={buildIssue()} />);
    await act(async () => {
      await window.__NEWS_DECK__!.seekTo(2000 + 700, 1000 / 30);
    });
    expect(readCardOpacities(container)).toEqual([1, 1, 1]);
  });

  it('配置 speechStartSec 为 1 秒时，前 1 秒闭嘴且无字幕，1 秒后才开始播报并在播完后释放高亮', async () => {
    window.history.replaceState({}, '', '/?clock=manual&clean=1');
    const issue = {
      fps: 30,
      coverFrameCount: 60,
      outroFrameCount: 60,
      items: [
        {
          title: '播前静候一秒验证',
          progressLabel: '播前静候',
          summary: '验证切页后等待一秒再开始播报口播、字幕和口型。',
          frameCount: 600,
          speechStartSec: 1.0,
          speechDurationSec: 18,
          lipSyncFrames: Array.from({ length: 540 }, () => 0.75),
          mascotId: 'none',
          cards: [
            { icon: 'candlestick', title: '定价', body: 'IPO定价每股83美元' },
            { icon: 'coins', title: '估值', body: '估值约1.5万亿美元' },
            { icon: 'user-minus', title: '买断', body: '向6万名员工提供买断' },
          ],
          subtitles: [
            { text: '第一句从一秒后开始', startSec: 1.0, endSec: 6.5 },
            { text: '第二句接着出现', startSec: 6.5, endSec: 12.5 },
            { text: '第三句最后收尾', startSec: 12.5, endSec: 19.0 },
          ],
        },
      ],
    };

    const { container, queryByTestId } = render(<NewsDeck initialData={issue} />);
    const page1StartMs = 2000;

    // 切页后 500ms（仍在 1 秒静候期内）：闭嘴、无字幕、仅首卡出现
    const snapWait = await act(async () =>
      window.__NEWS_DECK__!.seekTo(page1StartMs + 500, 1000 / 30),
    );
    expect(snapWait.mouthOpen).toBe(0);
    expect(queryByTestId('deck-subtitle-text')).toBeNull();
    expect(readCardOpacities(container)).toEqual([1, 0, 0]);

    // 切页后 1500ms（口播开始 0.5s）：张嘴、第 1 句字幕出现
    const snapStart = await act(async () =>
      window.__NEWS_DECK__!.seekTo(page1StartMs + 1500, 1000 / 30),
    );
    expect(snapStart.mouthOpen).toBeCloseTo(0.75, 2);
    expect(queryByTestId('deck-subtitle-text')?.textContent).toContain('第一句从一秒后开始');

    // 切页后 18500ms（1s + 17.5s，仍在 18s 口播内）：张嘴、三卡全齐且最后一张仍高亮
    const snapBeforeEnd = await act(async () =>
      window.__NEWS_DECK__!.seekTo(page1StartMs + 18_500, 1000 / 30),
    );
    expect(snapBeforeEnd.mouthOpen).toBeCloseTo(0.75, 2);
    expect(readCardOpacities(container)).toEqual([1, 1, 1]);
    expect(container.querySelectorAll('.page-sheet.is-active .news-info-card')[2]).toHaveClass(
      'is-current',
    );

    // 切页后 19500ms（已过 1s + 18s = 19s）：闭嘴、所有卡片释放高亮
    const snapAfterEnd = await act(async () =>
      window.__NEWS_DECK__!.seekTo(page1StartMs + 19_500, 1000 / 30),
    );
    expect(snapAfterEnd.mouthOpen).toBe(0);
    const activeCards = Array.from(
      container.querySelectorAll('.page-sheet.is-active .news-info-card'),
    );
    expect(activeCards.every((el) => !el.classList.contains('is-current'))).toBe(true);
  });
});
