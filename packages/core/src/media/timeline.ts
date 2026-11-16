import path from 'node:path';
import {
  type NarrationSection,
  type SectionAudio,
  type Timeline,
  TimelineSchema,
  type TimelineSection,
} from '@aidaily/contracts';

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
