import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const ENVELOPE_FRAME_MS = 20;
const MIN_PAUSE_FRAMES = 6; // 6 * 20ms = 120ms 句间停顿低谷门槛
const MAX_GAIN_DB = 9;
const TRANSITION_MS = 60;

/** 解析后的 16 位线性 PCM WAV 头部与数据区位置 */
interface ParsedPcm16Wav {
  channels: number;
  sampleRate: number;
  dataStart: number;
  totalSamples: number;
}

/** 解析标准 16 位 PCM WAV 缓冲区的数据块位置与采样参数（兼容含扩展子块的头部） */
function parsePcm16WavHeader(buf: Buffer): ParsedPcm16Wav | null {
  if (
    buf.length < 44 ||
    buf.toString('ascii', 0, 4) !== 'RIFF' ||
    buf.toString('ascii', 8, 12) !== 'WAVE'
  ) {
    return null;
  }

  let audioFormat = 0;
  let channels = 0;
  let sampleRate = 0;
  let bitsPerSample = 0;
  let dataStart = -1;
  let dataLength = 0;

  let offset = 12;
  while (offset + 8 <= buf.length) {
    const chunkId = buf.toString('ascii', offset, offset + 4);
    const chunkSize = buf.readUInt32LE(offset + 4);
    const payloadStart = offset + 8;
    const clampedEnd = Math.min(buf.length, payloadStart + chunkSize);

    if (chunkId === 'fmt ' && payloadStart + 16 <= buf.length) {
      audioFormat = buf.readUInt16LE(payloadStart);
      channels = buf.readUInt16LE(payloadStart + 2);
      sampleRate = buf.readUInt32LE(payloadStart + 4);
      bitsPerSample = buf.readUInt16LE(payloadStart + 14);
    } else if (chunkId === 'data') {
      dataStart = payloadStart;
      dataLength = clampedEnd - payloadStart;
      break;
    }

    const paddedSize = chunkSize + (chunkSize % 2);
    if (paddedSize <= 0 && chunkSize === 0 && chunkId === '') {
      break;
    }
    offset = payloadStart + paddedSize;
  }

  if (
    audioFormat !== 1 ||
    bitsPerSample !== 16 ||
    channels <= 0 ||
    sampleRate <= 0 ||
    dataStart < 0 ||
    dataLength <= 0
  ) {
    return null;
  }

  const blockAlign = channels * 2;
  const totalSamples = Math.floor(dataLength / blockAlign);
  if (totalSamples <= 0) {
    return null;
  }

  return { channels, sampleRate, dataStart, totalSamples };
}

/** 对超过 0.88 满刻度的瞬态峰值执行平滑软限幅，低于 0.88 的正常语音保持纯线性无失真放大 */
function softLimitSample(x: number): number {
  const abs = Math.abs(x);
  if (abs <= 0.88) {
    return x;
  }
  const sign = x < 0 ? -1 : 1;
  return sign * (0.88 + 0.115 * Math.tanh((abs - 0.88) / 0.115));
}

/**
 * 对内存中的 16 位 PCM WAV 执行分句恒定增益均衡：
 * 按句间静音低谷切分自然句，仅依据每句有效元音主体帧计算句级恒定增益，并在静音谷底平滑过渡，
 * 从而拉齐句间大小声差异，同时彻底杜绝流式变增益带来的波形电流失真、底噪抽吸与句尾音量下跌。
 */
