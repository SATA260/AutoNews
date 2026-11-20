import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execa } from 'execa';
import { z } from 'zod';
import { writeTtsFileAtomic } from './cache.js';
import { levelSpeechPhrasesWav } from './leveling.js';

const FfprobeDurationSchema = z.object({
  format: z
    .object({
      duration: z.union([z.string(), z.number()]).optional(),
    })
    .optional(),
});

const LoudnormStatsSchema = z.object({
  input_i: z.union([z.string(), z.number()]),
  input_tp: z.union([z.string(), z.number()]),
  input_lra: z.union([z.string(), z.number()]),
  input_thresh: z.union([z.string(), z.number()]),
  target_offset: z.union([z.string(), z.number()]),
});

/** 音频片段统一标准化参数 */
export interface NormalizeSegmentOptions {
  inFile: string;
  outFile: string;
  sampleRate: number;
  trimSilence: boolean;
  denoise?: boolean;
  isSilentProvider?: boolean;
  normalizeLoudness?: boolean;
  loudnessLUFS?: number;
  ffmpegBin?: string;
  ffprobeBin?: string;
  signal?: AbortSignal;
}

/** 多句音频拼接参数 */
export interface ConcatSentencesOptions {
  segmentFiles: string[];
  sentenceDurationsMs: number[];
  sentenceGapMs: number;
  sampleRate: number;
  outFile: string;
  ffmpegBin?: string;
  ffprobeBin?: string;
  signal?: AbortSignal;
}

/** 多句拼接完成后的段落总时长及每句话的起始偏移时间 */
export interface ConcatSentencesResult {
  speechMs: number;
  offsetsMs: number[];
}

const DEFAULT_MEDIA_TIMEOUT_MS = 60_000;

/** 生成高精度 64 阶 Kaiser 窗抗混叠重采样滤镜表达式，消除升采样高频镜像失真 */
export function buildHighQualityResampleFilter(sampleRate: number): string {
  return `aresample=${sampleRate}:filter_size=64:phase_shift=10:cutoff=0.96:filter_type=kaiser`;
}

/** 广播级人声去杂音、去声码器脉冲电流毛刺与音色温润化滤镜链 */
export const VOICE_CLEANUP_FILTER = [
  'highpass=f=85:poles=2,highpass=f=85:poles=2',
  'adeclick=w=30:o=60:t=2.5',
  'afftdn=nr=10:nf=-40:nt=w:tn=1:gs=3',
  'deesser=i=0.35:m=0.45:f=0.5:s=o',
  'equalizer=f=230:t=q:w=1.1:g=1.2',
  'equalizer=f=7500:t=q:w=1.3:g=-2.5',
  'lowpass=f=11200:poles=2,lowpass=f=11200:poles=2',
].join(',');

/** 温和的广播人声峰值收敛滤镜参数（保留句内自然呼吸与起伏，不扭曲声波也不拉高底噪） */
export const VOICE_DYNAMICS_FILTER =
  'acompressor=threshold=-20dB:ratio=1.8:attack=18:release=180:makeup=1';

/** 向后兼容导出的人声动态收敛滤镜常量 */
export const VOICE_LEVELING_FILTER = VOICE_DYNAMICS_FILTER;

/** 生成带合法后缀名的同目录临时文件路径，确保原子重命名且音视频工具能正确识别格式 */
function makeSiblingTempPath(targetFile: string): string {
  const dir = path.dirname(targetFile);
  const ext = path.extname(targetFile) || '.wav';
  const base = path.basename(targetFile, ext);
  const rand = crypto.randomBytes(4).toString('hex');
  return path.join(dir, `.${base}.${process.pid}.${rand}${ext}`);
}

/** 通过临时文件与原子重命名替换目标文件，失败时自动清理临时文件 */
async function withAtomicWavWrite(
  targetFile: string,
  writeFn: (tmpFile: string) => Promise<void>,
): Promise<void> {
  await fs.mkdir(path.dirname(targetFile), { recursive: true });
  const tmpFile = makeSiblingTempPath(targetFile);
  try {
    await writeFn(tmpFile);
    await fs.rename(tmpFile, targetFile);
  } catch (err) {
    await fs.rm(tmpFile, { force: true }).catch(() => undefined);
    throw err;
  }
}

