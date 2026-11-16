import fs from 'node:fs/promises';
import path from 'node:path';
import type { CliBridge } from '@aidaily/cli-bridge';
import type { NarrationSection, SectionAudio, TtsSettings } from '@aidaily/contracts';
import { concatSentenceWavs, normalizeSegmentToWav, probeAudioDurationMs } from './audio.js';
import { computeTtsCacheKey, saveToCache, tryRestoreFromCache } from './cache.js';
import { createSilentTtsProvider } from './providers/silent.js';
import type { TtsProvider, TtsServiceOptions } from './types.js';

export const TTS_VERSION = '0.1.0';

export * from './audio.js';
export * from './cache.js';
export * from './providers/silent.js';
export * from './types.js';

const SAFE_SECTION_KEY_PATTERN = /^[a-zA-Z0-9_-]+$/;

/**
 * 语音合成统一调度服务：管理多种语音引擎的注册与切换、单句缓存、音频标准化与句间拼接。
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

    this.register(createSilentTtsProvider(this.settings, this.ffmpegBin));
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
  getActiveProvider(): TtsProvider {
    const provider = this.providers.get(this.settings.provider);
    if (!provider) {
      throw new Error(
        `未注册语音合成引擎 "${this.settings.provider}"，当前可用: ${this.listProviders().join(', ') || '无'}`,
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
   * 批量合成多个口播段落：逐句检查缓存、标准化格式、拼接段落并产出精确到毫秒的时间轴信息。
   */
  async synthesizeSections(
    sections: NarrationSection[],
    outDir: string,
    signal?: AbortSignal,
  ): Promise<SectionAudio[]> {
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

    const provider = this.getActiveProvider();
    const providerConfig = this.settings.providers[provider.id] ?? {};
    const { sampleRate, trimSilence, sentenceGapMs } = this.settings.postprocess;
    const resolvedOutDir = path.resolve(outDir);

    await fs.mkdir(resolvedOutDir, { recursive: true });
    await provider.start?.();

    let primaryError: unknown;
    let stopError: unknown;
    const results: SectionAudio[] = [];
    try {
      for (const section of sections) {
        if (signal?.aborted) {
          throw new DOMException('已取消', 'AbortError');
        }

        const sectionDir = path.resolve(resolvedOutDir, section.key);
        if (!sectionDir.startsWith(`${resolvedOutDir}${path.sep}`)) {
          throw new Error(`段落目录越界: ${section.key}`);
        }
        await fs.mkdir(sectionDir, { recursive: true });

        const segmentFiles: string[] = [];
        const sentenceDurationsMs: number[] = [];

        for (let i = 0; i < section.sentences.length; i++) {
          const text = section.sentences[i] ?? '';
          const idxLabel = String(i + 1).padStart(2, '0');
          const normFile = path.join(sectionDir, `seg-${idxLabel}.wav`);
          const rawFile = path.join(sectionDir, `raw-${idxLabel}.wav`);
          const cacheKey = computeTtsCacheKey(
            provider.id,
            providerConfig,
            { sampleRate, trimSilence },
            text,
          );

          let durationMs: number | null = null;
          const cacheHit = await tryRestoreFromCache(this.cacheDir, cacheKey, normFile);
          if (cacheHit) {
            try {
              durationMs = await probeAudioDurationMs(normFile, this.ffprobeBin, signal);
            } catch {
              // 缓存文件损坏时删除失效缓存并回退到重新合成
              await fs
                .rm(path.join(this.cacheDir, `${cacheKey}.wav`), { force: true })
                .catch(() => undefined);
              await fs.rm(normFile, { force: true }).catch(() => undefined);
            }
          }

          if (durationMs === null) {
            await provider.synthesize({ text, outFile: rawFile, signal });
            await normalizeSegmentToWav({
              inFile: rawFile,
              outFile: normFile,
              sampleRate,
              trimSilence,
              isSilentProvider: provider.id === 'silent',
              ffmpegBin: this.ffmpegBin,
              ffprobeBin: this.ffprobeBin,
              signal,
            });
            await fs.rm(rawFile, { force: true }).catch(() => undefined);
            await saveToCache(this.cacheDir, cacheKey, normFile);
            durationMs = await probeAudioDurationMs(normFile, this.ffprobeBin, signal);
          }

          segmentFiles.push(normFile);
          sentenceDurationsMs.push(durationMs);
        }

        const sectionFile = path.resolve(resolvedOutDir, `${section.key}.wav`);
        const concatResult = await concatSentenceWavs({
          segmentFiles,
          sentenceDurationsMs,
          sentenceGapMs,
          sampleRate,
          outFile: sectionFile,
          ffmpegBin: this.ffmpegBin,
          ffprobeBin: this.ffprobeBin,
          signal,
        });

        results.push({
          key: section.key,
          file: sectionFile,
          speechMs: concatResult.speechMs,
          sentences: section.sentences.map((text, idx) => ({
            text,
            offsetMs: concatResult.offsetsMs[idx] ?? 0,
            durationMs: sentenceDurationsMs[idx] ?? 0,
          })),
        });
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
    const provider = this.getActiveProvider();
    await fs.mkdir(path.dirname(outFile), { recursive: true });
    const rawFile = path.join(path.dirname(outFile), `raw-${path.basename(outFile)}`);

    await provider.start?.();
    let primaryError: unknown;
    let stopError: unknown;
    try {
      await provider.synthesize({ text, outFile: rawFile });
      await normalizeSegmentToWav({
        inFile: rawFile,
        outFile,
        sampleRate: this.settings.postprocess.sampleRate,
        trimSilence: this.settings.postprocess.trimSilence,
        isSilentProvider: provider.id === 'silent',
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