export function levelSpeechPhrasesInWavBuffer(inputBuf: Buffer): {
  buffer: Buffer;
  modified: boolean;
} {
  const wav = parsePcm16WavHeader(inputBuf);
  if (!wav) {
    return { buffer: inputBuf, modified: false };
  }

  const { channels, sampleRate, dataStart, totalSamples } = wav;
  const blockAlign = channels * 2;
  const frameSamples = Math.max(1, Math.round((sampleRate * ENVELOPE_FRAME_MS) / 1000));
  const frameDb: number[] = [];
  let maxDb = -120;

  for (let start = 0; start < totalSamples; start += frameSamples) {
    const end = Math.min(totalSamples, start + frameSamples);
    const count = end - start;
    let sumSq = 0;
    for (let i = start; i < end; i++) {
      const base = dataStart + i * blockAlign;
      let mono = 0;
      for (let c = 0; c < channels; c++) {
        mono += inputBuf.readInt16LE(base + c * 2) / 32768;
      }
      mono /= channels;
      sumSq += mono * mono;
    }
    const rms = Math.sqrt(sumSq / Math.max(1, count));
    const db = 20 * Math.log10(Math.max(rms, 1e-6));
    frameDb.push(db);
    if (db > maxDb) {
      maxDb = db;
    }
  }

  if (maxDb <= -65 || frameDb.length < MIN_PAUSE_FRAMES * 2) {
    return { buffer: inputBuf, modified: false };
  }

  const pauseThresholdDb = Math.max(-58, maxDb - 30);
  const splitSamples: number[] = [];
  let runStart = -1;

  for (let f = 0; f <= frameDb.length; f++) {
    const isPause = f < frameDb.length && (frameDb[f] ?? -120) < pauseThresholdDb;
    if (isPause) {
      if (runStart < 0) {
        runStart = f;
      }
    } else if (runStart >= 0) {
      const runLen = f - runStart;
      const touchesStart = runStart === 0;
      const touchesEnd = f === frameDb.length;
      if (!touchesStart && !touchesEnd && runLen >= MIN_PAUSE_FRAMES) {
        const midFrame = runStart + runLen / 2;
        const centerSample = Math.min(
          totalSamples - 1,
          Math.max(1, Math.round(midFrame * frameSamples)),
        );
        splitSamples.push(centerSample);
      }
      runStart = -1;
    }
  }

  if (splitSamples.length === 0) {
    return { buffer: inputBuf, modified: false };
  }

  const boundaries = [0, ...splitSamples, totalSamples];
  const phraseRmsDb: Array<number | null> = [];
  const phraseWeights: number[] = [];

  for (let p = 0; p < boundaries.length - 1; p++) {
    const startSample = boundaries[p] ?? 0;
    const endSample = boundaries[p + 1] ?? totalSamples;
    const fStart = Math.floor(startSample / frameSamples);
    const fEnd = Math.min(frameDb.length, Math.ceil(endSample / frameSamples));

    const voicedDbs: number[] = [];
    for (let f = fStart; f < fEnd; f++) {
      const db = frameDb[f] ?? -120;
      if (db > pauseThresholdDb && db > -62) {
        voicedDbs.push(db);
      }
    }

    if (voicedDbs.length === 0) {
      phraseRmsDb.push(null);
      phraseWeights.push(0);
      continue;
    }

    const sorted = [...voicedDbs].sort((a, b) => a - b);
    const p85 = sorted[Math.floor((sorted.length - 1) * 0.85)] ?? sorted[sorted.length - 1] ?? -30;
    const gateFloor = p85 - 14;
    const coreDbs = voicedDbs.filter((db) => db >= gateFloor);
    const meanLinearPower =
      coreDbs.reduce((acc, db) => acc + 10 ** (db / 10), 0) / Math.max(1, coreDbs.length);
    phraseRmsDb.push(10 * Math.log10(Math.max(meanLinearPower, 1e-12)));
    phraseWeights.push(coreDbs.length);
  }

  const validPairs = phraseRmsDb
    .map((db, idx) => ({ db, weight: phraseWeights[idx] ?? 0 }))
    .filter((item): item is { db: number; weight: number } => item.db !== null && item.weight > 0);

  if (validPairs.length < 2) {
    return { buffer: inputBuf, modified: false };
  }

  const totalWeight = validPairs.reduce((acc, item) => acc + item.weight, 0);
  const weightedMeanDb =
    validPairs.reduce((acc, item) => acc + item.db * item.weight, 0) / Math.max(1, totalWeight);
  const targetDb = Math.min(-14, weightedMeanDb);

  let maxDeltaAbs = 0;
  const phraseGains: number[] = [];
  for (let p = 0; p < phraseRmsDb.length; p++) {
    const db = phraseRmsDb[p];
    if (db === null || db === undefined) {
      phraseGains.push(phraseGains[phraseGains.length - 1] ?? 1);
      continue;
    }
    const clampedDelta = Math.max(-MAX_GAIN_DB, Math.min(MAX_GAIN_DB, targetDb - db));
    if (Math.abs(clampedDelta) > maxDeltaAbs) {
      maxDeltaAbs = Math.abs(clampedDelta);
    }
    phraseGains.push(10 ** (clampedDelta / 20));
  }

  if (maxDeltaAbs < 0.35) {
    return { buffer: inputBuf, modified: false };
  }

  const halfTransSamples = Math.max(1, Math.round((sampleRate * TRANSITION_MS) / 2000));
  const outBuf = Buffer.from(inputBuf);

  let segIdx = 0;
  for (let s = 0; s < totalSamples; s++) {
    while (segIdx < splitSamples.length && s >= (splitSamples[segIdx] ?? totalSamples)) {
      segIdx += 1;
    }

    let gain = phraseGains[segIdx] ?? 1;

    // 仅在相邻分句间的静音低谷中心附近做平滑余弦过渡，句内全程保持严格恒定增益
    if (segIdx < splitSamples.length) {
      const nextSplit = splitSamples[segIdx] ?? totalSamples;
      const distToNext = nextSplit - s;
      if (distToNext <= halfTransSamples) {
        const gCurr = phraseGains[segIdx] ?? 1;
        const gNext = phraseGains[segIdx + 1] ?? gCurr;
        const t = (halfTransSamples - distToNext) / (2 * halfTransSamples);
        const w = 0.5 - 0.5 * Math.cos(Math.PI * t);
        gain = gCurr + (gNext - gCurr) * w;
      }
    }
    if (segIdx > 0) {
      const prevSplit = splitSamples[segIdx - 1] ?? 0;
      const distFromPrev = s - prevSplit;
      if (distFromPrev < halfTransSamples) {
        const gPrev = phraseGains[segIdx - 1] ?? 1;
        const gCurr = phraseGains[segIdx] ?? gPrev;
        const t = (halfTransSamples + distFromPrev) / (2 * halfTransSamples);
        const w = 0.5 - 0.5 * Math.cos(Math.PI * t);
        gain = gPrev + (gCurr - gPrev) * w;
      }
    }

    const base = dataStart + s * blockAlign;
    for (let c = 0; c < channels; c++) {
      const raw = inputBuf.readInt16LE(base + c * 2) / 32768;
      const scaled = softLimitSample(raw * gain);
      const pcm = Math.max(-32768, Math.min(32767, Math.round(scaled * 32767)));
      outBuf.writeInt16LE(pcm, base + c * 2);
    }
  }

  return { buffer: outBuf, modified: true };
}

/**
 * 读取磁盘上的 WAV 音频文件执行分句恒定增益均衡，若存在句间落差则以同目录临时文件原子替换写回。
 */
export async function levelSpeechPhrasesWav(wavPath: string): Promise<boolean> {
  const raw = await fs.readFile(wavPath);
  const { buffer, modified } = levelSpeechPhrasesInWavBuffer(raw);
  if (!modified) {
    return false;
  }
  const dir = path.dirname(wavPath);
  const ext = path.extname(wavPath) || '.wav';
  const base = path.basename(wavPath, ext);
  const tmpPath = path.join(
    dir,
    `.${base}.${process.pid}.${crypto.randomBytes(4).toString('hex')}${ext}`,
  );
  try {
    await fs.writeFile(tmpPath, buffer);
    await fs.rename(tmpPath, wavPath);
    return true;
  } catch (err) {
    await fs.rm(tmpPath, { force: true }).catch(() => undefined);
    throw err;
  }
}