/** 调用 ffprobe 精确读取音频文件的实际时长（毫秒） */
export async function probeAudioDurationMs(
  filePath: string,
  ffprobeBin = 'ffprobe',
  signal?: AbortSignal,
): Promise<number> {
  const res = await execa(
    ffprobeBin,
    ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', filePath],
    {
      cancelSignal: signal,
      timeout: DEFAULT_MEDIA_TIMEOUT_MS,
      reject: false,
    },
  );
  if (res.isCanceled) {
    throw new DOMException('已取消', 'AbortError');
  }
  if (res.timedOut) {
    throw new Error(`ffprobe 读取音频时长超时 (${filePath})`);
  }
  if (res.exitCode !== 0) {
    throw new Error(`ffprobe 读取音频时长失败 (${filePath}): ${res.stderr}`);
  }
  const parsed = FfprobeDurationSchema.parse(JSON.parse(res.stdout));
  const sec = Number(parsed.format?.duration ?? '0');
  if (!Number.isFinite(sec) || sec <= 0) {
    throw new Error(`无法解析音频时长: ${filePath} (stdout=${res.stdout})`);
  }
  return Math.max(1, Math.round(sec * 1000));
}

/** 生成指定采样率与时长（毫秒）的单声道静音 WAV 文件 */
export async function generateSilenceWav(
  outFile: string,
  durationMs: number,
  sampleRate = 48000,
  ffmpegBin = 'ffmpeg',
  signal?: AbortSignal,
): Promise<void> {
  const durationSec = Math.max(0.05, durationMs / 1000).toFixed(3);
  await withAtomicWavWrite(outFile, async (tmpOut) => {
    const res = await execa(
      ffmpegBin,
      [
        '-y',
        '-f',
        'lavfi',
        '-i',
        `anullsrc=r=${sampleRate}:cl=mono`,
        '-t',
        durationSec,
        '-c:a',
        'pcm_s16le',
        tmpOut,
      ],
      {
        cancelSignal: signal,
        timeout: DEFAULT_MEDIA_TIMEOUT_MS,
        reject: false,
      },
    );
    if (res.isCanceled) {
      throw new DOMException('已取消', 'AbortError');
    }
    if (res.timedOut) {
      throw new Error(`ffmpeg 生成静音音频超时 (${outFile})`);
    }
    if (res.exitCode !== 0) {
      throw new Error(`ffmpeg 生成静音音频失败: ${res.stderr}`);
    }
  });
}

/**
 * 将原始语音片段统一转换为目标采样率的单声道 WAV，
 * 开启裁剪首尾静音时会自动剔除多余空白；若裁剪后几乎为空白（如测试静音），自动回退到未裁剪版本。
 */
export async function normalizeSegmentToWav(opts: NormalizeSegmentOptions): Promise<void> {
  const ffmpegBin = opts.ffmpegBin ?? 'ffmpeg';
  const ffprobeBin = opts.ffprobeBin ?? 'ffprobe';
  const inputDuration = await probeAudioDurationMs(opts.inFile, ffprobeBin, opts.signal);
  const processingTimeout = Math.max(DEFAULT_MEDIA_TIMEOUT_MS, inputDuration * 4 + 60_000);

  const convert = async (applyTrim: boolean) => {
    await withAtomicWavWrite(opts.outFile, async (tmpOut) => {
      const args = ['-y', '-i', opts.inFile];
      const filters: string[] = [];
      if (applyTrim) {
        filters.push(
          'silenceremove=start_periods=1:start_duration=0:start_threshold=-68dB:start_silence=0.05:detection=peak,areverse,silenceremove=start_periods=1:start_duration=0:start_threshold=-72dB:start_silence=0.15:detection=peak,areverse',
        );
      }
      filters.push(buildHighQualityResampleFilter(opts.sampleRate));
      args.push('-af', filters.join(','), '-ac', '1', '-c:a', 'pcm_s16le', tmpOut);

      const res = await execa(ffmpegBin, args, {
        cancelSignal: opts.signal,
        timeout: processingTimeout,
        reject: false,
      });
      if (res.isCanceled) {
        throw new DOMException('已取消', 'AbortError');
      }
      if (res.timedOut) {
        throw new Error(`ffmpeg 标准化音频超时 (${opts.inFile})`);
      }
      if (res.exitCode !== 0) {
        throw new Error(`ffmpeg 标准化音频失败 (${opts.inFile}): ${res.stderr}`);
      }
    });
  };

  if (opts.trimSilence && !opts.isSilentProvider) {
    await convert(true);
    try {
      const trimmedMs = await probeAudioDurationMs(opts.outFile, ffprobeBin, opts.signal);
      if (trimmedMs >= 50) {
        if (opts.normalizeLoudness) {
          await levelSpeechPhrasesWav(opts.outFile);
          await polishLoudness(opts);
        }
        return;
      }
    } catch {
      // 若裁剪后没有有效音频流或时长异常，回退到未裁剪版本
    }
  }

  await convert(false);
  if (opts.normalizeLoudness) {
    await levelSpeechPhrasesWav(opts.outFile);
    await polishLoudness(opts);
  }
}

