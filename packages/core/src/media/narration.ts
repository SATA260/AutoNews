import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  type IssuePackage,
  MEDIA_ADJUSTABLE_RUN_STATUSES,
  type NarrationOverrideMap,
  NarrationOverrideMapSchema,
  type NarrationSection,
  type NarrationSectionView,
  type RunItemRecord,
  type SectionAudio,
  SectionAudioSchema,
  type Settings,
  type Timeline,
  TimelineSchema,
  UpdateSectionNarrationInputSchema,
} from '@aidaily/contracts';
import {
  alignDisplaySentencesToWav,
  buildNarrationParagraph,
  isLocalVoiceCloneProvider,
  prepareNarrationSentences,
  probeAudioDurationMs,
  QWEN_AUDIO_PROCESSING_VERSION,
} from '@aidaily/tts';
import { z } from 'zod';
import type { CoreContext } from '../context.js';
import { PackageCheckpointSchema } from '../editorial/s6-package.js';
import { PipelineError } from '../errors.js';
import { inTransaction } from '../storage/db.js';
import { readJsonOrNull, readJsonOrNullWithSchema, writeJsonAtomic } from '../storage/files.js';
import { emitRunEvent } from '../workflow/events.js';
import { buildTimeline, resolvePageTurnPostDelayMs } from './timeline.js';

/** 语音合成阶段完成后写入检查点的结果摘要 */
export interface NarrateCheckpoint {
  timelinePath: string;
  totalMs: number;
  sectionCount: number;
  synthesizedCount: number;
  reusedSectionCount: number;
}

/** 保存在音频目录中用于记录单段配音完成状态的进度记录结构 */
const SectionProgressMapSchema = z.record(
  z.string(),
  z.object({
    hash: z.string(),
    audio: SectionAudioSchema,
  }),
);

/** 计算单个口播段落与当前合成配置的校验摘要，配置或语音文案变化时使旧音频失效。画面字幕不参与这个摘要 */
function computeSectionDigest(section: NarrationSection, settings: Settings): string {
  const providerId = section.provider ?? settings.tts.provider;
  const providerConfig = settings.tts.providers[providerId] ?? {};
  const { sampleRate, loudnessLUFS, trimSilence } = settings.tts.postprocess;
  const denoise = settings.tts.postprocess.denoise ?? true;
  const payload = JSON.stringify({
    key: section.key,
    paragraph: buildNarrationParagraph(section.sentences),
    synthesisMode: 'whole-paragraph',
    subtitleTimingVersion: 2,
    providerId,
    providerConfig,
    postprocess: { sampleRate, loudnessLUFS, trimSilence, denoise },
    processingVersion: isLocalVoiceCloneProvider(providerId) ? QWEN_AUDIO_PROCESSING_VERSION : 0,
  });
  return crypto.createHash('sha1').update(payload, 'utf8').digest('hex');
}

/** 人工保存的分段配音文件名，和整期编排放在一起，重做编排时会一并备份 */
const NARRATION_OVERRIDES_FILE = 'narration-overrides.json';

/** 段落标识只允许字母、数字、横线和下划线，避免写出任务目录外面 */
const SECTION_KEY_PATTERN = /^[a-zA-Z0-9_-]+$/;

/** 按最终播出顺序组装本期节目的开场、各条新闻正文及结尾口播段落列表 */
export function buildNarrationSections(
  pkg: IssuePackage,
  itemsById: ReadonlyMap<string, RunItemRecord>,
  overrides: NarrationOverrideMap = {},
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

  return sections.map((section) => applySectionOverride(section, overrides[section.key]));
}

/** 把人工保存的语音、字幕和引擎套到原始段落上。没有修改时保持原稿 */
function applySectionOverride(
  section: NarrationSection,
  override: NarrationOverrideMap[string] | undefined,
): NarrationSection {
  if (!override) {
    return section;
  }
  return {
    ...section,
    sentences: override.ttsSentences,
    displaySentences: override.displaySentences,
    ...(override.provider ? { provider: override.provider } : {}),
  };
}

/** 画面字幕优先用人工分句；没有人工分句时用清理后的语音分句 */
function resolveDisplaySentences(section: NarrationSection): string[] {
  const custom = section.displaySentences?.map((sentence) => sentence.trim()).filter(Boolean);
  if (custom && custom.length > 0) {
    return custom;
  }
  return prepareNarrationSentences(section.sentences);
}

