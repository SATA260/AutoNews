import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NewsDeck } from '../components/deck/NewsDeck';
import { PAGE_TURN_DURATION_MS } from '../components/deck/PageTransitionStage';
import { DeckErrorBoundary } from '../components/guard/DeckErrorBoundary';
import { SAMPLE_DAILY_ISSUE } from '../data/sampleIssue';
import { HARD_LIMITS, sanitizeDailyIssue } from '../schema/newsSchema';
import { mediaReadyTracker, transitionTiming } from '../utils/mediaReadyTracker';

beforeEach(() => {
  vi.spyOn(mediaReadyTracker, 'waitForAll').mockResolvedValue(undefined);
  vi.spyOn(transitionTiming, 'wait').mockResolvedValue(undefined);
});

describe('Layer 1: Zero-Throw Sanitizer & Editorial Contract Limits', () => {
  it('validates the built-in sample issue with zero warnings', () => {
    const res = sanitizeDailyIssue(SAMPLE_DAILY_ISSUE);
    expect(res.isClean).toBe(true);
    expect(res.warnings).toHaveLength(0);
    expect(res.issue.items).toHaveLength(5);
    expect(res.issue.hostMascotId).toBe('deepseek');
  });

  it('never throws on null, undefined, primitives, empty items, or pathological proxies', () => {
    const evilProxy = new Proxy(
      {},
      {
        get() {
          throw new Error('Evil getter!');
        },
      },
    );

    for (const bad of [
      null,
      undefined,
      'bad-string',
      42,
      {},
      { items: [] },
      { items: [null, 123, {}] },
      evilProxy,
    ]) {
      const res = sanitizeDailyIssue(bad);
      expect(res.issue.items.length).toBeGreaterThanOrEqual(1);
      expect(res.issue.items[0]!.summary.length).toBeGreaterThan(0);
      expect(res.warnings.length).toBeGreaterThan(0);
    }
  });

  it('clamps >12 items, preserves emoji surrogate pairs, strips unsafe URLs, and supports fractional TTS durations', () => {
    const longEmojiText = '🚀'.repeat(120);
    const items = Array.from({ length: 20 }).map((_, idx) => ({
      title: `${longEmojiText} 标题 #${idx}`,
      summary: `${'⚡'.repeat(60)} 总结`,
      imageUrl: idx === 0 ? 'javascript:alert(1)' : '/media/official-deepseek-report.svg',
      mascotId: idx === 0 ? 'unknown_bot' : idx === 1 ? 'claude' : 'deepseek',
      durationSec: idx === 1 ? 12.4 : 999,
    }));

    const res = sanitizeDailyIssue({ items });
    expect(res.issue.items).toHaveLength(HARD_LIMITS.maxItems);

    const first = res.issue.items[0]!;
    expect(Array.from(first.title).length).toBeLessThanOrEqual(HARD_LIMITS.title);
    expect(Array.from(first.summary).length).toBeLessThanOrEqual(HARD_LIMITS.summary);
    expect(first.title.includes('\uFFFD')).toBe(false);
    expect(first.imageUrl).toBeNull();
    expect(first.mascotId).toBe('deepseek');
    expect(first.durationSec).toBe(HARD_LIMITS.maxItemDurationSec);

    const second = res.issue.items[1]!;
    expect(second.durationSec).toBe(12.4);
    expect(res.warnings.some((w) => w.code === 'invalid_url')).toBe(true);
    expect(res.warnings.some((w) => w.code === 'clamped')).toBe(true);
  });
});

