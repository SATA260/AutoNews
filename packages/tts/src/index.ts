import fs from 'node:fs/promises';
import path from 'node:path';
import type { CliBridge } from '@aidaily/cli-bridge';
import type { NarrationSection, SectionAudio, TtsSettings } from '@aidaily/contracts';
import { normalizeSegmentToWav, probeAudioDurationMs } from './audio.js';
import { computeTtsCacheKey, saveToCache, tryRestoreFromCache } from './cache.js';
import { createIndexTtsProvider } from './providers/indextts.js';
import { createQwenLocalTtsProvider } from './providers/qwen-local.js';
import { createSilentTtsProvider } from './providers/silent.js';
import { buildNarrationParagraph } from './sanitize.js';
import { alignSentencesToWav } from './subtitles.js';
import type { TtsProvider, TtsServiceOptions } from './types.js';

export const TTS_VERSION = '0.1.0';
/** 本地语音处理方式变化时递增，用于使旧音频缓存失效。 */
export const QWEN_AUDIO_PROCESSING_VERSION = 7;

/** 判断指定引擎标识是否属于需要主播音色参考与统一响度后处理的本地语音克隆引擎 */
export function isLocalVoiceCloneProvider(providerId: string): boolean {
  return providerId === 'qwen-local' || providerId === 'indextts';
}

export * from './audio.js';
export * from './cache.js';
export * from './providers/qwen-local.js';
export * from './providers/silent.js';
export * from './sanitize.js';
export * from './subtitles.js';
export * from './types.js';

const SAFE_SECTION_KEY_PATTERN = /^[a-zA-Z0-9_-]+$/;

/**
 * 语音合成统一调度服务：管理多种语音引擎的注册与切换、整段缓存、音频标准化与时长探测。
 */
export class TtsService {
  readonly bridge?: CliBridge;
  private readonly settings: TtsSettings;
  private readonly cacheDir: string;
  private readonly ffmpegBin: string;
  private readonly ffprobeBin: string;
  private readonly providers = new Map<string, TtsProvider>();

  constructor(opts: TtsServiceOptions) {
    this.settings = opts.settings;
    this.cacheDir = opts.cacheDir;
    this.bridge = opts.bridge;
    this.ffmpegBin = opts.ffmpegBin ?? 'ffmpeg';
    this.ffprobeBin = opts.ffprobeBin ?? 'ffprobe';

    const rootDir = opts.rootDir ?? process.cwd();
    this.register(createSilentTtsProvider(this.settings, this.ffmpegBin));
    this.register(createIndexTtsProvider(rootDir, this.settings.providers.indextts ?? {}));
    this.register(createQwenLocalTtsProvider(rootDir, this.settings.providers['qwen-local'] ?? {}));
  }

  /** 注册或替换一个语音合成引擎实例 */
  register(provider: TtsProvider): void {
    this.providers.set(provider.id, provider);
  }

  /** 列出当前已注册的所有语音合成引擎名称 */
  listProviders(): string[] {
    return Array.from(this.providers.keys());
  }

  /** 获取配置中当前启用的语音合成引擎，未注册时抛出清晰错误 */
  getActiveProvider(providerId = this.settings.provider): TtsProvider {
    const provider = this.providers.get(providerId);
    if (!provider) {
      throw new Error(
        `未注册语音合成引擎 "${providerId}"，当前可用: ${this.listProviders().join(', ') || '无'}`,
      );
    }
    return provider;
  }

  /** 检查当前启用语音引擎的健康状态 */
  async healthcheck(): Promise<{ ok: boolean; detail: string }> {
    const provider = this.providers.get(this.settings.provider);
    if (!provider) {
      return {
        ok: false,
        detail: `未注册语音合成引擎: ${this.settings.provider}`,
      };
    }
    return provider.healthcheck();
  }

