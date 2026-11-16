import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  IssuePackage,
  NarrationSection,
  RunItemRecord,
  SectionAudio,
  Settings,
  Timeline,
} from '@aidaily/contracts';
import { probeAudioDurationMs } from '@aidaily/tts';
import type { CoreContext } from '../context.js';
import { PipelineError } from '../errors.js';
import { readJsonOrNull, writeJsonAtomic } from '../storage/files.js';
import { buildTimeline } from './timeline.js';

/** 语音合成阶段完成后写入检查点的结果摘要 */
export interface NarrateCheckpoint {
  timelinePath: string;
  totalMs: number;
  sectionCount: number;
  synthesizedCount: number;
  reusedSectionCount: number;
}

/** 保存在音频目录中用于记录单段配音完成状态的进度记录 */
interface SectionProgressRecord {
  hash: string;
  audio: SectionAudio;
}

/** 计算单个口播段落与当前合成配置的校验摘要，配置或文案变化时使旧进度失效 */
function computeSectionDigest(section: NarrationSection, settings: Settings): string {
  const providerId = settings.tts.provider;
  const providerConfig = settings.tts.providers[providerId] ?? {};
  const payload = JSON.stringify({
    key: section.key,
    sentences: section.sentences,
    providerId,
    providerConfig,
    postprocess: settings.tts.postprocess,
  });
  return crypto.createHash('sha1').update(payload, 'utf8').digest('hex');
}

/** 按最终播出顺序组装本期节目的开场、各条新闻正文及结尾口播段落列表 */
export function buildNarrationSections(
  pkg: IssuePackage,
  itemsById: ReadonlyMap<string, RunItemRecord>,
): NarrationSection[] {
  const sections: NarrationSection[] = [
    {
      key: 'intro',
      kind: 'intro',
      sentences: pkg.intro.narration,
    },
  ];

  pkg.order.forEach((itemId, idx) => {
    const item = itemsById.get(itemId);
    if (!item?.finalJson) {
      throw new Error(`编排顺序中的新闻条目 ${itemId} 缺少定稿内容`);
    }
    sections.push({
      key: `item-${String(idx + 1).padStart(2, '0')}`,
      kind: 'item',
      itemId: item.id,
      sentences: item.finalJson.narration,
    });
  });

  sections.push({
    key: 'outro',
    kind: 'outro',
    sentences: pkg.outro.narration,
  });

  return sections;
}

/**
 * 执行配音合成与时间轴生成阶段：
 * 优先复用此前中断前已完成且音频完整有效、配置未变的段落结果；
 * 其余段落逐句走本地缓存与标准化拼接，完成后原子写出 `timeline.json`。
 */
export async function runNarrateStage(opts: {
  ctx: CoreContext;
  runId: string;
  settings: Settings;
  packageData: IssuePackage;
  signal?: AbortSignal;
}): Promise<{ checkpoint: NarrateCheckpoint; timeline: Timeline }> {
  const { ctx, runId, settings, packageData, signal } = opts;
  const runDir = ctx.paths.runDir(runId);
  const audioDir = path.join(runDir, 'audio');
  const progressFile = path.join(audioDir, 'sections-progress.json');
  const timelineFile = path.join(runDir, 'timeline.json');

  const items = ctx.repos.runItems.listByRun(runId);
  const itemsById = new Map(items.map((i) => [i.id, i]));
  const sections = buildNarrationSections(packageData, itemsById);

  const savedProgress =
    (await readJsonOrNull<Record<string, SectionProgressRecord>>(progressFile)) ?? {};
  const audioByKey = new Map<string, SectionAudio>();
  const pendingSections: NarrationSection[] = [];
  const digestByKey = new Map<string, string>();

  const resolvedAudioDir = path.resolve(audioDir);

  for (const section of sections) {
    const digest = computeSectionDigest(section, settings);
    digestByKey.set(section.key, digest);

    const prev = savedProgress[section.key];
    if (prev && prev.hash === digest && prev.audio.file) {
      const resolvedAudioFile = path.resolve(prev.audio.file);
      if (resolvedAudioFile.startsWith(`${resolvedAudioDir}${path.sep}`)) {
        try {
          await fs.access(resolvedAudioFile);
          const probedMs = await probeAudioDurationMs(resolvedAudioFile, undefined, signal);
          if (Math.abs(probedMs - prev.audio.speechMs) <= 40) {
            audioByKey.set(section.key, {
              ...prev.audio,
              file: resolvedAudioFile,
            });
            continue;
          }
        } catch {
          // 既有段落音频缺失、损坏或时长不一致时清理残片后重新合成
        }
      }
    }

    // 清理可能残留的该段落旧切片或残缺成片后再重新合成
    await fs
      .rm(path.join(resolvedAudioDir, section.key), { recursive: true, force: true })
      .catch(() => undefined);
    await fs
      .rm(path.join(resolvedAudioDir, `${section.key}.wav`), { force: true })
      .catch(() => undefined);
    pendingSections.push(section);
  }

  let writeChain = Promise.resolve();
  const persistSectionProgress = (audio: SectionAudio) => {
    const hash = digestByKey.get(audio.key);
    if (!hash) {
      return Promise.resolve();
    }
    savedProgress[audio.key] = { hash, audio };
    const snapshot = { ...savedProgress };
    writeChain = writeChain
      .catch(() => undefined)
      .then(() => writeJsonAtomic(progressFile, snapshot));
    return writeChain;
  };

  if (pendingSections.length > 0) {
    try {
      const newlySynthesized = await ctx.tts.synthesizeSections(pendingSections, audioDir, {
        signal,
        onSectionDone: persistSectionProgress,
        settingsOverride: settings.tts,
      });
      for (const audio of newlySynthesized) {
        audioByKey.set(audio.key, audio);
      }
      await writeChain;
    } catch (err) {
      await writeChain.catch(() => undefined);
      if (err instanceof Error && err.name === 'AbortError') {
        throw err;
      }
      throw new PipelineError(
        'tts_failed',
        `语音合成失败: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }
  }

  const orderedAudio: SectionAudio[] = [];
  for (const section of sections) {
    const audio = audioByKey.get(section.key);
    if (!audio) {
      throw new PipelineError('tts_failed', `缺少段落 ${section.key} 的合成音频`);
    }
    orderedAudio.push(audio);
  }

  const timeline = buildTimeline({
    sections,
    audioSections: orderedAudio,
    runDir,
    pagePaddingSec: settings.render.pagePaddingSec,
    sectionGapMs: settings.tts.postprocess.sectionGapMs,
  });

  await writeJsonAtomic(timelineFile, timeline);

  return {
    checkpoint: {
      timelinePath: path.relative(ctx.paths.rootDir, timelineFile),
      totalMs: timeline.totalMs,
      sectionCount: sections.length,
      synthesizedCount: pendingSections.length,
      reusedSectionCount: sections.length - pendingSections.length,
    },
    timeline,
  };
}
