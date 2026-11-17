import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Timeline } from '@aidaily/contracts';
import { execa } from 'execa';

const DEFAULT_FFMPEG_TIMEOUT_MS = 180_000;

/** 生成带正确媒体扩展名的同目录临时文件路径，保证转码格式识别与原子重命名替换 */
function makeSiblingTempPath(targetFile: string, fallbackExt: string): string {
  const dir = path.dirname(targetFile);
  const ext = path.extname(targetFile) || fallbackExt;
  const base = path.basename(targetFile, ext);
  const rand = crypto.randomBytes(4).toString('hex');
  return path.join(dir, `.${base}.${process.pid}.${rand}${ext}`);
}

/** 通过写同目录临时文件再原子重命名，安全生成视频或图像产物 */
async function withAtomicMediaWrite(
  targetFile: string,
  fallbackExt: string,
  writeFn: (tmpOut: string) => Promise<void>,
): Promise<void> {
  await fs.mkdir(path.dirname(targetFile), { recursive: true });
  const tmpOut = makeSiblingTempPath(targetFile, fallbackExt);
  try {
    await writeFn(tmpOut);
    await fs.rename(tmpOut, targetFile);
  } catch (err) {
    await fs.rm(tmpOut, { force: true }).catch(() => undefined);
    throw err;
  }
}

/** 调用外部音视频处理工具并返回标准输出与错误日志，统一处理取消和超时 */
export async function runMediaCommand(
  bin: string,
  args: string[],
  opts?: { signal?: AbortSignal; timeoutMs?: number; actionLabel?: string },
): Promise<{ stdout: string; stderr: string }> {
  const label = opts?.actionLabel ?? bin;
  const res = await execa(bin, args, {
    cancelSignal: opts?.signal,
    timeout: opts?.timeoutMs ?? DEFAULT_FFMPEG_TIMEOUT_MS,
    reject: false,
  });
  if (res.isCanceled) {
    throw new DOMException('已取消', 'AbortError');
  }
  if (res.timedOut) {
    throw new Error(`${label} 执行超时`);
  }
  if (res.exitCode !== 0) {
    throw new Error(`${label} 执行失败: ${res.stderr || res.stdout}`);
  }
  return { stdout: res.stdout, stderr: res.stderr };
}

/** 根据第一页画面截图转换生成高清视频封面图片 */
export async function renderCoverJpg(opts: {
  inPng: string;
  outJpg: string;
  ffmpegBin?: string;
  signal?: AbortSignal;
}): Promise<void> {
  const ffmpegBin = opts.ffmpegBin ?? 'ffmpeg';
  await withAtomicMediaWrite(opts.outJpg, '.jpg', async (tmpOut) => {
    await runMediaCommand(
      ffmpegBin,
      ['-y', '-i', opts.inPng, '-frames:v', '1', '-q:v', '2', tmpOut],
      { signal: opts.signal, actionLabel: 'ffmpeg 生成封面图' },
    );
  });
}

interface LoudnormStats {
  input_i?: string;
  input_tp?: string;
  input_lra?: string;
  input_thresh?: string;
  target_offset?: string;
}

/** 从 ffmpeg 双遍响度测量日志中提取标准 JSON 测量数据 */
function parseLoudnormStats(stderr: string): LoudnormStats | null {
  let end = stderr.lastIndexOf('}');
  while (end !== -1) {
    let start = stderr.lastIndexOf('{', end);
    while (start !== -1) {
      const candidate = stderr.slice(start, end + 1);
      if (candidate.includes('"input_i"')) {
        try {
          const parsed = JSON.parse(candidate) as LoudnormStats;
          const vals = [
            parsed.input_i,
            parsed.input_tp,
            parsed.input_lra,
            parsed.input_thresh,
            parsed.target_offset ?? '0',
          ];
          if (vals.every((v) => v && v !== '-inf' && Number.isFinite(Number(v)))) {
            return parsed;
          }
        } catch {
          // 继续向上寻找合法 JSON 片段
        }
      }
      start = stderr.lastIndexOf('{', start - 1);
    }
    end = stderr.lastIndexOf('}', end - 1);
  }
  return null;
}

