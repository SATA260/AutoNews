import path from 'node:path';
import { type PublishDraft, PublishDraftSchema } from '@aidaily/contracts';
import type { CoreContext } from '../context.js';
import { checkCoverText, normalizeCoverText } from '../editorial/cover-text.js';
import {
  COVER_IMAGE_REL_PATH,
  type CoverState,
  readCoverState,
  renderCoverImage,
  saveCoverText,
} from '../media/cover.js';
import {
  assertReadyToUpload,
  buildBiliLoginCommand,
  executeBilibiliUpload,
  normalizeBvid,
} from '../publish/bilibili.js';
import { commitRunConsumption } from '../publish/consumption.js';
import { ensurePublishDraftForRun } from '../publish/description.js';
import { inTransaction } from '../storage/db.js';
import type { PublishedHistoryRecord } from '../storage/repos/articles-repo.js';
import { emitRunEvent } from '../workflow/events.js';
import {
  acquirePipelineLock,
  assertPipelineLockAvailable,
  releasePipelineLock,
} from '../workflow/lock.js';

/** 确认或重试发布时可选的后台执行模式及重试间隔参数 */
export interface PublishActionOptions {
  detach?: boolean;
  retryDelaysMs?: readonly number[];
  dtimeUnixSec?: number;
}

/** 局部更新投稿草稿时允许修改的标题、简介与标签集合 */
export interface PublishDraftPatch {
  title?: string;
  description?: string;
  tags?: string[];
}

/** B 站视频审核、发布文案微调、上传确认与人工兜底服务接口（供命令行与网页后台共用） */
export interface PublishService {
  /** 获取指定期次的待审核视频投稿草稿（含标题、章节简介、参考来源、标签及成片路径） */
  getDraft(runId: string): Promise<PublishDraft>;
  /** 人工修改投稿标题、简介或标签列表并校验平台字数与数量限制 */
  updateDraft(runId: string, patch: PublishDraftPatch): Promise<PublishDraft>;
  /** 审核通过并立即触发 B 站投稿上传 */
  approve(runId: string, opts?: PublishActionOptions): Promise<void>;
  /** 在投稿明确失败后重新尝试上传（禁止用于状态不明的任务） */
  retry(runId: string, opts?: PublishActionOptions): Promise<void>;
  /** 对上传途中失联的状态不明任务执行人工核对定案：确认未发布转为可重传，或补填已收录 BV 号完成消费闭环 */
  confirmUncertain(
    runId: string,
    result: { published: false } | { published: true; bvid: string },
  ): Promise<void>;
  /** 人工审核驳回本期内容，并立即释放其锁定的候选新闻文章 */
  reject(runId: string, reason?: string): Promise<void>;
  /** 不向外网投稿发布，仅把本期选用的新闻提交已播历史库并标记整期完结 */
  markConsumed(runId: string): Promise<void>;
  /** 按发布时间倒序查询已播出新闻的历史记录列表 */
  listHistory(limit?: number): Promise<PublishedHistoryRecord[]>;
  /** 返回用于命令行交互式扫码登录 B 站的可执行程序路径与参数列表 */
  biliLoginCommand(): { bin: string; args: string[] };
  /** 读取本期当前生效的封面文字（人工修改 / 编排生成 / 自动截取）与封面图片状态 */
  getCover(runId: string): Promise<CoverState>;
  /** 人工修改封面主标题或副标题，校验字数后只重新生成封面图片 */
  updateCover(runId: string, patch: CoverTextPatch): Promise<CoverState>;
}

/** 局部修改封面文字时允许修改的主标题与副标题 */
export interface CoverTextPatch {
  title?: string;
  subtitle?: string;
}

/** 允许修改封面的任务状态：待审核、投稿失败，以及已经发布、需要重做封面的任务 */
const COVER_EDITABLE_STATUSES = new Set(['awaiting_review', 'publish_failed', 'published']);

