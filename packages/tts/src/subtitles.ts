import fs from 'node:fs/promises';
import type { SectionAudio } from '@aidaily/contracts';
import { prepareNarrationSentences } from './sanitize.js';

/** 单个分句与合成语音对齐后的字幕时间戳条目 */
export type AlignedSentenceAudio = SectionAudio['sentences'][number];

const FRAME_MS = 10;
const PAUSE_WINDOW_FRAMES = 8;

/** 解析后的单声道音频能量包络信息 */
interface WavEnvelope {
  frameDb: number[];
  maxDb: number;
  minDb: number;
}

/** 从标准 PCM WAV 字节流中按 10ms 切片提取逐帧均方根分贝序列（兼容扩展头部子块） */
function extractWavEnergyEnvelope(buf: Buffer): WavEnvelope | null {
  if (
    buf.length < 44 ||
    buf.toString('ascii', 0, 4) !== 'RIFF' ||
    buf.toString('ascii', 8, 12) !== 'WAVE'
  ) {
    return null;
  }

  let channels = 0;
  let sampleRate = 0;
  let bitsPerSample = 0;
  let audioFormat = 0;
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
    dataStart < 0 ||
    dataLength <= 0 ||
    channels <= 0 ||
    sampleRate <= 0 ||
    audioFormat !== 1 ||
    bitsPerSample !== 16
  ) {
    return null;
  }

  const bytesPerSample = bitsPerSample / 8;
  const blockAlign = bytesPerSample * channels;
  const totalSamples = Math.floor(dataLength / blockAlign);
  const frameSamples = Math.max(1, Math.round((sampleRate * FRAME_MS) / 1000));
  const frameDb: number[] = [];
  let maxDb = -120;
  let minDb = 0;

  for (let start = 0; start < totalSamples; start += frameSamples) {
    const end = Math.min(totalSamples, start + frameSamples);
    const count = end - start;
    if (count <= 0) {
      continue;
    }
    let sumSq = 0;
    for (let s = start; s < end; s++) {
      let chSum = 0;
      const base = dataStart + s * blockAlign;
      for (let c = 0; c < channels; c++) {
        chSum += buf.readInt16LE(base + c * bytesPerSample) / 32768;
      }
      const mono = chSum / channels;
      sumSq += mono * mono;
    }
    const rms = Math.sqrt(sumSq / count);
    const db = 20 * Math.log10(Math.max(rms, 1e-6));
    frameDb.push(db);
    if (db > maxDb) maxDb = db;
    if (db < minDb) minDb = db;
  }

  if (frameDb.length === 0) {
    return null;
  }
  return { frameDb, maxDb, minDb };
}

/** 估算单句口播包含中英文、数字与句内停顿后的朗读相对权重 */
function estimateSentenceWeight(sentence: string, isLast: boolean): number {
  const cjkCount = (sentence.match(/[\u4e00-\u9fff]/g) ?? []).length;
  const digitCount = (sentence.match(/\d/g) ?? []).length;
  const englishTokens = sentence.match(/[A-Za-z]+/g) ?? [];
  const englishWeight = englishTokens.reduce(
    (sum, token) => sum + Math.max(1.4, token.length * 0.4),
    0,
  );
  const innerPauseCount = (sentence.match(/[，、；：]/g) ?? []).length;
  const endPause = isLast ? 0 : 1.1;
  return Math.max(
    1,
    cjkCount * 1.0 + digitCount * 0.9 + englishWeight + innerPauseCount * 0.85 + endPause,
  );
}

