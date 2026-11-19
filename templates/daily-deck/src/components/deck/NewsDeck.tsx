import { Volume2 } from 'lucide-react';
import type React from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import {
  clampPageIndex,
  type DeckBridgeState,
  type DeckClockMode,
  type DeckPageType,
  type DeckTransitionStyle,
  parseTransitionStyle,
  type SeekToResult,
} from '../../bridge/videoSynthBridge';
import { SAMPLE_DAILY_ISSUE } from '../../data/sampleIssue';
import { MASCOT_REGISTRY } from '../../mascots/mascotRegistry';
import {
  type DailyIssueInput,
  type MascotMood,
  type PresetMascotId,
  type SanitizedIssueResult,
  type SanitizedSubtitleCue,
  sanitizeDailyIssue,
} from '../../schema/newsSchema';
import { formatSubtitleLines } from '../../utils/formatSubtitle';
import { mediaReadyTracker, transitionTiming } from '../../utils/mediaReadyTracker';
import { DeckErrorBoundary } from '../guard/DeckErrorBoundary';
import { ViewportScaler } from '../guard/ViewportScaler';
import { CornerMascot } from '../mascot/CornerMascot';
import type { MascotImperativeHandle } from '../mascot/Live2DMascotCanvas';
import { CoverPage } from '../pages/CoverPage';
import { NewsCardPage } from '../pages/NewsCardPage';
import { SummaryOutroPage } from '../pages/SummaryOutroPage';
import { DataInspectorDrawer, type InspectorTab } from './DataInspectorDrawer';
import { DeckControls } from './DeckControls';
import { DeckHeader } from './DeckHeader';
import { PAGE_TURN_DURATION_MS, PageTransitionStage } from './PageTransitionStage';

/** 从浏览器网址查询串解析出的初始启动运行参数 */
interface StartupOptions {
  cleanMode: boolean;
  autoplay: boolean;
  clockMode: DeckClockMode;
  initialPage: number;
  theme: 'light' | 'dark';
  transition: DeckTransitionStyle;
  motion: 'animated' | 'static';
  /** 卡片显示方式：progressive 跟着口播逐张出现，all 一开始就全部显示 */
  reveal: 'progressive' | 'all';
}

/** 页面翻页原子状态：在同一渲染周期同步更新当前页、离场页与翻页方向 */
interface PageNavState {
  currentPage: number;
  exitingPage: number | null;
  direction: 'next' | 'prev';
  turnSeq: number;
  virtualProgress: number | null;
}

/** 单个章节在整期时间轴上的起止帧号、起止毫秒、配音链接与口型数据计划 */
interface DeckSectionTiming {
  pageIndex: number;
  pageType: DeckPageType;
  pageLabel: string;
  newsIndex: number;
  startFrame: number | null;
  endFrame: number | null;
  startMs: number;
  durationMs: number;
  /** 本页画面出现后延迟多少毫秒再开始播报口播 */
  speechStartMs: number;
  speechMs: number;
  audioUrl: string | null;
  lipSyncFrames: number[];
  subtitles: SanitizedSubtitleCue[];
  mascotId: PresetMascotId;
  customMascotUrl: string | null;
  mascotMood: MascotMood;
}

const TRANSITION_ORDER: readonly DeckTransitionStyle[] = ['fade', 'glide', 'flip', 'none'];
const DEFAULT_LIP_SYNC_FPS = 30;

/** 从浏览器网址查询参数中读取初始播放、时钟驱动模式、主题、动效与卡片显示方式配置 */
function parseStartupOptions(): StartupOptions {
  if (typeof window === 'undefined') {
    return {
      cleanMode: false,
      autoplay: false,
      clockMode: 'realtime',
      initialPage: 0,
      theme: 'light',
      transition: 'fade',
      motion: 'animated',
      reveal: 'progressive',
    };
  }
  const params = new URLSearchParams(window.location.search);
  const cleanMode = params.get('clean') === '1' || params.get('clean') === 'true';
  const autoplay = params.get('autoplay') === '1' || params.get('autoplay') === 'true';
  const clockMode: DeckClockMode = params.get('clock') === 'manual' ? 'manual' : 'realtime';
  const pageParam = Number(params.get('page') ?? '0');
  const initialPage = Number.isFinite(pageParam) ? Math.max(0, Math.trunc(pageParam)) : 0;
  const theme = params.get('theme') === 'dark' ? 'dark' : 'light';
  const transition = parseTransitionStyle(params.get('transition'));
  const motion = params.get('motion') === 'static' ? 'static' : 'animated';
  const reveal = params.get('reveal') === 'all' ? 'all' : 'progressive';

  return { cleanMode, autoplay, clockMode, initialPage, theme, transition, motion, reveal };
}

/** 按指定秒数在预计算口型数组中执行线性插值采样（超过纯人声时长后严格闭嘴归零） */
function sampleLipSyncAtSec(
  frames: number[],
  localSec: number,
  speechSec: number,
  fps: number,
): number {
  if (localSec < 0 || localSec > speechSec || frames.length === 0) {
    return 0;
  }
  const exactIdx = localSec * fps;
  const i0 = Math.floor(exactIdx);
  if (i0 >= frames.length) {
    return 0;
  }
  const i1 = Math.min(frames.length - 1, i0 + 1);
  const frac = exactIdx - i0;
  const v0 = frames[i0] ?? 0;
  const v1 = frames[i1] ?? v0;
  return Math.min(1, Math.max(0, v0 + (v1 - v0) * frac));
}

/** 分贝音量转换为线性增益比例 */
function dbToLinearGain(db: number): number {
  if (!Number.isFinite(db)) {
    return 0.12;
  }
  return Math.min(1, Math.max(0, 10 ** (db / 20)));
}

/** 判断当前环境是否支持真实浏览器音频播放（排除单元测试模拟 DOM 环境） */
function canPlayHtmlAudio(): boolean {
  if (typeof window === 'undefined' || typeof Audio === 'undefined') {
    return false;
  }
  if (typeof navigator !== 'undefined' && /jsdom/i.test(navigator.userAgent)) {
    return false;
  }
  return true;
}

/** 新闻模板主容器组件的入参属性 */
export interface NewsDeckProps {
  initialData?: unknown;
}