/** 对完成分句线性均衡的音频执行可选降噪去毛刺、温和动态收敛与两遍线性响度校准，并保留自然结尾。 */
async function polishLoudness(opts: NormalizeSegmentOptions): Promise<void> {
  const ffmpeg = opts.ffmpegBin ?? 'ffmpeg';
  const duration = await probeAudioDurationMs(opts.outFile, opts.ffprobeBin, opts.signal);
  const target = opts.loudnessLUFS ?? -16;
  const processingTimeout = Math.max(DEFAULT_MEDIA_TIMEOUT_MS, duration * 4 + 60_000);
  const preChain =
    opts.denoise !== false
      ? `${VOICE_CLEANUP_FILTER},${VOICE_DYNAMICS_FILTER}`
      : VOICE_DYNAMICS_FILTER;
  const analysis = await execa(
    ffmpeg,
    [
      '-hide_banner',
      '-i',
      opts.outFile,
      '-af',
      `${preChain},loudnorm=I=${target}:TP=-1.5:LRA=8:print_format=json`,
      '-f',
      'null',
      '-',
    ],
    { cancelSignal: opts.signal, timeout: processingTimeout, reject: false },
  );
  if (analysis.isCanceled) throw new DOMException('已取消', 'AbortError');
  if (analysis.exitCode !== 0) throw new Error(`测量语音响度失败: ${analysis.stderr}`);
  const match = analysis.stderr.match(/\{[^{}]*"input_i"[^{}]*\}/s);
  if (!match) throw new Error('无法读取语音响度测量结果');
  const rawStats = LoudnormStatsSchema.parse(JSON.parse(match[0]));
  const values = [
    rawStats.input_i,
    rawStats.input_tp,
    rawStats.input_lra,
    rawStats.input_thresh,
    rawStats.target_offset,
  ].map((item) => Number(item));
  if (values.some((value) => !Number.isFinite(value))) throw new Error('语音响度测量结果无效');
  const postGate =
    opts.denoise !== false ? ',agate=threshold=0.002:ratio=2:range=0.25:attack=5:release=180' : '';
  const filter = `${preChain},loudnorm=I=${target}:TP=-1.5:LRA=8:measured_I=${values[0]}:measured_TP=${values[1]}:measured_LRA=${values[2]}:measured_thresh=${values[3]}:offset=${values[4]}:linear=true${postGate},afade=t=in:st=0:d=0.005,apad=pad_dur=0.08,${buildHighQualityResampleFilter(opts.sampleRate)}`;
  await withAtomicWavWrite(opts.outFile, async (tmp) => {
    const result = await execa(
      ffmpeg,
      [
        '-y',
        '-i',
        opts.outFile,
        '-af',
        filter,
        '-ar',
        String(opts.sampleRate),
        '-ac',
        '1',
        '-c:a',
        'pcm_s16le',
        tmp,
      ],
      { cancelSignal: opts.signal, timeout: processingTimeout, reject: false },
    );
    if (result.isCanceled) throw new DOMException('已取消', 'AbortError');
    if (result.exitCode !== 0) throw new Error(`语音响度处理失败: ${result.stderr}`);
  });
}