/** 将路径安全限定在允许的基准目录之内，防止读取目录外的文件 */
async function assertConfinedMediaPath(
  baseDir: string,
  relOrAbs: string,
  label: string,
): Promise<string> {
  const resolvedBase = path.resolve(baseDir);
  const candidate = path.resolve(resolvedBase, relOrAbs);
  if (candidate !== resolvedBase && !candidate.startsWith(`${resolvedBase}${path.sep}`)) {
    throw new Error(`${label}超出允许目录范围: ${relOrAbs}`);
  }
  await fs.access(candidate);
  const realBase = await fs.realpath(resolvedBase).catch(() => resolvedBase);
  const realTarget = await fs.realpath(candidate);
  if (!realTarget.startsWith(`${realBase}${path.sep}`)) {
    throw new Error(`${label}指向目录外软链接: ${relOrAbs}`);
  }
  return realTarget;
}

/** 合成与视频页时间轴精确对齐的全片主音轨（含响度平衡和可选背景音乐闪避混音） */
export async function buildMasterAudioWav(opts: {
  timeline: Timeline;
  runDir: string;
  outWav: string;
  sampleRate: number;
  loudnessLUFS: number;
  isSilentProvider: boolean;
  bgm: { file: string; volumeDb: number; duckDb: number };
  rootDir: string;
  ffmpegBin?: string;
  signal?: AbortSignal;
}): Promise<void> {
  const ffmpegBin = opts.ffmpegBin ?? 'ffmpeg';
  const totalSec = (opts.timeline.totalMs / 1000).toFixed(3);
  const workDir = path.join(
    path.dirname(opts.outWav),
    `.master-work-${crypto.randomBytes(4).toString('hex')}`,
  );
  await fs.mkdir(workDir, { recursive: true });

  try {
    // 1. 按各页起始毫秒位置（adelay）把所有分镜配音拼接成精确时长的纯净人声主轨
    const inputArgs: string[] = [];
    const filterParts: string[] = [];
    const mixTags: string[] = [];

    for (let i = 0; i < opts.timeline.sections.length; i++) {
      const sec = opts.timeline.sections[i];
      if (!sec) {
        continue;
      }
      const absAudio = await assertConfinedMediaPath(
        opts.runDir,
        sec.audioFile,
        `口播音频文件 ${sec.key}`,
      );
      inputArgs.push('-i', absAudio);

      const delayMs = Math.max(0, Math.round(sec.startMs));
      const delayFilter = delayMs > 0 ? `,adelay=${delayMs}|${delayMs}` : '';
      filterParts.push(
        `[${i}:a]aresample=${opts.sampleRate},aformat=sample_fmts=s16:channel_layouts=stereo${delayFilter}[s${i}]`,
      );
      mixTags.push(`[s${i}]`);
    }

    if (mixTags.length === 0) {
      throw new Error('时间轴中没有可用于合成主音轨口播片段');
    }

    if (mixTags.length > 1) {
      filterParts.push(
        `${mixTags.join('')}amix=inputs=${mixTags.length}:duration=longest:dropout_transition=0:normalize=0,apad,atrim=0:${totalSec}[voice]`,
      );
    } else {
      filterParts.push(`${mixTags[0]}apad,atrim=0:${totalSec}[voice]`);
    }

    const rawVoiceWav = path.join(workDir, 'voice-raw.wav');
    await runMediaCommand(
      ffmpegBin,
      [
        '-y',
        ...inputArgs,
        '-filter_complex',
        filterParts.join(';'),
        '-map',
        '[voice]',
        '-ar',
        String(opts.sampleRate),
        '-ac',
        '2',
        '-c:a',
        'pcm_s16le',
        rawVoiceWav,
      ],
      { signal: opts.signal, actionLabel: 'ffmpeg 拼接时间轴人声轨道' },
    );

    // 2. 若启用真实语音合成（非静音测试器），采用双遍 loudnorm 统一响度至目标 LUFS
    let voiceWav = rawVoiceWav;
    if (!opts.isSilentProvider) {
      const measureRes = await runMediaCommand(
        ffmpegBin,
        [
          '-y',
          '-i',
          rawVoiceWav,
          '-af',
          `loudnorm=I=${opts.loudnessLUFS}:TP=-1.5:LRA=11:print_format=json`,
          '-f',
          'null',
          '-',
        ],
        { signal: opts.signal, actionLabel: 'ffmpeg 测量人声响度' },
      );

      const stats = parseLoudnormStats(measureRes.stderr);
      const normVoiceWav = path.join(workDir, 'voice-norm.wav');
      const loudnormFilter = stats
        ? `loudnorm=I=${opts.loudnessLUFS}:TP=-1.5:LRA=11:measured_I=${stats.input_i}:measured_TP=${stats.input_tp}:measured_LRA=${stats.input_lra}:measured_thresh=${stats.input_thresh}:offset=${stats.target_offset ?? '0'}:linear=true:print_format=summary`
        : `loudnorm=I=${opts.loudnessLUFS}:TP=-1.5:LRA=11`;

      await runMediaCommand(
        ffmpegBin,
        [
          '-y',
          '-i',
          rawVoiceWav,
          '-af',
          loudnormFilter,
          '-ar',
          String(opts.sampleRate),
          '-ac',
          '2',
          '-c:a',
          'pcm_s16le',
          normVoiceWav,
        ],
        { signal: opts.signal, actionLabel: 'ffmpeg 执行人声响度归一化' },
      );
      voiceWav = normVoiceWav;
    }

    // 3. 若配置了背景音乐，循环铺满全片并挂载人声侧链压低混音
    const bgmRel = opts.bgm.file.trim();
    if (bgmRel) {
      if (!Number.isFinite(opts.bgm.volumeDb) || !Number.isFinite(opts.bgm.duckDb)) {
        throw new Error('背景音乐音量与避让增益配置必须为合法有限数字');
      }
      const bgmPath = path.isAbsolute(bgmRel) ? bgmRel : path.resolve(opts.rootDir, bgmRel);
      await fs.access(bgmPath);

      const duckMagnitude = Math.abs(opts.bgm.duckDb);
      const bgmFilter =
        `[0:a]aresample=${opts.sampleRate},aformat=sample_fmts=s16:channel_layouts=stereo,` +
        `atrim=0:${totalSec},asetpts=PTS-STARTPTS,volume=${opts.bgm.volumeDb}dB,afade=t=out:st=${Math.max(0, opts.timeline.totalMs / 1000 - 1.5).toFixed(3)}:d=1.5[bgm_lvl];`;

      const filterComplex =
        duckMagnitude === 0
          ? `${bgmFilter}[1:a][bgm_lvl]amix=inputs=2:duration=first:normalize=0,atrim=0:${totalSec},alimiter=limit=0.95[out]`
          : (() => {
              const duckRatio = Math.max(2, Math.min(20, Math.round(duckMagnitude / 2) || 2));
              return (
                `[1:a]asplit=2[voice_main][voice_sc];` +
                bgmFilter +
                `[bgm_lvl][voice_sc]sidechaincompress=threshold=0.02:ratio=${duckRatio}:attack=40:release=350[bgm_ducked];` +
                `[voice_main][bgm_ducked]amix=inputs=2:duration=first:normalize=0,atrim=0:${totalSec},alimiter=limit=0.95[out]`
              );
            })();

      await withAtomicMediaWrite(opts.outWav, '.wav', async (tmpOut) => {
        await runMediaCommand(
          ffmpegBin,
          [
            '-y',
            '-stream_loop',
            '-1',
            '-i',
            bgmPath,
            '-i',
            voiceWav,
            '-filter_complex',
            filterComplex,
            '-map',
            '[out]',
            '-ar',
            String(opts.sampleRate),
            '-ac',
            '2',
            '-c:a',
            'pcm_s16le',
            tmpOut,
          ],
          { signal: opts.signal, actionLabel: 'ffmpeg 混音背景音乐并侧链避让人声' },
        );
      });
      return;
    }

    await withAtomicMediaWrite(opts.outWav, '.wav', async (tmpOut) => {
      await fs.copyFile(voiceWav, tmpOut);
    });
  } finally {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** 转义 ffmpeg concat 列表文件里的反斜杠与单引号 */
function escapeConcatPath(filePath: string): string {
  return filePath.replaceAll('\\', '\\\\').replaceAll("'", "'\\''");
}

/**
 * 将逐页画面 PNG 截图与主音轨按时间轴毫秒数合成为标准高清 MP4 视频（H.264 + AAC，支持网页秒开）。
 */
export async function composeSlidesVideoMp4(opts: {
  frameFiles: string[];
  pageDurationsMs: number[];
  totalMs: number;
  masterWav: string;
  outMp4: string;
  width: number;
  height: number;
  fps: number;
  sampleRate: number;
  crf?: number;
  ffmpegBin?: string;
  signal?: AbortSignal;
}): Promise<void> {
  if (opts.frameFiles.length === 0) {
    throw new Error('没有可用于合成视频的截图帧');
  }
  if (opts.frameFiles.length !== opts.pageDurationsMs.length) {
    throw new Error(
      `截图页数 (${opts.frameFiles.length}) 与时长计划数量 (${opts.pageDurationsMs.length}) 不匹配`,
    );
  }

  const ffmpegBin = opts.ffmpegBin ?? 'ffmpeg';
  const crf = opts.crf ?? 18;
  const totalSec = (opts.totalMs / 1000).toFixed(3);
  const workDir = path.join(
    path.dirname(opts.outMp4),
    `.video-work-${crypto.randomBytes(4).toString('hex')}`,
  );
  await fs.mkdir(workDir, { recursive: true });

  try {
    const lines = ['ffconcat version 1.0'];
    for (let i = 0; i < opts.frameFiles.length; i++) {
      const frame = opts.frameFiles[i];
      if (!frame) {
        throw new Error(`第 ${i} 页渲染截图路径为空，无法合成视频`);
      }
      const durMs = opts.pageDurationsMs[i] ?? 1000;
      lines.push(`file '${escapeConcatPath(path.resolve(frame))}'`);
      lines.push(`duration ${(durMs / 1000).toFixed(3)}`);
    }
    const lastFrame = opts.frameFiles[opts.frameFiles.length - 1];
    if (lastFrame) {
      lines.push(`file '${escapeConcatPath(path.resolve(lastFrame))}'`);
    }

    const concatFile = path.join(workDir, 'frames.ffconcat');
    await fs.writeFile(concatFile, `${lines.join('\n')}\n`, 'utf8');

    const vf = `scale=${opts.width}:${opts.height}:force_original_aspect_ratio=decrease,pad=${opts.width}:${opts.height}:(ow-iw)/2:(oh-ih)/2,fps=${opts.fps},format=yuv420p`;

    await withAtomicMediaWrite(opts.outMp4, '.mp4', async (tmpOut) => {
      await runMediaCommand(
        ffmpegBin,
        [
          '-y',
          '-fflags',
          '+genpts',
          '-f',
          'concat',
          '-safe',
          '0',
          '-i',
          concatFile,
          '-i',
          opts.masterWav,
          '-map',
          '0:v:0',
          '-map',
          '1:a:0',
          '-vf',
          vf,
          '-c:v',
          'libx264',
          '-profile:v',
          'high',
          '-preset',
          'medium',
          '-crf',
          String(crf),
          '-c:a',
          'aac',
          '-b:a',
          '192k',
          '-ar',
          String(opts.sampleRate),
          '-movflags',
          '+faststart',
          '-t',
          totalSec,
          tmpOut,
        ],
        { signal: opts.signal, timeoutMs: 300_000, actionLabel: 'ffmpeg 合成成片 MP4' },
      );
    });
  } finally {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
