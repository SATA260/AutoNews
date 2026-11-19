import { act, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NewsDeck } from '../components/deck/NewsDeck';
import { sanitizeDailyIssue } from '../schema/newsSchema';
import { CARD_REVEAL_FADE_MS } from '../utils/cardReveal';
import {
  computeImageSpotlightWindow,
  easeInOutCubic,
  IMAGE_SPOTLIGHT_EXPAND_MS,
  IMAGE_SPOTLIGHT_MAX_HOLD_MS,
  IMAGE_SPOTLIGHT_RETRACT_MS,
  resolveImageSpotlightState,
} from '../utils/imageSpotlight';
import { mediaReadyTracker, transitionTiming } from '../utils/mediaReadyTracker';

beforeEach(() => {
  vi.spyOn(mediaReadyTracker, 'waitForAll').mockResolvedValue(undefined);
  vi.spyOn(transitionTiming, 'wait').mockResolvedValue(undefined);
});

describe('配图动态放大时间窗口计算', () => {
  it('缓动曲线在首尾平缓归零归壹、中点为一半', () => {
    expect(easeInOutCubic(-0.2)).toBe(0);
    expect(easeInOutCubic(0)).toBe(0);
    expect(easeInOutCubic(0.5)).toBeCloseTo(0.5, 6);
    expect(easeInOutCubic(1)).toBe(1);
    expect(easeInOutCubic(1.5)).toBe(1);
  });

  it('针对 20～30 秒真实新闻页，在末卡淡入后展开并停留 4.5～5.4 秒，切页前收回', () => {
    for (const [durMs, lastRevealMs] of [
      [27_500, 18_987],
      [22_733, 14_292],
    ] as const) {
      const win = computeImageSpotlightWindow(durMs, lastRevealMs);
      expect(win).not.toBeNull();
      const { expandStartMs, expandEndMs, retractStartMs, retractEndMs } = win!;
      const lastCardDoneMs = lastRevealMs + CARD_REVEAL_FADE_MS;

      expect(expandStartMs).toBeGreaterThan(lastCardDoneMs);
      expect(expandEndMs - expandStartMs).toBe(IMAGE_SPOTLIGHT_EXPAND_MS);
      expect(retractEndMs - retractStartMs).toBe(IMAGE_SPOTLIGHT_RETRACT_MS);
      const holdMs = retractStartMs - expandEndMs;
      expect(holdMs).toBeGreaterThanOrEqual(4500);
      expect(holdMs).toBeLessThanOrEqual(IMAGE_SPOTLIGHT_MAX_HOLD_MS);
      expect(retractEndMs).toBeLessThan(durMs);
    }
  });

  it('针对 8 秒短样例自动压缩窗口仍保留完整闭环；极短页面安全跳过', () => {
    const shortWin = computeImageSpotlightWindow(8000, 4000);
    expect(shortWin).not.toBeNull();
    expect(shortWin!.expandStartMs).toBeGreaterThan(4000 + CARD_REVEAL_FADE_MS);
    expect(shortWin!.retractEndMs).toBeLessThan(8000);
    expect(shortWin!.expandEndMs).toBeGreaterThan(shortWin!.expandStartMs);
    expect(shortWin!.retractStartMs).toBeGreaterThanOrEqual(shortWin!.expandEndMs);
    expect(shortWin!.retractEndMs).toBeGreaterThan(shortWin!.retractStartMs);

    expect(computeImageSpotlightWindow(3000, 0)).toBeNull();
    expect(computeImageSpotlightWindow(8000, 7200)).toBeNull();
    expect(computeImageSpotlightWindow(Number.NaN, 1000)).toBeNull();
  });

  it('单卡页面（末卡零延迟淡出）同样在页面后半段完成展开与收回', () => {
    const singleWin = computeImageSpotlightWindow(16_000, 0, 0);
    expect(singleWin).not.toBeNull();
    expect(singleWin!.retractStartMs - singleWin!.expandEndMs).toBe(IMAGE_SPOTLIGHT_MAX_HOLD_MS);
    expect(singleWin!.retractEndMs).toBeLessThan(16_000);
  });

  it('同一时刻重复查询状态输出完全一致（无历史依赖）', () => {
    const win = computeImageSpotlightWindow(25_000, 14_000)!;
    const sampleTimes = [
      0,
      win.expandStartMs - 10,
      win.expandStartMs + IMAGE_SPOTLIGHT_EXPAND_MS / 2,
      win.expandEndMs + 1000,
      win.retractStartMs + IMAGE_SPOTLIGHT_RETRACT_MS / 2,
      win.retractEndMs + 50,
    ];
    for (const ms of sampleTimes) {
      expect(resolveImageSpotlightState(win, ms)).toEqual(resolveImageSpotlightState(win, ms));
    }

    expect(resolveImageSpotlightState(win, win.expandStartMs)).toEqual({
      phase: 'idle',
      progress: 0,
    });
    const midExpand = resolveImageSpotlightState(win, (win.expandStartMs + win.expandEndMs) / 2);
    expect(midExpand.phase).toBe('expanding');
    expect(midExpand.progress).toBeCloseTo(0.5, 3);

    expect(resolveImageSpotlightState(win, win.expandEndMs + 10)).toEqual({
      phase: 'holding',
      progress: 1,
    });

    const midRetract = resolveImageSpotlightState(win, (win.retractStartMs + win.retractEndMs) / 2);
    expect(midRetract.phase).toBe('retracting');
    expect(midRetract.progress).toBeCloseTo(0.5, 3);

    expect(resolveImageSpotlightState(win, win.retractEndMs)).toEqual({
      phase: 'idle',
      progress: 0,
    });
  });
});