/** 多行文本按行拆开；只有一行时按句号、问号和叹号拆开，方便编辑框里直接改断句 */
function splitSubtitleText(text: string): string[] {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) {
    throw new Error('字幕文本不能为空');
  }
  if (lines.length > 1) {
    return lines;
  }
  const onlyLine = lines[0] ?? '';
  const parts = onlyLine
    .split(/(?<=[。！？!?]+)(?![。！？!?])\s*/u)
    .map((part) => part.trim())
    .filter(Boolean);
  return parts.length > 0 ? parts : [onlyLine];
}

/** 判断两组分句是否逐句相同 */
function sameSentences(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((sentence, index) => sentence === right[index]);
}

/** 把编辑框里的语音文本整理成适合整段合成的分句 */
function splitTtsText(text: string): string[] {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const prepared = prepareNarrationSentences(lines.length > 0 ? lines : [text]);
  if (prepared.length === 0) {
    throw new Error('语音文本清理后为空');
  }
  return prepared;
}

/** 读取本期人工配音修改。文件不存在时当作没有修改 */
async function readNarrationOverrides(runDir: string): Promise<NarrationOverrideMap> {
  const raw = await readJsonOrNull<unknown>(path.join(runDir, NARRATION_OVERRIDES_FILE));
  if (raw === null) {
    return {};
  }
  const parsed = NarrationOverrideMapSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error('配音修改记录无法读取，请恢复原稿后再试');
  }
  return parsed.data;
}

/** 把本期主播和音色摘要写进即将使用的每个语音引擎配置，保证换引擎后仍用同一个主播 */
async function settingsForNarrationProviders(
  ctx: CoreContext,
  runId: string,
  settings: Settings,
  providerIds: readonly string[],
): Promise<Settings> {
  const row = ctx.db.prepare('SELECT host_id FROM runs WHERE id = ?').get(runId) as
    | { host_id: string | null }
    | undefined;
  const hostId = row?.host_id ?? null;
  const providers = { ...settings.tts.providers };
  for (const providerId of new Set(providerIds)) {
    if (isLocalVoiceCloneProvider(providerId) && !hostId) {
      throw new PipelineError('tts_failed', '尚未确定本期主播，请从选题阶段重新运行或指定主播');
    }
    const providerConfig = {
      ...(providers[providerId] ?? {}),
      ...(hostId && isLocalVoiceCloneProvider(providerId) ? { hostId } : {}),
    };
    const identity = await ctx.tts.getActiveProvider(providerId).cacheIdentity?.(providerConfig);
    providers[providerId] = {
      ...providerConfig,
      ...(identity ? { referenceHash: identity } : {}),
    };
  }
  return {
    ...settings,
    tts: {
      ...settings.tts,
      providers,
    },
  };
}

/** 读取磁盘最新全局配置并同步任务记录快照，确保配音与字幕调整按当前界面配置生效 */
async function readRunSettings(ctx: CoreContext, runId: string): Promise<Settings> {
  const run = ctx.repos.runs.getById(runId);
  if (!run) {
    throw new Error(`未找到任务记录: ${runId}`);
  }
  await ctx.reloadConfig();
  const nextJson = JSON.stringify(ctx.settings);
  if (nextJson !== run.configSnapshotJson) {
    ctx.db.prepare('UPDATE runs SET config_snapshot = ? WHERE id = ?').run(nextJson, runId);
  }
  return ctx.settings;
}

/** 确认当前状态允许改配音、字幕、配图或背景音乐 */
function assertNarrationEditable(ctx: CoreContext, runId: string): void {
  const status = ctx.repos.runs.getById(runId)?.status;
  if (!status || !MEDIA_ADJUSTABLE_RUN_STATUSES.includes(status)) {
    throw new Error('当前任务状态不允许修改配音或字幕');
  }
}

