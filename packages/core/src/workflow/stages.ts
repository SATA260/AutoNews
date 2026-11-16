import path from 'node:path';
import {
  type ContentLimits,
  type PIPELINE_STAGES,
  type Settings,
  type Timeline,
  TimelineSchema,
} from '@aidaily/contracts';
import { collectSources } from '../collector/index.js';
import type { CoreContext } from '../context.js';
import {
  type PackageCheckpoint,
  runEditStage,
  runPackageStage,
  runSelectStage,
} from '../editorial/index.js';
import { runRenderStage } from '../media/compositor.js';
import { runNarrateStage } from '../media/narration.js';
import { runQaStage } from '../media/qa.js';
import { readJsonOrNull } from '../storage/files.js';
import { resolveEffectiveContentLimits } from '../templates/registry.js';

/** 自动化流程中按顺序执行的步骤名称类型 */
export type PipelineStage = (typeof PIPELINE_STAGES)[number];

/** 单个自动化流程步骤运行所需的标准输入参数 */
export interface StageExecutionArgs {
  ctx: CoreContext;
  runId: string;
  settings: Settings;
  signal: AbortSignal;
  limitsOverride?: Partial<ContentLimits>;
}

/** 单个自动化流程步骤的执行函数签名 */
export type StageExecutor = (args: StageExecutionArgs) => Promise<unknown>;

/** 每个流程步骤在任务目录下产生的检查点或产物相对路径（用于重跑作废时归档保留） */
export const STAGE_ARTIFACTS: Record<PipelineStage, readonly string[]> = {
  collect: ['stages/collect.json'],
  select: ['stages/select.json'],
  edit: ['stages/edit.json', 'items'],
  package: ['stages/package.json'],
  narrate: ['stages/narrate.json', 'timeline.json', 'audio'],
  render: [
    'stages/render.json',
    'template-data.json',
    'assets',
    'frames',
    'output/video.mp4',
    'output/cover.jpg',
  ],
  qa: ['qa.json'],
};

/** 每个流程步骤最终落盘的检查点文件相对路径 */
export const STAGE_CHECKPOINT_REL_PATH: Record<PipelineStage, string> = {
  collect: 'stages/collect.json',
  select: 'stages/select.json',
  edit: 'stages/edit.json',
  package: 'stages/package.json',
  narrate: 'stages/narrate.json',
  render: 'stages/render.json',
  qa: 'qa.json',
};

/** 核心内置各流程步骤的默认执行实现 */
export const DEFAULT_STAGE_EXECUTORS: Record<PipelineStage, StageExecutor> = {
  /** 增量采集主力新闻信源 */
  async collect({ ctx, runId, settings, signal }) {
    return collectSources(ctx, { pool: 'primary', runId, settings, signal });
  },

  /** 聚类去重并筛选本期主选与替补新闻事件 */
  async select({ ctx, runId, settings, signal }) {
    return runSelectStage(ctx, runId, settings, signal);
  },

  /** 并发执行新闻总结、口播润色、规则预检与独立事实核查 */
  async edit({ ctx, runId, settings, signal, limitsOverride }) {
    const effectiveLimits = resolveEffectiveContentLimits(ctx, settings, limitsOverride);
    return runEditStage(ctx, runId, settings, { signal, limitsOverride: effectiveLimits });
  },

  /** 编排播出顺序、生成开场白、结尾互动及投稿标题简介 */
  async package({ ctx, runId, settings, signal, limitsOverride }) {
    const effectiveLimits = resolveEffectiveContentLimits(ctx, settings, limitsOverride);
    return runPackageStage(ctx, runId, settings, { signal, limitsOverride: effectiveLimits });
  },

  /** 调用语音合成并生成整期视频时间轴 */
  async narrate({ ctx, runId, settings, signal }) {
    const pkgFile = path.join(ctx.paths.runDir(runId), STAGE_CHECKPOINT_REL_PATH.package);
    const pkgCheckpoint = await readJsonOrNull<PackageCheckpoint>(pkgFile);
    if (!pkgCheckpoint?.packageData) {
      throw new Error(`任务 ${runId} 缺少整期编排检查点，无法开始配音合成`);
    }
    const { checkpoint } = await runNarrateStage({
      ctx,
      runId,
      settings,
      packageData: pkgCheckpoint.packageData,
      signal,
    });
    return checkpoint;
  },

  /** 调用前端视觉模板截图并合成带响度均衡音轨的高清成片与封面图 */
  async render({ ctx, runId, settings, signal }) {
    const runDir = ctx.paths.runDir(runId);
    const pkgCheckpoint = await readJsonOrNull<PackageCheckpoint>(
      path.join(runDir, STAGE_CHECKPOINT_REL_PATH.package),
    );
    if (!pkgCheckpoint?.packageData) {
      throw new Error(`任务 ${runId} 缺少整期编排检查点，无法开始视频渲染`);
    }
    const rawTimeline = await readJsonOrNull<Timeline>(path.join(runDir, 'timeline.json'));
    const parsedTimeline = TimelineSchema.safeParse(rawTimeline);
    if (!parsedTimeline.success) {
      throw new Error(`任务 ${runId} 缺少合法的时间轴文件，无法开始视频渲染`);
    }
    return runRenderStage({
      ctx,
      runId,
      settings,
      packageData: pkgCheckpoint.packageData,
      timeline: parsedTimeline.data,
      signal,
    });
  },

  /** 对合成的成片视频执行自动化音画参数、时长同步与空白画面检查 */
  async qa({ ctx, runId, settings, signal }) {
    const runDir = ctx.paths.runDir(runId);
    const rawTimeline = await readJsonOrNull<Timeline>(path.join(runDir, 'timeline.json'));
    const parsedTimeline = TimelineSchema.safeParse(rawTimeline);
    if (!parsedTimeline.success) {
      throw new Error(`任务 ${runId} 缺少合法的时间轴文件，无法执行成片质检`);
    }
    return runQaStage({
      ctx,
      runId,
      settings,
      timeline: parsedTimeline.data,
      signal,
    });
  },
};
