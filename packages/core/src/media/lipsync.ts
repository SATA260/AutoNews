import fs from 'node:fs/promises';

/** WAV 音频头部解析出的采样率、声道数与数据区间信息 */
export interface ParsedWavPcmInfo {
  audioFormat: number;
  numChannels: number;
  sampleRate: number;
  bitsPerSample: number;
  dataOffset: number;
  dataByteLength: number;
}

/** 提取口型开合序列时的可选控制参数 */
export interface ExtractLipSyncOptions {
  /** 视频帧率（每秒提取多少个口型采样点，默认 30） */
  fps?: number;
  /** 整页总时长毫秒数；传入时会自动在语音结束后补齐闭嘴零值帧直至页面结束 */
  totalDurationMs?: number;
  /** 底噪静音阈值（分贝，低于此值视为完全闭嘴，默认 -42dB） */
  noiseFloorDb?: number;
  /** 饱满张嘴对应的参考响度上限（分贝，默认 -9dB） */
  peakCeilingDb?: number;
}

/**
 * 解析标准 RIFF WAVE 字节缓冲区，逐块查找 fmt 与 data 子块，
 * 兼容 FFmpeg 在音频头部插入 LIST/INFO/JUNK 等元数据块的常见结构。
 */
export function parseWavHeader(buf: Buffer): ParsedWavPcmInfo {
  if (buf.byteLength < 44) {
    throw new Error(`WAV 文件过短（${buf.byteLength} 字节），无法解析头部`);
  }
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('文件不是有效的 RIFF WAVE 音频格式');
  }

  let offset = 12;
  let audioFormat = 0;
  let numChannels = 0;
  let sampleRate = 0;
  let bitsPerSample = 0;
  let hasFmt = false;

  while (offset + 8 <= buf.byteLength) {
    const chunkId = buf.toString('ascii', offset, offset + 4);
    const chunkSize = buf.readUInt32LE(offset + 4);
    const bodyStart = offset + 8;

    if (chunkId === 'fmt ') {
      if (bodyStart + 16 > buf.byteLength) {
        throw new Error('WAV fmt 块不完整');
      }
      audioFormat = buf.readUInt16LE(bodyStart);
      numChannels = buf.readUInt16LE(bodyStart + 2);
      sampleRate = buf.readUInt32LE(bodyStart + 4);
      bitsPerSample = buf.readUInt16LE(bodyStart + 14);
      hasFmt = true;
    } else if (chunkId === 'data') {
      if (!hasFmt) {
        throw new Error('WAV 文件在 fmt 块之前出现了 data 块');
      }
      const available = Math.max(0, buf.byteLength - bodyStart);
      const dataByteLength = Math.min(chunkSize, available);
      return {
        audioFormat,
        numChannels,
        sampleRate,
        bitsPerSample,
        dataOffset: bodyStart,
        dataByteLength,
      };
    }

    const paddedSize = chunkSize + (chunkSize % 2);
    const nextOffset = bodyStart + paddedSize;
    if (nextOffset <= offset) {
      break;
    }
    offset = nextOffset;
  }

  throw new Error('WAV 文件缺少有效的音频采样 data 块');
}

/** 读取单个声道采样点并归一化为 [-1, 1] 浮点数（支持 8/16/24/32 位整型及 32 位浮点 PCM） */
function readNormalizedSample(
  buf: Buffer,
  bytePos: number,
  audioFormat: number,
  bitsPerSample: number,
): number {
  if (audioFormat === 3 && bitsPerSample === 32) {
    const v = buf.readFloatLE(bytePos);
    return Number.isFinite(v) ? Math.max(-1, Math.min(1, v)) : 0;
  }
  if (bitsPerSample === 16) {
    return buf.readInt16LE(bytePos) / 32768;
  }
  if (bitsPerSample === 24) {
    const b0 = buf[bytePos] ?? 0;
    const b1 = buf[bytePos + 1] ?? 0;
    const b2 = buf[bytePos + 2] ?? 0;
    let val = b0 | (b1 << 8) | (b2 << 16);
    if (val & 0x800000) {
      val |= ~0xffffff;
    }
    return val / 8388608;
  }
  if (bitsPerSample === 32) {
    return buf.readInt32LE(bytePos) / 2147483648;
  }
  if (bitsPerSample === 8) {
    return ((buf[bytePos] ?? 128) - 128) / 128;
  }
  return 0;
}

