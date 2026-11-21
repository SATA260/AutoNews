import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parseTransitionStyle } from '../bridge/videoSynthBridge';
import { NewsDeck } from '../components/deck/NewsDeck';
import { PAGE_TURN_DURATION_MS } from '../components/deck/PageTransitionStage';
import { DeckErrorBoundary } from '../components/guard/DeckErrorBoundary';
import { SAMPLE_DAILY_ISSUE } from '../data/sampleIssue';
import { HARD_LIMITS, sanitizeDailyIssue } from '../schema/newsSchema';
import { formatSubtitleLines, measureSubtitleUnits } from '../utils/formatSubtitle';
import { mediaReadyTracker, transitionTiming } from '../utils/mediaReadyTracker';

beforeEach(() => {
  vi.spyOn(mediaReadyTracker, 'waitForAll').mockResolvedValue(undefined);
  vi.spyOn(transitionTiming, 'wait').mockResolvedValue(undefined);
});

/** 用于模拟子组件渲染异常的测试组件 */
const BrokenChild = () => {
  throw new Error('Simulated crash');
};

describe('Layer 1: Zero-Throw Sanitizer & Editorial Contract Limits', () => {
  it('validates the built-in sample issue with zero warnings', () => {
    const res = sanitizeDailyIssue(SAMPLE_DAILY_ISSUE);
    expect(res.isClean).toBe(true);
    expect(res.warnings).toHaveLength(0);
    expect(res.issue.items).toHaveLength(5);
    expect(res.issue.hostMascotId).toBe('deepseek');
    expect(res.issue.items[0]!.progressLabel).toBe('DeepSeek推理降本');
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
      expect(res.issue.items[0]!.progressLabel.length).toBeGreaterThan(0);
      expect(res.warnings.length).toBeGreaterThan(0);
    }
  });

  it('clamps >12 items, preserves emoji surrogate pairs, strips unsafe URLs, and supports fractional TTS durations', () => {
    const longEmojiText = '🚀'.repeat(120);
    const items = Array.from({ length: 20 }).map((_, idx) => ({
      title: `${longEmojiText} 标题 #${idx}`,
      summary: `${'⚡'.repeat(60)} 总结`,
      progressLabel: `${'🔥'.repeat(20)} 极简总结`,
      entity: `${'🏢'.repeat(40)}公司`,
      impact: idx === 0 ? 'breaking' : 'unknown-impact',
      companyLogoUrl: idx === 0 ? 'javascript:bad()' : '/__logo_assets__/openai.svg',
      imageUrl: idx === 0 ? 'javascript:alert(1)' : '/media/official-deepseek-report.svg',
      audioUrl: idx === 0 ? 'javascript:evil()' : '/__run_assets__/audio/01-item-1.wav',
      cards: Array.from({ length: 10 }).map((_, cIdx) => ({
        icon: 'invalid-icon',
        title: `${'✨'.repeat(24)}卡片${cIdx}`,
        body: `${'📢'.repeat(90)}内容${cIdx}`,
      })),
      lipSyncFrames: [0, 0.45, 1.5, -0.3],
      mascotId: idx === 0 ? 'unknown_bot' : idx === 1 ? 'claude' : 'deepseek',
      durationSec: idx === 1 ? 12.4 : 999,
    }));

    const res = sanitizeDailyIssue({ items });
    expect(res.issue.items).toHaveLength(HARD_LIMITS.maxItems);

    const first = res.issue.items[0]!;
    expect(Array.from(first.title).length).toBeLessThanOrEqual(HARD_LIMITS.title);
    expect(Array.from(first.summary).length).toBeLessThanOrEqual(HARD_LIMITS.summary);
    expect(Array.from(first.progressLabel).length).toBeLessThanOrEqual(HARD_LIMITS.progressLabel);
    expect(Array.from(first.entity).length).toBeLessThanOrEqual(HARD_LIMITS.entity);
    expect(first.impact).toBe('breaking');
    expect(first.companyLogoUrl).toBeNull();
    expect(first.title.includes('\uFFFD')).toBe(false);
    expect(first.imageUrl).toBeNull();
    expect(first.audioUrl).toBeNull();
    expect(first.cards).toHaveLength(HARD_LIMITS.cardsMaxCount);
    expect(Array.from(first.cards[0]!.title).length).toBeLessThanOrEqual(HARD_LIMITS.cardTitle);
    expect(Array.from(first.cards[0]!.body).length).toBeLessThanOrEqual(HARD_LIMITS.cardBody);
    expect(first.cards[0]!.title.includes('\uFFFD')).toBe(false);
    expect(first.lipSyncFrames).toEqual([0, 0.45, 1, 0]);
    expect(first.mascotId).toBe('deepseek');
    expect(first.durationSec).toBe(HARD_LIMITS.maxItemDurationSec);

    const second = res.issue.items[1]!;
    expect(second.durationSec).toBe(12.4);
    expect(second.audioUrl).toBe('/__run_assets__/audio/01-item-1.wav');
    expect(second.impact).toBe('normal');
    expect(second.companyLogoUrl).toBe('/__logo_assets__/openai.svg');
    expect(res.warnings.some((w) => w.code === 'invalid_url')).toBe(true);
    expect(res.warnings.some((w) => w.code === 'clamped')).toBe(true);
  });
});

