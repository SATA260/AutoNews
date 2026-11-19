import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NewsDeck } from '../components/deck/NewsDeck';
import { CoverPage } from '../components/pages/CoverPage';
import { resolveItemCompany } from '../logos/companyRegistry';
import { sanitizeDailyIssue } from '../schema/newsSchema';
import {
  assignMasonryColumns,
  buildCoverWaterfallGroups,
  formatOverviewDateTitle,
} from '../utils/coverOverview';
import { computeCoverScrollState } from '../utils/coverScroll';
import { mediaReadyTracker, transitionTiming } from '../utils/mediaReadyTracker';

const originalUrl = window.location.href;

beforeEach(() => {
  vi.spyOn(mediaReadyTracker, 'waitForAll').mockResolvedValue(undefined);
  vi.spyOn(transitionTiming, 'wait').mockResolvedValue(undefined);
});

afterEach(() => {
  window.history.replaceState({}, '', originalUrl);
});

describe('Cover Waterfall Overview & Company Logos', () => {
  it('formats overview date titles cleanly', () => {
    expect(formatOverviewDateTitle('2026.11.19')).toBe('2026-11-19 资讯概览');
    expect(formatOverviewDateTitle('2026-11-5')).toBe('2026-11-05 资讯概览');
    expect(formatOverviewDateTitle('今日速递')).toBe('今日速递 资讯概览');
  });

  it('prevents false-positive alias matches on Muse Spark, intelligence, and metadata', () => {
    const res = sanitizeDailyIssue({
      items: [
        {
          title: 'Meta 发布 Muse Spark 模型家族',
          shortTitle: 'Meta发布Muse Spark',
          summary: 'Meta 推出多模态推理新模型。',
          source: 'Meta AI Blog',
        },
        {
          title: 'Artificial Intelligence 评测综述更新',
          shortTitle: 'AI评测方法更新',
          summary: '梳理常见评测基准元数据 metadata 规范。',
          source: 'AI Weekly',
        },
      ],
    });

    const firstCompany = resolveItemCompany(res.issue.items[0]!);
    expect(firstCompany.id).toBe('meta');
    expect(firstCompany.logoUrl).toBe('/logos/meta.svg');

    const secondCompany = resolveItemCompany(res.issue.items[1]!);
    expect(secondCompany.isKnown).toBe(false);
    expect(secondCompany.logoUrl).toBeNull();
  });

  it('groups 1, 5, 10, and 12 items into featured, company cards, and merged other card', () => {
    const single = sanitizeDailyIssue({
      items: [{ entity: 'OpenAI', shortTitle: 'OpenAI发布新接口', title: 'T1', summary: 'S1' }],
    }).issue;
    const singleGroups = buildCoverWaterfallGroups(single.items);
    expect(singleGroups).toHaveLength(1);
    expect(singleGroups[0]?.kind).toBe('featured');
    expect(assignMasonryColumns(singleGroups).singleColumn).toBe(true);

    const ten = sanitizeDailyIssue({
      date: '2026.11.19',
      items: [
        { entity: 'Google DeepMind', shortTitle: 'Gemini 4 Neon发布', title: 'T1', summary: 'S1' },
        { entity: 'Meta', shortTitle: 'Meta发布Muse Spark', title: 'T2', summary: 'S2' },
        { entity: 'Google DeepMind', shortTitle: 'Google开放Genie 4', title: 'T3', summary: 'S3' },
        { entity: 'Meta', shortTitle: 'Meta推Muse视觉模型', title: 'T4', summary: 'S4' },
        { entity: '腾讯混元', shortTitle: '混元Hy4 flash登顶', title: 'T5', summary: 'S5' },
        { entity: 'Kling', shortTitle: '可灵Image 4.0发布', title: 'T6', summary: 'S6' },
        { entity: '范式智能', shortTitle: '范式智能发Phai双基模', title: 'T7', summary: 'S7' },
        { entity: 'Hugging Face', shortTitle: 'Rumble-2-Flash开源', title: 'T8', summary: 'S8' },
        { entity: 'Anthropic', shortTitle: 'Anthropic定价83美元', title: 'T9', summary: 'S9' },
        { entity: '花旗银行', shortTitle: '花旗上线AI免责条款', title: 'T10', summary: 'S10' },
      ],
    }).issue;

    const groups = buildCoverWaterfallGroups(ten.items);
    expect(groups[0]?.kind).toBe('featured');
    expect(groups[0]?.items.map((e) => e.originalIndex)).toEqual([0, 1]);
    expect(groups[0]?.showItemLogos).toBe(true);

    const googleCard = groups.find((g) => g.title === 'Google');
    expect(googleCard?.kind).toBe('company');
    expect(googleCard?.showItemLogos).toBe(false);
    expect(googleCard?.headerCompany?.logoUrl).toBe('/logos/google.svg');

    const otherCard = groups[groups.length - 1];
    expect(otherCard?.kind).toBe('other');
    expect(otherCard?.title).toBe('其他动态');
    expect(otherCard?.showItemLogos).toBe(true);
    expect(otherCard?.items.map((e) => e.item.entity)).toEqual(['范式智能', '花旗银行']);

    const twelve = sanitizeDailyIssue({
      items: Array.from({ length: 12 }, (_, idx) => ({
        entity: ['OpenAI', 'Google', 'Anthropic', '阿里巴巴', '字节跳动', '腾讯'][idx % 6],
        shortTitle: `AI 资讯第 ${idx + 1} 条`,
        title: `标题 ${idx + 1}`,
        summary: `摘要 ${idx + 1}`,
      })),
    }).issue;
    const twelveGroups = buildCoverWaterfallGroups(twelve.items);
    const totalShown = twelveGroups.reduce((sum, g) => sum + g.items.length, 0);
    expect(totalShown).toBe(12);
    const cols = assignMasonryColumns(twelveGroups);
    expect(cols.left.length + cols.right.length).toBe(twelveGroups.length);
  });

  it('renders item logos in mixed cards, card header logos with bullet dots in company cards, and monogram fallback', () => {
    const issue = sanitizeDailyIssue({
      date: '2026.11.19',
      items: [
        { entity: 'OpenAI', shortTitle: 'OpenAI 发布新模型', title: 'T1', summary: 'S1' },
        { entity: 'Google', shortTitle: 'Google 更新AI Studio', title: 'T2', summary: 'S2' },
        { entity: '阿里巴巴', shortTitle: '通义千问代码工具升级', title: 'T3', summary: 'S3' },
        { entity: '范式智能', shortTitle: '范式智能发布双基模', title: 'T4', summary: 'S4' },
        { entity: '花旗银行', shortTitle: '花旗银行引入AI风控', title: 'T5', summary: 'S5' },
      ],
    }).issue;

    const onJump = vi.fn();
    const { container } = render(<CoverPage issue={issue} onJumpToNews={onJump} />);

    expect(screen.getByText('2026-11-19 资讯概览')).toBeInTheDocument();

    const featuredCard = container.querySelector('.cover-waterfall-card.is-featured')!;
    expect(featuredCard.querySelectorAll('.company-logo-badge.is-item')).toHaveLength(2);

    const companyCard = container.querySelector('.cover-waterfall-card.is-company')!;
    expect(companyCard.querySelectorAll('.company-logo-badge.is-card')).toHaveLength(1);
    expect(companyCard.querySelectorAll('.waterfall-bullet-dot')).toHaveLength(1);
    expect(companyCard.querySelectorAll('.company-logo-badge.is-item')).toHaveLength(0);

    const otherCard = container.querySelector('.cover-waterfall-card.is-other')!;
    const monograms = Array.from(otherCard.querySelectorAll('.company-logo-monogram.is-item')).map(
      (el) => el.textContent,
    );
    expect(monograms).toEqual(['范式', '花旗']);

    // 模拟卡片内 Logo 图片加载失败，验证无感降级为单层首字母徽章
    const alibabaImg = companyCard.querySelector('img[alt="阿里巴巴"]') as HTMLImageElement;
    expect(alibabaImg).toBeTruthy();
    fireEvent.error(alibabaImg);
    expect(companyCard.querySelector('.company-logo-badge')).toBeNull();
    expect(companyCard.querySelector('.company-logo-monogram.is-card')?.textContent).toBe('阿里');

    fireEvent.click(screen.getByText('通义千问代码工具升级'));
    expect(onJump).toHaveBeenCalledWith(2);
  });

  it('computes deterministic scroll offset curve and clamps non-overflowing layouts to zero', () => {
    expect(computeCoverScrollState(2500, 5000, 3)).toEqual({
      offsetPx: 0,
      progress: 0,
      hasOverflow: false,
      canScrollUp: false,
      canScrollDown: false,
    });

    const atStart = computeCoverScrollState(500, 6000, 300);
    expect(atStart.offsetPx).toBe(0);
    expect(atStart.hasOverflow).toBe(true);
    expect(atStart.canScrollDown).toBe(true);

    const atMid = computeCoverScrollState(3000, 6000, 300);
    expect(atMid.offsetPx).toBeGreaterThan(80);
    expect(atMid.offsetPx).toBeLessThan(220);
    expect(atMid.canScrollUp).toBe(true);
    expect(atMid.canScrollDown).toBe(true);

    const atEnd = computeCoverScrollState(5600, 6000, 300);
    expect(atEnd.offsetPx).toBe(300);
    expect(atEnd.progress).toBe(1);
    expect(atEnd.canScrollDown).toBe(false);
  });

  it('drives CoverPage scroll via seekTo and keeps exiting CoverPage at bottom without snap-back', async () => {
    window.history.replaceState({}, '', '/?clock=manual&clean=1');
    const clientHeightSpy = vi
      .spyOn(HTMLElement.prototype, 'clientHeight', 'get')
      .mockImplementation(function (this: HTMLElement) {
        if (this.classList.contains('cover-waterfall-viewport')) {
          return 420;
        }
        return 0;
      });
    const scrollHeightSpy = vi
      .spyOn(HTMLElement.prototype, 'scrollHeight', 'get')
      .mockImplementation(function (this: HTMLElement) {
        if (this.classList.contains('cover-waterfall-track')) {
          return 720;
        }
        return 0;
      });

    try {
      const { container } = render(
        <NewsDeck
          initialData={{
            fps: 30,
            coverFrameCount: 180,
            outroFrameCount: 90,
            items: Array.from({ length: 6 }, (_, idx) => ({
              entity: ['OpenAI', 'Google', 'Meta', 'Anthropic', 'DeepSeek', 'xAI'][idx],
              shortTitle: `测试新闻条目 ${idx + 1}`,
              title: `测试标题 ${idx + 1}`,
              summary: `测试摘要 ${idx + 1}`,
              frameCount: 120,
            })),
          }}
        />,
      );

      await act(async () => {
        await window.__NEWS_DECK__!.seekTo(500, 1000 / 30);
      });
      const coverEl1 = container.querySelector('.cover-overview-layout')!;
      expect(coverEl1.getAttribute('data-scroll-overflow')).toBe('true');
      expect(Number(coverEl1.getAttribute('data-scroll-offset'))).toBe(0);

      await act(async () => {
        await window.__NEWS_DECK__!.seekTo(3200, 1000 / 30);
      });
      const midOffset = Number(
        container.querySelector('.cover-overview-layout')!.getAttribute('data-scroll-offset'),
      );
      expect(midOffset).toBeGreaterThan(50);
      expect(midOffset).toBeLessThan(300);

      // 步进至第 1 条新闻起点（6000ms + 100ms 处于渐出过渡期），退场中的封面仍保持底部终态 300px
      await act(async () => {
        await window.__NEWS_DECK__!.seekTo(6100, 1000 / 30);
      });
      const exitingCover = container.querySelector('.page-sheet.is-exiting .cover-overview-layout');
      expect(exitingCover).toBeTruthy();
      expect(Number(exitingCover!.getAttribute('data-scroll-offset'))).toBe(300);
    } finally {
      clientHeightSpy.mockRestore();
      scrollHeightSpy.mockRestore();
    }
  });
});
