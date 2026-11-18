import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Timeline } from '@aidaily/contracts';
import { VOICE_LEVELING_FILTER } from '@aidaily/tts';
import { execa } from 'execa';

const DEFAULT_FFMPEG_TIMEOUT_MS = 180_000;

/** 按视频时长为处理命令预留时间，避免长视频过早超时。 */
export function mediaTimeoutMs(durationMs: number, encoding = false): number {
  return Math.max(
    encoding ? 300_000 : 180_000,
    Math.ceil(durationMs * (encoding ? 8 : 4)) + 60_000,
  );
}

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
  levelVoice?: boolean;
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
      // 仅针对尚未在语音合成阶段执行均衡的外部音源启用单遍响度拉齐，避免重复放大已淡出的尾音
      const levelingPrefix =
        opts.levelVoice && !opts.isSilentProvider
          ? `${VOICE_LEVELING_FILTER},loudnorm=I=${opts.loudnessLUFS}:TP=-1.5:LRA=5,`
          : '';
      filterParts.push(
        `[${i}:a]${levelingPrefix}aresample=${opts.sampleRate},aformat=sample_fmts=s16:channel_layouts=stereo${delayFilter}[s${i}]`,
      );
      mixTags.push(`[s${i}]`);
    }

    if (mixTags.length === 0) {
      throw new Error('时间轴中没有可用于合成主音轨口播片段');
    }

    if (mixTags.length > 1) {
      filterParts.push(
        `${mixTags.join('')}amix=inputs=${mixTags.length}:duration=longest:dropout_transition=0:normalize=0,apad,atrim=0:${totalSec},alimiter=limit=0.8414:level=false:latency=true[voice]`,
      );
    } else {
      filterParts.push(
        `${mixTags[0]}apad,atrim=0:${totalSec},alimiter=limit=0.8414:level=false:latency=true[voice]`,
      );
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
      {
        signal: opts.signal,
        timeoutMs: mediaTimeoutMs(opts.timeline.totalMs),
        actionLabel: 'ffmpeg 拼接时间轴人声轨道',
      },
    );

    // 保持单句的响度，整轨仅限制峰值。
    const voiceWav = rawVoiceWav;

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
        `[0:a]atrim=0:${totalSec},asetpts=PTS-STARTPTS,` +
        `loudnorm=I=-16:TP=-1.5:LRA=11,` +
        `aresample=${opts.sampleRate},aformat=sample_fmts=s16:channel_layouts=stereo,` +
        `volume=${opts.bgm.volumeDb}dB,afade=t=out:st=${Math.max(0, opts.timeline.totalMs / 1000 - 1.5).toFixed(3)}:d=1.5[bgm_lvl];`;

      const filterComplex =
        duckMagnitude === 0
          ? `${bgmFilter}[1:a][bgm_lvl]amix=inputs=2:duration=first:normalize=0,atrim=0:${totalSec},alimiter=limit=0.95:level=false:latency=true[out]`
          : (() => {
              const duckRatio = Number(
                Math.max(1.5, Math.min(8, 1 + duckMagnitude / 4)).toFixed(2),
              );
              return (
                `[1:a]asplit=2[voice_main][voice_sc];` +
                bgmFilter +
                `[bgm_lvl][voice_sc]sidechaincompress=threshold=0.06:ratio=${duckRatio}:attack=50:release=400[bgm_ducked];` +
                `[voice_main][bgm_ducked]amix=inputs=2:duration=first:normalize=0,atrim=0:${totalSec},alimiter=limit=0.95:level=false:latency=true[out]`
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
          {
            signal: opts.signal,
            timeoutMs: mediaTimeoutMs(opts.timeline.totalMs),
            actionLabel: 'ffmpeg 混音背景音乐并侧链避让人声',
          },
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
        {
          signal: opts.signal,
          timeoutMs: mediaTimeoutMs(opts.totalMs, true),
          actionLabel: 'ffmpeg 合成成片 MP4',
        },
      );
    });
  } finally {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * 通过标准输入管道将逐帧截取的 JPEG 字节流实时编码为单个章节的无音轨 H.264 视频分片，
 * 避免在磁盘生成成百上千张零碎图片文件，并采用同目录临时文件原子替换落盘。
 */
export async function encodeJpegStreamToMp4(opts: {
  produceFrames: (pushJpegFrame: (jpegBytes: Buffer) => Promise<void>) => Promise<number>;
  outMp4: string;
  width: number;
  height: number;
  fps: number;
  durationMs: number;
  crf?: number;
  ffmpegBin?: string;
  signal?: AbortSignal;
}): Promise<void> {
  const ffmpegBin = opts.ffmpegBin ?? 'ffmpeg';
  const crf = opts.crf ?? 18;
  const vf = `scale=${opts.width}:${opts.height}:force_original_aspect_ratio=decrease,pad=${opts.width}:${opts.height}:(ow-iw)/2:(oh-ih)/2,format=yuv420p`;

  await withAtomicMediaWrite(opts.outMp4, '.mp4', async (tmpOut) => {
    if (opts.signal?.aborted) {
      throw new DOMException('已取消', 'AbortError');
    }

    const child = spawn(
      ffmpegBin,
      [
        '-y',
        '-f',
        'image2pipe',
        '-vcodec',
        'mjpeg',
        '-framerate',
        String(opts.fps),
        '-i',
        '-',
        '-vf',
        vf,
        '-c:v',
        'libx264',
        '-profile:v',
        'high',
        '-preset',
        'veryfast',
        '-crf',
        String(crf),
        '-r',
        String(opts.fps),
        '-pix_fmt',
        'yuv420p',
        '-an',
        tmpOut,
      ],
      { stdio: ['pipe', 'ignore', 'pipe'] },
    );

    const stdin = child.stdin;
    const stderr = child.stderr;
    let stderrText = '';
    stderr?.setEncoding('utf8');
    stderr?.on('data', (chunk: string) => {
      if (stderrText.length < 16_384) {
        stderrText += chunk;
      }
    });

    let spawnErr: Error | null = null;
    child.on('error', (err) => {
      spawnErr = err;
    });

    let stdinErr: Error | null = null;
    stdin?.on('error', (err) => {
      stdinErr = err;
    });

    let inputEnded = false;
    let childExited = false;
    let childExitCode: number | null = null;

    const exitPromise = new Promise<number | null>((resolve) => {
      child.once('close', (code) => {
        childExited = true;
        childExitCode = code;
        resolve(code);
      });
    });

    let timedOut = false;
    const timer = setTimeout(
      () => {
        timedOut = true;
        stdin?.destroy();
        stderr?.destroy();
        child.kill('SIGKILL');
      },
      mediaTimeoutMs(opts.durationMs, true),
    );

    const onAbort = () => {
      stdin?.destroy();
      stderr?.destroy();
      child.kill('SIGKILL');
    };
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    /** 为单次管道反压构造独立可清理的等待句柄，避免在全局退出 Promise 上残留未捕获拒绝分支 */
    const waitForDrainOrClose = (): Promise<void> => {
      if (!stdin) {
        return Promise.reject(new Error('无法打开 ffmpeg 视频帧写入管道'));
      }
      if (opts.signal?.aborted) {
        return Promise.reject(new DOMException('已取消', 'AbortError'));
      }
      if (timedOut) {
        return Promise.reject(new Error('ffmpeg 章节视频流编码超时'));
      }
      if (spawnErr) {
        return Promise.reject(spawnErr);
      }
      if (stdinErr) {
        return Promise.reject(stdinErr);
      }
      if (childExited || stdin.destroyed || !stdin.writable) {
        return Promise.reject(new Error(`ffmpeg 在等待帧写入时提前退出: ${stderrText}`));
      }

      return new Promise<void>((resolve, reject) => {
        const cleanup = () => {
          stdin.removeListener('drain', onDrain);
          stdin.removeListener('error', onPipeErr);
          stdin.removeListener('close', onPipeClose);
          child.removeListener('close', onChildClose);
          child.removeListener('error', onPipeErr);
          opts.signal?.removeEventListener('abort', onSignalAbort);
        };

        const onDrain = () => {
          cleanup();
          resolve();
        };

        const onPipeErr = (err: Error) => {
          cleanup();
          reject(err);
        };

        const onPipeClose = () => {
          cleanup();
          if (opts.signal?.aborted) {
            reject(new DOMException('已取消', 'AbortError'));
          } else if (timedOut) {
            reject(new Error('ffmpeg 章节视频流编码超时'));
          } else {
            reject(new Error(`ffmpeg 帧管道在反压等待期间关闭: ${stderrText}`));
          }
        };

        const onChildClose = () => {
          cleanup();
          if (opts.signal?.aborted) {
            reject(new DOMException('已取消', 'AbortError'));
          } else if (timedOut) {
            reject(new Error('ffmpeg 章节视频流编码超时'));
          } else {
            reject(
              new Error(
                `ffmpeg 在等待帧写入时异常退出 (code=${String(childExitCode)}): ${stderrText}`,
              ),
            );
          }
        };

        const onSignalAbort = () => {
          cleanup();
          reject(new DOMException('已取消', 'AbortError'));
        };

        stdin.on('drain', onDrain);
        stdin.on('error', onPipeErr);
        stdin.on('close', onPipeClose);
        child.on('close', onChildClose);
        child.on('error', onPipeErr);
        opts.signal?.addEventListener('abort', onSignalAbort, { once: true });
      });
    };

    try {
      if (!stdin) {
        throw new Error('无法打开 ffmpeg 视频帧写入管道');
      }

      const writtenFrames = await opts.produceFrames(async (jpegBytes: Buffer) => {
        if (opts.signal?.aborted) {
          throw new DOMException('已取消', 'AbortError');
        }
        if (timedOut) {
          throw new Error('ffmpeg 章节视频流编码超时');
        }
        if (spawnErr) {
          throw spawnErr;
        }
        if (stdinErr) {
          throw stdinErr;
        }
        if (childExited || stdin.destroyed || !stdin.writable) {
          throw new Error(`ffmpeg 帧管道提前关闭: ${stderrText}`);
        }
        const ok = stdin.write(jpegBytes);
        if (!ok) {
          await waitForDrainOrClose();
        }
      });

      if (writtenFrames <= 0) {
        throw new Error('章节流式渲染未产出任何画面帧');
      }

      inputEnded = true;
      stdin.end();
      const exitCode = await exitPromise;
      if (opts.signal?.aborted) {
        throw new DOMException('已取消', 'AbortError');
      }
      if (timedOut) {
        throw new Error('ffmpeg 章节视频流编码超时');
      }
      if (spawnErr) {
        throw spawnErr;
      }
      if (exitCode !== 0 || !inputEnded) {
        throw new Error(`ffmpeg 章节视频流编码失败 (code=${String(exitCode)}): ${stderrText}`);
      }
    } catch (err) {
      stdin?.removeAllListeners('drain');
      stdin?.destroy();
      stderr?.destroy();
      child.kill('SIGKILL');
      await Promise.race([
        exitPromise.catch(() => undefined),
        new Promise<void>((r) => setTimeout(r, 2000)),
      ]);
      throw err;
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      stdin?.removeAllListeners('drain');
      stdin?.destroy();
      stderr?.destroy();
    }
  });
}

/**
 * 将各章节已编码好的无损对齐 H.264 视频分片按顺序直接拼接（不重复编码视频流），
 * 并与校准后的全片主音轨混流封装为支持网页快速起播的标准 MP4 成片。
 */
export async function composeSectionVideosMp4(opts: {
  sectionMp4Files: string[];
  totalMs: number;
  totalFrames?: number;
  fps?: number;
  masterWav: string;
  outMp4: string;
  sampleRate: number;
  ffmpegBin?: string;
  signal?: AbortSignal;
}): Promise<void> {
  if (opts.sectionMp4Files.length === 0) {
    throw new Error('没有可用于拼接合成的章节视频分片');
  }
  const ffmpegBin = opts.ffmpegBin ?? 'ffmpeg';
  const totalSec =
    opts.totalFrames !== undefined && opts.fps !== undefined && opts.totalFrames > 0 && opts.fps > 0
      ? (opts.totalFrames / opts.fps).toFixed(6)
      : (opts.totalMs / 1000).toFixed(3);
  const workDir = path.join(
    path.dirname(opts.outMp4),
    `.concat-work-${crypto.randomBytes(4).toString('hex')}`,
  );
  await fs.mkdir(workDir, { recursive: true });

  try {
    const lines = ['ffconcat version 1.0'];
    for (let i = 0; i < opts.sectionMp4Files.length; i++) {
      const mp4File = opts.sectionMp4Files[i];
      if (!mp4File) {
        throw new Error(`第 ${i} 个章节视频分片路径为空`);
      }
      lines.push(`file '${escapeConcatPath(path.resolve(mp4File))}'`);
    }
    const concatFile = path.join(workDir, 'sections.ffconcat');
    await fs.writeFile(concatFile, `${lines.join('\n')}\n`, 'utf8');

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
          '-c:v',
          'copy',
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
        {
          signal: opts.signal,
          timeoutMs: mediaTimeoutMs(opts.totalMs),
          actionLabel: 'ffmpeg 拼接章节视频与主音轨',
        },
      );
    });
  } finally {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
