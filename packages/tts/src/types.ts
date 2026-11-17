import type { CliBridge } from '@aidaily/cli-bridge';
import type { TtsSettings } from '@aidaily/contracts';

/** 单句语音合成请求参数 */
export interface SynthesizeRequest {
  text: string;
  outFile: string;
  sampleRate?: number;
  providerConfig?: Record<string, unknown>;
  signal?: AbortSignal;
}

/**
 * 语音合成引擎统一接口，屏蔽底层是本地模型还是云端服务的实现差异。
 */
export interface TtsProvider {
  id: string;
  /** 将指定文本合成为音频并写入目标文件路径 */
  synthesize(req: SynthesizeRequest): Promise<void>;
  /** 检查当前语音合成引擎是否可用 */
  healthcheck(): Promise<{ ok: boolean; detail: string }>;
  /** 计算会影响音色的参考素材标识，避免复用过期音频 */
  cacheIdentity?(config: Record<string, unknown>): Promise<string>;
  /** 可选生命周期方法：开始整期配音前启动本地模型服务或预热资源 */
  start?(providerConfig?: Record<string, unknown>, signal?: AbortSignal): Promise<void>;
  /** 可选生命周期方法：整期配音完成后关闭服务或释放本地内存 */
  stop?(): Promise<void>;
}

/** 语音合成调度服务初始化参数（`bridge` 供后续接入命令行类本地语音引擎时调用） */
export interface TtsServiceOptions {
  settings: TtsSettings;
  cacheDir: string;
  rootDir?: string;
  bridge?: CliBridge;
  ffmpegBin?: string;
  ffprobeBin?: string;
}