describe('逐帧渲染与预览态下的配图放大行为', () => {
  const originalUrl = window.location.href;

  afterEach(() => {
    window.history.replaceState({}, '', originalUrl);
  });

  const buildDeckData = (withSecondNews = false) => ({
    fps: 30,
    coverFrameCount: 60,
    outroFrameCount: 60,
    items: [
      {
        id: 'spot-item-1',
        title: '带图新闻从右向左动态放大测试',
        progressLabel: '动态放大测试',
        summary: '验证所有卡片出齐后配图从右向左展开铺满信息板，切页前收回右侧。',
        frameCount: 750,
        speechStartSec: 1,
        speechDurationSec: 22.5,
        imageUrl: '/media/official-deepseek-report.svg',
        imageCaption: '图｜官方性能对比图表',
        mascotId: 'gemini',
        cards: [
          { icon: 'rocket', title: '特性一', body: '第一张卡片随翻页出现' },
          { icon: 'gauge', title: '特性二', body: '第二张卡片对齐口播淡入' },
          { icon: 'coins', title: '特性三', body: '第三张卡片最晚七成时出现' },
        ],
        subtitles: [
          { text: '第一句开场介绍', startSec: 1, endSec: 7 },
          { text: '第二句补充指标', startSec: 7, endSec: 13 },
          { text: '第三句总结数据', startSec: 13, endSec: 23.5 },
        ],
      },
      ...(withSecondNews
        ? [
            {
              id: 'spot-item-2',
              title: '无配图对照新闻页',
              progressLabel: '无图对照',
              summary: '验证无图新闻不会出现放大遮罩，且切页时旧页配图已归位。',
              frameCount: 300,
              speechStartSec: 1,
              speechDurationSec: 8,
              imageUrl: null,
              mascotId: 'gemini',
              cards: [{ icon: 'sparkles', title: '要点', body: '纯文字卡片展示页' }],
              subtitles: [{ text: '纯卡片播报内容', startSec: 1, endSec: 9 }],
            },
          ]
        : []),
    ],
  });

  it('在逐帧渲染中完整经历常态 → 展开中 → 满板停留 → 收回中 → 归位，且不复制图片节点', async () => {
    window.history.replaceState({}, '', '/?clock=manual&clean=1');
    const { container } = render(<NewsDeck initialData={buildDeckData(true)} />);

    const page1StartMs = 2000;
    const expectedWin = computeImageSpotlightWindow(25_000, 13_000)!;
    const getActiveFigure = () =>
      container.querySelector('.page-sheet.is-active .official-plate-figure') as HTMLElement;
    const getActiveRefCol = () =>
      container.querySelector('.page-sheet.is-active .news-reference-col') as HTMLElement;

    // 1. 卡片尚在出场期间：常态分栏
    await act(async () => {
      await window.__NEWS_DECK__!.seekTo(page1StartMs + 8000, 1000 / 30);
    });
    expect(getActiveFigure().dataset.spotlightPhase).toBe('idle');
    expect(getActiveFigure().style.getPropertyValue('--spotlight-p')).toBe('0');
    expect(getActiveFigure()).not.toHaveClass('is-spotlight-active');

    // 2. 展开中段：左缘与宽高比例平滑插值，且全页仅保留唯一 img 元素
    const midExpandMs = (expectedWin.expandStartMs + expectedWin.expandEndMs) / 2;
    await act(async () => {
      await window.__NEWS_DECK__!.seekTo(page1StartMs + midExpandMs, 1000 / 30);
    });
    expect(getActiveFigure().dataset.spotlightPhase).toBe('expanding');
    const midExpandProgress = Number(getActiveFigure().style.getPropertyValue('--spotlight-p'));
    expect(midExpandProgress).toBeGreaterThan(0.2);
    expect(midExpandProgress).toBeLessThan(0.8);
    expect(getActiveRefCol()).toHaveClass('is-spotlight-active');

    // 3. 满板放大停留期：进度为 1，遮罩生效，依然只有唯一 1 张 img
    const holdMs = (expectedWin.expandEndMs + expectedWin.retractStartMs) / 2;
    await act(async () => {
      await window.__NEWS_DECK__!.seekTo(page1StartMs + holdMs, 1000 / 30);
    });
    expect(getActiveFigure().dataset.spotlightPhase).toBe('holding');
    expect(getActiveFigure().style.getPropertyValue('--spotlight-p')).toBe('1');
    expect(getActiveFigure()).toHaveClass('is-spotlight-active');
    expect(container.querySelectorAll('.page-sheet.is-active .official-media-img')).toHaveLength(1);

    // 4. 收回中段：从左向右退回右侧
    const midRetractMs = (expectedWin.retractStartMs + expectedWin.retractEndMs) / 2;
    await act(async () => {
      await window.__NEWS_DECK__!.seekTo(page1StartMs + midRetractMs, 1000 / 30);
    });
    expect(getActiveFigure().dataset.spotlightPhase).toBe('retracting');
    const midRetractProgress = Number(getActiveFigure().style.getPropertyValue('--spotlight-p'));
    expect(midRetractProgress).toBeGreaterThan(0.2);
    expect(midRetractProgress).toBeLessThan(0.8);

    // 5. 切页前已彻底归位
    await act(async () => {
      await window.__NEWS_DECK__!.seekTo(page1StartMs + 24_800, 1000 / 30);
    });
    expect(getActiveFigure().dataset.spotlightPhase).toBe('idle');
    expect(getActiveFigure().style.getPropertyValue('--spotlight-p')).toBe('0');
    expect(getActiveFigure()).not.toHaveClass('is-spotlight-active');

    // 6. 翻入第 2 条无图新闻时：离场旧页配图保持归位，当前无图页不渲染放大遮罩
    const page2StartMs = 27_000;
    await act(async () => {
      await window.__NEWS_DECK__!.seekTo(page2StartMs + 300, 1000 / 30);
    });
    const exitingFig = container.querySelector(
      '.page-sheet.is-exiting .official-plate-figure',
    ) as HTMLElement;
    expect(exitingFig.dataset.spotlightPhase).toBe('idle');
    expect(exitingFig.dataset.spotlightProgress).toBe('0.0000');
    expect(
      container.querySelector('.page-sheet.is-active .image-spotlight-scrim'),
    ).not.toBeInTheDocument();
  });

  it('指定 reveal=all 或 motion=static 时关闭自动展开放大', async () => {
    window.history.replaceState({}, '', '/?clock=manual&clean=1&reveal=all');
    const { container } = render(<NewsDeck initialData={buildDeckData(false)} />);
    const win = computeImageSpotlightWindow(25_000, 13_000)!;
    await act(async () => {
      await window.__NEWS_DECK__!.seekTo(
        2000 + (win.expandEndMs + win.retractStartMs) / 2,
        1000 / 30,
      );
    });
    const fig = container.querySelector(
      '.page-sheet.is-active .official-plate-figure',
    ) as HTMLElement;
    expect(fig.dataset.spotlightPhase).toBe('idle');
    expect(fig.style.getPropertyValue('--spotlight-p')).toBe('0');
  });

  it('预览台暂停浏览时支持点击配图手动放大与收起，翻页后自动复位', async () => {
    window.history.replaceState({}, '', '/?clean=1');
    const { container } = render(<NewsDeck initialData={buildDeckData(true)} />);

    await act(async () => {
      await window.__NEWS_DECK__!.goToPage(1);
    });

    const getActiveFigure = () =>
      container.querySelector('.page-sheet.is-active .official-plate-figure') as HTMLElement;
    expect(getActiveFigure()).toHaveClass('is-manual-toggleable');
    expect(getActiveFigure().dataset.spotlightPhase).toBe('idle');

    fireEvent.click(getActiveFigure());
    expect(getActiveFigure().dataset.spotlightPhase).toBe('holding');
    expect(getActiveFigure().style.getPropertyValue('--spotlight-p')).toBe('1');

    fireEvent.click(getActiveFigure());
    expect(getActiveFigure().dataset.spotlightPhase).toBe('idle');
    expect(getActiveFigure().style.getPropertyValue('--spotlight-p')).toBe('0');

    // 先放大，再翻去别的页后切回，应恢复为未放大常态
    fireEvent.click(getActiveFigure());
    expect(getActiveFigure().dataset.spotlightPhase).toBe('holding');

    await act(async () => {
      await window.__NEWS_DECK__!.goToPage(2);
    });
    await act(async () => {
      await window.__NEWS_DECK__!.goToPage(1);
    });
    expect(getActiveFigure().dataset.spotlightPhase).toBe('idle');
  });

  it('每条新闻强制只展示一张图片，忽略传入的 secondaryImageUrl', async () => {
    window.history.replaceState({}, '', '/?clean=1');
    const rawWithSecondary = {
      ...buildDeckData(false),
      items: [
        {
          ...buildDeckData(false).items[0]!,
          secondaryImageUrl: '/media/official-openai-bench.svg',
        },
      ],
    };
    const sanitized = sanitizeDailyIssue(rawWithSecondary);
    expect(sanitized.issue.items[0]?.secondaryImageUrl).toBeNull();

    const { container } = render(<NewsDeck initialData={rawWithSecondary} />);
    await act(async () => {
      await window.__NEWS_DECK__!.goToPage(1);
    });
    expect(container.querySelectorAll('.page-sheet.is-active .official-media-img')).toHaveLength(1);
    expect(container.querySelector('.page-sheet.is-active .is-two-up')).toBeNull();
  });
});