/**
 * 执行配音合成与时间轴生成阶段：
 * 优先复用此前中断前已完成且音频完整有效、配置未变的段落结果；
 * 其余段落先清洗句内多余空格并以单个空格逐句隔开合段送入语音引擎、执行标准化，完成后原子写出 `timeline.json`。
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
  const overrides = await readNarrationOverrides(runDir);
  const sections = buildNarrationSections(packageData, itemsById, overrides);
  const effectiveSettings = await settingsForNarrationProviders(ctx, runId, settings, [
    settings.tts.provider,
    ...sections.map((section) => section.provider ?? settings.tts.provider),
  ]);

  const savedProgress =
    (await readJsonOrNullWithSchema(progressFile, SectionProgressMapSchema, {
      fallbackNullOnInvalid: true,
    })) ?? {};
  let progressDirty = false;
  const audioByKey = new Map<string, SectionAudio>();
  const pendingSections: NarrationSection[] = [];
  const digestByKey = new Map<string, string>();

  const resolvedAudioDir = path.resolve(audioDir);

  for (const section of sections) {
    const digest = computeSectionDigest(section, effectiveSettings);
    digestByKey.set(section.key, digest);

    const prev = savedProgress[section.key];
    if (prev && prev.hash === digest && prev.audio.file) {
      const resolvedAudioFile = path.resolve(prev.audio.file);
      if (resolvedAudioFile.startsWith(`${resolvedAudioDir}${path.sep}`)) {
        try {
          await fs.access(resolvedAudioFile);
          const probedMs = await probeAudioDurationMs(resolvedAudioFile, undefined, signal);
          if (Math.abs(probedMs - prev.audio.speechMs) <= 40) {
            const displaySentences = resolveDisplaySentences(section);
            const savedTexts = prev.audio.sentences.map((sentence) => sentence.text);
            const displayChanged =
              displaySentences.length !== savedTexts.length ||
              displaySentences.some((text, index) => text !== savedTexts[index]);
            const reusedAudio: SectionAudio = displayChanged
              ? {
                  ...prev.audio,
                  file: resolvedAudioFile,
                  speechMs: probedMs,
                  sentences: await alignDisplaySentencesToWav(
                    resolvedAudioFile,
                    section.sentences,
                    displaySentences,
                    probedMs,
                  ),
                }
              : {
                  ...prev.audio,
                  file: resolvedAudioFile,
                };
            if (displayChanged) {
              savedProgress[section.key] = { hash: digest, audio: reusedAudio };
              progressDirty = true;
            }
            audioByKey.set(section.key, reusedAudio);
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
        onWarning: (message) => {
          ctx.repos.runEvents.append({
            runId,
            ts: ctx.now().toISOString(),
            level: 'warn',
            stage: 'narrate',
            type: 'tts_duration_warning',
            message,
          });
        },
        settingsOverride: effectiveSettings.tts,
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

  if (progressDirty) {
    await writeJsonAtomic(progressFile, savedProgress);
  }

  const timeline = buildTimeline({
    sections,
    audioSections: orderedAudio,
    runDir,
    pagePaddingSec: settings.render.pagePaddingSec,
    sectionGapMs: settings.tts.postprocess.sectionGapMs,
    sectionLeadSilenceMs: resolvePageTurnPostDelayMs(settings.render.pageTurnSfx),
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

/** 读取整期编排。还没编排完时不能单独改某一段配音 */
async function loadIssuePackage(ctx: CoreContext, runId: string): Promise<IssuePackage> {
  const ckpt = await readJsonOrNullWithSchema(
    path.join(ctx.paths.runDir(runId), 'stages', 'package.json'),
    PackageCheckpointSchema,
    { label: '整期编排检查点' },
  );
  if (!ckpt?.packageData) {
    throw new Error('还没有整期编排，不能修改配音');
  }
  return ckpt.packageData;
}

/** 给页面用的段落名称：开场、第几条新闻、片尾 */
function sectionLabel(
  section: NarrationSection,
  itemsById: ReadonlyMap<string, RunItemRecord>,
  itemOrdinal: number,
): string {
  if (section.kind === 'intro') {
    return '开场导语';
  }
  if (section.kind === 'outro') {
    return '片尾总结';
  }
  const title = section.itemId ? itemsById.get(section.itemId)?.finalJson?.shortTitle : undefined;
  return title ? `第${itemOrdinal}条 ${title}` : `第${itemOrdinal}条`;
}