/** 新闻模板主容器：负责数据安全清洗、双模时钟（有声预览与无状态确定性虚拟时钟）、翻页状态机与外部合成桥接 */
export const NewsDeck: React.FC<NewsDeckProps> = ({ initialData }) => {
  const startup = useMemo(() => parseStartupOptions(), []);

  const [rawIssue, setRawIssue] = useState<DailyIssueInput>(() =>
    initialData && typeof initialData === 'object'
      ? (initialData as DailyIssueInput)
      : SAMPLE_DAILY_ISSUE,
  );

  const sanitized: SanitizedIssueResult = useMemo(
    () =>
      sanitizeDailyIssue(
        initialData !== undefined && rawIssue === initialData ? initialData : rawIssue,
      ),
    [initialData, rawIssue],
  );

  const issueFps = sanitized.issue.fps || DEFAULT_LIP_SYNC_FPS;

  const sectionTimings = useMemo((): DeckSectionTiming[] => {
    const issue = sanitized.issue;
    const fps = issue.fps || DEFAULT_LIP_SYNC_FPS;
    const hasExactFrameGrid =
      issue.coverFrameCount !== null &&
      issue.outroFrameCount !== null &&
      issue.items.every((it) => it.frameCount !== null);

    const list: DeckSectionTiming[] = [];
    let cursorMs = 0;
    let frameCursor = 0;

    const coverFrames = hasExactFrameGrid ? issue.coverFrameCount : null;
    const coverDurMs =
      coverFrames !== null
        ? (coverFrames * 1000) / fps
        : Math.max(1000, Math.round(issue.coverDurationSec * 1000));
    const coverSpeechStartMs = Math.min(coverDurMs, Math.round(issue.coverSpeechStartSec * 1000));
    const coverSpeechMs = Math.min(
      Math.max(0, coverDurMs - coverSpeechStartMs),
      Math.round(issue.coverSpeechSec * 1000),
    );
    list.push({
      pageIndex: 0,
      pageType: 'cover',
      pageLabel: '本期导览',
      newsIndex: -1,
      startFrame: coverFrames !== null ? frameCursor : null,
      endFrame: coverFrames !== null ? frameCursor + coverFrames : null,
      startMs: cursorMs,
      durationMs: coverDurMs,
      speechStartMs: coverSpeechStartMs,
      speechMs: coverSpeechMs,
      audioUrl: issue.coverAudioUrl,
      lipSyncFrames: issue.coverLipSync,
      subtitles: issue.coverSubtitles,
      mascotId: issue.hostMascotId,
      customMascotUrl: issue.hostMascotUrl,
      mascotMood: 'neutral',
    });
    cursorMs += coverDurMs;
    if (coverFrames !== null) {
      frameCursor += coverFrames;
    }

    issue.items.forEach((item, idx) => {
      const itemFrames = hasExactFrameGrid ? item.frameCount : null;
      const durMs =
        itemFrames !== null
          ? (itemFrames * 1000) / fps
          : Math.max(1000, Math.round(item.durationSec * 1000));
      const spStartMs = Math.min(durMs, Math.round(item.speechStartSec * 1000));
      const spMs = Math.min(
        Math.max(0, durMs - spStartMs),
        Math.round(item.speechDurationSec * 1000),
      );
      list.push({
        pageIndex: idx + 1,
        pageType: 'news',
        pageLabel: `资讯 ${item.indexLabel}`,
        newsIndex: idx,
        startFrame: itemFrames !== null ? frameCursor : null,
        endFrame: itemFrames !== null ? frameCursor + itemFrames : null,
        startMs: cursorMs,
        durationMs: durMs,
        speechStartMs: spStartMs,
        speechMs: spMs,
        audioUrl: item.audioUrl,
        lipSyncFrames: item.lipSyncFrames,
        subtitles: item.subtitles,
        mascotId: issue.mascotMode === 'fixed-host' ? issue.hostMascotId : item.mascotId,
        customMascotUrl:
          issue.mascotMode === 'per-item' ? item.customMascotUrl : issue.hostMascotUrl,
        mascotMood: item.mascotMood,
      });
      cursorMs += durMs;
      if (itemFrames !== null) {
        frameCursor += itemFrames;
      }
    });

    const outroFrames = hasExactFrameGrid ? issue.outroFrameCount : null;
    const outroDurMs =
      outroFrames !== null
        ? (outroFrames * 1000) / fps
        : Math.max(1000, Math.round(issue.outroDurationSec * 1000));
    const outroSpeechStartMs = Math.min(outroDurMs, Math.round(issue.outroSpeechStartSec * 1000));
    const outroSpeechMs = Math.min(
      Math.max(0, outroDurMs - outroSpeechStartMs),
      Math.round(issue.outroSpeechSec * 1000),
    );
    list.push({
      pageIndex: issue.items.length + 1,
      pageType: 'outro',
      pageLabel: '全期速览',
      newsIndex: -1,
      startFrame: outroFrames !== null ? frameCursor : null,
      endFrame: outroFrames !== null ? frameCursor + outroFrames : null,
      startMs: cursorMs,
      durationMs: outroDurMs,
      speechStartMs: outroSpeechStartMs,
      speechMs: outroSpeechMs,
      audioUrl: issue.outroAudioUrl,
      lipSyncFrames: issue.outroLipSync,
      subtitles: issue.outroSubtitles,
      mascotId: issue.hostMascotId,
      customMascotUrl: issue.hostMascotUrl,
      mascotMood: 'proud',
    });

    return list;
  }, [sanitized.issue]);

  const totalPages = sectionTimings.length;
  const sectionDurationsMs = useMemo(
    () => sectionTimings.map((s) => s.durationMs),
    [sectionTimings],
  );
  const totalDurationMs = useMemo(
    () => sectionTimings.reduce((acc, s) => acc + s.durationMs, 0),
    [sectionTimings],
  );
  const hasAnySubtitles = useMemo(
    () => sectionTimings.some((s) => s.subtitles.length > 0),
    [sectionTimings],
  );
  const hasAnyAudioSource = useMemo(
    () => Boolean(sanitized.issue.bgmAudioUrl || sectionTimings.some((s) => Boolean(s.audioUrl))),
    [sanitized.issue.bgmAudioUrl, sectionTimings],
  );

  const [navState, setNavState] = useState<PageNavState>(() => {
    const initialIdx = clampPageIndex(startup.initialPage, totalPages);
    return {
      currentPage: initialIdx,
      exitingPage: null,
      direction: 'next',
      turnSeq: 0,
      virtualProgress: null,
    };
  });
  const [issueVersion, setIssueVersion] = useState<number>(0);
  const [isAutoPlaying, setIsAutoPlaying] = useState<boolean>(
    startup.clockMode === 'manual' ? false : startup.autoplay,
  );
  const [isMuted, setIsMuted] = useState<boolean>(false);
  const [autoplayBlocked, setAutoplayBlocked] = useState<boolean>(false);
  const [cleanMode, setCleanMode] = useState<boolean>(startup.cleanMode);
  const [theme, setTheme] = useState<'light' | 'dark'>(startup.theme);
  const [transitionStyle, setTransitionStyle] = useState<DeckTransitionStyle>(startup.transition);
  const [inspectorOpen, setInspectorOpen] = useState<boolean>(false);
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>('summary');
  const [runtimeErrors, setRuntimeErrors] = useState<string[]>([]);
  const [sectionProgress, setSectionProgress] = useState<number>(0);
  const [globalTimeMs, setGlobalTimeMs] = useState<number>(
    () => sectionTimings[clampPageIndex(startup.initialPage, totalPages)]?.startMs ?? 0,
  );
  const [mouthOpen, setMouthOpen] = useState<number>(0);
  const [live2dReady, setLive2dReady] = useState<boolean>(false);
  const [audioUnlockTick, setAudioUnlockTick] = useState<number>(0);

  const mascotRef = useRef<MascotImperativeHandle | null>(null);
  const voiceAudioRef = useRef<HTMLAudioElement | null>(null);
  const bgmAudioRef = useRef<HTMLAudioElement | null>(null);
  const pageTurnSfxRef = useRef<HTMLAudioElement | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const analyserBufRef = useRef<Float32Array<ArrayBuffer> | null>(null);
  const wheelLockUntilRef = useRef<number>(0);
  const hasPerformedInitialSeekRef = useRef<boolean>(false);

  const { currentPage, exitingPage, direction, virtualProgress } = navState;
  const effectiveTransition: DeckTransitionStyle =
    startup.motion === 'static' ? 'none' : transitionStyle;
  const currentSection =
    sectionTimings[clampPageIndex(currentPage, totalPages)] ?? sectionTimings[0]!;

  useEffect(() => {
    setNavState((prev) => {
      const nextCurrent = clampPageIndex(prev.currentPage, totalPages);
      const nextExiting =
        prev.exitingPage !== null &&
        prev.exitingPage < totalPages &&
        prev.exitingPage !== nextCurrent
          ? prev.exitingPage
          : null;
      if (nextCurrent === prev.currentPage && nextExiting === prev.exitingPage) {
        return prev;
      }
      return {
        currentPage: nextCurrent,
        exitingPage: nextExiting,
        direction: prev.direction,
        turnSeq: prev.turnSeq + 1,
        virtualProgress: null,
      };
    });
  }, [totalPages]);

  // 实时模式下定时卸载离场书页；虚拟时钟模式由 seekTo 精确控制离场页生命周期
  useEffect(() => {
    if (startup.clockMode === 'manual' || navState.exitingPage === null) {
      return;
    }
    if (effectiveTransition === 'none') {
      setNavState((prev) => (prev.exitingPage === null ? prev : { ...prev, exitingPage: null }));
      return;
    }

    const activeSeq = navState.turnSeq;
    const duration = PAGE_TURN_DURATION_MS[effectiveTransition];
    const timer = window.setTimeout(() => {
      setNavState((prev) =>
        prev.turnSeq === activeSeq ? { ...prev, exitingPage: null, virtualProgress: null } : prev,
      );
    }, duration);

    return () => {
      window.clearTimeout(timer);
    };
  }, [navState.exitingPage, navState.turnSeq, effectiveTransition, startup.clockMode]);

  useEffect(() => {
    if (typeof Image === 'undefined') {
      return;
    }
    const urls = new Set<string>();
    for (const profile of Object.values(MASCOT_REGISTRY)) {
      if (profile.assetUrl) {
        urls.add(profile.assetUrl);
      }
    }
    if (sanitized.issue.hostMascotUrl) {
      urls.add(sanitized.issue.hostMascotUrl);
    }
    for (const item of sanitized.issue.items) {
      if (item.imageUrl) {
        urls.add(item.imageUrl);
      }
      if (item.customMascotUrl) {
        urls.add(item.customMascotUrl);
      }
    }
    for (const url of urls) {
      const img = new Image();
      img.decoding = 'sync';
      img.src = url;
    }
  }, [sanitized.issue.hostMascotUrl, sanitized.issue.items]);

  const recordRuntimeError = useCallback((scopeName: string, message: string) => {
    setRuntimeErrors((prev) => {
      const entry = `[${scopeName}] ${message}`;
      return prev.includes(entry) ? prev : [...prev.slice(-19), entry];
    });
  }, []);

  useEffect(() => {
    const onError = (event: ErrorEvent) => {
      recordRuntimeError('window', event.message || 'Unhandled error');
    };
    const onRejection = (event: PromiseRejectionEvent) => {
      const msg =
        event.reason instanceof Error
          ? event.reason.message
          : String(event.reason ?? 'Promise rejection');
      recordRuntimeError('promise', msg);
    };
    window.addEventListener('error', onError);
    window.addEventListener('unhandledrejection', onRejection);
    return () => {
      window.removeEventListener('error', onError);
      window.removeEventListener('unhandledrejection', onRejection);
    };
  }, [recordRuntimeError]);

  const navigateTo = useCallback(
    (targetPage: number) => {
      const clamped = clampPageIndex(targetPage, totalPages);
      const targetSec = sectionTimings[clamped];
      setNavState((prev) => {
        if (clamped === prev.currentPage) {
          return prev;
        }
        return {
          currentPage: clamped,
          exitingPage: effectiveTransition === 'none' ? null : prev.currentPage,
          direction: clamped > prev.currentPage ? 'next' : 'prev',
          turnSeq: prev.turnSeq + 1,
          virtualProgress: null,
        };
      });
      setSectionProgress(0);
      setMouthOpen(0);
      if (targetSec) {
        setGlobalTimeMs(targetSec.startMs);
      }
      return clamped;
    },
    [effectiveTransition, sectionTimings, totalPages],
  );

  const cycleTransitionStyle = useCallback(() => {
    setTransitionStyle((prev) => {
      const idx = TRANSITION_ORDER.indexOf(prev);
      return TRANSITION_ORDER[(idx + 1) % TRANSITION_ORDER.length] ?? 'fade';
    });
  }, []);

  // 背景音乐在实时有声预览模式下的启停与音量控制
  useEffect(() => {
    if (startup.clockMode === 'manual' || !canPlayHtmlAudio()) {
      return;
    }
    const bgmUrl = sanitized.issue.bgmAudioUrl;
    if (!bgmUrl || !isAutoPlaying || inspectorOpen || autoplayBlocked) {
      bgmAudioRef.current?.pause();
      return;
    }

    let bgm = bgmAudioRef.current;
    if (!bgm) {
      bgm = new Audio();
      bgm.loop = true;
      bgm.preload = 'auto';
      bgmAudioRef.current = bgm;
    }
    if (bgm.src !== new URL(bgmUrl, window.location.href).toString()) {
      bgm.src = bgmUrl;
    }
    bgm.muted = isMuted;
    bgm.volume = dbToLinearGain(sanitized.issue.bgmVolumeDb);
    void bgm.play().catch(() => {
      // 背景音乐受阻时静默忽略，由主口播音轨统一处理解锁提示
    });

    return () => {
      bgm?.pause();
    };
  }, [
    autoplayBlocked,
    inspectorOpen,
    isAutoPlaying,
    isMuted,
    sanitized.issue.bgmAudioUrl,
    sanitized.issue.bgmVolumeDb,
    startup.clockMode,
  ]);

  // 实时预览时每次切换页面播放一声鼠标点击音效；逐帧渲染模式不发声，成片里的音效由后期混音统一加入
  const lastClickedPageRef = useRef<number>(navState.currentPage);
  useEffect(() => {
    const prevPage = lastClickedPageRef.current;
    lastClickedPageRef.current = currentPage;
    if (prevPage === currentPage || startup.clockMode === 'manual' || !canPlayHtmlAudio()) {
      return;
    }
    const sfxUrl = sanitized.issue.pageTurnSfxUrl;
    if (!sfxUrl || isMuted) {
      return;
    }
    let sfx = pageTurnSfxRef.current;
    if (!sfx) {
      sfx = new Audio();
      sfx.preload = 'auto';
      pageTurnSfxRef.current = sfx;
    }
    if (sfx.src !== new URL(sfxUrl, window.location.href).toString()) {
      sfx.src = sfxUrl;
    }
    sfx.volume = dbToLinearGain(sanitized.issue.pageTurnSfxVolumeDb);
    sfx.currentTime = 0;
    void sfx.play().catch(() => {
      // 浏览器尚未允许发声时静默跳过，不影响翻页
    });
  }, [
    currentPage,
    isMuted,
    sanitized.issue.pageTurnSfxUrl,
    sanitized.issue.pageTurnSfxVolumeDb,
    startup.clockMode,
  ]);

  // 组件卸载时彻底释放音频上下文与媒体元素
  useEffect(() => {
    return () => {
      voiceAudioRef.current?.pause();
      voiceAudioRef.current = null;
      bgmAudioRef.current?.pause();
      bgmAudioRef.current = null;
      pageTurnSfxRef.current?.pause();
      pageTurnSfxRef.current = null;
      if (audioCtxRef.current && audioCtxRef.current.state !== 'closed') {
        void audioCtxRef.current.close().catch(() => undefined);
      }
    };
  }, []);

  // 实时预览模式下的有声章节播放、与成片严格一致的口型截止及进度推进
  useEffect(() => {
    // 显式读取解锁计数器，确保用户点击开启有声播报后能重新触发播放副作用
    if (audioUnlockTick < 0) {
      return;
    }
    if (startup.clockMode === 'manual') {
      return;
    }
    if (!isAutoPlaying || inspectorOpen) {
      voiceAudioRef.current?.pause();
      setMouthOpen(0);
      return;
    }

    const sec = currentSection;
    const durationMs = sec.durationMs;
    const speechStartMs = sec.speechStartMs;
    const speechStartSec = speechStartMs / 1000;
    const speechSec = sec.speechMs / 1000;
    const postSpeechPauseMs = Math.max(0, Math.round(durationMs - speechStartMs - sec.speechMs));
    const effectiveChapterSec = Math.max(0.001, durationMs / 1000);
    let cancelled = false;
    let intervalId = 0;
    let preTimerId = 0;
    let padTimerId = 0;

    const advanceOrFinish = () => {
      if (cancelled) {
        return;
      }
      setMouthOpen(0);
      if (currentPage < totalPages - 1) {
        navigateTo(currentPage + 1);
      } else {
        setIsAutoPlaying(false);
        setSectionProgress(1);
        setGlobalTimeMs(totalDurationMs);
      }
    };

    const startSilentTimerFallback = (initialElapsedMs = 0) => {
      const startedAt = Date.now() - initialElapsedMs;
      intervalId = window.setInterval(() => {
        if (cancelled) {
          return;
        }
        const elapsed = Math.min(durationMs, Date.now() - startedAt);
        const ratio = Math.min(1, elapsed / Math.max(1, durationMs));
        setSectionProgress(ratio);
        setGlobalTimeMs(sec.startMs + elapsed);
        setMouthOpen(
          sampleLipSyncAtSec(
            sec.lipSyncFrames,
            (elapsed - speechStartMs) / 1000,
            speechSec,
            issueFps,
          ),
        );
        if (elapsed >= durationMs) {
          window.clearInterval(intervalId);
          advanceOrFinish();
        }
      }, 40);
    };

    if (sec.audioUrl && canPlayHtmlAudio()) {
      let voice = voiceAudioRef.current;
      if (!voice) {
        voice = new Audio();
        voice.preload = 'auto';
        voiceAudioRef.current = voice;
      }

      // 若该章节未提供预计算口型数组，按需连接 Web Audio 频谱分析器实时提取振幅
      if (sec.lipSyncFrames.length === 0 && !analyserRef.current) {
        try {
          const AudioContextCtor =
            window.AudioContext ||
            (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
          if (AudioContextCtor) {
            const ctx = new AudioContextCtor();
            const sourceNode = ctx.createMediaElementSource(voice);
            const analyser = ctx.createAnalyser();
            analyser.fftSize = 512;
            sourceNode.connect(analyser);
            analyser.connect(ctx.destination);
            audioCtxRef.current = ctx;
            analyserRef.current = analyser;
            analyserBufRef.current = new Float32Array(analyser.fftSize);
          }
        } catch {
          // 浏览器不支持或重复绑定时跳过实时分析器，不影响正常发声播放
        }
      }

      voice.pause();
      voice.src = sec.audioUrl;
      voice.currentTime = 0;
      voice.muted = isMuted;

      const sampleRealtimeMouth = (curSec: number): number => {
        if (curSec > speechSec) {
          return 0;
        }
        if (sec.lipSyncFrames.length > 0) {
          return sampleLipSyncAtSec(sec.lipSyncFrames, curSec, speechSec, issueFps);
        }
        const analyser = analyserRef.current;
        const buf = analyserBufRef.current;
        if (!analyser || !buf) {
          return 0;
        }
        analyser.getFloatTimeDomainData(buf);
        let sumSq = 0;
        for (let i = 0; i < buf.length; i++) {
          const s = buf[i] ?? 0;
          sumSq += s * s;
        }
        const rms = Math.sqrt(sumSq / buf.length);
        const db = 20 * Math.log10(Math.max(rms, 1e-7));
        if (db < -42) {
          return 0;
        }
        return Math.min(1, Math.max(0, (db + 42) / 30));
      };

      const onAudioEnded = () => {
        if (cancelled) {
          return;
        }
        window.clearInterval(intervalId);
        setMouthOpen(0);
        if (postSpeechPauseMs <= 20) {
          advanceOrFinish();
          return;
        }
        const padStart = Date.now();
        intervalId = window.setInterval(() => {
          const pElapsedSec = (Date.now() - padStart) / 1000;
          const clampedElapsedSec = Math.min(
            durationMs / 1000,
            speechStartSec + speechSec + pElapsedSec,
          );
          setSectionProgress(Math.min(1, clampedElapsedSec / effectiveChapterSec));
          setGlobalTimeMs(sec.startMs + Math.min(durationMs, clampedElapsedSec * 1000));
        }, 40);
        padTimerId = window.setTimeout(() => {
          window.clearInterval(intervalId);
          advanceOrFinish();
        }, postSpeechPauseMs);
      };

      const onAudioError = () => {
        if (cancelled) {
          return;
        }
        window.clearInterval(intervalId);
        window.clearTimeout(preTimerId);
        startSilentTimerFallback();
      };

      voice.addEventListener('ended', onAudioEnded, { once: true });
      voice.addEventListener('error', onAudioError, { once: true });

      const startVoicePlay = () => {
        if (cancelled) {
          return;
        }
        if (audioCtxRef.current?.state === 'suspended') {
          void audioCtxRef.current.resume().catch(() => undefined);
        }

        voice
          .play()
          .then(() => {
            if (cancelled) {
              voice?.pause();
              return;
            }
            setAutoplayBlocked(false);
            intervalId = window.setInterval(() => {
              if (cancelled || !voice) {
                return;
              }
              const voiceCurSec = Math.max(0, voice.currentTime);
              const pageCurSec = Math.min(durationMs / 1000, speechStartSec + voiceCurSec);
              setSectionProgress(Math.min(1, pageCurSec / effectiveChapterSec));
              setGlobalTimeMs(sec.startMs + Math.min(durationMs, pageCurSec * 1000));
              setMouthOpen(voice.paused ? 0 : sampleRealtimeMouth(voiceCurSec));
            }, 33);
          })
          .catch((err: unknown) => {
            if (cancelled) {
              return;
            }
            const errName = err instanceof Error ? err.name : '';
            if (errName === 'NotAllowedError') {
              setAutoplayBlocked(true);
              return;
            }
            startSilentTimerFallback(speechStartMs);
          });
      };

      if (speechStartMs > 20) {
        // 切页后先静候一段时间（让切换音效清晰落位），期间正常推进画面进度并保持闭嘴
        const waitStart = Date.now();
        setMouthOpen(0);
        intervalId = window.setInterval(() => {
          if (cancelled) {
            return;
          }
          const waitedMs = Math.min(speechStartMs, Date.now() - waitStart);
          setSectionProgress(Math.min(1, waitedMs / Math.max(1, durationMs)));
          setGlobalTimeMs(sec.startMs + waitedMs);
        }, 40);
        preTimerId = window.setTimeout(() => {
          window.clearInterval(intervalId);
          startVoicePlay();
        }, speechStartMs);
      } else {
        startVoicePlay();
      }

      return () => {
        cancelled = true;
        window.clearInterval(intervalId);
        window.clearTimeout(preTimerId);
        window.clearTimeout(padTimerId);
        voice.removeEventListener('ended', onAudioEnded);
        voice.removeEventListener('error', onAudioError);
        voice.pause();
      };
    }

    startSilentTimerFallback();
    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
      window.clearTimeout(preTimerId);
      window.clearTimeout(padTimerId);
    };
  }, [
    audioUnlockTick,
    currentPage,
    currentSection,
    inspectorOpen,
    isAutoPlaying,
    isMuted,
    issueFps,
    navigateTo,
    startup.clockMode,
    totalDurationMs,
    totalPages,
  ]);

  useEffect(() => {
    if (voiceAudioRef.current) {
      voiceAudioRef.current.muted = isMuted;
    }
    if (bgmAudioRef.current) {
      bgmAudioRef.current.muted = isMuted;
    }
  }, [isMuted]);

  const handleUnlockAudioPlay = useCallback(() => {
    if (audioCtxRef.current?.state === 'suspended') {
      void audioCtxRef.current.resume().catch(() => undefined);
    }
    setAutoplayBlocked(false);
    setIsAutoPlaying(true);
    setAudioUnlockTick((n) => n + 1);
  }, []);

  useEffect(() => {
    if (startup.clockMode === 'manual') {
      return;
    }

    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName?.toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select' || target?.isContentEditable) {
        if (event.key === 'Escape' && inspectorOpen) {
          setInspectorOpen(false);
        }
        return;
      }

      if (event.key === 'ArrowRight' || event.key === 'PageDown' || event.key === ' ') {
        event.preventDefault();
        navigateTo(currentPage + 1);
      } else if (event.key === 'ArrowLeft' || event.key === 'PageUp') {
        event.preventDefault();
        navigateTo(currentPage - 1);
      } else if (event.key.toLowerCase() === 'p') {
        event.preventDefault();
        setIsAutoPlaying((prev) => !prev);
      } else if (event.key.toLowerCase() === 'm') {
        event.preventDefault();
        setIsMuted((prev) => !prev);
      } else if (event.key.toLowerCase() === 't') {
        event.preventDefault();
        cycleTransitionStyle();
      } else if (event.key.toLowerCase() === 'h') {
        event.preventDefault();
        setCleanMode((prev) => !prev);
      } else if (event.key.toLowerCase() === 'e') {
        event.preventDefault();
        setInspectorTab('summary');
        setInspectorOpen((prev) => !prev);
      } else if (event.key === 'Escape' && inspectorOpen) {
        setInspectorOpen(false);
      }
    };

    const onWheel = (event: WheelEvent) => {
      if (inspectorOpen || cleanMode) {
        return;
      }
      const absX = Math.abs(event.deltaX);
      const absY = Math.abs(event.deltaY);
      if (absX < 36 || absX <= absY) {
        return;
      }
      const now = Date.now();
      if (now < wheelLockUntilRef.current) {
        return;
      }
      wheelLockUntilRef.current = now + 750;
      navigateTo(event.deltaX > 0 ? currentPage + 1 : currentPage - 1);
    };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('wheel', onWheel, { passive: true });
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('wheel', onWheel);
    };
  }, [currentPage, inspectorOpen, cleanMode, navigateTo, cycleTransitionStyle, startup.clockMode]);

  const applyRawData = useCallback((nextRaw: unknown) => {
    const check = sanitizeDailyIssue(nextRaw);
    flushSync(() => {
      if (nextRaw && typeof nextRaw === 'object' && !Array.isArray(nextRaw)) {
        setRawIssue(nextRaw as DailyIssueInput);
      } else {
        setRawIssue(check.issue);
      }
      setIssueVersion((v) => v + 1);
      setSectionProgress(0);
      setGlobalTimeMs(0);
      setMouthOpen(0);
      hasPerformedInitialSeekRef.current = false;
      setNavState((prev) => ({
        ...prev,
        currentPage: clampPageIndex(prev.currentPage, check.issue.items.length + 2),
        exitingPage: null,
        virtualProgress: null,
      }));
    });
    return check;
  }, []);

  const resetSampleIssue = useCallback(() => {
    setRawIssue(SAMPLE_DAILY_ISSUE);
    setIssueVersion((v) => v + 1);
    setSectionProgress(0);
    setGlobalTimeMs(0);
    setMouthOpen(0);
    hasPerformedInitialSeekRef.current = false;
    setNavState((prev) => ({ ...prev, exitingPage: null, virtualProgress: null }));
  }, []);

  const stateRef = useRef({
    currentPage,
    totalPages,
    currentSection,
    sectionTimings,
    totalDurationMs,
    issueFps,
    isAutoPlaying,
    cleanMode,
    theme,
    transitionStyle,
    effectiveTransition,
    clockMode: startup.clockMode,
    motion: startup.motion,
    sanitized,
    runtimeErrors,
    globalTimeMs,
    sectionProgress,
    mouthOpen,
    live2dReady,
  });

  stateRef.current = {
    currentPage,
    totalPages,
    currentSection,
    sectionTimings,
    totalDurationMs,
    issueFps,
    isAutoPlaying,
    cleanMode,
    theme,
    transitionStyle,
    effectiveTransition,
    clockMode: startup.clockMode,
    motion: startup.motion,
    sanitized,
    runtimeErrors,
    globalTimeMs,
    sectionProgress,
    mouthOpen,
    live2dReady,
  };

  useEffect(() => {
    const waitSettledFrame = async (pageChanged: boolean) => {
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      });
      if (
        pageChanged &&
        stateRef.current.motion !== 'static' &&
        stateRef.current.clockMode !== 'manual'
      ) {
        const settleMs = PAGE_TURN_DURATION_MS[stateRef.current.transitionStyle];
        await transitionTiming.wait(settleMs);
      }
      await mediaReadyTracker.waitForAll(1500);
    };

    const seekTo = async (targetTimeMs: number, explicitDtMs?: number): Promise<SeekToResult> => {
      const timings = stateRef.current.sectionTimings;
      const maxDur = stateRef.current.totalDurationMs;
      const fps = stateRef.current.issueFps || DEFAULT_LIP_SYNC_FPS;
      const safeMs = Number.isFinite(targetTimeMs)
        ? Math.min(maxDur, Math.max(0, targetTimeMs))
        : 0;

      const targetFrame = Math.round((safeMs * fps) / 1000);
      let secIdx = timings.length - 1;
      for (let i = 0; i < timings.length; i++) {
        const sec = timings[i]!;
        if (sec.startFrame !== null && sec.endFrame !== null) {
          if (targetFrame < sec.endFrame) {
            secIdx = i;
            break;
          }
        } else if (safeMs + 1e-4 < sec.startMs + sec.durationMs) {
          secIdx = i;
          break;
        }
      }
      const sec = timings[secIdx]!;
      const localMs =
        sec.startFrame !== null
          ? Math.max(0, ((targetFrame - sec.startFrame) * 1000) / fps)
          : Math.max(0, safeMs - sec.startMs);
      const secRatio = sec.durationMs > 0 ? Math.min(1, localMs / sec.durationMs) : 1;

      const effStyle = stateRef.current.effectiveTransition;
      const turnDur = PAGE_TURN_DURATION_MS[effStyle];
      let nextExiting: number | null = null;
      let nextVirtualProg: number | null = null;
      if (secIdx > 0 && effStyle !== 'none' && turnDur > 0 && localMs < turnDur) {
        nextExiting = secIdx - 1;
        nextVirtualProg = Math.min(1, Math.max(0, localMs / turnDur));
      }

      const speechLocalMs = localMs - sec.speechStartMs;
      const nextMouth =
        speechLocalMs < 0
          ? 0
          : sampleLipSyncAtSec(sec.lipSyncFrames, speechLocalMs / 1000, sec.speechMs / 1000, fps);
      const prevPage = stateRef.current.currentPage;

      flushSync(() => {
        setNavState((prev) => ({
          currentPage: secIdx,
          exitingPage: nextExiting,
          direction: 'next',
          turnSeq: secIdx !== prev.currentPage ? prev.turnSeq + 1 : prev.turnSeq,
          virtualProgress: nextVirtualProg,
        }));
        setGlobalTimeMs(safeMs);
        setSectionProgress(secRatio);
        setMouthOpen(nextMouth);
      });

      const fixedDtMs =
        explicitDtMs !== undefined && Number.isFinite(explicitDtMs) && explicitDtMs > 0
          ? explicitDtMs
          : 1000 / fps;

      mascotRef.current?.renderAt(
        safeMs,
        fixedDtMs,
        nextMouth,
        sec.mascotMood,
        speechLocalMs >= 0 && speechLocalMs <= sec.speechMs && nextMouth > 0.01,
      );

      if (secIdx !== prevPage || !hasPerformedInitialSeekRef.current) {
        hasPerformedInitialSeekRef.current = true;
        await mediaReadyTracker.waitForAll(1500);
      }

      const isL2dReady = Boolean(mascotRef.current?.isLive2DReady());
      return {
        currentPage: secIdx,
        exitingPage: nextExiting,
        transitionProgress: nextVirtualProg ?? 1,
        sectionProgress: secRatio,
        mouthOpen: nextMouth,
        live2dReady: isL2dReady,
      };
    };

    window.__NEWS_DECK__ = {
      getState: (): DeckBridgeState => ({
        currentPage: stateRef.current.currentPage,
        totalPages: stateRef.current.totalPages,
        pageType: stateRef.current.currentSection.pageType,
        suggestedDurationSec: stateRef.current.currentSection.durationMs / 1000,
        isAutoPlaying: stateRef.current.isAutoPlaying,
        cleanMode: stateRef.current.cleanMode,
        theme: stateRef.current.theme,
        transition: stateRef.current.transitionStyle,
        clockMode: stateRef.current.clockMode,
        globalTimeMs: stateRef.current.globalTimeMs,
        totalDurationMs: stateRef.current.totalDurationMs,
        sectionProgress: stateRef.current.sectionProgress,
        mouthOpen: stateRef.current.mouthOpen,
        live2dReady: Boolean(mascotRef.current?.isLive2DReady() ?? stateRef.current.live2dReady),
      }),
      getPageCount: () => stateRef.current.totalPages,
      getCurrentPage: () => stateRef.current.currentPage,
      goToPage: async (index: number) => {
        const prev = stateRef.current.currentPage;
        const clamped = navigateTo(index);
        await waitSettledFrame(clamped !== prev);
        return clamped;
      },
      nextPage: async () => {
        const curr = stateRef.current.currentPage;
        const max = stateRef.current.totalPages - 1;
        if (curr >= max) {
          return false;
        }
        navigateTo(curr + 1);
        await waitSettledFrame(true);
        return true;
      },
      prevPage: async () => {
        const curr = stateRef.current.currentPage;
        if (curr <= 0) {
          return false;
        }
        navigateTo(curr - 1);
        await waitSettledFrame(true);
        return true;
      },
      setNewsData: (raw: unknown) => {
        const result = applyRawData(raw);
        return {
          ok: true,
          warningCount: result.warnings.length,
          warnings: result.warnings,
          totalPages: result.issue.items.length + 2,
        };
      },
      getHealthReport: () => ({
        ok: stateRef.current.runtimeErrors.length === 0,
        isDataClean: stateRef.current.sanitized.isClean,
        warningCount: stateRef.current.sanitized.warnings.length,
        warnings: stateRef.current.sanitized.warnings,
        runtimeErrors: stateRef.current.runtimeErrors,
      }),
      waitUntilReady: async (timeoutMs = 12_000) => {
        if (typeof document !== 'undefined' && document.fonts?.ready) {
          await Promise.race([document.fonts.ready, new Promise<void>((r) => setTimeout(r, 3000))]);
        }
        await mediaReadyTracker.waitForAll(Math.min(5000, timeoutMs));
        // 让出一个宏任务周期，确保数据更新后的被动副作用已完成角色模型加载任务注册
        await new Promise<void>((r) => setTimeout(r, 0));
        const l2d = (await mascotRef.current?.waitUntilReady(timeoutMs)) ?? false;
        return { ok: true, live2dReady: l2d };
      },
      warmupPhysics: async (
        atTimeMs: number,
        steps = 18,
        mood: MascotMood = 'neutral',
        stepMs?: number,
      ) => {
        mascotRef.current?.warmupPhysics(
          atTimeMs,
          steps,
          mood,
          stepMs ?? 1000 / (stateRef.current.issueFps || DEFAULT_LIP_SYNC_FPS),
        );
      },
      seekTo,
    };

    return () => {
      delete window.__NEWS_DECK__;
    };
  }, [applyRawData, navigateTo]);

  const activeMascotId = currentSection.mascotId;
  const activeCustomMascotUrl = currentSection.customMascotUrl;
  const activeLive2dUrl =
    sanitized.issue.mascotMode === 'fixed-host' || activeMascotId === sanitized.issue.hostMascotId
      ? sanitized.issue.hostLive2dUrl
      : null;
  const hasVisibleMascot = Boolean(
    activeMascotId !== 'none' || activeCustomMascotUrl || activeLive2dUrl,
  );
  const currentLocalSec = (sectionProgress * currentSection.durationMs) / 1000;
  const activeSubtitle = hasAnySubtitles
    ? currentSection.subtitles.find(
        (cue) => currentLocalSec >= cue.startSec && currentLocalSec < cue.endSec,
      )
    : undefined;
  const subtitleLines = activeSubtitle
    ? formatSubtitleLines(activeSubtitle.text, hasVisibleMascot ? 28.5 : 31.5)
    : [];

  // 卡片跟着口播逐张出现只在「正在播放」或「逐帧渲染」时生效；暂停浏览、静态模式或指定全部显示时直接显示全部卡片
  const progressiveRevealActive =
    startup.reveal === 'progressive' &&
    startup.motion !== 'static' &&
    (startup.clockMode === 'manual' || isAutoPlaying);
  const currentRevealLocalMs = progressiveRevealActive ? currentLocalSec * 1000 : null;

  const renderPageByIndex = useCallback(
    (pageIdx: number, isExiting: boolean) => {
      const clampedIdx = clampPageIndex(pageIdx, totalPages);
      if (clampedIdx === 0) {
        return (
          <CoverPage
            issue={sanitized.issue}
            onJumpToNews={isExiting ? () => {} : (itemIdx) => navigateTo(itemIdx + 1)}
          />
        );
      }
      if (clampedIdx >= totalPages - 1) {
        return (
          <SummaryOutroPage
            issue={sanitized.issue}
            onJumpToNews={isExiting ? () => {} : (itemIdx) => navigateTo(itemIdx + 1)}
          />
        );
      }
      const item = sanitized.issue.items[clampedIdx - 1];
      if (!item) {
        return null;
      }
      const pageMascotId =
        sanitized.issue.mascotMode === 'fixed-host' ? sanitized.issue.hostMascotId : item.mascotId;
      const pageHasMascot = Boolean(
        pageMascotId !== 'none' ||
          item.customMascotUrl ||
          sanitized.issue.hostMascotUrl ||
          (sanitized.issue.mascotMode === 'fixed-host' && sanitized.issue.hostLive2dUrl),
      );
      const pageSection = sectionTimings[clampedIdx];
      // 正在渐出的旧页保持完整画面；只有当前页的卡片按播放进度逐张出现
      const pageRevealLocalMs =
        !isExiting && clampedIdx === currentPage ? currentRevealLocalMs : null;
      return (
        <NewsCardPage
          item={item}
          totalItems={sanitized.issue.items.length}
          hasMascot={pageHasMascot}
          isExiting={isExiting}
          onErrorCaptured={isExiting ? undefined : recordRuntimeError}
          revealLocalMs={pageRevealLocalMs}
          pageDurationMs={pageSection?.durationMs ?? item.durationSec * 1000}
          subtitles={pageSection?.subtitles ?? item.subtitles}
          speechStartMs={pageSection?.speechStartMs ?? item.speechStartSec * 1000}
          speechMs={pageSection?.speechMs ?? item.speechDurationSec * 1000}
        />
      );
    },
    [
      currentPage,
      currentRevealLocalMs,
      navigateTo,
      recordRuntimeError,
      sanitized.issue,
      sectionTimings,
      totalPages,
    ],
  );

  const controlsOverlay = (
    <>
      {!cleanMode && autoplayBlocked && (
        <button
          type="button"
          className="autoplay-unlock-pill"
          data-testid="unlock-autoplay-pill"
          onClick={handleUnlockAudioPlay}
        >
          <Volume2 size={17} />
          <span>点击开启有声播报</span>
        </button>
      )}

      <DeckControls
        currentPage={currentPage}
        totalPages={totalPages}
        isAutoPlaying={isAutoPlaying}
        isMuted={isMuted}
        hasAudioSource={hasAnyAudioSource}
        theme={theme}
        cleanMode={cleanMode}
        transitionStyle={transitionStyle}
        warningCount={sanitized.warnings.length}
        runtimeErrorCount={runtimeErrors.length}
        onPrev={() => navigateTo(currentPage - 1)}
        onNext={() => navigateTo(currentPage + 1)}
        onToggleAutoPlay={() => {
          if (autoplayBlocked) {
            handleUnlockAudioPlay();
          } else {
            setIsAutoPlaying((prev) => !prev);
          }
        }}
        onToggleMute={() => setIsMuted((prev) => !prev)}
        onCycleTransition={cycleTransitionStyle}
        onToggleTheme={() => setTheme((prev) => (prev === 'light' ? 'dark' : 'light'))}
        onToggleCleanMode={() => setCleanMode((prev) => !prev)}
        onOpenInspector={(tab = 'summary') => {
          setInspectorTab(tab);
          setInspectorOpen(true);
        }}
      />
    </>
  );

  return (
    <DeckErrorBoundary scopeName="deck-root" onErrorCaptured={recordRuntimeError}>
      <ViewportScaler
        theme={theme}
        motion={startup.motion}
        clockMode={startup.clockMode}
        cleanMode={cleanMode}
        overlay={controlsOverlay}
      >
        <div
          className={`deck-canvas ${hasAnySubtitles ? 'has-subtitles' : ''}`}
          data-host={activeMascotId}
        >
          <DeckHeader
            issue={sanitized.issue}
            currentPage={currentPage}
            totalPages={totalPages}
            pageLabel={currentSection.pageLabel}
            activeMascotId={activeMascotId}
            sectionProgress={sectionProgress}
            sectionDurationsMs={sectionDurationsMs}
            globalTimeMs={globalTimeMs}
            totalDurationMs={totalDurationMs}
            onSelectPage={(idx) => navigateTo(idx)}
          />

          <main className="deck-slide-body">
            <PageTransitionStage
              currentPage={currentPage}
              exitingPage={exitingPage}
              direction={direction}
              issueVersion={issueVersion}
              transitionStyle={transitionStyle}
              motion={startup.motion}
              virtualProgress={virtualProgress}
              renderPage={renderPageByIndex}
            />
          </main>

          {hasAnySubtitles && (
            <footer
              className={`deck-subtitle-dock ${hasVisibleMascot ? 'has-mascot' : 'no-mascot'}`}
              data-testid="deck-subtitle-dock"
              aria-live="polite"
            >
              {subtitleLines.length > 0 && (
                <div
                  className={`deck-subtitle-pill ${
                    subtitleLines.length >= 3
                      ? 'is-multiline is-three-lines'
                      : subtitleLines.length === 2
                        ? 'is-multiline'
                        : ''
                  }`}
                  data-testid="deck-subtitle-text"
                >
                  {subtitleLines.join('\n')}
                </div>
              )}
            </footer>
          )}

          <CornerMascot
            ref={mascotRef}
            mascotId={activeMascotId}
            customMascotUrl={activeCustomMascotUrl}
            live2dModelUrl={activeLive2dUrl}
            clockMode={startup.clockMode}
            globalTimeMs={globalTimeMs}
            mouthOpen={mouthOpen}
            mood={currentSection.mascotMood}
            speaking={isAutoPlaying && mouthOpen > 0.01}
            onLive2DReadyChange={setLive2dReady}
            onErrorCaptured={recordRuntimeError}
          />
        </div>
      </ViewportScaler>

      <DataInspectorDrawer
        open={!cleanMode && inspectorOpen}
        activeTab={inspectorTab}
        rawIssue={rawIssue}
        sanitizedIssue={sanitized.issue}
        warnings={sanitized.warnings}
        runtimeErrors={runtimeErrors}
        activeNewsItemIndex={Math.max(currentSection.newsIndex, 0)}
        onTabChange={setInspectorTab}
        onClose={() => setInspectorOpen(false)}
        onApplyRawData={applyRawData}
        onResetSample={resetSampleIssue}
        onJumpToNewsPage={(idx) => navigateTo(idx + 1)}
      />
    </DeckErrorBoundary>
  );
};