describe('Layer 2-5: Editorial Deck, Segmented Chapter Bar, Virtual Clock & Error Isolation', () => {
  it('renders 7 editorial slides, segmented chapter progress pills, shows mascot, and clamps pagination safely', async () => {
    const { container } = render(<NewsDeck />);

    expect(window.__NEWS_DECK__).toBeDefined();
    expect(window.__NEWS_DECK__!.getPageCount()).toBe(7);
    expect(window.__NEWS_DECK__!.getCurrentPage()).toBe(0);
    expect(window.__NEWS_DECK__!.getState().transition).toBe('fade');
    expect(parseTransitionStyle('shutter')).toBe('fade');
    expect(parseTransitionStyle('slide')).toBe('glide');
    expect(parseTransitionStyle('glide')).toBe('glide');
    expect(parseTransitionStyle('flip')).toBe('flip');
    expect(parseTransitionStyle('unknown')).toBe('fade');
    expect(parseTransitionStyle(undefined)).toBe('fade');
    expect(screen.getByText('2026-11-16 资讯概览')).toBeInTheDocument();

    // 验证顶部章节分段进度条渲染 [导览] + 5 条新闻总结胶囊 + [速览]，且已移除底部旧进度线
    const pills = container.querySelectorAll('.chapter-pill');
    expect(pills).toHaveLength(7);
    expect(screen.getByText('DeepSeek推理降本')).toBeInTheDocument();
    expect(screen.getByText('Claude百文件重构')).toBeInTheDocument();
    expect(container.querySelector('.autoplay-progress-track')).toBeNull();

    const mascotImg = container.querySelector('.corner-mascot-img') as HTMLImageElement | null;
    expect(mascotImg).toBeTruthy();
    expect(mascotImg!.getAttribute('src')).toBe('/mascots/deepseek.png');

    // 跳转到第 2 条新闻（Claude），验证内容与看板娘切换，且左下角不再贴网址与信源底栏
    await act(async () => {
      const target = await window.__NEWS_DECK__!.goToPage(2);
      expect(target).toBe(2);
    });
    expect(screen.getByText(/Claude 升级长程代码工作流/)).toBeInTheDocument();
    expect(container.querySelector('.news-source-footer')).toBeNull();
    expect(container.textContent).not.toContain(SAMPLE_DAILY_ISSUE.items[1]!.sourceUrl);
    const claudeImg = container.querySelector('.corner-mascot-img') as HTMLImageElement | null;
    expect(claudeImg!.getAttribute('src')).toBe('/mascots/claude.png');

    // 验证越界页码安全钳制
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

  it('drives deterministic virtual clock seekTo(ms) across exact frame grid, page-turn transition, and lip-sync envelope', async () => {
    const { container } = render(
      <NewsDeck
        initialData={{
          fps: 30,
          coverFrameCount: 121,
          coverSpeechSec: 3,
          coverLipSync: Array.from({ length: 90 }, (_, i) => (i === 30 ? 0.8 : 0.2)),
          outroFrameCount: 120,
          items: [
            {
              title: '虚拟时钟步进验证新闻',
              progressLabel: '虚拟时钟步进',
              summary: '验证任意毫秒输入与跨区间跳转都能精确锁定唯一章节、翻页插值与口型振幅。',
              frameCount: 180,
              speechDurationSec: 5,
              lipSyncFrames: Array.from({ length: 150 }, () => 0.65),
              mascotId: 'deepseek',
            },
          ],
        }}
      />,
    );

    // 验证第 30 帧（1000ms）落在封面且口型精确命中 0.8
    let snap = await act(async () => window.__NEWS_DECK__!.seekTo(1000, 1000 / 30));
    expect(snap.currentPage).toBe(0);
    expect(snap.exitingPage).toBeNull();
    expect(snap.mouthOpen).toBeCloseTo(0.8, 3);

    // 验证第 120 帧（4000ms）仍属于封面（coverFrameCount=121），而第 121 帧（4033.33ms）精确切入第 1 章起点
    snap = await act(async () => window.__NEWS_DECK__!.seekTo((120 * 1000) / 30, 1000 / 30));
    expect(snap.currentPage).toBe(0);
    expect(snap.mouthOpen).toBe(0);

    snap = await act(async () => window.__NEWS_DECK__!.seekTo((121 * 1000) / 30, 1000 / 30));
    expect(snap.currentPage).toBe(1);
    expect(snap.exitingPage).toBe(0);
    expect(snap.transitionProgress).toBeCloseTo(0, 4);

    // 验证无论从前面顺序步进还是从尾页跨区间跳回同一时刻，画面过渡状态均完全一致（无调用历史依赖）
    const snapFromForward = await act(async () =>
      window.__NEWS_DECK__!.seekTo((127 * 1000) / 30, 1000 / 30),
    );
    await act(async () => window.__NEWS_DECK__!.seekTo(9500, 1000 / 30));
    const snapFromJump = await act(async () =>
      window.__NEWS_DECK__!.seekTo((127 * 1000) / 30, 1000 / 30),
    );
    expect(snapFromJump).toEqual(snapFromForward);
    expect(container.querySelector('.page-turn-stage')).toHaveClass('is-virtual-turn');
    expect(snapFromJump.mouthOpen).toBeCloseTo(0.65, 2);
  });

  it('mounts dual exiting/entering sheets in the same atomic turn without flash and cycles transition styles', async () => {
    vi.useFakeTimers();
    try {
      const { container } = render(<NewsDeck />);

      // 默认是平滑渐变；按 T 键依次循环四种过渡样式：fade -> glide -> flip -> none -> fade，最后再切到 glide 继续验证滑移
      expect(window.__NEWS_DECK__!.getState().transition).toBe('fade');
      fireEvent.keyDown(window, { key: 't' });
      expect(window.__NEWS_DECK__!.getState().transition).toBe('glide');
      fireEvent.keyDown(window, { key: 't' });
      expect(window.__NEWS_DECK__!.getState().transition).toBe('flip');
      fireEvent.keyDown(window, { key: 't' });
      expect(window.__NEWS_DECK__!.getState().transition).toBe('none');
      fireEvent.keyDown(window, { key: 't' });
      expect(window.__NEWS_DECK__!.getState().transition).toBe('fade');
      fireEvent.keyDown(window, { key: 't' });
      expect(window.__NEWS_DECK__!.getState().transition).toBe('glide');

      // 触发向后翻页，验证离场页与入场页在同一原子提交中同时挂载且无闪烁
      fireEvent.click(screen.getByRole('button', { name: '下一页' }));

      const stage = container.querySelector('.page-turn-stage');
      expect(stage).toHaveClass('mode-glide', 'is-turning', 'dir-next');
      const exitingForward = container.querySelector('.page-sheet.is-exiting');
      const enteringForward = container.querySelector('.page-sheet.is-active.is-entering');
      expect(exitingForward).toBeInTheDocument();
      expect(enteringForward).toBeInTheDocument();
      expect(exitingForward!.textContent).toContain('2026-11-16 资讯概览');
      expect(enteringForward!.textContent).toContain(SAMPLE_DAILY_ISSUE.items[0]!.title);

      // 推进定时器越过滑移过渡时长，验证离场页卸载
      await act(async () => {
        vi.advanceTimersByTime(PAGE_TURN_DURATION_MS.glide + 20);
      });

      expect(container.querySelector('.page-sheet.is-exiting')).not.toBeInTheDocument();
      expect(container.querySelector('.page-turn-stage')).toHaveClass('is-settled');

      // 触发向前翻页，验证反向双页挂载对称生效
      fireEvent.click(screen.getByRole('button', { name: '上一页' }));
      expect(container.querySelector('.page-turn-stage')).toHaveClass(
        'mode-glide',
        'is-turning',
        'dir-prev',
      );
      const exitingBack = container.querySelector('.page-sheet.is-exiting');
      const enteringBack = container.querySelector('.page-sheet.is-active.is-entering');
      expect(exitingBack).toBeInTheDocument();
      expect(enteringBack).toBeInTheDocument();
      expect(exitingBack!.textContent).toContain(SAMPLE_DAILY_ISSUE.items[0]!.title);
      expect(enteringBack!.textContent).toContain('2026-11-16 资讯概览');

      await act(async () => {
        vi.advanceTimersByTime(PAGE_TURN_DURATION_MS.glide + 20);
      });
      expect(container.querySelector('.page-turn-stage')).toHaveClass('is-settled');
    } finally {
      vi.useRealTimers();
    }
  });

  it('switches cleanly to a full-width panel when an official image fails to load', async () => {
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
    expect(document.querySelector('.news-editorial-layout')).toHaveClass('is-full-panel');
    expect(screen.queryByText('官方摘录表')).not.toBeInTheDocument();
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
    expect(activeSheet!.querySelectorAll('.news-info-card').length).toBeGreaterThanOrEqual(1);
    expect(activeSheet!.querySelector('.news-editorial-layout')).toHaveClass('no-mascot');
    expect(container.querySelector('.corner-mascot-dock')).toBeNull();

    // 验证稀疏条目（1 条）比密集条目（12 条）顶部进度条初始响应式字号更大
    const singleTrackFont = parseFloat(
      (container.querySelector('.chapter-pill.is-news .chapter-pill-track-inner') as HTMLElement)
        .style.fontSize,
    );
    act(() => {
      window.__NEWS_DECK__!.setNewsData({
        items: Array.from({ length: 12 }).map((_, i) => ({
          title: `高密度测试新闻第 ${i + 1} 条`,
          progressLabel: `测试总结第${i + 1}条`,
          summary: '测试高密度章节轨道的响应式字号缩放表现。',
        })),
      });
    });
    const denseTrackFont = parseFloat(
      (container.querySelector('.chapter-pill.is-news .chapter-pill-track-inner') as HTMLElement)
        .style.fontSize,
    );
    expect(singleTrackFont).toBeGreaterThan(denseTrackFont);

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(
      <DeckErrorBoundary scopeName="unit-probe">
        <BrokenChild />
      </DeckErrorBoundary>,
    );
    expect(screen.getByTestId('boundary-fallback-unit-probe')).toBeInTheDocument();
    consoleSpy.mockRestore();
  });

  it('binds chapter pill flex weights proportionally to section durations and syncs bottom subtitles', async () => {
    const { container } = render(
      <NewsDeck
        initialData={{
          fps: 30,
          coverDurationSec: 5,
          coverSubtitles: [{ text: '大家好，欢迎收看今天的AI每日报', startSec: 0, endSec: 4.4 }],
          outroDurationSec: 6,
          outroSubtitles: [{ text: '以上就是本期全部重点', startSec: 0, endSec: 5.2 }],
          items: [
            {
              title: '时长绑定与同步字幕测试',
              progressLabel: '同步字幕测试',
              summary: '验证进度条长度随章节时长同比拉伸以及底部口播字幕随时间轴准确切换与退场。',
              durationSec: 10,
              speechDurationSec: 9.2,
              subtitles: [
                { text: '第一句字幕先交代事情核心变化', startSec: 0, endSec: 4.5 },
                { text: '第二句接着说明为什么它很实用', startSec: 4.5, endSec: 9.2 },
              ],
            },
            {
              title: '长章节比例对照测试',
              progressLabel: '长章节对照',
              summary: '第二条新闻设为 20 秒，进度条宽度权重应为第一条 10 秒的两倍。',
              durationSec: 20,
              speechDurationSec: 18.5,
              subtitles: [{ text: '这里是第二条新闻的字幕', startSec: 0, endSec: 18.5 }],
            },
          ],
        }}
      />,
    );

    const pills = Array.from(container.querySelectorAll('.chapter-pill')) as HTMLElement[];
    expect(pills).toHaveLength(4);
    expect(pills[0]?.style.flexGrow).toBe('5000');
    expect(pills[1]?.style.flexGrow).toBe('10000');
    expect(pills[2]?.style.flexGrow).toBe('20000');
    expect(pills[3]?.style.flexGrow).toBe('6000');

    await act(async () => {
      await window.__NEWS_DECK__!.seekTo(1000, 1000 / 30);
    });
    expect(screen.getByTestId('deck-subtitle-text')).toHaveTextContent(
      '大家好，欢迎收看今天的AI每日报',
    );

    await act(async () => {
      await window.__NEWS_DECK__!.seekTo(6000, 1000 / 30);
    });
    expect(screen.getByTestId('deck-subtitle-text')).toHaveTextContent(
      '第一句字幕先交代事情核心变化',
    );

    await act(async () => {
      await window.__NEWS_DECK__!.seekTo(10500, 1000 / 30);
    });
    expect(screen.getByTestId('deck-subtitle-text')).toHaveTextContent(
      '第二句接着说明为什么它很实用',
    );

    // 超过本章节 9.2s 语音结尾进入停顿期（第 14.5s）时，字幕应自动收起
    await act(async () => {
      await window.__NEWS_DECK__!.seekTo(14500, 1000 / 30);
    });
    expect(screen.queryByTestId('deck-subtitle-text')).toBeNull();

    // 验证 sanitizeDailyIssue 会将重叠与越界的字幕时间单调裁剪至区间内且严格不重叠
    const overlappingRes = sanitizeDailyIssue({
      items: [
        {
          title: '字幕单调裁剪验证',
          summary: '校验重叠和越界字幕区间会被自动顺延并严格截断在章节总时长之内。',
          durationSec: 5,
          subtitles: [
            { text: '第一句字幕正常区间', startSec: 0, endSec: 2.5 },
            { text: '第二句重叠起点会顺延', startSec: 2.0, endSec: 4.99 },
            { text: '第三句越界时间段会被剔除', startSec: 4.5, endSec: 6.0 },
          ],
        },
      ],
    });
    const cues = overlappingRes.issue.items[0]?.subtitles ?? [];
    expect(cues).toHaveLength(2);
    expect(cues[0]).toEqual({ text: '第一句字幕正常区间', startSec: 0, endSec: 2.5 });
    expect(cues[1]).toEqual({ text: '第二句重叠起点会顺延', startSec: 2.5, endSec: 4.99 });
  });

  it('formats long subtitles by breaking on punctuation first or splitting evenly without punctuation', async () => {
    // 1. 未超单行宽度的短句保持单行不折行
    expect(formatSubtitleLines('两款已对付费订阅和API开放，因达高风险门槛收紧了安全限制')).toEqual([
      '两款已对付费订阅和API开放，因达高风险门槛收紧了安全限制',
    ]);

    // 2. 包含标点的长句优先按语义最均衡的分句标点换行，标点保留在上一行末尾
    expect(
      formatSubtitleLines(
        'Google把任务放进专属隔离虚拟机，付款前也会暂停确认，不过也坦言目前仍可能失败',
      ),
    ).toEqual(['Google把任务放进专属隔离虚拟机，', '付款前也会暂停确认，不过也坦言目前仍可能失败']);

    expect(
      formatSubtitleLines(
        '编程同档位实测中，新模型比上代用量少近半、得分升近两成半，单任务费用降百分之五十八',
      ),
    ).toEqual([
      '编程同档位实测中，新模型比上代用量少近半、得分升近两成半，',
      '单任务费用降百分之五十八',
    ]);

    // 3. 没有可用标点的长句均匀分成两行，且不拆断英文单词和小数版本号
    const noPunctLines = formatSubtitleLines(
      'DeepMind最新发布的超大规模强化学习推理引擎已全面向开发者开放测试',
    );
    expect(noPunctLines).toHaveLength(2);
    expect(noPunctLines[0]).toContain('DeepMind');
    expect(
      Math.abs(
        measureSubtitleUnits(noPunctLines[0] ?? '') - measureSubtitleUnits(noPunctLines[1] ?? ''),
      ),
    ).toBeLessThanOrEqual(2.5);

    const decimalLines = formatSubtitleLines(
      '微软今天推出的新一代本地代码模型GPT-6.2和辅助代理系统已经全面开放给个人开发者使用',
    );
    expect(decimalLines.join('')).toContain('GPT-6.2');
    expect(decimalLines.every((l) => !l.endsWith('GPT-6') && !l.startsWith('.2'))).toBe(true);

    // 4. 页面组件渲染超长字幕时应用多行样式并保留换行符
    render(
      <NewsDeck
        initialData={{
          fps: 30,
          coverDurationSec: 5,
          coverSubtitles: [
            {
              text: 'OpenAI发布GPT-6.2双模型Astra和Sol，输出字数更少，表现更强',
              startSec: 0,
              endSec: 4.5,
            },
          ],
          outroDurationSec: 4,
          items: [
            {
              title: '多行智能排版验证',
              summary: '验证字幕条在需要换行时自动添加 is-multiline 类名并按标点折行。',
              durationSec: 5,
            },
          ],
        }}
      />,
    );

    await act(async () => {
      await window.__NEWS_DECK__!.seekTo(1000, 1000 / 30);
    });
    const subEl = screen.getByTestId('deck-subtitle-text');
    expect(subEl).toHaveClass('is-multiline');
    expect(subEl.textContent).toBe('OpenAI发布GPT-6.2双模型Astra和Sol，\n输出字数更少，表现更强');
  });

  it('sanitizes actionHint by stripping accidental URLs and renders the practical search capsule on NewsCardPage', async () => {
    const sanitized = sanitizeDailyIssue({
      items: [
        {
          title: '开源推理引擎发布新版本',
          summary: '支持最新量化格式并降低显存占用。',
          actionHint: 'GitHub 搜索 llama.cpp https://example.com/leak',
        },
      ],
    });
    expect(sanitized.issue.items[0]!.actionHint).toBe('GitHub 搜索 llama.cpp');

    render(
      <NewsDeck
        initialData={{
          items: [
            {
              title: '开源推理引擎发布新版本',
              summary: '支持最新量化格式并降低显存占用。',
              actionHint: 'GitHub 搜索 llama.cpp',
            },
          ],
        }}
      />,
    );

    await act(async () => {
      await window.__NEWS_DECK__!.goToPage(1);
    });
    const hintEl = screen.getByTestId('news-action-hint');
    expect(hintEl).toHaveTextContent('实操检索');
    expect(hintEl).toHaveTextContent('GitHub 搜索 llama.cpp');
  });

  it('renders rival-host guestReaction speech bubble synced to playback time window', async () => {
    render(
      <NewsDeck
        initialData={{
          fps: 30,
          coverDurationSec: 4,
          outroDurationSec: 4,
          items: [
            {
              title: '大厂合并订阅并翻倍额度',
              summary: '免费额度翻倍但高峰期限流规则收紧。',
              durationSec: 10,
              speechDurationSec: 5,
              guestReaction: {
                hostId: 'claude',
                hostName: '小克',
                line: '额度给得挺大方，高峰期别掉链子就行。',
                startSec: 5.5,
                endSec: 8.5,
              },
            },
          ],
        }}
      />,
    );

    // 播放到主讲前半段（第 1 条新闻本地 2s，全局 6s），嘉宾气泡尚未出现
    await act(async () => {
      await window.__NEWS_DECK__!.seekTo(6000, 1000 / 30);
    });
    expect(screen.queryByTestId('guest-reaction-bubble')).toBeNull();

    // 播放到嘉宾插嘴窗口内（第 1 条新闻本地 6.5s，全局 10.5s），气泡滑入显示
    await act(async () => {
      await window.__NEWS_DECK__!.seekTo(10500, 1000 / 30);
    });
    const bubble = screen.getByTestId('guest-reaction-bubble');
    expect(bubble).toHaveAttribute('data-guest-host', 'claude');
    expect(bubble).toHaveTextContent('小克 插嘴');
    expect(bubble).toHaveTextContent('额度给得挺大方，高峰期别掉链子就行。');
  });
});