/** 按当前配音进度重写整期时间轴，让字幕和每段音频时长重新对齐 */
async function rebuildTimeline(
  ctx: CoreContext,
  runId: string,
  settings: Settings,
  sections: NarrationSection[],
): Promise<Timeline> {
  const runDir = ctx.paths.runDir(runId);
  const progressFile = path.join(runDir, 'audio', 'sections-progress.json');
  const saved =
    (await readJsonOrNullWithSchema(progressFile, SectionProgressMapSchema, {
      fallbackNullOnInvalid: true,
    })) ?? {};
  const audioSections: SectionAudio[] = [];
  for (const section of sections) {
    const audio = saved[section.key]?.audio;
    if (!audio?.file) {
      throw new Error(`缺少段落 ${section.key} 的配音，请先生成本段音频`);
    }
    audioSections.push(audio);
  }
  const timeline = buildTimeline({
    sections,
    audioSections,
    runDir,
    pagePaddingSec: settings.render.pagePaddingSec,
    sectionGapMs: settings.tts.postprocess.sectionGapMs,
    sectionLeadSilenceMs: resolvePageTurnPostDelayMs(settings.render.pageTurnSfx),
  });
  await writeJsonAtomic(path.join(runDir, 'timeline.json'), timeline);
  return timeline;
}

/** 把某一段新的音频结果写进配音进度，供下次整期配音直接复用 */
async function saveSectionProgress(
  runDir: string,
  section: NarrationSection,
  settings: Settings,
  audio: SectionAudio,
  preserveHash?: string,
): Promise<void> {
  const progressFile = path.join(runDir, 'audio', 'sections-progress.json');
  const saved =
    (await readJsonOrNullWithSchema(progressFile, SectionProgressMapSchema, {
      fallbackNullOnInvalid: true,
    })) ?? {};
  saved[section.key] = {
    hash: preserveHash ?? computeSectionDigest(section, settings),
    audio,
  };
  await writeJsonAtomic(progressFile, saved);
}

/** 配音或字幕变了之后，作废已合成的画面，等人工确认再重新做视频 */
function markAudiovisualStale(
  ctx: CoreContext,
  runId: string,
  sectionKey: string,
  detail: { regenerateAudio: boolean; provider: string; reset?: boolean },
): void {
  inTransaction(ctx.db, () => {
    ctx.db.prepare('UPDATE runs SET media_dirty = 1 WHERE id = ?').run(runId);
    ctx.repos.runStages.markStaleFrom(runId, ['render', 'qa']);
    emitRunEvent(ctx, {
      runId,
      level: 'info',
      stage: 'narrate',
      type: 'section_narration_updated',
      message: detail.reset
        ? `已恢复「${sectionKey}」的原稿并重新配音`
        : detail.regenerateAudio
          ? `已按所选语音引擎重新生成「${sectionKey}」`
          : `已保存「${sectionKey}」的字幕文本，原配音保持不变`,
      data: { sectionKey, ...detail },
    });
  });
}

/** 列出每一段当前的语音文本、字幕文本、引擎和音频，供页面编辑 */
export async function listNarrationSectionViews(
  ctx: CoreContext,
  runId: string,
): Promise<NarrationSectionView[]> {
  const runDir = ctx.paths.runDir(runId);
  const packageFile = path.join(runDir, 'stages', 'package.json');
  const rawPackage = await readJsonOrNullWithSchema(packageFile, PackageCheckpointSchema, {
    fallbackNullOnInvalid: true,
  });
  if (!rawPackage?.packageData) {
    return [];
  }
  const settings = await readRunSettings(ctx, runId);
  const items = ctx.repos.runItems.listByRun(runId);
  const itemsById = new Map(items.map((item) => [item.id, item]));
  const overrides = await readNarrationOverrides(runDir);
  const sections = buildNarrationSections(rawPackage.packageData, itemsById, overrides);
  const timeline = await readJsonOrNullWithSchema(
    path.join(runDir, 'timeline.json'),
    TimelineSchema,
    { fallbackNullOnInvalid: true },
  );
  let itemOrdinal = 0;
  return sections.map((section) => {
    if (section.kind === 'item') {
      itemOrdinal += 1;
    }
    const timelineSection = timeline?.sections.find((item) => item.key === section.key);
    const subtitleSentences =
      section.displaySentences ??
      timelineSection?.sentences.map((sentence) => sentence.text) ??
      section.sentences;
    const audioFile = timelineSection?.audioFile ?? null;
    return {
      key: section.key,
      kind: section.kind,
      itemId: section.itemId,
      label: sectionLabel(section, itemsById, itemOrdinal),
      ttsText: section.sentences.join('\n'),
      subtitleText: subtitleSentences.join('\n'),
      provider: section.provider ?? settings.tts.provider,
      audioFile,
      speechMs: timelineSection?.speechMs ?? null,
      hasOverride: Boolean(overrides[section.key]),
    };
  });
}