/**
 * 从内存中的 WAV 字节流提取按固定视频帧率对齐的归一化口型开合度序列（范围 0 ~ 1）：
 * 低于静音门限时归零闭嘴，说话区间按分贝能量映射并做快张慢合平滑滤波，使角色嘴型贴合真实播报。
 */
export function computeLipSyncFramesFromWavBuffer(
  buf: Buffer,
  opts: ExtractLipSyncOptions = {},
): number[] {
  const fps = Math.max(1, Math.round(opts.fps ?? 30));
  const noiseFloorDb = opts.noiseFloorDb ?? -42;
  const peakCeilingDb = opts.peakCeilingDb ?? -9;
  const dbSpan = Math.max(6, peakCeilingDb - noiseFloorDb);

  const info = parseWavHeader(buf);
  if (info.numChannels < 1 || info.sampleRate < 1000) {
    return [];
  }
  const bytesPerSample = Math.max(1, Math.floor(info.bitsPerSample / 8));
  const blockAlign = bytesPerSample * info.numChannels;
  const totalSampleFrames = Math.floor(info.dataByteLength / blockAlign);
  const audioFramesCount = Math.max(1, Math.ceil((totalSampleFrames / info.sampleRate) * fps));

  const targetTotalFrames =
    opts.totalDurationMs !== undefined && opts.totalDurationMs > 0
      ? Math.max(audioFramesCount, Math.round((opts.totalDurationMs / 1000) * fps))
      : audioFramesCount;

  const rawTargets: number[] = new Array<number>(targetTotalFrames).fill(0);
  const samplesPerVideoFrame = info.sampleRate / fps;

  for (let f = 0; f < audioFramesCount; f++) {
    const startSample = Math.floor(f * samplesPerVideoFrame);
    const endSample = Math.min(totalSampleFrames, Math.floor((f + 1) * samplesPerVideoFrame));
    const count = endSample - startSample;
    if (count <= 0) {
      continue;
    }

    let sumSq = 0;
    for (let s = startSample; s < endSample; s++) {
      const frameByteOffset = info.dataOffset + s * blockAlign;
      let mono = 0;
      for (let ch = 0; ch < info.numChannels; ch++) {
        mono += readNormalizedSample(
          buf,
          frameByteOffset + ch * bytesPerSample,
          info.audioFormat,
          info.bitsPerSample,
        );
      }
      mono /= info.numChannels;
      sumSq += mono * mono;
    }

    const rms = Math.sqrt(sumSq / count);
    if (rms <= 1e-5) {
      rawTargets[f] = 0;
      continue;
    }
    const db = 20 * Math.log10(rms);
    if (db <= noiseFloorDb) {
      rawTargets[f] = 0;
      continue;
    }

    const normalized = Math.min(1, Math.max(0, (db - noiseFloorDb) / dbSpan));
    rawTargets[f] = Math.min(1, normalized ** 0.85);
  }

  // 非对称指数移动平均滤波：张嘴迅速跟上字头（0.65），闭嘴自然回落（0.35）
  const smoothed: number[] = new Array<number>(targetTotalFrames).fill(0);
  const attack = 0.65;
  const release = 0.35;
  let current = 0;

  for (let i = 0; i < targetTotalFrames; i++) {
    const target = rawTargets[i] ?? 0;
    const alpha = target > current ? attack : release;
    current = current + (target - current) * alpha;
    if (current < 0.02 && target === 0) {
      current = 0;
    }
    smoothed[i] = Math.round(Math.min(1, Math.max(0, current)) * 1000) / 1000;
  }

  return smoothed;
}

/**
 * 读取本地 WAV 口播音频文件并提取按帧对齐的归一化口型开合序列；
 * 当音频文件缺失或损坏时安全回退为空数组，不阻断画面渲染。
 */
export async function extractWavLipSyncFrames(
  wavFilePath: string,
  opts: ExtractLipSyncOptions = {},
): Promise<number[]> {
  try {
    const buf = await fs.readFile(wavFilePath);
    return computeLipSyncFramesFromWavBuffer(buf, opts);
  } catch {
    return [];
  }
}