  /**
   * 批量合成多个口播段落：先清理各句内部多余空格并以单个空格逐句分隔合段，再检查整段缓存、一次性调用引擎生成并标准化输出音频。
   */
  async synthesizeSections(
    sections: NarrationSection[],
    outDir: string,
    signalOrOpts?:
      | AbortSignal
      | {
          signal?: AbortSignal;
          onSectionDone?: (audio: SectionAudio) => Promise<void> | void;
          onWarning?: (message: string) => Promise<void> | void;
          settingsOverride?: TtsSettings;
        },
  ): Promise<SectionAudio[]> {
    const signal = signalOrOpts && 'aborted' in signalOrOpts ? signalOrOpts : signalOrOpts?.signal;
    const onSectionDone =
      signalOrOpts && 'onSectionDone' in signalOrOpts ? signalOrOpts.onSectionDone : undefined;
    const onWarning =
      signalOrOpts && 'onWarning' in signalOrOpts ? signalOrOpts.onWarning : undefined;
    const effectiveSettings =
      signalOrOpts && 'settingsOverride' in signalOrOpts && signalOrOpts.settingsOverride
        ? signalOrOpts.settingsOverride
        : this.settings;
    const seenKeys = new Set<string>();
    for (const section of sections) {
      if (!SAFE_SECTION_KEY_PATTERN.test(section.key)) {
        throw new Error(`非法的口播段落标识: ${section.key}`);
      }
      if (seenKeys.has(section.key)) {
        throw new Error(`存在重复的口播段落标识: ${section.key}`);
      }
      seenKeys.add(section.key);
    }

    const provider = this.getActiveProvider(effectiveSettings.provider);
    const providerConfig = effectiveSettings.providers[provider.id] ?? {};
    const cacheIdentity = await provider.cacheIdentity?.(providerConfig);
    const { sampleRate, trimSilence } = effectiveSettings.postprocess;
    const resolvedOutDir = path.resolve(outDir);

    await fs.mkdir(resolvedOutDir, { recursive: true });
    await provider.start?.(providerConfig, signal);

    let primaryError: unknown;
    let stopError: unknown;
    const results: SectionAudio[] = [];
    try {
      for (const section of sections) {
        if (signal?.aborted) {
          throw new DOMException('已取消', 'AbortError');
        }

        const paragraphText = buildNarrationParagraph(section.sentences);
        if (!paragraphText) {
          throw new Error('口播内容清理后为空');
        }

        const sectionDir = path.resolve(resolvedOutDir, section.key);
        if (!sectionDir.startsWith(`${resolvedOutDir}${path.sep}`)) {
          throw new Error(`段落目录越界: ${section.key}`);
        }
        const sectionFile = path.resolve(resolvedOutDir, `${section.key}.wav`);
        if (!sectionFile.startsWith(`${resolvedOutDir}${path.sep}`)) {
          throw new Error(`段落输出文件越界: ${section.key}`);
        }

        const isLocalClone = isLocalVoiceCloneProvider(provider.id);
        const cacheKey = computeTtsCacheKey(
          provider.id,
          {
            ...providerConfig,
            cacheIdentity,
            synthesisMode: 'whole-paragraph',
            processingVersion: isLocalClone ? QWEN_AUDIO_PROCESSING_VERSION : 0,
          },
          {
            sampleRate,
            trimSilence,
            ...(isLocalClone
              ? {
                  loudnessLUFS: effectiveSettings.postprocess.loudnessLUFS,
                  fadeInMs: 15,
                  fadeOutMs: 80,
                  tailPadMs: 160,
                }
              : {}),
          },
          paragraphText,
        );

        let durationMs: number | null = null;
        const cacheHit = await tryRestoreFromCache(this.cacheDir, cacheKey, sectionFile);
        if (cacheHit) {
          try {
            durationMs = await probeAudioDurationMs(sectionFile, this.ffprobeBin, signal);
          } catch {
            // 缓存文件损坏时删除失效缓存并回退到重新合成
            await fs
              .rm(path.join(this.cacheDir, `${cacheKey}.wav`), { force: true })
              .catch(() => undefined);
            await fs.rm(sectionFile, { force: true }).catch(() => undefined);
          }
        }

        if (durationMs === null) {
          await fs.mkdir(sectionDir, { recursive: true });
          const rawFile = path.join(sectionDir, 'raw-section.wav');
          try {
            const charCount = Array.from(paragraphText.replace(/[\p{P}\p{S}\s]/gu, '')).length;
            const maxAttempts = isLocalClone ? 3 : 1;
            for (let attempt = 0; attempt < maxAttempts; attempt++) {
              await provider.synthesize({
                text: paragraphText,
                outFile: rawFile,
                sampleRate,
                providerConfig,
                signal,
              });
              await normalizeSegmentToWav({
                inFile: rawFile,
                outFile: sectionFile,
                sampleRate,
                trimSilence,
                isSilentProvider: provider.id === 'silent',
                normalizeLoudness: isLocalClone,
                loudnessLUFS: effectiveSettings.postprocess.loudnessLUFS,
                ffmpegBin: this.ffmpegBin,
                ffprobeBin: this.ffprobeBin,
                signal,
              });
              await fs.rm(rawFile, { force: true }).catch(() => undefined);
              const measured = await probeAudioDurationMs(sectionFile, this.ffprobeBin, signal);
              if (
                !isLocalClone ||
                (measured >= Math.max(200, charCount * 60) &&
                  measured <= Math.max(3000, charCount * 1300))
              ) {
                durationMs = measured;
                break;
              }
            }
            if (durationMs === null) {
              durationMs = await probeAudioDurationMs(sectionFile, this.ffprobeBin, signal);
              await onWarning?.(
                `语音段落时长异常，重试 ${maxAttempts} 次后保留最后一次可播放结果：${section.key}`,
              );
            } else {
              await saveToCache(this.cacheDir, cacheKey, sectionFile);
            }
          } finally {
            await fs.rm(sectionDir, { recursive: true, force: true }).catch(() => undefined);
          }
        }

        const alignedSentences = await alignSentencesToWav(
          sectionFile,
          section.sentences,
          durationMs,
        );
        const sectionAudio: SectionAudio = {
          key: section.key,
          file: sectionFile,
          speechMs: durationMs,
          sentences:
            alignedSentences.length > 0
              ? alignedSentences
              : [
                  {
                    text: paragraphText,
                    offsetMs: 0,
                    durationMs,
                  },
                ],
        };
        await onSectionDone?.(sectionAudio);
        results.push(sectionAudio);
      }
    } catch (err) {
      primaryError = err;
      throw err;
    } finally {
      try {
        await provider.stop?.();
      } catch (err) {
        stopError = err;
      }
    }

    if (stopError !== undefined && primaryError === undefined) {
      throw stopError;
    }
    return results;
  }