/** 保存某一段的语音文本和字幕。可以选择只改字幕，或按指定引擎重新生成这一段音频 */
export async function updateSingleSectionNarration(
  ctx: CoreContext,
  runId: string,
  sectionKey: string,
  rawInput: unknown,
): Promise<NarrationSectionView> {
  if (!SECTION_KEY_PATTERN.test(sectionKey)) {
    throw new Error(`非法的口播段落标识: ${sectionKey}`);
  }
  assertNarrationEditable(ctx, runId);
  const input = UpdateSectionNarrationInputSchema.parse(rawInput);
  const settings = await readRunSettings(ctx, runId);
  const builtinTtsProviders = new Set(['silent', 'indextts', 'qwen-local']);
  const hasProvider =
    !input.provider ||
    Object.hasOwn(settings.tts.providers, input.provider) ||
    (!builtinTtsProviders.has(input.provider) && ctx.tts.hasProvider(input.provider));
  if (!hasProvider) {
    throw new Error(`未配置语音合成引擎: ${input.provider}`);
  }
  const runDir = ctx.paths.runDir(runId);
  const packageData = await loadIssuePackage(ctx, runId);
  const itemsById = new Map(ctx.repos.runItems.listByRun(runId).map((item) => [item.id, item]));
  const overrides = await readNarrationOverrides(runDir);
  const currentSections = buildNarrationSections(packageData, itemsById, overrides);
  const current = currentSections.find((section) => section.key === sectionKey);
  if (!current) {
    throw new Error(`未找到口播段落: ${sectionKey}`);
  }

  const requestedTts = splitTtsText(input.ttsText);
  const displaySentences = splitSubtitleText(input.subtitleText);
  const currentProvider = current.provider ?? settings.tts.provider;
  let ttsSentences = requestedTts;
  let provider = input.provider;
  if (!input.regenerateAudio) {
    const spokenSentences = prepareNarrationSentences(current.sentences);
    const ttsUnchanged =
      sameSentences(requestedTts, current.sentences) ||
      sameSentences(requestedTts, spokenSentences);
    const providerUnchanged = !input.provider || input.provider === currentProvider;
    if (!ttsUnchanged || !providerUnchanged) {
      throw new Error(
        '仅保存字幕时不能修改语音文本或语音引擎。若要改读音或换引擎，请重新生成本段音频',
      );
    }
    // 字幕对齐必须使用已经合成进音频的原句，不能改用编辑框里尚未重配的语音文本
    ttsSentences = current.sentences;
    provider = current.provider;
  }
  const nextOverrides: NarrationOverrideMap = {
    ...overrides,
    [sectionKey]: {
      ttsSentences,
      displaySentences,
      ...(provider ? { provider } : {}),
    },
  };
  const nextSections = buildNarrationSections(packageData, itemsById, nextOverrides);
  const nextSection = nextSections.find((section) => section.key === sectionKey);
  if (!nextSection) {
    throw new Error(`未找到口播段落: ${sectionKey}`);
  }

  const audioDir = path.join(runDir, 'audio');
  const effectiveSettings = await settingsForNarrationProviders(ctx, runId, settings, [
    provider ?? settings.tts.provider,
  ]);
  const progressFile = path.join(audioDir, 'sections-progress.json');
  const saved =
    (await readJsonOrNullWithSchema(progressFile, SectionProgressMapSchema, {
      fallbackNullOnInvalid: true,
    })) ?? {};

  if (input.regenerateAudio) {
    const [audio] = await ctx.tts.synthesizeSections([nextSection], audioDir, {
      settingsOverride: effectiveSettings.tts,
    });
    if (!audio) {
      throw new Error(`段落 ${sectionKey} 没有生成音频`);
    }
    await saveSectionProgress(runDir, nextSection, effectiveSettings, audio);
  } else {
    const existingFile = saved[sectionKey]?.audio.file ?? path.join(audioDir, `${sectionKey}.wav`);
    const resolved = path.resolve(existingFile);
    const resolvedAudioDir = path.resolve(audioDir);
    if (!resolved.startsWith(`${resolvedAudioDir}${path.sep}`)) {
      throw new Error(`段落音频路径越界: ${sectionKey}`);
    }
    try {
      await fs.access(resolved);
    } catch {
      throw new Error('当前段落还没有配音，请先重新生成本段音频');
    }
    const speechMs = await probeAudioDurationMs(resolved);
    const sentences = await alignDisplaySentencesToWav(
      resolved,
      ttsSentences,
      displaySentences,
      speechMs,
    );
    if (sentences.length === 0) {
      throw new Error('字幕文本不能为空');
    }
    await saveSectionProgress(
      runDir,
      nextSection,
      effectiveSettings,
      {
        key: sectionKey,
        file: resolved,
        speechMs,
        sentences,
      },
      saved[sectionKey]?.hash,
    );
  }

  await writeJsonAtomic(path.join(runDir, NARRATION_OVERRIDES_FILE), nextOverrides);
  await rebuildTimeline(ctx, runId, settings, nextSections);
  markAudiovisualStale(ctx, runId, sectionKey, {
    regenerateAudio: input.regenerateAudio,
    provider: provider ?? settings.tts.provider,
  });
  const views = await listNarrationSectionViews(ctx, runId);
  const view = views.find((item) => item.key === sectionKey);
  if (!view) {
    throw new Error(`未找到口播段落: ${sectionKey}`);
  }
  return view;
}

