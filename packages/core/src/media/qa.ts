import fs from 'node:fs/promises';
import path from 'node:path';
import {
  type QaCheckItem,
  type QaReport,
  QaReportSchema,
  type Settings,
  type Timeline,
} from '@aidaily/contracts';
import { z } from 'zod';
import type { CoreContext } from '../context.js';
import { PipelineError } from '../errors.js';
import { writeJsonAtomic } from '../storage/files.js';
import { mediaTimeoutMs, runMediaCommand } from './ffmpeg.js';

/** 质检阶段解析 `ffprobe` 音视频流参数输出的契约结构 */
const FfprobeOutputSchema = z.object({
  streams: z
    .array(
      z.object({
        codec_type: z.string().optional(),
        width: z.number().optional(),
        height: z.number().optional(),
        r_frame_rate: z.string().optional(),
        avg_frame_rate: z.string().optional(),
        duration: z
          .union([z.string(), z.number()])
          .transform((v) => String(v))
          .optional(),
      }),
    )
    .optional(),
  format: z
    .object({
      duration: z
        .union([z.string(), z.number()])
        .transform((v) => String(v))
        .optional(),
    })
    .optional(),
});
/** 解析 `ffprobe` 输出的媒体流与容器信息类型 */
type FfprobeOutput = z.infer<typeof FfprobeOutputSchema>;

/** 解析 ffprobe 返回的分数格式帧率（如 `30/1` 或 `30000/1001`） */
function parseFpsFraction(raw?: string): number {
  if (!raw) {
    return 0;
  }
  const parts = raw.split('/');
  if (parts.length === 2) {
    const num = Number(parts[0]);
    const den = Number(parts[1]);
    if (Number.isFinite(num) && Number.isFinite(den) && den > 0) {
      return num / den;
    }
  }
  const val = Number(raw);
  return Number.isFinite(val) ? val : 0;
}

/** 从 ffmpeg blackdetect 输出解析黑场总时长（秒） */
function sumBlackDurations(stderr: string): number {
  const regex = /black_duration:\s*([\d.]+)/g;
  let total = 0;
  for (let match = regex.exec(stderr); match !== null; match = regex.exec(stderr)) {
    const sec = Number(match[1]);
    if (Number.isFinite(sec) && sec > 0) {
      total += sec;
    }
  }
  return total;
}

/** 从 ffmpeg volumedetect 输出提取平均音量（dB），极低静音时返回 null */
function parseMeanVolumeDb(stderr: string): number | null {
  const match = /mean_volume:\s*(-?[\d.]+|-inf)\s*dB/i.exec(stderr);
  if (!match?.[1] || match[1].toLowerCase() === '-inf') {
    return null;
  }
  const db = Number(match[1]);
  return Number.isFinite(db) ? db : null;
}

const PNG_MAGIC_HEADER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** 读取流或容器的合法正数时长（秒），无法解析时返回 null */
function parsePositiveSec(raw?: string): number | null {
  if (!raw) {
    return null;
  }
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** 验证截图文件是否存在、体积达标且具备标准 PNG 文件头字节 */
async function isHealthyFramePng(filePath: string, minBytes: number): Promise<string | null> {
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile() || stat.size < minBytes) {
      return `体积不足(${stat.size}B)`;
    }
    const fh = await fs.open(filePath, 'r');
    try {
      const head = Buffer.alloc(8);
      await fh.read(head, 0, 8, 0);
      if (!head.equals(PNG_MAGIC_HEADER)) {
        return '文件头非PNG';
      }
    } finally {
      await fh.close();
    }
    return null;
  } catch {
    return '缺失';
  }
}

/**
 * 对合成完成的成片视频执行自动化音画质检：
 * 核对视频流与音频流存在性、分辨率与帧率匹配、音画时长同步差、平均响度、黑屏占比以及所有页面截图非空白，
 * 检测任一项目不达标时均会保存详细报告并抛出 `qa_failed` 异常，允许后续单独从渲染阶段重跑。
 */
