'use server';

import {
  type AiChannel,
  AiChannelSchema,
  AiStageModeSchema,
  AiStageNameSchema,
  type ArticleDetail,
  type DeleteArticlesInput,
  DeleteArticlesInputSchema,
  type DeleteArticlesResult,
  type DeleteRunsInput,
  DeleteRunsInputSchema,
  type DeleteRunsResult,
  type DoctorReport,
  HostMascotIdSchema,
  MarkArticlesUnplayedInputSchema,
  type MarkArticlesUnplayedResult,
  type MarkHistoryUnplayedResult,
  PIPELINE_STAGES,
  type ScheduleCutoffMode,
  ScheduleCutoffModeSchema,
  ScheduleTimeSchema,
  type SourceTestResult,
  StageSchema,
} from '@aidaily/contracts';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { getCore } from '@/lib/core';
import { formatBytes, STAGE_LABELS } from '@/lib/format';

/** 网页端提交操作后的统一响应结构 */
export interface ActionResult<T = undefined> {
  ok: boolean;
  message?: string;
  error?: string;
  data?: T;
}

const RunIdSchema = z.string().trim().min(1, '任务 ID 不能为空');
const ItemIdSchema = z.string().trim().min(1, '条目 ID 不能为空');
const EditStepSchema = z.enum(['summarize', 'polish', 'factcheck']);

/** 安全解析正整数表单字段（禁止空白与非正整数，不回退默认值） */
function parseRequiredPositiveInt(raw: FormDataEntryValue | null, label: string): number {
  const str = typeof raw === 'string' ? raw.trim() : '';
  if (!str) {
    throw new Error(`请显式填写${label}（正整数，不设默认值）`);
  }
  if (!/^[1-9]\d*$/.test(str)) {
    throw new Error(`${label}必须为大于 0 的整数`);
  }
  const num = Number.parseInt(str, 10);
  if (!Number.isSafeInteger(num) || num <= 0 || String(num) !== str) {
    throw new Error(`${label}超出有效正整数范围`);
  }
  return num;
}

/** 从表单条目读取必填非空字符串 */
function parseRequiredString(raw: FormDataEntryValue | null, label: string): string {
  const str = typeof raw === 'string' ? raw.trim() : '';
  if (!str) {
    throw new Error(`${label}不能为空`);
  }
  return str;
}

/** 严格解析必填整数表单字段，拒绝空白、小数或超出安全整数范围的输入 */
function parseRequiredIntField(raw: FormDataEntryValue | null, label: string): number {
  const str = typeof raw === 'string' ? raw.trim() : '';
  if (!str) {
    throw new Error(`${label}不能为空`);
  }
  if (!/^-?(?:0|[1-9]\d*)$/.test(str)) {
    throw new Error(`${label}必须为标准整数`);
  }
  const num = Number.parseInt(str, 10);
  if (!Number.isSafeInteger(num) || String(num) !== str) {
    throw new Error(`${label}超出安全整数范围`);
  }
  return num;
}

/** 严格解析必填十进制数值表单字段，防止空白被转成 0 或科学计数法失真 */
function parseRequiredNumberField(raw: FormDataEntryValue | null, label: string): number {
  const str = typeof raw === 'string' ? raw.trim() : '';
  if (!str) {
    throw new Error(`${label}不能为空`);
  }
  if (!/^-?\d+(?:\.\d+)?$/.test(str)) {
    throw new Error(`${label}必须为有效十进制数字`);
  }
  const num = Number(str);
  if (!Number.isFinite(num)) {
    throw new Error(`${label}超出有效数值范围`);
  }
  return num;
}

/** 从表单条目读取布尔开关值 */
function parseBooleanField(raw: FormDataEntryValue | null): boolean {
  if (typeof raw !== 'string') {
    return false;
  }
  return raw === 'true' || raw === 'on' || raw === '1';
}

/** 在 Next.js 请求上下文中刷新指定页面缓存；测试环境无请求上下文时静默跳过 */
function safeRevalidate(pathTarget: string): void {
  try {
    revalidatePath(pathTarget);
  } catch {
    // 直接单元测试调用时不存在 Next.js 页面缓存上下文
  }
}