/** 去掉某一段的人工修改，按原稿和当前默认引擎重新生成音频 */
export async function resetSingleSectionNarration(
  ctx: CoreContext,
  runId: string,
  sectionKey: string,
): Promise<NarrationSectionView> {
  if (!SECTION_KEY_PATTERN.test(sectionKey)) {
    throw new Error(`非法的口播段落标识: ${sectionKey}`);
  }
  assertNarrationEditable(ctx, runId);
  const settings = await readRunSettings(ctx, runId);
  const runDir = ctx.paths.runDir(runId);
  const packageData = await loadIssuePackage(ctx, runId);
  const itemsById = new Map(ctx.repos.runItems.listByRun(runId).map((item) => [item.id, item]));
  const overrides = await readNarrationOverrides(runDir);
  if (!overrides[sectionKey]) {
    const views = await listNarrationSectionViews(ctx, runId);
    const existing = views.find((item) => item.key === sectionKey);
    if (!existing) {
      throw new Error(`未找到口播段落: ${sectionKey}`);
    }
    return existing;
  }
  const nextOverrides = { ...overrides };
  delete nextOverrides[sectionKey];
  const nextSections = buildNarrationSections(packageData, itemsById, nextOverrides);
  const nextSection = nextSections.find((section) => section.key === sectionKey);
  if (!nextSection) {
    throw new Error(`未找到口播段落: ${sectionKey}`);
  }
  const effectiveSettings = await settingsForNarrationProviders(ctx, runId, settings, [
    settings.tts.provider,
  ]);
  const [audio] = await ctx.tts.synthesizeSections([nextSection], path.join(runDir, 'audio'), {
    settingsOverride: effectiveSettings.tts,
  });
  if (!audio) {
    throw new Error(`段落 ${sectionKey} 没有生成音频`);
  }
  await saveSectionProgress(runDir, nextSection, effectiveSettings, audio);
  await writeJsonAtomic(path.join(runDir, NARRATION_OVERRIDES_FILE), nextOverrides);
  await rebuildTimeline(ctx, runId, settings, nextSections);
  markAudiovisualStale(ctx, runId, sectionKey, {
    regenerateAudio: true,
    provider: settings.tts.provider,
    reset: true,
  });
  const views = await listNarrationSectionViews(ctx, runId);
  const view = views.find((item) => item.key === sectionKey);
  if (!view) {
    throw new Error(`未找到口播段落: ${sectionKey}`);
  }
  return view;
}