/** 统计字符串的完整 Unicode 字符个数 */
function countCodepoints(text: string): number {
  return Array.from(text).length;
}

/** 创建审核发布服务实例，支持可选传入后台独立进程启动回调 */
export function createPublishService(
  ctx: CoreContext,
  opts?: {
    retryDelaysMs?: readonly number[];
    spawnDetachedPublish?: (req: {
      action: 'publish-approve' | 'publish-retry';
      runId: string;
      dtimeUnixSec?: number;
    }) => Promise<void>;
  },
): PublishService {
  return {
    /** 读取并校验当前期次的发布草稿内容 */
    async getDraft(runId: string): Promise<PublishDraft> {
      const run = ctx.repos.runs.getById(runId);
      if (!run) {
        throw new Error(`未找到任务记录: ${runId}`);
      }
      const draft = await ensurePublishDraftForRun(ctx, runId, ctx.settings);
      if (!draft) {
        throw new Error(`任务 ${runId} 尚未生成整期编排或时间轴，无法读取投稿草稿`);
      }
      return draft;
    },

    /** 修改并校验人工编辑后的投稿标题、简介和标签列表 */
    async updateDraft(runId: string, patch: PublishDraftPatch): Promise<PublishDraft> {
      const run = ctx.repos.runs.getById(runId);
      if (!run) {
        throw new Error(`未找到任务记录: ${runId}`);
      }

      const current = await ensurePublishDraftForRun(ctx, runId, ctx.settings);
      if (!current) {
        throw new Error(`任务 ${runId} 缺少投稿草稿，无法修改`);
      }

      const limits = ctx.settings.publish.bilibili;
      let nextTitle: string | undefined;
      if (patch.title !== undefined) {
        const trimmed = patch.title.trim();
        if (!trimmed) {
          throw new Error('投稿标题不能为空');
        }
        if (countCodepoints(trimmed) > limits.titleMax) {
          throw new Error(`投稿标题超出最大长度限制（${limits.titleMax} 字）`);
        }
        nextTitle = trimmed;
      }

      let nextDesc: string | undefined;
      if (patch.description !== undefined) {
        const trimmed = patch.description.trim();
        if (!trimmed) {
          throw new Error('视频简介不能为空');
        }
        if (countCodepoints(trimmed) > limits.descMax) {
          throw new Error(`视频简介超出最大长度限制（${limits.descMax} 字）`);
        }
        nextDesc = trimmed;
      }

      let nextTags: string[] | undefined;
      if (patch.tags !== undefined) {
        const cleaned = Array.from(new Set(patch.tags.map((t) => t.trim()).filter(Boolean)));
        if (cleaned.length === 0) {
          throw new Error('至少需要保留 1 个视频标签');
        }
        if (cleaned.length > limits.tagsMax) {
          throw new Error(`视频标签数量不能超过 ${limits.tagsMax} 个`);
        }
        nextTags = cleaned;
      }

      const updated = ctx.repos.publish.updateDraftFields(runId, {
        title: nextTitle,
        description: nextDesc,
        tags: nextTags,
        updatedAt: ctx.now().toISOString(),
      });
      if (!updated) {
        throw new Error(`更新投稿草稿失败，未找到任务记录: ${runId}`);
      }

      const runDir = ctx.paths.runDir(runId);
      return PublishDraftSchema.parse({
        runId,
        title: updated.title ?? current.title,
        description: updated.description ?? current.description,
        tags: updated.tags.length > 0 ? updated.tags : current.tags,
        videoPath: path.relative(ctx.paths.rootDir, path.join(runDir, 'output', 'video.mp4')),
        coverPath: path.relative(ctx.paths.rootDir, path.join(runDir, 'output', 'cover.jpg')),
        aiDeclaration: true,
        status: updated.status,
      });
    },

    /** 确认审核通过并开始向 B 站投稿发布 */
    async approve(runId: string, actionOpts?: PublishActionOptions): Promise<void> {
      if (actionOpts?.detach && opts?.spawnDetachedPublish) {
        assertPipelineLockAvailable(ctx);
        await assertReadyToUpload({
          ctx,
          runId,
          settings: ctx.settings,
          allowedRunStatuses: ['awaiting_review'],
        });
        await opts.spawnDetachedPublish({
          action: 'publish-approve',
          runId,
          dtimeUnixSec: actionOpts.dtimeUnixSec,
        });
        return;
      }
      await executeBilibiliUpload({
        ctx,
        runId,
        settings: ctx.settings,
        allowedRunStatuses: ['awaiting_review'],
        retryDelaysMs: actionOpts?.retryDelaysMs ?? opts?.retryDelaysMs,
        dtimeUnixSec: actionOpts?.dtimeUnixSec,
      });
    },

    /** 投稿明确失败后重新尝试上传 */
    async retry(runId: string, actionOpts?: PublishActionOptions): Promise<void> {
      if (actionOpts?.detach && opts?.spawnDetachedPublish) {
        assertPipelineLockAvailable(ctx);
        await assertReadyToUpload({
          ctx,
          runId,
          settings: ctx.settings,
          allowedRunStatuses: ['publish_failed'],
        });
        await opts.spawnDetachedPublish({
          action: 'publish-retry',
          runId,
          dtimeUnixSec: actionOpts.dtimeUnixSec,
        });
        return;
      }
      await executeBilibiliUpload({
        ctx,
        runId,
        settings: ctx.settings,
        allowedRunStatuses: ['publish_failed'],
        retryDelaysMs: actionOpts?.retryDelaysMs ?? opts?.retryDelaysMs,
        dtimeUnixSec: actionOpts?.dtimeUnixSec,
      });
    },

    /** 人工确认上传中断且状态不明期次的真实平台状态 */
    async confirmUncertain(
      runId: string,
      result: { published: false } | { published: true; bvid: string },
    ): Promise<void> {
      assertPipelineLockAvailable(ctx);
      const nowIso = ctx.now().toISOString();

      if (!result.published) {
        const deadlineIso = new Date(
          ctx.now().getTime() + ctx.settings.retry.reservationHoldHours * 3600_000,
        ).toISOString();
        inTransaction(ctx.db, () => {
          const run = ctx.repos.runs.getById(runId);
          if (!run) {
            throw new Error(`未找到任务记录: ${runId}`);
          }
          if (run.status !== 'publish_uncertain') {
            throw new Error(
              `任务 ${runId} 当前状态为 ${run.status}，仅 publish_uncertain 支持人工确认`,
            );
          }

          const pub = ctx.repos.publish.getByRun(runId);
          if (pub) {
            ctx.repos.publish.updateStatus(runId, 'failed', {
              error: '经人工核实尚未在 B 站发布成功，可重新发起投稿重试',
              updatedAt: nowIso,
            });
          }
          ctx.repos.runs.updateStatus(runId, 'publish_failed', {
            currentStage: 'publish',
            errorCode: 'publish_failed',
            error: '经人工核实平台尚未收稿，可安全重试发布',
            pid: null,
            retryDeadlineAt: deadlineIso,
          });
          emitRunEvent(ctx, {
            runId,
            level: 'info',
            stage: 'publish',
            type: 'publish_uncertain_resolved',
            message: '人工确认平台未收稿，已重置为可重试发布状态',
            data: { published: false },
          });
        });
        return;
      }

      const validBvid = normalizeBvid(result.bvid);
      const stats = commitRunConsumption(
        ctx,
        runId,
        nowIso,
        () => {
          const pub = ctx.repos.publish.getByRun(runId);
          if (!pub) {
            ctx.repos.publish.upsertDraft({
              runId,
              title: `第 ${runId} 期`,
              description: ctx.settings.publish.bilibili.aiDisclaimerText,
              tags: ctx.settings.publish.bilibili.defaultTags,
              updatedAt: nowIso,
            });
          }
          ctx.repos.publish.updateStatus(runId, 'published', {
            bvid: validBvid,
            error: null,
            updatedAt: nowIso,
          });
          ctx.repos.runs.updateStatus(runId, 'published', {
            currentStage: 'publish',
            pid: null,
            finishedAt: nowIso,
            errorCode: null,
            error: null,
            retryDeadlineAt: null,
          });
        },
        { expectedRunStatuses: ['publish_uncertain'] },
      );

      emitRunEvent(ctx, {
        runId,
        level: 'info',
        stage: 'publish',
        type: 'run_published',
        message: `人工确认平台已收稿（${validBvid}），已提交 ${stats.consumedArticleCount} 篇已播新闻并释放 ${stats.releasedUnusedCount} 篇备用文章`,
        data: { bvid: validBvid, ...stats, manualConfirmed: true },
      });
      try {
        await ctx.notifier.notify({
          type: 'published',
          runId,
          message: `第 ${runId} 期经人工确认已成功发布（${validBvid}）`,
          data: { bvid: validBvid, manualConfirmed: true },
        });
      } catch (notifyErr) {
        ctx.logger.warn({ err: notifyErr, runId, bvid: validBvid }, '发送人工确认发布通知时出错');
      }
    },

    /** 驳回本期内容，立即释放已占用的新闻文章回到待选库 */
    async reject(runId: string, reason?: string): Promise<void> {
      assertPipelineLockAvailable(ctx);
      const nowIso = ctx.now().toISOString();
      const deadlineIso = new Date(
        ctx.now().getTime() + ctx.settings.retry.reservationHoldHours * 3600_000,
      ).toISOString();
      const rejectMsg = reason?.trim() || '人工审核未通过，已驳回本期内容';

      inTransaction(ctx.db, () => {
        const run = ctx.repos.runs.getById(runId);
        if (!run) {
          throw new Error(`未找到任务记录: ${runId}`);
        }
        if (run.status !== 'awaiting_review' && run.status !== 'publish_failed') {
          throw new Error(`任务 ${runId} 当前状态为 ${run.status}，不允许执行驳回操作`);
        }

        const released = ctx.repos.articles.releaseByRun(runId);
        ctx.repos.runs.updateStatus(runId, 'rejected', {
          currentStage: 'review',
          error: rejectMsg,
          pid: null,
          finishedAt: nowIso,
          retryDeadlineAt: deadlineIso,
        });
        emitRunEvent(ctx, {
          runId,
          level: 'warn',
          stage: 'review',
          type: 'run_rejected',
          message: `${rejectMsg}（已释放 ${released} 篇占用新闻回到候选库）`,
          data: { reason: rejectMsg, releasedArticles: released },
        });
      });
    },

    /** 跳过外网发布，直接把本期新闻计入历史已播库 */
    async markConsumed(runId: string): Promise<void> {
      assertPipelineLockAvailable(ctx);
      const runBefore = ctx.repos.runs.getById(runId);
      if (!runBefore) {
        throw new Error(`未找到任务记录: ${runId}`);
      }
      if (runBefore.status !== 'awaiting_review' && runBefore.status !== 'publish_failed') {
        throw new Error(`任务 ${runId} 当前状态为 ${runBefore.status}，不能标记为仅已消费完结`);
      }

      await ensurePublishDraftForRun(ctx, runId, ctx.settings);
      const nowIso = ctx.now().toISOString();

      const stats = commitRunConsumption(
        ctx,
        runId,
        nowIso,
        () => {
          const pub = ctx.repos.publish.getByRun(runId);
          if (!pub) {
            ctx.repos.publish.upsertDraft({
              runId,
              title: `第 ${runId} 期（仅本地完结）`,
              description: ctx.settings.publish.bilibili.aiDisclaimerText,
              tags: ctx.settings.publish.bilibili.defaultTags,
              updatedAt: nowIso,
            });
          }
          ctx.repos.publish.updateStatus(runId, 'consumed_only', {
            error: null,
            updatedAt: nowIso,
          });
          ctx.repos.runs.updateStatus(runId, 'published', {
            currentStage: 'publish',
            pid: null,
            finishedAt: nowIso,
            errorCode: null,
            error: null,
            retryDeadlineAt: null,
          });
        },
        { expectedRunStatuses: ['awaiting_review', 'publish_failed'] },
      );

      emitRunEvent(ctx, {
        runId,
        level: 'info',
        stage: 'publish',
        type: 'run_consumed_only',
        message: `已跳过平台上传，提交 ${stats.consumedArticleCount} 篇已播新闻并释放 ${stats.releasedUnusedCount} 篇未用新闻`,
        data: stats,
      });
    },

    /** 查询最近已播出新闻事件历史记录 */
    async listHistory(limit = 100): Promise<PublishedHistoryRecord[]> {
      return ctx.repos.history.listAll(limit);
    },

    /** 返回供 CLI 执行交互式 B 站扫码登录的命令结构 */
    biliLoginCommand(): { bin: string; args: string[] } {
      return buildBiliLoginCommand(ctx, ctx.settings);
    },

    /** 读取本期当前生效的封面文字与封面图片状态 */
    async getCover(runId: string): Promise<CoverState> {
      if (!ctx.repos.runs.getById(runId)) {
        throw new Error(`未找到任务记录: ${runId}`);
      }
      const state = await readCoverState(ctx, runId);
      if (!state) {
        throw new Error(`任务 ${runId} 尚未完成整期编排，暂无封面文字`);
      }
      return state;
    },

    /** 修改封面文字并只重新生成封面图片（不重新合成视频） */
    async updateCover(runId: string, patch: CoverTextPatch): Promise<CoverState> {
      const run = ctx.repos.runs.getById(runId);
      if (!run) {
        throw new Error(`未找到任务记录: ${runId}`);
      }
      if (!COVER_EDITABLE_STATUSES.has(run.status)) {
        throw new Error(
          `任务 ${runId} 当前状态为 ${run.status}，只有待审核、投稿失败或已发布的任务可以修改封面`,
        );
      }
      const current = await readCoverState(ctx, runId);
      if (!current) {
        throw new Error(`任务 ${runId} 尚未完成整期编排，无法修改封面`);
      }
      const next = normalizeCoverText({
        title: patch.title ?? current.text.title,
        subtitle: patch.subtitle ?? current.text.subtitle,
      });
      const errors = checkCoverText(next);
      if (errors.length > 0) {
        throw new Error(errors.join('；'));
      }
      if (!ctx.settings.template.cover) {
        throw new Error('尚未配置封面模板目录（template.cover.dir），无法重新生成封面');
      }

      acquirePipelineLock(ctx, runId, ctx.settings);
      try {
        const { warnings } = await renderCoverImage({
          ctx,
          runId,
          settings: ctx.settings,
          text: next,
          outJpg: path.join(ctx.paths.runDir(runId), COVER_IMAGE_REL_PATH),
        });
        await saveCoverText(ctx, runId, next);
        emitRunEvent(ctx, {
          runId,
          level: warnings.length > 0 ? 'warn' : 'info',
          stage: 'publish',
          type: 'cover_updated',
          message:
            warnings.length > 0
              ? `封面文字已修改并重新生成封面，排版提醒：${warnings.join('；')}`
              : '封面文字已修改并重新生成封面',
          data: next,
        });
      } finally {
        releasePipelineLock(ctx, runId);
      }

      const state = await readCoverState(ctx, runId);
      if (!state) {
        throw new Error(`任务 ${runId} 封面状态读取失败`);
      }
      return state;
    },
  };
}
