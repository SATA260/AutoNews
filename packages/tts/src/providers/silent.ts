import type { TtsSettings } from '@aidaily/contracts';
import { generateSilenceWav } from '../audio.js';
import type { SynthesizeRequest, TtsProvider } from '../types.js';

/** 默认每秒模拟朗读字数，用于根据文本长度估算静音测试音频时长 */
const DEFAULT_CHARS_PER_SECOND = 4.5;

/** 创建默认内置的测试用无声合成器，按字数估算时长并输出标准静音文件 */
export function createSilentTtsProvider(settings: TtsSettings, ffmpegBin = 'ffmpeg'): TtsProvider {
  const providerCfg = settings.providers.silent ?? {};
  const rawCps = Number(providerCfg.charsPerSecond ?? DEFAULT_CHARS_PER_SECOND);
  const charsPerSecond = Number.isFinite(rawCps) && rawCps > 0 ? rawCps : DEFAULT_CHARS_PER_SECOND;
  const sampleRate = settings.postprocess.sampleRate;

  return {
    id: 'silent',

    /** 按文本字符数换算大致口播毫秒数，并生成对应长度的静音 WAV 文件 */
    async synthesize(req: SynthesizeRequest): Promise<void> {
      const reqCps = Number(req.providerConfig?.charsPerSecond ?? charsPerSecond);
      const effectiveCps = Number.isFinite(reqCps) && reqCps > 0 ? reqCps : charsPerSecond;
      const effectiveRate = req.sampleRate ?? sampleRate;
      const charCount = Array.from(req.text.trim()).length;
      const durationMs = Math.max(400, Math.round((charCount / effectiveCps) * 1000));
      await generateSilenceWav(req.outFile, durationMs, effectiveRate, ffmpegBin, req.signal);
    },

    /** 返回可用状态说明，用于环境检查 */
    async healthcheck(): Promise<{ ok: boolean; detail: string }> {
      return {
        ok: true,
        detail: `内置测试静音合成器就绪（语速估算 ${charsPerSecond} 字/秒）`,
      };
    },
  };
}