/** 转义 ffmpeg concat 列表文件里的路径单引号 */
function escapeConcatPath(filePath: string): string {
  return filePath.replaceAll("'", "'\\''");
}

/**
 * 按顺序把多句标准化音频拼成整段 WAV，并在句与句之间插入固定时长停顿。
 */
export async function concatSentenceWavs(
  opts: ConcatSentencesOptions,
): Promise<ConcatSentencesResult> {
  if (opts.segmentFiles.length === 0) {
    throw new Error('没有可拼接的语音片段');
  }
  if (opts.segmentFiles.length !== opts.sentenceDurationsMs.length) {
    throw new Error(
      `音频片段数量 (${opts.segmentFiles.length}) 与时长数量 (${opts.sentenceDurationsMs.length}) 不匹配`,
    );
  }

  const ffmpegBin = opts.ffmpegBin ?? 'ffmpeg';
  const ffprobeBin = opts.ffprobeBin ?? 'ffprobe';
  await fs.mkdir(path.dirname(opts.outFile), { recursive: true });

  if (opts.segmentFiles.length === 1 && opts.segmentFiles[0]) {
    const singleSeg = opts.segmentFiles[0];
    await withAtomicWavWrite(opts.outFile, async (tmpOut) => {
      await fs.copyFile(singleSeg, tmpOut);
    });
    const speechMs = await probeAudioDurationMs(opts.outFile, ffprobeBin, opts.signal);
    return { speechMs, offsetsMs: [0] };
  }

  const workDir = path.join(
    path.dirname(opts.outFile),
    `.concat-${crypto.randomBytes(4).toString('hex')}`,
  );
  await fs.mkdir(workDir, { recursive: true });

  try {
    let gapFile: string | null = null;
    let actualGapMs = 0;
    if (opts.sentenceGapMs > 0) {
      gapFile = path.join(workDir, 'gap.wav');
      await generateSilenceWav(
        gapFile,
        opts.sentenceGapMs,
        opts.sampleRate,
        ffmpegBin,
        opts.signal,
      );
      actualGapMs = await probeAudioDurationMs(gapFile, ffprobeBin, opts.signal);
    }

    const offsetsMs: number[] = [];
    let cursorMs = 0;
    for (let i = 0; i < opts.sentenceDurationsMs.length; i++) {
      offsetsMs.push(cursorMs);
      const dur = opts.sentenceDurationsMs[i] ?? 0;
      cursorMs += dur + (i < opts.sentenceDurationsMs.length - 1 ? actualGapMs : 0);
    }

    const lines: string[] = [];
    for (let i = 0; i < opts.segmentFiles.length; i++) {
      const seg = opts.segmentFiles[i];
      if (!seg) {
        continue;
      }
      lines.push(`file '${escapeConcatPath(path.resolve(seg))}'`);
      if (gapFile && i < opts.segmentFiles.length - 1) {
        lines.push(`file '${escapeConcatPath(path.resolve(gapFile))}'`);
      }
    }

    const listFile = path.join(workDir, 'concat.txt');
    await writeTtsFileAtomic(listFile, `${lines.join('\n')}\n`);

    await withAtomicWavWrite(opts.outFile, async (tmpOut) => {
      const res = await execa(
        ffmpegBin,
        ['-y', '-f', 'concat', '-safe', '0', '-i', listFile, '-c:a', 'pcm_s16le', tmpOut],
        {
          cancelSignal: opts.signal,
          timeout: Math.max(DEFAULT_MEDIA_TIMEOUT_MS, cursorMs * 4 + 60_000),
          reject: false,
        },
      );
      if (res.isCanceled) {
        throw new DOMException('已取消', 'AbortError');
      }
      if (res.timedOut) {
        throw new Error(`ffmpeg 拼接段落音频超时 (${opts.outFile})`);
      }
      if (res.exitCode !== 0) {
        throw new Error(`ffmpeg 拼接段落音频失败: ${res.stderr}`);
      }
    });

    const speechMs = await probeAudioDurationMs(opts.outFile, ffprobeBin, opts.signal);
    return { speechMs, offsetsMs };
  } finally {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