describe('Layer 2-5: Editorial Deck, 3D Page Turn, Corner Mascot & Error Isolation', () => {
  it('renders 7 editorial slides, shows DeepSeek corner mascot, and clamps bridge pagination safely', async () => {
    const { container } = render(<NewsDeck />);

    expect(window.__NEWS_DECK__).toBeDefined();
    expect(window.__NEWS_DECK__!.getPageCount()).toBe(7);
    expect(window.__NEWS_DECK__!.getCurrentPage()).toBe(0);
    expect(window.__NEWS_DECK__!.getState().transition).toBe('flip');
    expect(screen.getByText('今日要闻')).toBeInTheDocument();

    const mascotImg = container.querySelector('.corner-mascot-img') as HTMLImageElement | null;
    expect(mascotImg).toBeTruthy();
    expect(mascotImg!.getAttribute('src')).toBe('/mascots/deepseek.png');

    // Navigate to News #02 (Claude)
    await act(async () => {
      const target = await window.__NEWS_DECK__!.goToPage(2);
      expect(target).toBe(2);
    });
    expect(screen.getByText(/Claude 升级长程代码工作流/)).toBeInTheDocument();
    const claudeImg = container.querySelector('.corner-mascot-img') as HTMLImageElement | null;
    expect(claudeImg!.getAttribute('src')).toBe('/mascots/claude.png');

    // Out-of-bounds clamping
    await act(async () => {
      const clampedHigh = await window.__NEWS_DECK__!.goToPage(999);
      expect(clampedHigh).toBe(6);
    });
    expect(screen.getByText('本期速览')).toBeInTheDocument();

    await act(async () => {
      const clampedLow = await window.__NEWS_DECK__!.goToPage(-5);
      expect(clampedLow).toBe(0);
      const clampedNaN = await window.__NEWS_DECK__!.goToPage(Number.NaN);
      expect(clampedNaN).toBe(0);
    });

    expect(window.__NEWS_DECK__!.getHealthReport().runtimeErrors).toHaveLength(0);
  });

  it('mounts dual exiting/entering sheets during page turn, cleans up after transition, and cycles transition styles', async () => {
    vi.useFakeTimers();
    try {
      const { container } = render(<NewsDeck />);

      // Cycle transition style via T shortcut: flip -> glide -> shutter -> none -> flip
      fireEvent.keyDown(window, { key: 't' });
      expect(window.__NEWS_DECK__!.getState().transition).toBe('glide');
      fireEvent.keyDown(window, { key: 't' });
      expect(window.__NEWS_DECK__!.getState().transition).toBe('shutter');
      fireEvent.keyDown(window, { key: 't' });
      expect(window.__NEWS_DECK__!.getState().transition).toBe('none');
      fireEvent.keyDown(window, { key: 't' });
      expect(window.__NEWS_DECK__!.getState().transition).toBe('flip');

      // Trigger forward page turn
      fireEvent.click(screen.getByRole('button', { name: '下一页' }));

      const stage = container.querySelector('.page-turn-stage');
      expect(stage).toHaveClass('mode-flip', 'is-turning', 'dir-next');
      expect(container.querySelector('.page-sheet.is-exiting')).toBeInTheDocument();
      expect(container.querySelector('.page-sheet.is-active.is-entering')).toBeInTheDocument();

      // Advance past flip animation duration
      await act(async () => {
        vi.advanceTimersByTime(PAGE_TURN_DURATION_MS.flip + 20);
      });

      expect(container.querySelector('.page-sheet.is-exiting')).not.toBeInTheDocument();
      expect(container.querySelector('.page-turn-stage')).toHaveClass('is-settled');
    } finally {
      vi.useRealTimers();
    }
  });

  it('switches cleanly to the Official Disclosure Excerpt sheet when an official image fails to load', async () => {
    render(
      <NewsDeck
        initialData={{
          items: [
            {
              category: '视觉测试',
              title: '官方配图失效自动切换测试',
              summary: '官方引用图加载失败时无感切回官方披露摘录表格，零裂图零报错。',
              imageUrl: 'https://example.com/broken-official-chart.png',
              officialQuote: '“这里是官方公告原文摘录测试内容。”',
              metrics: [{ label: '降级模式', value: '官方摘录表' }],
              mascotId: 'deepseek',
            },
          ],
        }}
      />,
    );

    await act(async () => {
      await window.__NEWS_DECK__!.goToPage(1);
    });

    const img = screen.getByAltText('官方配图失效自动切换测试');
    fireEvent.error(img);

    await waitFor(() => {
      expect(screen.queryByAltText('官方配图失效自动切换测试')).not.toBeInTheDocument();
    });
    expect(screen.getByText('官方披露摘录 / PRIMARY SOURCE NOTES')).toBeInTheDocument();
    expect(screen.getByText('官方摘录表')).toBeInTheDocument();
    expect(window.__NEWS_DECK__!.getHealthReport().runtimeErrors).toHaveLength(0);
  });

  it('supports hiding mascot with mascotId="none", updates via setNewsData, and isolates child render errors', async () => {
    const { container } = render(<NewsDeck />);

    act(() => {
      const updateRes = window.__NEWS_DECK__!.setNewsData({
        issueTitle: 'AI 每日报',
        hostMascotId: 'none',
        mascotMode: 'fixed-host',
        items: [
          {
            title: '动态注入测试新闻',
            summary: '前端仅展示简短梗概与官方引用，不含主持人口播稿。',
            mascotId: 'gpt',
          },
        ],
      });
      expect(updateRes.ok).toBe(true);
      expect(updateRes.totalPages).toBe(3);
    });

    await act(async () => {
      await window.__NEWS_DECK__!.goToPage(1);
    });
    const activeSheet = container.querySelector('.page-sheet.is-active') as HTMLElement | null;
    expect(activeSheet).toBeTruthy();
    expect(activeSheet!.textContent).toContain('动态注入测试新闻');
    expect(container.querySelector('.corner-mascot-dock')).toBeNull();

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const BrokenChild = () => {
      throw new Error('Simulated crash');
    };
    render(
      <DeckErrorBoundary scopeName="unit-probe">
        <BrokenChild />
      </DeckErrorBoundary>,
    );
    expect(screen.getByTestId('boundary-fallback-unit-probe')).toBeInTheDocument();
    consoleSpy.mockRestore();
  });
});