/** 启动新一期视频生成任务（后台工作进程模式，必须显式填写正整数条数） */
export async function startRunAction(formData: FormData): Promise<ActionResult<{ runId: string }>> {
  try {
    const itemCount = parseRequiredPositiveInt(formData.get('itemCount'), '本期新闻条数');
    const hostValue = String(formData.get('hostId') ?? '').trim();
    const bgmFile = String(formData.get('bgmFile') ?? '').trim();
    const rawPreset = String(formData.get('notBeforePreset') ?? '').trim();
    const rawCustom = String(formData.get('notBeforeAt') ?? '').trim();
    let notBeforeAt: string | undefined;
    if (rawPreset === 'custom') {
      if (!rawCustom) {
        throw new Error('选择自定义最早时间时，请填写具体日期时间');
      }
      notBeforeAt = rawCustom;
    } else if (rawCustom) {
      notBeforeAt = rawCustom;
    } else if (rawPreset && rawPreset !== 'none') {
      notBeforeAt = rawPreset;
    }

    const hostId = hostValue ? HostMascotIdSchema.parse(hostValue) : undefined;
    const core = await getCore();
    const { runId } = await core.tasks.start({
      itemCount,
      notBeforeAt,
      hostId,
      bgmFile: bgmFile || undefined,
      trigger: 'manual-web',
      detach: true,
    });
    safeRevalidate('/');
    safeRevalidate('/runs');
    safeRevalidate(`/runs/${runId}`);
    return { ok: true, data: { runId }, message: `已创建并在后台启动第 ${runId} 期任务` };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** 恢复中断任务或从指定阶段重跑（自动归档之后作废产物，在后台进程执行） */
export async function resumeRunAction(formData: FormData): Promise<ActionResult> {
  try {
    const runId = RunIdSchema.parse(formData.get('runId'));
    const rawFrom = formData.get('fromStage');
    const fromStr = typeof rawFrom === 'string' ? rawFrom.trim() : '';
    let fromStage: (typeof PIPELINE_STAGES)[number] | undefined;
    if (fromStr) {
      const parsed = StageSchema.parse(fromStr);
      if (!(PIPELINE_STAGES as readonly string[]).includes(parsed)) {
        throw new Error(`阶段 ${parsed} 不支持直接从该处重跑`);
      }
      fromStage = parsed as (typeof PIPELINE_STAGES)[number];
    }
    const useLatestRaw = formData.get('useLatestConfig');
    const useLatestConfig = useLatestRaw === null ? true : parseBooleanField(useLatestRaw);

    const core = await getCore();
    await core.tasks.resume(runId, {
      fromStage,
      useLatestConfig,
      detach: true,
    });
    safeRevalidate('/');
    safeRevalidate('/runs');
    safeRevalidate(`/runs/${runId}`);
    return {
      ok: true,
      message: fromStage ? `已从「${STAGE_LABELS[fromStage]}」开始重跑` : '已从中断处继续执行',
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** 单独或批量并发重做指定新闻条目，并在完成后自动重新编排与合成成片（后台进程执行） */
export async function retryItemsAction(formData: FormData): Promise<ActionResult> {
  try {
    const runId = RunIdSchema.parse(formData.get('runId'));
    const rawItemIds = formData
      .getAll('itemIds')
      .map((val) => (typeof val === 'string' ? val.trim() : ''))
      .filter(Boolean);
    const singleFallback = formData.get('itemId');
    if (
      rawItemIds.length === 0 &&
      typeof singleFallback === 'string' &&
      singleFallback.trim().length > 0
    ) {
      rawItemIds.push(singleFallback.trim());
    }
    const itemIds = z.array(ItemIdSchema).min(1, '请至少选择一条需要重做的新闻').parse(rawItemIds);
    const rawStep = formData.get('fromStep');
    const fromStep =
      typeof rawStep === 'string' && rawStep.trim()
        ? EditStepSchema.parse(rawStep.trim())
        : 'summarize';
    const useLatestRaw = formData.get('useLatestConfig');
    const useLatestConfig = useLatestRaw === null ? true : parseBooleanField(useLatestRaw);

    const core = await getCore();
    await core.tasks.retryItems(runId, itemIds, {
      fromStep,
      useLatestConfig,
      detach: true,
    });
    safeRevalidate(`/runs/${runId}`);
    return {
      ok: true,
      message:
        itemIds.length === 1
          ? '已开始重做这条新闻'
          : `已启动并发重做选中的 ${itemIds.length} 条新闻`,
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** 单独重做指定新闻条目并自动触发后续编排与视频合成（后台进程执行） */
export async function retryItemAction(formData: FormData): Promise<ActionResult> {
  return retryItemsAction(formData);
}

/** 放弃未发布或中断任务并释放已占用的新闻文章 */
export async function abandonRunAction(formData: FormData): Promise<ActionResult> {
  try {
    const runId = RunIdSchema.parse(formData.get('runId'));
    const core = await getCore();
    await core.tasks.abandon(runId);
    safeRevalidate('/');
    safeRevalidate('/runs');
    safeRevalidate(`/runs/${runId}`);
    return { ok: true, message: `已放弃任务 ${runId} 并释放占用的新闻` };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** 发出安全停止请求取消正在运行的任务 */
export async function cancelRunAction(formData: FormData): Promise<ActionResult> {
  try {
    const runId = RunIdSchema.parse(formData.get('runId'));
    const core = await getCore();
    await core.tasks.cancel(runId);
    safeRevalidate('/');
    safeRevalidate('/runs');
    safeRevalidate(`/runs/${runId}`);
    return { ok: true, message: `已向任务 ${runId} 发送取消请求` };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** 保存人工编辑后的视频标题、简介和标签草稿 */
export async function updateDraftAction(formData: FormData): Promise<ActionResult> {
  try {
    const runId = RunIdSchema.parse(formData.get('runId'));
    const title = parseRequiredString(formData.get('title'), '视频标题');
    const description = parseRequiredString(formData.get('description'), '视频简介');
    const tagsRaw = parseRequiredString(formData.get('tags'), '视频标签');
    const tags = tagsRaw
      .split(/[,，\n]/)
      .map((t) => t.trim())
      .filter(Boolean);

    const core = await getCore();
    await core.publish.updateDraft(runId, { title, description, tags });
    safeRevalidate(`/runs/${runId}`);
    return { ok: true, message: '投稿文案草稿已保存' };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** 修改封面主标题与副标题，并只重新生成封面图片 */
export async function updateCoverAction(formData: FormData): Promise<ActionResult> {
  try {
    const runId = RunIdSchema.parse(formData.get('runId'));
    const title = parseRequiredString(formData.get('title'), '封面主标题');
    const rawSubtitle = formData.get('subtitle');
    const subtitle = typeof rawSubtitle === 'string' ? rawSubtitle.trim() : '';
    const core = await getCore();
    await core.publish.updateCover(runId, { title, subtitle });
    safeRevalidate(`/runs/${runId}`);
    return { ok: true, message: '封面文字已保存，封面图片已重新生成' };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** 审核通过并启动后台 B 站投稿上传（强制开启 AI 生成内容声明） */
export async function approvePublishAction(formData: FormData): Promise<ActionResult> {
  try {
    const runId = RunIdSchema.parse(formData.get('runId'));
    const core = await getCore();
    await core.publish.approve(runId, { detach: true });
    safeRevalidate('/');
    safeRevalidate('/runs');
    safeRevalidate(`/runs/${runId}`);
    return { ok: true, message: '已确认通过审核并在后台启动 B 站投稿' };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** 投稿明确失败后在后台重新发起 B 站上传 */
export async function retryPublishAction(formData: FormData): Promise<ActionResult> {
  try {
    const runId = RunIdSchema.parse(formData.get('runId'));
    const core = await getCore();
    await core.publish.retry(runId, { detach: true });
    safeRevalidate('/');
    safeRevalidate('/runs');
    safeRevalidate(`/runs/${runId}`);
    return { ok: true, message: '已在后台重新发起 B 站投稿上传' };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** 对上传失联后处于状态待确认的任务执行人工核实定案 */
export async function confirmUncertainAction(formData: FormData): Promise<ActionResult> {
  try {
    const runId = RunIdSchema.parse(formData.get('runId'));
    const outcome = z.enum(['published', 'not_published']).parse(formData.get('outcome'));
    const core = await getCore();
    if (outcome === 'not_published') {
      await core.publish.confirmUncertain(runId, { published: false });
      safeRevalidate('/');
      safeRevalidate('/runs');
      safeRevalidate(`/runs/${runId}`);
      return { ok: true, message: '已确认平台未收稿，现可发起安全重试' };
    }
    const bvid = parseRequiredString(formData.get('bvid'), 'B 站 BV 号');
    await core.publish.confirmUncertain(runId, { published: true, bvid });
    safeRevalidate('/');
    safeRevalidate('/runs');
    safeRevalidate('/history');
    safeRevalidate(`/runs/${runId}`);
    return { ok: true, message: `已确认稿件已发布（${bvid}）并完成已播提交` };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** 驳回待审视频并立即释放其预留的新闻文章 */
export async function rejectPublishAction(formData: FormData): Promise<ActionResult> {
  try {
    const runId = RunIdSchema.parse(formData.get('runId'));
    const reasonRaw = formData.get('reason');
    const reason = typeof reasonRaw === 'string' && reasonRaw.trim() ? reasonRaw.trim() : undefined;
    const core = await getCore();
    await core.publish.reject(runId, reason);
    safeRevalidate('/');
    safeRevalidate('/runs');
    safeRevalidate(`/runs/${runId}`);
    return { ok: true, message: '已驳回本期视频并释放占用的新闻文章' };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** 审核通过但不上传视频，直接将本期选用新闻归入历史已播库 */
export async function markConsumedAction(formData: FormData): Promise<ActionResult> {
  try {
    const runId = RunIdSchema.parse(formData.get('runId'));
    const core = await getCore();
    await core.publish.markConsumed(runId);
    safeRevalidate('/');
    safeRevalidate('/runs');
    safeRevalidate('/history');
    safeRevalidate('/articles');
    safeRevalidate(`/runs/${runId}`);
    return { ok: true, message: '已审核通过（不上传视频），本期新闻已记入已播历史' };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** 新建每日定时执行任务（必须显式填写每日时间与新闻条数，不设默认值） */
export async function createScheduleAction(formData: FormData): Promise<ActionResult> {
  try {
    const timeRaw = parseRequiredString(formData.get('time'), '每日执行时间');
    const time = ScheduleTimeSchema.parse(timeRaw);
    const itemCount = parseRequiredPositiveInt(formData.get('itemCount'), '每期新闻条数');
    const nameRaw = formData.get('name');
    const name = typeof nameRaw === 'string' && nameRaw.trim() ? nameRaw.trim() : undefined;
    const enabled = formData.has('enabled') ? parseBooleanField(formData.get('enabled')) : true;
    const rawCutoff = String(formData.get('cutoffMode') ?? '').trim();
    const cutoffMode: ScheduleCutoffMode = rawCutoff
      ? ScheduleCutoffModeSchema.parse(rawCutoff)
      : 'none';
    const maxAgeHours =
      cutoffMode === 'hours'
        ? parseRequiredPositiveInt(formData.get('maxAgeHours'), '回溯小时数')
        : undefined;

    const core = await getCore();
    const bgmFile = String(formData.get('bgmFile') ?? '').trim();
    const job = await core.scheduler.create({
      name,
      time,
      itemCount,
      cutoffMode,
      maxAgeHours,
      enabled,
      bgmFile: bgmFile || undefined,
    });
    safeRevalidate('/');
    safeRevalidate('/schedules');
    return { ok: true, message: `已创建并同步定时任务「${job.name}」（每日 ${job.time}）` };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** 更新定时任务配置或启停状态，并同步更新系统调度代理 */
export async function updateScheduleAction(formData: FormData): Promise<ActionResult> {
  try {
    const id = parseRequiredString(formData.get('id'), '定时任务 ID');
    const patch: {
      name?: string;
      time?: string;
      itemCount?: number;
      cutoffMode?: ScheduleCutoffMode;
      maxAgeHours?: number | null;
      bgmFile?: string | null;
      enabled?: boolean;
    } = {};

    const nameRaw = formData.get('name');
    if (typeof nameRaw === 'string' && nameRaw.trim()) {
      patch.name = nameRaw.trim();
    }
    const timeRaw = formData.get('time');
    if (typeof timeRaw === 'string' && timeRaw.trim()) {
      patch.time = ScheduleTimeSchema.parse(timeRaw.trim());
    }
    const cutoffRaw = formData.get('cutoffMode');
    if (typeof cutoffRaw === 'string' && cutoffRaw.trim()) {
      patch.cutoffMode = ScheduleCutoffModeSchema.parse(cutoffRaw.trim());
    }
    if (patch.cutoffMode === 'hours') {
      patch.maxAgeHours = parseRequiredPositiveInt(formData.get('maxAgeHours'), '回溯小时数');
    } else if (patch.cutoffMode !== undefined) {
      patch.maxAgeHours = null;
    } else if (
      typeof formData.get('maxAgeHours') === 'string' &&
      String(formData.get('maxAgeHours')).trim()
    ) {
      patch.maxAgeHours = parseRequiredPositiveInt(formData.get('maxAgeHours'), '回溯小时数');
    }
    const bgmRaw = formData.get('bgmFile');
    if (typeof bgmRaw === 'string') patch.bgmFile = bgmRaw.trim() || null;

    const itemsRaw = formData.get('itemCount');
    if (typeof itemsRaw === 'string' && itemsRaw.trim()) {
      patch.itemCount = parseRequiredPositiveInt(itemsRaw, '每期新闻条数');
    }
    if (formData.has('enabled')) {
      patch.enabled = parseBooleanField(formData.get('enabled'));
    }

    const core = await getCore();
    const updated = await core.scheduler.update(id, patch);
    safeRevalidate('/');
    safeRevalidate('/schedules');
    return { ok: true, message: `已更新定时任务「${updated.name}」` };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** 删除指定定时任务并从系统调度器卸载 */
export async function removeScheduleAction(formData: FormData): Promise<ActionResult> {
  try {
    const id = parseRequiredString(formData.get('id'), '定时任务 ID');
    const core = await getCore();
    await core.scheduler.remove(id);
    safeRevalidate('/');
    safeRevalidate('/schedules');
    return { ok: true, message: '已删除定时任务并清理系统调度配置' };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** 将数据库中的全部定时任务全量重同步到系统调度器 */
export async function syncSchedulesAction(): Promise<ActionResult> {
  try {
    const core = await getCore();
    await core.scheduler.sync();
    safeRevalidate('/');
    safeRevalidate('/schedules');
    return { ok: true, message: '已全量重同步全部定时任务到 launchd' };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

const StageFieldPatchSchema = z.object({
  mode: AiStageModeSchema.optional(),
  cli: z.string().trim().min(1),
  model: z.string().trim().min(1),
  timeoutSec: z.number().int().positive(),
  retries: z.number().int().min(0),
});

/** 将网页提交的 API 连接和密钥交给配置服务保存 */
export async function saveModelApiConnectionAction(formData: FormData): Promise<ActionResult> {
  try {
    const core = await getCore();
    const apiKey = formData.get('apiKey');
    await core.config.saveModelApiConnection({
      previousName: formData.get('previousName') ?? undefined,
      name: formData.get('name'),
      baseUrl: formData.get('baseUrl'),
      protocol: formData.get('protocol'),
      jsonMode: formData.get('jsonMode') ?? undefined,
      apiKey: typeof apiKey === 'string' && !apiKey.trim() ? undefined : (apiKey ?? undefined),
      clearApiKey: parseBooleanField(formData.get('clearApiKey')),
    });
    safeRevalidate('/settings');
    return { ok: true, message: 'API 连接已保存' };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : '保存 API 连接失败' };
  }
}

/** 删除未被阶段使用的 API 连接 */
export async function removeModelApiConnectionAction(formData: FormData): Promise<ActionResult> {
  try {
    const name = z.string().min(1, '请指定要删除的 API 连接').parse(formData.get('name'));
    const core = await getCore();
    await core.config.removeModelApiConnection(name);
    safeRevalidate('/settings');
    return { ok: true, message: 'API 连接已删除' };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : '删除 API 连接失败' };
  }
}

/** 更新各阶段的调用方式、模型配置与全局 AI 渠道优先级集合 */
export async function updateStageRoutingAction(formData: FormData): Promise<ActionResult> {
  try {
    const rawChannelsJson = formData.get('channelsJson');
    let channels: AiChannel[] | undefined;
    if (typeof rawChannelsJson === 'string' && rawChannelsJson.trim().length > 0) {
      channels = z.array(AiChannelSchema).parse(JSON.parse(rawChannelsJson));
    }
    const primaryPoolChannel = channels?.find((ch) => ch.enabled !== false);

    const stageEntries = AiStageNameSchema.options.map((key) => {
      const rawMode = formData.get(`stage_${key}_mode`);
      const mode =
        typeof rawMode === 'string' && rawMode.trim()
          ? AiStageModeSchema.parse(rawMode.trim())
          : channels === undefined
            ? ('custom' as const)
            : undefined;
      const rawCli = formData.get(`stage_${key}_cli`);
      const rawModel = formData.get(`stage_${key}_model`);
      const rawRetries = formData.get(`stage_${key}_retries`);
      const usePoolFallback = mode === 'pool' && primaryPoolChannel !== undefined;
      return [
        key,
        {
          ...(mode ? { mode } : {}),
          cli:
            usePoolFallback && (!rawCli || !String(rawCli).trim())
              ? primaryPoolChannel.cli
              : rawCli,
          model:
            usePoolFallback && (!rawModel || !String(rawModel).trim())
              ? primaryPoolChannel.model
              : rawModel,
          timeoutSec: parseRequiredIntField(
            formData.get(`stage_${key}_timeoutSec`),
            `${key} 阶段超时时间`,
          ),
          retries:
            usePoolFallback && (!rawRetries || !String(rawRetries).trim())
              ? primaryPoolChannel.retries
              : parseRequiredIntField(rawRetries, `${key} 阶段重试次数`),
        },
      ];
    });
    const stages = z
      .record(AiStageNameSchema, StageFieldPatchSchema)
      .parse(Object.fromEntries(stageEntries));
    const maxConcurrentCalls = z
      .number()
      .int()
      .min(1)
      .max(20)
      .parse(parseRequiredIntField(formData.get('maxConcurrentCalls'), '最大并发模型调用数'));

    const core = await getCore();
    await core.config.updateStageRouting({
      maxConcurrentCalls,
      ...(channels !== undefined ? { channels } : {}),
      stages,
    });
    safeRevalidate('/');
    safeRevalidate('/settings');
    safeRevalidate('/runs');
    return { ok: true, message: 'AI 渠道池与各阶段配置已保存，已即时生效' };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** 校验时区标识是否可被标准时间格式库识别 */
function assertValidTimezone(timezone: string): void {
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: timezone });
  } catch {
    throw new Error(`无效的时区标识: ${timezone}`);
  }
}

/** 保存选题补抓、模板渲染以及 B 站发布参数配置（强制保留 AI 声明开启状态） */
export async function updateWorkflowSettingsAction(formData: FormData): Promise<ActionResult> {
  try {
    const rawTtsProvider = formData.get('ttsProvider');
    const rawTtsGuestProvider = formData.get('ttsGuestProvider');
    const rawRenderTheme = formData.get('renderTheme');
    const rawRenderLive2dPack = formData.get('renderLive2dPack');
    const rawBgmVolumeDb = formData.get('bgmVolumeDb');
    const parsed = z
      .object({
        timezone: z.string().trim().min(1),
        freshnessHours: z.number().int().positive(),
        itemConcurrency: z.number().int().min(1).max(20),
        maxRounds: z.number().int().min(0).max(10),
        useBackupSources: z.boolean(),
        lookbackStepHours: z.number().int().positive(),
        maxLookbackHours: z.number().int().positive(),
        reservationHoldHours: z.number().int().positive(),
        maxRevisions: z.number().int().min(0).max(5),
        ttsProvider: z.string().trim().min(1).optional(),
        ttsGuestProvider: z.string().trim().optional(),
        pauseAfterNarrate: z.boolean(),
        activeTemplate: z.string().trim().min(1),
        renderTheme: z.enum(['light', 'dark']).optional(),
        renderLive2dPack: z.enum(['fullbody', 'expression']).optional(),
        pagePaddingSec: z.number().nonnegative(),
        bgmVolumeDb: z.number().min(-30).max(0).optional(),
        publishMode: z.enum(['manual-review', 'auto']),
        bilibiliTid: z.number().int().nonnegative(),
        titleMax: z.number().int().positive(),
        descMax: z.number().int().positive(),
        tagsMax: z.number().int().positive(),
        defaultTags: z.string(),
        aiDisclaimerText: z.string().trim().min(1),
      })
      .parse({
        timezone: formData.get('timezone'),
        freshnessHours: parseRequiredIntField(formData.get('freshnessHours'), '新闻新鲜度窗口'),
        itemConcurrency: parseRequiredIntField(
          formData.get('itemConcurrency'),
          '同时处理新闻并发数',
        ),
        maxRounds: parseRequiredIntField(formData.get('maxRounds'), '最大补抓替补轮数'),
        useBackupSources: parseBooleanField(formData.get('useBackupSources')),
        lookbackStepHours: parseRequiredIntField(formData.get('lookbackStepHours'), '回溯步长'),
        maxLookbackHours: parseRequiredIntField(formData.get('maxLookbackHours'), '最大回溯上限'),
        reservationHoldHours: parseRequiredIntField(
          formData.get('reservationHoldHours'),
          '文章锁定保留小时数',
        ),
        maxRevisions: parseRequiredIntField(formData.get('maxRevisions'), '单条最大核查打回次数'),
        ...(typeof rawTtsProvider === 'string' && rawTtsProvider.trim()
          ? { ttsProvider: rawTtsProvider.trim() }
          : {}),
        ...(typeof rawTtsGuestProvider === 'string'
          ? { ttsGuestProvider: rawTtsGuestProvider.trim() }
          : {}),
        pauseAfterNarrate: parseBooleanField(formData.get('pauseAfterNarrate')),
        activeTemplate: formData.get('activeTemplate'),
        ...(typeof rawRenderTheme === 'string' && rawRenderTheme.trim()
          ? { renderTheme: rawRenderTheme.trim() }
          : {}),
        ...(typeof rawRenderLive2dPack === 'string' && rawRenderLive2dPack.trim()
          ? { renderLive2dPack: rawRenderLive2dPack.trim() }
          : {}),
        pagePaddingSec: parseRequiredNumberField(
          formData.get('pagePaddingSec'),
          '翻页停顿缓冲秒数',
        ),
        ...(typeof rawBgmVolumeDb === 'string' && rawBgmVolumeDb.trim()
          ? { bgmVolumeDb: parseRequiredNumberField(rawBgmVolumeDb, '背景音乐音量') }
          : {}),
        publishMode: formData.get('publishMode'),
        bilibiliTid: parseRequiredIntField(formData.get('bilibiliTid'), 'B 站分区编号'),
        titleMax: parseRequiredIntField(formData.get('titleMax'), '标题最大字数'),
        descMax: parseRequiredIntField(formData.get('descMax'), '简介最大字数'),
        tagsMax: parseRequiredIntField(formData.get('tagsMax'), '标签最多个数'),
        defaultTags: String(formData.get('defaultTags') ?? ''),
        aiDisclaimerText: formData.get('aiDisclaimerText'),
      });

    assertValidTimezone(parsed.timezone);

    const tagList = Array.from(
      new Set(
        parsed.defaultTags
          .split(/[,，]/)
          .map((t) => t.trim())
          .filter(Boolean),
      ),
    );

    const core = await getCore();
    const currentSettings = core.config.getSettings();
    if (
      parsed.ttsProvider !== undefined &&
      !Object.hasOwn(currentSettings.tts.providers, parsed.ttsProvider)
    ) {
      throw new Error(`未配置语音合成引擎: ${parsed.ttsProvider}`);
    }
    if (
      parsed.ttsGuestProvider !== undefined &&
      parsed.ttsGuestProvider !== '' &&
      !Object.hasOwn(currentSettings.tts.providers, parsed.ttsGuestProvider)
    ) {
      throw new Error(`未配置嘉宾吐槽语音合成引擎: ${parsed.ttsGuestProvider}`);
    }
    if (!Object.hasOwn(currentSettings.template.registry, parsed.activeTemplate)) {
      throw new Error(`未在模板注册表中配置模板: ${parsed.activeTemplate}`);
    }
    await core.config.updateSettings({
      timezone: parsed.timezone,
      issue: {
        freshnessHours: parsed.freshnessHours,
        itemConcurrency: parsed.itemConcurrency,
        refill: {
          maxRounds: parsed.maxRounds,
          useBackupSources: parsed.useBackupSources,
          lookbackStepHours: parsed.lookbackStepHours,
          maxLookbackHours: parsed.maxLookbackHours,
        },
      },
      retry: {
        reservationHoldHours: parsed.reservationHoldHours,
      },
      editorial: {
        maxRevisions: parsed.maxRevisions,
      },
      tts: {
        ...(parsed.ttsProvider !== undefined ? { provider: parsed.ttsProvider } : {}),
        ...(parsed.ttsGuestProvider !== undefined
          ? { guestProvider: parsed.ttsGuestProvider }
          : {}),
        pauseAfterNarrate: parsed.pauseAfterNarrate,
      },
      template: {
        active: parsed.activeTemplate,
      },
      render: {
        ...(parsed.renderTheme !== undefined ? { theme: parsed.renderTheme } : {}),
        ...(parsed.renderLive2dPack !== undefined ? { live2dPack: parsed.renderLive2dPack } : {}),
        pagePaddingSec: parsed.pagePaddingSec,
        ...(parsed.bgmVolumeDb !== undefined ? { bgm: { volumeDb: parsed.bgmVolumeDb } } : {}),
      },
      publish: {
        mode: parsed.publishMode,
        bilibili: {
          tid: parsed.bilibiliTid,
          titleMax: parsed.titleMax,
          descMax: parsed.descMax,
          tagsMax: parsed.tagsMax,
          defaultTags: tagList,
          aiDeclaration: true,
          aiDisclaimerText: parsed.aiDisclaimerText,
        },
      },
    });
    safeRevalidate('/settings');
    safeRevalidate('/');
    return { ok: true, message: '工作流与发布配置已保存' };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** 切换单个新闻信源的启用或停用状态并保留 YAML 注释落盘 */
export async function toggleSourceAction(formData: FormData): Promise<ActionResult> {
  try {
    const sourceId = parseRequiredString(formData.get('sourceId'), '信源 ID');
    const enabled = parseBooleanField(formData.get('enabled'));
    const core = await getCore();
    await core.config.toggleSource(sourceId, enabled);
    safeRevalidate('/sources');
    safeRevalidate('/');
    return { ok: true, message: `信源 ${sourceId} 已${enabled ? '启用' : '停用'}` };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** 立即对单个订阅信源执行无缓存试抓并返回诊断结果 */
export async function testSourceAction(
  formData: FormData,
): Promise<ActionResult<SourceTestResult>> {
  try {
    const sourceId = parseRequiredString(formData.get('sourceId'), '信源 ID');
    const core = await getCore();
    const result = await core.sources.test(sourceId);
    safeRevalidate('/sources');
    return {
      ok: result.ok,
      data: result,
      message: result.ok
        ? `试抓成功：获取到 ${result.itemCount} 条（耗时 ${result.durationMs}ms）`
        : undefined,
      error: result.ok ? undefined : (result.error ?? '试抓失败'),
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

const LoadModelRoutesInputSchema = z
  .object({
    routes: z.array(z.string().trim().min(1)).max(50).optional(),
    forceRefresh: z.boolean().optional(),
  })
  .optional();

/** 模型列表后台加载或强制刷新的响应负载 */
export interface LoadModelRoutesPayload {
  revision: number;
  modelsByCli: Record<string, string[]>;
  errorsByCli: Record<string, string>;
}

/** 按需后台预热或强制刷新调用方式的模型列表，区分成功列表与单路失败错误 */
export async function loadModelRoutesAction(input?: {
  routes?: string[];
  forceRefresh?: boolean;
}): Promise<ActionResult<LoadModelRoutesPayload>> {
  try {
    const parsed = LoadModelRoutesInputSchema.parse(input);
    const core = await getCore();
    const result = await core.system.warmModelRoutes(parsed);
    if (parsed?.forceRefresh) {
      safeRevalidate('/settings');
    }
    const failedEntries = Object.entries(result.errorsByCli);
    if (failedEntries.length > 0) {
      const summary = failedEntries.map(([name, reason]) => `${name}（${reason}）`).join('；');
      return {
        ok: false,
        data: result,
        error: `部分或全部调用方式未能获取模型列表：${summary}`,
      };
    }
    return {
      ok: true,
      data: result,
      message: parsed?.forceRefresh ? '可用模型列表已刷新' : undefined,
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : '加载模型列表失败' };
  }
}

const RunDoctorInputSchema = z
  .object({
    forceRefresh: z.boolean().optional(),
  })
  .optional();

/** 在设置页执行或强制重新执行环境健康自检并返回诊断报告 */
export async function runDoctorCheckAction(input?: {
  forceRefresh?: boolean;
}): Promise<ActionResult<DoctorReport>> {
  try {
    const parsed = RunDoctorInputSchema.parse(input);
    const core = await getCore();
    const report = await core.system.doctor({
      useCache: !parsed?.forceRefresh,
      forceRefresh: Boolean(parsed?.forceRefresh),
    });
    safeRevalidate('/settings');
    return { ok: true, data: report, message: '环境自检已完成' };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : '环境自检失败' };
  }
}

/** 保存待审核新闻的唯一配图（支持单张候选选图、本地上传或切换无图模式）。 */
export async function setItemImageAction(formData: FormData): Promise<ActionResult> {
  try {
    const runId = RunIdSchema.parse(formData.get('runId'));
    const itemId = ItemIdSchema.parse(formData.get('itemId'));
    const mode = z.enum(['auto', 'none', 'custom']).parse(formData.get('mode'));
    const file = formData.get('image');
    const data =
      file instanceof File && file.size > 0 ? new Uint8Array(await file.arrayBuffer()) : undefined;
    const rawPrimaryId = formData.get('selectedPrimaryMediaId');
    const selectedPrimaryMediaId =
      typeof rawPrimaryId === 'string' && rawPrimaryId.trim() ? rawPrimaryId.trim() : undefined;
    const caption = formData.has('caption')
      ? String(formData.get('caption') ?? '')
      : mode === 'custom'
        ? undefined
        : '';
    const core = await getCore();
    await core.tasks.setItemImage(runId, itemId, {
      mode,
      data,
      selectedPrimaryMediaId,
      caption,
    });
    safeRevalidate(`/runs/${runId}`);
    return { ok: true, message: '图片设置已保存，请重新合成视频' };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** 保存某一段的语音文本和字幕。可以只改字幕，或按所选引擎重做这一段音频 */
export async function updateSectionNarrationAction(formData: FormData): Promise<ActionResult> {
  try {
    const runId = RunIdSchema.parse(formData.get('runId'));
    const sectionKey = z
      .string()
      .trim()
      .regex(/^[a-zA-Z0-9_-]+$/, '段落标识无效')
      .parse(formData.get('sectionKey'));
    const providerRaw = formData.get('provider');
    const provider = typeof providerRaw === 'string' ? providerRaw.trim() : '';
    const core = await getCore();
    await core.tasks.updateSectionNarration(runId, sectionKey, {
      ttsText: String(formData.get('ttsText') ?? ''),
      subtitleText: String(formData.get('subtitleText') ?? ''),
      ...(provider ? { provider } : {}),
      regenerateAudio: parseBooleanField(formData.get('regenerateAudio')),
    });
    safeRevalidate(`/runs/${runId}`);
    return {
      ok: true,
      message: parseBooleanField(formData.get('regenerateAudio'))
        ? '已重新生成本段配音'
        : '已保存字幕文本，原配音保持不变',
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** 取消某一段的人工修改，并按原稿重新生成这一段音频 */
export async function resetSectionNarrationAction(formData: FormData): Promise<ActionResult> {
  try {
    const runId = RunIdSchema.parse(formData.get('runId'));
    const sectionKey = z
      .string()
      .trim()
      .regex(/^[a-zA-Z0-9_-]+$/, '段落标识无效')
      .parse(formData.get('sectionKey'));
    const core = await getCore();
    await core.tasks.resetSectionNarration(runId, sectionKey);
    safeRevalidate(`/runs/${runId}`);
    return { ok: true, message: '已恢复这一段的原稿并重新配音' };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

const ArticleIdSchema = z.string().trim().min(1, '文章 ID 不能为空');

/** 读取单篇已抓取新闻文章的正文全文与候选配图明细 */
export async function getArticleDetailAction(
  articleId: string,
): Promise<ActionResult<ArticleDetail>> {
  try {
    const id = ArticleIdSchema.parse(articleId);
    const core = await getCore();
    const detail = await core.articles.getDetail(id);
    return { ok: true, data: detail };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** 预演选择性或按时间范围删除已抓取新闻文章，返回受影响范围与预计回收空间 */
export async function previewDeleteArticlesAction(
  input: DeleteArticlesInput,
): Promise<ActionResult<DeleteArticlesResult>> {
  try {
    const parsed = DeleteArticlesInputSchema.parse(input);
    const core = await getCore();
    const result = await core.articles.delete({ ...parsed, dryRun: true });
    return { ok: true, data: result };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** 正式执行选择性或按时间范围删除已抓取新闻文章，并同步清理关联缓存文件 */
export async function deleteArticlesAction(
  input: DeleteArticlesInput,
): Promise<ActionResult<DeleteArticlesResult>> {
  try {
    const parsed = DeleteArticlesInputSchema.parse(input);
    const core = await getCore();
    const result = await core.articles.delete({ ...parsed, dryRun: false });
    safeRevalidate('/articles');
    safeRevalidate('/');
    const skippedNote =
      result.skippedReservedCount > 0
        ? `（另有 ${result.skippedReservedCount} 篇正被任务占用已自动跳过）`
        : '';
    return {
      ok: true,
      data: result,
      message: `已删除 ${result.deletedCount} 篇爬取文章及 ${result.deletedFileCount} 个本地文件，释放 ${formatBytes(result.reclaimedBytes)}${skippedNote}`,
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** 将已播放的新闻文章手动标记为未播放，同时移出历史已播去重库 */
export async function markArticlesUnplayedAction(
  ids: string[],
): Promise<ActionResult<MarkArticlesUnplayedResult>> {
  try {
    const parsed = MarkArticlesUnplayedInputSchema.parse({ ids });
    const core = await getCore();
    const result = await core.articles.markUnplayed(parsed);
    safeRevalidate('/articles');
    safeRevalidate('/history');
    safeRevalidate('/');
    if (result.updatedCount === 0) {
      return {
        ok: true,
        data: result,
        message: '所选文章中没有处于「已播」状态的记录，无需变更',
      };
    }
    const historyNote =
      result.removedHistoryCount > 0
        ? `，并同步移出 ${result.removedHistoryCount} 条已播历史防重记录`
        : '';
    return {
      ok: true,
      data: result,
      message: `已将 ${result.updatedCount} 篇新闻标记为未播（待选）${historyNote}`,
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** 将历史已播库中的单条新闻手动标记为未播，并把关联文章重置为待选 */
export async function markHistoryUnplayedAction(
  eventId: string,
): Promise<ActionResult<MarkHistoryUnplayedResult>> {
  try {
    const id = parseRequiredString(eventId, '历史事件 ID');
    const core = await getCore();
    const result = await core.publish.markHistoryUnplayed(id);
    safeRevalidate('/history');
    safeRevalidate('/articles');
    safeRevalidate('/');
    if (!result.removed) {
      return { ok: false, error: '未找到该条已播历史记录，可能已被移除' };
    }
    const articleNote =
      result.resetArticleCount > 0
        ? `，并将关联的 ${result.resetArticleCount} 篇文章重置为待选`
        : '';
    return {
      ok: true,
      data: result,
      message: `已移出历史已播库${articleNote}`,
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** 预演选择性或按时间范围删除任务记录或磁盘产物，返回受影响期数与空间统计 */
export async function previewDeleteRunsAction(
  input: DeleteRunsInput,
): Promise<ActionResult<DeleteRunsResult>> {
  try {
    const parsed = DeleteRunsInputSchema.parse(input);
    const core = await getCore();
    const result = await core.tasks.deleteRuns({ ...parsed, dryRun: true });
    return { ok: true, data: result };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** 正式执行选择性或按时间范围删除任务记录或仅清理任务磁盘产物 */
export async function deleteRunsAction(
  input: DeleteRunsInput,
): Promise<ActionResult<DeleteRunsResult>> {
  try {
    const parsed = DeleteRunsInputSchema.parse(input);
    const core = await getCore();
    const result = await core.tasks.deleteRuns({ ...parsed, dryRun: false });
    safeRevalidate('/');
    safeRevalidate('/runs');
    safeRevalidate('/articles');
    for (const runId of result.affectedRunIds) {
      safeRevalidate(`/runs/${runId}`);
    }
    const modeLabel = result.mode === 'artifacts_only' ? '清理磁盘产物' : '彻底删除任务及产物';
    const skippedNote =
      result.skippedProtectedRunIds.length > 0
        ? `（另有 ${result.skippedProtectedRunIds.length} 期进行中或待核实投稿任务已跳过）`
        : '';
    const releasedNote =
      result.releasedArticlesCount > 0 ? `，释放 ${result.releasedArticlesCount} 篇占用文章` : '';
    return {
      ok: true,
      data: result,
      message: `已对 ${result.affectedRunIds.length} 期任务执行「${modeLabel}」${releasedNote}，回收 ${formatBytes(result.reclaimedBytes)}${skippedNote}`,
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