  /** 用当前配置的语音引擎合成一段试听音频文件 */
  async test(text: string, outFile: string): Promise<void> {
    const cleanedText = buildNarrationParagraph([text]);
    if (!cleanedText) {
      throw new Error('口播内容清理后为空');
    }
    const provider = this.getActiveProvider();
    await fs.mkdir(path.dirname(outFile), { recursive: true });
    const rawFile = path.join(path.dirname(outFile), `raw-${path.basename(outFile)}`);

    await provider.start?.(this.settings.providers[provider.id] ?? {});
    let primaryError: unknown;
    let stopError: unknown;
    try {
      await provider.synthesize({
        text: cleanedText,
        outFile: rawFile,
        providerConfig: this.settings.providers[provider.id] ?? {},
      });
      await normalizeSegmentToWav({
        inFile: rawFile,
        outFile,
        sampleRate: this.settings.postprocess.sampleRate,
        trimSilence: this.settings.postprocess.trimSilence,
        isSilentProvider: provider.id === 'silent',
        normalizeLoudness: isLocalVoiceCloneProvider(provider.id),
        loudnessLUFS: this.settings.postprocess.loudnessLUFS,
        ffmpegBin: this.ffmpegBin,
        ffprobeBin: this.ffprobeBin,
      });
    } catch (err) {
      primaryError = err;
      throw err;
    } finally {
      await fs.rm(rawFile, { force: true }).catch(() => undefined);
      try {
        await provider.stop?.();
      } catch (err) {
        stopError = err;
      }
    }

    if (stopError !== undefined && primaryError === undefined) {
      throw stopError;
    }
  }
}