/** 根据有效语音起止区间、能量包络动态寻找句间停顿低谷，返回递增的分句边界毫秒位置 */
function computeAlignedBoundaries(opts: {
  sentences: readonly string[];
  envelope: WavEnvelope | null;
  totalDurationMs: number;
}): number[] {
  const { sentences, envelope, totalDurationMs } = opts;
  const count = sentences.length;
  const safeTotal = Math.max(1, Math.round(totalDurationMs));
  const isDynamicSpeech =
    envelope !== null &&
    envelope.maxDb - envelope.minDb > 12 &&
    envelope.maxDb > -45 &&
    envelope.frameDb.length > 0;

  let speechStartMs = 0;
  let speechEndMs = safeTotal;

  if (isDynamicSpeech && envelope) {
    const activeThresholdDb = -52;
    const firstActive = envelope.frameDb.findIndex((db) => db > activeThresholdDb);
    let lastActive = -1;
    for (let idx = envelope.frameDb.length - 1; idx >= 0; idx--) {
      if ((envelope.frameDb[idx] ?? -120) > activeThresholdDb) {
        lastActive = idx;
        break;
      }
    }
    if (firstActive >= 0 && lastActive >= firstActive) {
      speechStartMs = Math.min(250, Math.round(safeTotal * 0.15), firstActive * FRAME_MS);
      speechEndMs = Math.min(
        safeTotal,
        Math.max(speechStartMs + 100, (lastActive + 1) * FRAME_MS + 60),
      );
    }
  }

  if (count === 1) {
    return [0, speechEndMs];
  }

  const weights = sentences.map((s, idx) => estimateSentenceWeight(s, idx === count - 1));
  const totalWeight = weights.reduce((acc, w) => acc + w, 0);
  const usableSpanMs = Math.max(count, speechEndMs - speechStartMs);
  const minStepMs = Math.min(160, Math.max(1, Math.floor(usableSpanMs / count)));
  const avgSentenceMs = usableSpanMs / count;
  const searchRadiusMs = Math.min(420, Math.round(avgSentenceMs * 0.28));

  const boundaries: number[] = [0];
  let cumWeight = 0;

  for (let k = 1; k < count; k++) {
    cumWeight += weights[k - 1] ?? 1;
    const expectedMs = Math.round(speechStartMs + (usableSpanMs * cumWeight) / totalWeight);
    const prevBoundary = boundaries[boundaries.length - 1] ?? 0;
    const remaining = count - k;
    const minAllowed = prevBoundary + minStepMs;
    const maxAllowed = Math.max(minAllowed, speechEndMs - remaining * minStepMs);

    let chosenMs = Math.min(maxAllowed, Math.max(minAllowed, expectedMs));

    if (isDynamicSpeech && envelope && maxAllowed > minAllowed) {
      const searchStart = Math.max(minAllowed, expectedMs - searchRadiusMs);
      const searchEnd = Math.min(maxAllowed, expectedMs + searchRadiusMs);
      const halfWin = Math.floor(PAUSE_WINDOW_FRAMES / 2);

      let bestScore = Number.POSITIVE_INFINITY;
      for (let candMs = searchStart; candMs <= searchEnd; candMs += FRAME_MS) {
        const centerFrame = Math.round(candMs / FRAME_MS);
        const winStart = Math.max(0, centerFrame - halfWin);
        const winEnd = Math.min(envelope.frameDb.length, centerFrame + halfWin);
        if (winEnd <= winStart) {
          continue;
        }
        let sumDb = 0;
        for (let f = winStart; f < winEnd; f++) {
          sumDb += envelope.frameDb[f] ?? -120;
        }
        const avgDb = sumDb / (winEnd - winStart);
        // 用适度距离惩罚抑制逗号短停顿误吸，既吸附句间低谷又避免跨入邻近句子内部
        const score = avgDb + 0.025 * Math.abs(candMs - expectedMs);
        if (score < bestScore) {
          bestScore = score;
          chosenMs = candMs;
        }
      }
      chosenMs = Math.min(maxAllowed, Math.max(minAllowed, Math.round(chosenMs)));
    }

    boundaries.push(chosenMs);
  }

  boundaries.push(Math.max((boundaries[boundaries.length - 1] ?? 0) + 1, speechEndMs));
  return boundaries;
}

/**
 * 为整段合成为同一音频文件的多句口播计算逐句字幕时间戳：
 * 结合中文字符、英文词汇与标点朗读权重预估位置，并在真实人声能量包络中自动吸附句间停顿低谷。
 */
export async function alignSentencesToWav(
  wavFile: string,
  rawSentences: readonly string[],
  totalDurationMs: number,
): Promise<AlignedSentenceAudio[]> {
  const cleanSentences = prepareNarrationSentences(rawSentences);
  if (cleanSentences.length === 0) {
    return [];
  }

  let envelope: WavEnvelope | null = null;
  try {
    const wavBytes = await fs.readFile(wavFile);
    envelope = extractWavEnergyEnvelope(wavBytes);
  } catch {
    envelope = null;
  }

  const boundaries = computeAlignedBoundaries({
    sentences: cleanSentences,
    envelope,
    totalDurationMs,
  });

  return cleanSentences.map((text, idx) => {
    const offsetMs = boundaries[idx] ?? 0;
    const nextMs = boundaries[idx + 1] ?? Math.max(offsetMs + 1, totalDurationMs);
    return {
      text,
      offsetMs,
      durationMs: Math.max(1, nextMs - offsetMs),
    };
  });
}
