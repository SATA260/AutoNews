import path from 'node:path';
import {
  type NarrationSection,
  type SectionAudio,
  type Timeline,
  TimelineSchema,
  type TimelineSection,
} from '@aidaily/contracts';

/** 单个章节在整期统一帧网格上的起止帧号与量化毫秒信息 */
export interface QuantizedSectionFrames {
  index: number;
  sectionKey: string;
  startFrame: number;
  frameCount: number;
  quantizedStartMs: number;
  quantizedDurationMs: number;
  speechMs: number;
}

/** 整期时间轴按目标帧率统一划分后的章节帧区间与对齐音频时间轴 */
export interface QuantizedTimelineResult {
  fps: number;
  totalFrames: number;
  quantizedTotalMs: number;
  sections: QuantizedSectionFrames[];
  audioTimeline: Timeline;
}

/**
 * 根据口播段落定义与实际测量得到的音频时长，计算整期视频每页画面的起止时间、页面停留时长与字幕时间戳。
 */
export function buildTimeline(opts: {
  sections: NarrationSection[];
  audioSections: SectionAudio[];
  runDir: string;
  pagePaddingSec: number;
  sectionGapMs: number;
}): Timeline {
  const { sections, audioSections, runDir, pagePaddingSec, sectionGapMs } = opts;
  const audioByKey = new Map(audioSections.map((a) => [a.key, a]));
  const paddingMs = Math.max(0, Math.round(pagePaddingSec * 1000));

  let cursorMs = 0;
  const timelineSections: TimelineSection[] = [];

  for (let i = 0; i < sections.length; i++) {
    const section = sections[i];
    if (!section) {
      continue;
    }
    const audio = audioByKey.get(section.key);
    if (!audio) {
      throw new Error(`缺少段落 ${section.key} 对应的音频合成结果`);
    }

    const isLast = i === sections.length - 1;
    const trailingGapMs = isLast ? 0 : Math.max(0, sectionGapMs);
    const pageMs = Math.max(1, Math.round(audio.speechMs) + paddingMs + trailingGapMs);
    const startMs = cursorMs;
    cursorMs += pageMs;

    const relAudioFile = path.relative(runDir, audio.file);
    timelineSections.push({
      key: section.key,
      kind: section.kind,
      itemId: section.itemId,
      audioFile: relAudioFile,
      startMs,
      speechMs: Math.round(audio.speechMs),
      pageMs,
      sentences: audio.sentences.map((s) => ({
        text: s.text,
        startMs: startMs + Math.round(s.offsetMs),
        durationMs: Math.round(s.durationMs),
      })),
    });
  }

  return TimelineSchema.parse({
    totalMs: cursorMs,
    sections: timelineSections,
  });
}

/**
 * 将毫秒级原始时间轴映射到整期唯一的固定帧率时间网格上：
 * 每个全局帧时刻 `t_i = i * 1000 / fps` 被唯一归入一个章节，并同步导出使用同一组量化起点的主音轨时间轴，
 * 从根源消除跨章节半帧舍入错位与音画累计漂移。
 */
export function quantizeTimelineToFps(timeline: Timeline, fps: number): QuantizedTimelineResult {
  const safeFps = Math.max(1, Math.round(fps));
  const secCount = timeline.sections.length;
  if (secCount === 0) {
    return {
      fps: safeFps,
      totalFrames: 0,
      quantizedTotalMs: 0,
      sections: [],
      audioTimeline: timeline,
    };
  }

  let totalFrames = Math.max(secCount, Math.round((timeline.totalMs * safeFps) / 1000));
  const counts = new Array<number>(secCount).fill(0);

  for (let f = 0; f < totalFrames; f++) {
    const tMs = (f * 1000) / safeFps;
    let ownerIdx = secCount - 1;
    for (let k = 0; k < secCount; k++) {
      const sec = timeline.sections[k];
      if (!sec) {
        continue;
      }
      if (tMs < sec.startMs + sec.pageMs) {
        ownerIdx = k;
        break;
      }
    }
    counts[ownerIdx] = (counts[ownerIdx] ?? 0) + 1;
  }

  // 极端超短测试段落兜底：保证每个章节至少拥有 1 帧可编码画面
  for (let k = 0; k < secCount; k++) {
    if ((counts[k] ?? 0) <= 0) {
      let donor = -1;
      let maxFrames = 1;
      for (let j = 0; j < secCount; j++) {
        if ((counts[j] ?? 0) > maxFrames) {
          maxFrames = counts[j] ?? 0;
          donor = j;
        }
      }
      if (donor >= 0) {
        counts[donor] = (counts[donor] ?? 2) - 1;
      } else {
        totalFrames += 1;
      }
      counts[k] = 1;
    }
  }

  const quantizedSections: QuantizedSectionFrames[] = [];
  const audioSections: TimelineSection[] = [];
  let frameCursor = 0;

  for (let k = 0; k < secCount; k++) {
    const orig = timeline.sections[k];
    if (!orig) {
      continue;
    }
    const frameCount = counts[k] ?? 1;
    const startFrame = frameCursor;
    const endFrame = startFrame + frameCount;
    frameCursor = endFrame;

    const quantizedStartMs = (startFrame * 1000) / safeFps;
    const quantizedDurationMs = (frameCount * 1000) / safeFps;

    const audioStartMs = Math.round(quantizedStartMs);
    const audioEndMs = Math.round((endFrame * 1000) / safeFps);
    const audioPageMs = Math.max(1, audioEndMs - audioStartMs);
    const shiftMs = audioStartMs - orig.startMs;

    quantizedSections.push({
      index: k,
      sectionKey: orig.key,
      startFrame,
      frameCount,
      quantizedStartMs,
      quantizedDurationMs,
      speechMs: Math.min(orig.speechMs, Math.round(quantizedDurationMs)),
    });

    audioSections.push({
      ...orig,
      startMs: audioStartMs,
      pageMs: audioPageMs,
      speechMs: Math.min(orig.speechMs, audioPageMs),
      sentences: orig.sentences.map((s) => ({
        ...s,
        startMs: Math.max(audioStartMs, s.startMs + shiftMs),
      })),
    });
  }

  const audioTotalMs = Math.max(1, Math.round((frameCursor * 1000) / safeFps));

  return {
    fps: safeFps,
    totalFrames: frameCursor,
    quantizedTotalMs: (frameCursor * 1000) / safeFps,
    sections: quantizedSections,
    audioTimeline: {
      totalMs: audioTotalMs,
      sections: audioSections,
    },
  };
}
