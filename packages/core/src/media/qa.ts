import fs from 'node:fs/promises';
import path from 'node:path';
import {
  type QaCheckItem,
  type QaReport,
  QaReportSchema,
  type Settings,
  type Timeline,
} from '@aidaily/contracts';
import type { CoreContext } from '../context.js';
import { PipelineError } from '../errors.js';
import { writeJsonAtomic } from '../storage/files.js';
import { runMediaCommand } from './ffmpeg.js';

interface FfprobeStream {
  codec_type?: string;
  width?: number;
  height?: number;
  r_frame_rate?: string;
  avg_frame_rate?: string;
  duration?: string;
}

interface FfprobeOutput {
  streams?: FfprobeStream[];
  format?: { duration?: string };
}

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

/**
 * 对合成完成的成片视频执行自动化音画质检：
 * 核对视频流与音频流存在性、分辨率与帧率匹配、音画时长同步差、平均响度、黑屏占比以及所有页面截图非空白，
 * 检测任一项目不达标时抛出 `qa_failed` 异常，允许后续单独从渲染阶段重跑。
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

  const parsed = JSON.parse(probeOut.stdout) as FfprobeOutput;
  const videoStream = parsed.streams?.find((s) => s.codec_type === 'video');
  const audioStream = parsed.streams?.find((s) => s.codec_type === 'audio');
  const formatDurationSec = Number(parsed.format?.duration ?? '0');

  const videoDurationSec =
    Number(videoStream?.duration ?? '0') ||
    (Number.isFinite(formatDurationSec) ? formatDurationSec : 0);
  const audioDurationSec =
    Number(audioStream?.duration ?? '0') ||
    (Number.isFinite(formatDurationSec) ? formatDurationSec : 0);

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
      Math.abs(fps - settings.render.fps) <= 1,
    detail: `实际=${width}x${height}@${fps.toFixed(2)}fps，配置=${settings.render.width}x${settings.render.height}@${settings.render.fps}fps`,
  });

  const avDiffSec = Math.abs(videoDurationSec - audioDurationSec);
  checks.push({
    name: 'av_sync',
    passed: Boolean(videoStream && audioStream) && avDiffSec < 0.3,
    detail: `视频 ${videoDurationSec.toFixed(3)}s，音频 ${audioDurationSec.toFixed(3)}s，差值 ${avDiffSec.toFixed(3)}s`,
  });

  const timelineSec = timeline.totalMs / 1000;
  const timelineDiffSec = Math.abs(videoDurationSec - timelineSec);
  checks.push({
    name: 'timeline_duration_match',
    passed: videoDurationSec > 0 && timelineDiffSec < 0.5,
    detail: `成片 ${videoDurationSec.toFixed(3)}s，时间轴 ${timelineSec.toFixed(3)}s，差值 ${timelineDiffSec.toFixed(3)}s`,
  });

  // 检查音量与黑场比例
  const volRes = await runMediaCommand(
    ffmpegBin,
    ['-v', 'info', '-i', videoFile, '-af', 'volumedetect', '-f', 'null', '-'],
    { signal, actionLabel: 'ffmpeg 检测成片音量' },
  );
  const meanVolumeDb = parseMeanVolumeDb(volRes.stderr);
  const isSilentTest = settings.tts.provider === 'silent';
  checks.push({
    name: 'audio_volume',
    passed: isSilentTest ? true : meanVolumeDb !== null && meanVolumeDb > -35,
    detail: isSilentTest
      ? `当前使用测试无声配音（平均音量=${meanVolumeDb === null ? '-inf' : `${meanVolumeDb.toFixed(1)}dB`}），放行通过`
      : `平均音量=${meanVolumeDb === null ? '-inf' : `${meanVolumeDb.toFixed(1)}dB`}（要求 > -35dB）`,
  });

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
    { signal, actionLabel: 'ffmpeg 检测成片黑场画面' },
  );
  const blackSec = sumBlackDurations(blackRes.stderr);
  const blackRatio = videoDurationSec > 0 ? Math.min(1, blackSec / videoDurationSec) : 1;
  checks.push({
    name: 'black_frames',
    passed: blackRatio < 0.05,
    detail: `黑场累计 ${blackSec.toFixed(3)}s，占比 ${(blackRatio * 100).toFixed(2)}%（要求 < 5%）`,
  });

  // 检查每张截图是否超出最小文件大小阈值（防止空白或渲染失效页面）
  const expectedFrameCount = timeline.sections.length;
  const minPngBytes = 1024;
  let framesOk = true;
  const frameIssues: string[] = [];
  for (let i = 0; i < expectedFrameCount; i++) {
    const fileName = `page-${String(i).padStart(2, '0')}.png`;
    try {
      const stat = await fs.stat(path.join(framesDir, fileName));
      if (!stat.isFile() || stat.size < minPngBytes) {
        framesOk = false;
        frameIssues.push(`${fileName}(${stat.size}B)`);
      }
    } catch {
      framesOk = false;
      frameIssues.push(`${fileName}(缺失)`);
    }
  }
  checks.push({
    name: 'frame_screenshots',
    passed: framesOk,
    detail: framesOk
      ? `共 ${expectedFrameCount} 张画面截图均大于 ${minPngBytes} 字节`
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