export async function runQaStage(opts: {
  ctx: CoreContext;
  runId: string;
  settings: Settings;
  timeline: Timeline;
  ffmpegBin?: string;
  ffprobeBin?: string;
  signal?: AbortSignal;
}): Promise<QaReport> {
  const { ctx, runId, settings, timeline, signal } = opts;
  const ffmpegBin = opts.ffmpegBin ?? 'ffmpeg';
  const ffprobeBin = opts.ffprobeBin ?? 'ffprobe';

  const runDir = ctx.paths.runDir(runId);
  const videoFile = path.join(runDir, 'output', 'video.mp4');
  const framesDir = path.join(runDir, 'frames');

  try {
    await fs.access(videoFile);
  } catch {
    throw new PipelineError('qa_failed', `成片视频文件不存在: ${videoFile}`);
  }

  let parsed: FfprobeOutput;
  try {
    const probeOut = await runMediaCommand(
      ffprobeBin,
      [
        '-v',
        'error',
        '-show_entries',
        'stream=codec_type,width,height,r_frame_rate,avg_frame_rate,duration:format=duration',
        '-of',
        'json',
        videoFile,
      ],
      { signal, actionLabel: 'ffprobe 检查成片流参数' },
    );
    parsed = FfprobeOutputSchema.parse(JSON.parse(probeOut.stdout));
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw err;
    }
    throw new PipelineError(
      'qa_failed',
      `探测成片音视频流信息失败: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }

  const videoStream = parsed.streams?.find((s) => s.codec_type === 'video');
  const audioStream = parsed.streams?.find((s) => s.codec_type === 'audio');
  const formatDurationSec = parsePositiveSec(parsed.format?.duration);

  const rawVideoSec = parsePositiveSec(videoStream?.duration);
  const rawAudioSec = parsePositiveSec(audioStream?.duration);
  const videoDurationSec = videoStream ? (rawVideoSec ?? formatDurationSec ?? 0) : 0;
  const audioDurationSec = audioStream ? (rawAudioSec ?? formatDurationSec ?? 0) : 0;

  const width = videoStream?.width ?? 0;
  const height = videoStream?.height ?? 0;
  const fps =
    parseFpsFraction(videoStream?.avg_frame_rate) || parseFpsFraction(videoStream?.r_frame_rate);

  const checks: QaCheckItem[] = [];

  checks.push({
    name: 'streams_present',
    passed: Boolean(videoStream && audioStream),
    detail: `视频流=${Boolean(videoStream)}，音频流=${Boolean(audioStream)}`,
  });

  checks.push({
    name: 'resolution_and_fps',
    passed:
      width === settings.render.width &&
      height === settings.render.height &&
      Math.abs(fps - settings.render.fps) <= 0.15,
    detail: `实际=${width}x${height}@${fps.toFixed(2)}fps，配置=${settings.render.width}x${settings.render.height}@${settings.render.fps}fps`,
  });

  const bothHaveDuration =
    Boolean(videoStream && audioStream) && videoDurationSec > 0 && audioDurationSec > 0;
  const avDiffSec = Math.abs(videoDurationSec - audioDurationSec);
  checks.push({
    name: 'av_sync',
    passed: bothHaveDuration && avDiffSec < 0.3,
    detail: `视频 ${videoDurationSec.toFixed(3)}s，音频 ${audioDurationSec.toFixed(3)}s，差值 ${avDiffSec.toFixed(3)}s`,
  });

  const timelineSec = timeline.totalMs / 1000;
  const timelineDiffSec = Math.abs(videoDurationSec - timelineSec);
  checks.push({
    name: 'timeline_duration_match',
    passed: videoDurationSec > 0 && timelineDiffSec < 0.5,
    detail: `成片 ${videoDurationSec.toFixed(3)}s，时间轴 ${timelineSec.toFixed(3)}s，差值 ${timelineDiffSec.toFixed(3)}s`,
  });

  // 仅在音频流存在时执行音量检测，避免缺失音轨时滤镜直接抛错跳过 qa.json 写入
  let meanVolumeDb: number | null = null;
  const isSilentTest = settings.tts.provider === 'silent';
  if (!audioStream) {
    checks.push({
      name: 'audio_volume',
      passed: false,
      detail: '成片缺少音频流，无法通过音量检测',
    });
  } else {
    const volRes = await runMediaCommand(
      ffmpegBin,
      ['-v', 'info', '-i', videoFile, '-af', 'volumedetect', '-f', 'null', '-'],
      { signal, timeoutMs: mediaTimeoutMs(timeline.totalMs), actionLabel: 'ffmpeg 检测成片音量' },
    );
    meanVolumeDb = parseMeanVolumeDb(volRes.stderr);
    checks.push({
      name: 'audio_volume',
      passed: isSilentTest ? true : meanVolumeDb !== null && meanVolumeDb > -35,
      detail: isSilentTest
        ? `当前使用测试无声配音（平均音量=${meanVolumeDb === null ? '-inf' : `${meanVolumeDb.toFixed(1)}dB`}），放行通过`
        : `平均音量=${meanVolumeDb === null ? '-inf' : `${meanVolumeDb.toFixed(1)}dB`}（要求 > -35dB）`,
    });
  }

  // 仅在视频流存在时执行黑场检测
  let blackRatio = 1;
  if (!videoStream || videoDurationSec <= 0) {
    checks.push({
      name: 'black_frames',
      passed: false,
      detail: '成片缺少有效视频流，无法通过黑场检测',
    });
  } else {
    const blackRes = await runMediaCommand(
      ffmpegBin,
      [
        '-v',
        'info',
        '-i',
        videoFile,
        '-vf',
        'blackdetect=d=0.1:pix_th=0.10',
        '-an',
        '-f',
        'null',
        '-',
      ],
      {
        signal,
        timeoutMs: mediaTimeoutMs(timeline.totalMs),
        actionLabel: 'ffmpeg 检测成片黑场画面',
      },
    );
    const blackSec = sumBlackDurations(blackRes.stderr);
    blackRatio = Math.min(1, blackSec / videoDurationSec);
    checks.push({
      name: 'black_frames',
      passed: blackRatio < 0.05,
      detail: `黑场累计 ${blackSec.toFixed(3)}s，占比 ${(blackRatio * 100).toFixed(2)}%（要求 < 5%）`,
    });
  }

  // 检查每张截图是否存在、体积达标且为真实 PNG 图片（防止空白或残缺画面文件）
  const expectedFrameCount = timeline.sections.length;
  const minPngBytes = 1024;
  let framesOk = true;
  const frameIssues: string[] = [];
  for (let i = 0; i < expectedFrameCount; i++) {
    const fileName = `page-${String(i).padStart(2, '0')}.png`;
    const issue = await isHealthyFramePng(path.join(framesDir, fileName), minPngBytes);
    if (issue) {
      framesOk = false;
      frameIssues.push(`${fileName}(${issue})`);
    }
  }
  checks.push({
    name: 'frame_screenshots',
    passed: framesOk,
    detail: framesOk
      ? `共 ${expectedFrameCount} 张画面截图均为合法 PNG 且大于 ${minPngBytes} 字节`
      : `截图异常: ${frameIssues.join(', ')}`,
  });

  const allPassed = checks.every((c) => c.passed);
  const report = QaReportSchema.parse({
    passed: allPassed,
    videoPath: path.relative(ctx.paths.rootDir, videoFile),
    width: Math.max(1, width),
    height: Math.max(1, height),
    fps: fps > 0 ? Number(fps.toFixed(2)) : 1,
    videoDurationSec,
    audioDurationSec,
    meanVolumeDb,
    blackRatio,
    checks,
    checkedAt: ctx.now().toISOString(),
  });

  if (!allPassed) {
    // 即使质检不通过，也将详细核验结果落盘以便用户或后台定位具体失败项
    await writeJsonAtomic(path.join(runDir, 'qa.json'), report);
    const failedSummary = checks
      .filter((c) => !c.passed)
      .map((c) => `${c.name}: ${c.detail}`)
      .join('；');
    throw new PipelineError('qa_failed', `成片质检未通过：${failedSummary}`);
  }

  return report;
}
