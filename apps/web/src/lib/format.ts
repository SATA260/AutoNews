import type {
  ArticleStatus,
  ExtractStatus,
  PublishStatus,
  RunItemStatus,
  RunStatus,
  Stage,
  StageStatus,
} from '@aidaily/contracts';

/** 任务整体状态的中文展示标签 */
export const RUN_STATUS_TEXT: Record<RunStatus, string> = {
  queued: '排队中',
  running: '运行中',
  skipped: '已跳过',
  failed: '已失败',
  cancelled: '已取消',
  interrupted: '已中断',
  awaiting_audio_review: '待试听配音',
  awaiting_review: '待人工审核',
  rejected: '已驳回',
  publishing: '上传发布中',
  publish_failed: '发布失败',
  publish_uncertain: '投稿结果待确认',
  published: '已完成发布',
  abandoned: '已放弃',
};

/** 步骤中文展示名称 */
export const STAGE_LABELS: Record<Stage, string> = {
  collect: '新闻抓取',
  select: '选题去重',
  edit: '撰稿与核查',
  package: '整期编排',
  narrate: '语音与时间轴',
  render: '画面合成',
  qa: '成片质检',
  review: '人工审核',
  publish: '投稿发布',
};

/** 步骤状态的中文展示标签 */
export const STAGE_STATUS_TEXT: Record<StageStatus, string> = {
  pending: '待执行',
  running: '进行中',
  done: '已完成',
  failed: '失败',
  interrupted: '中断',
  stale: '已作废归档',
  skipped: '已跳过',
};

/** 单条新闻状态中文标签 */
export const ITEM_STATUS_TEXT: Record<RunItemStatus, string> = {
  queued: '队列中',
  summarizing: '总结中',
  polishing: '润色中',
  prechecking: '预检中',
  checking: '事实核查中',
  revising: '退回微调中',
  passed: '已通过',
  dropped: '已剔除',
};

/** 发布记录状态中文标签 */
export const PUBLISH_STATUS_TEXT: Record<PublishStatus, string> = {
  draft: '草稿待审',
  publishing: '上传中',
  published: '已发布',
  failed: '上传失败',
  uncertain: '状态待人工核对',
  consumed_only: '审核通过（未上传）',
};

/** 爬取文章流转状态的中文标签 */
export const ARTICLE_STATUS_TEXT: Record<ArticleStatus, string> = {
  new: '待选',
  reserved: '任务占用中',
  consumed: '已播出',
  expired: '已过期',
  rejected: '已拒绝',
};

/** 爬取文章正文提取状态的中文标签 */
export const EXTRACT_STATUS_TEXT: Record<ExtractStatus, string> = {
  pending: '待提取',
  ok: '正文完整',
  feed_only: '仅摘要',
  failed: '提取失败',
};

/** 为爬取文章状态返回对应的徽标样式类名 */
export function articleStatusBadgeClass(status: ArticleStatus): string {
  switch (status) {
    case 'new':
      return 'bg-sky-100 text-sky-800 border-sky-200';
    case 'reserved':
      return 'bg-amber-100 text-amber-800 border-amber-200';
    case 'consumed':
      return 'bg-emerald-100 text-emerald-800 border-emerald-200';
    case 'rejected':
      return 'bg-rose-100 text-rose-800 border-rose-200';
    default:
      return 'bg-slate-100 text-slate-600 border-slate-200';
  }
}

/** 为任务整体状态返回对应的徽标样式类名 */
export function runStatusBadgeClass(status: RunStatus): string {
  switch (status) {
    case 'published':
      return 'bg-emerald-100 text-emerald-800 border-emerald-200';
    case 'awaiting_audio_review':
    case 'awaiting_review':
      return 'bg-amber-100 text-amber-800 border-amber-200';
    case 'running':
    case 'publishing':
    case 'queued':
      return 'bg-sky-100 text-sky-800 border-sky-200';
    case 'failed':
    case 'publish_failed':
    case 'publish_uncertain':
      return 'bg-rose-100 text-rose-800 border-rose-200';
    case 'interrupted':
    case 'cancelled':
    case 'rejected':
      return 'bg-orange-100 text-orange-800 border-orange-200';
    default:
      return 'bg-slate-100 text-slate-700 border-slate-200';
  }
}

/** 按配置的时区格式化 UTC ISO 时间戳用于网页展示 */
export function formatTimestamp(iso: string | null | undefined, timezone: string): string {
  if (!iso) {
    return '-';
  }
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  try {
    const parts = new Intl.DateTimeFormat('zh-CN', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).formatToParts(date);
    const byType = new Map(parts.map((p) => [p.type, p.value]));
    return `${byType.get('year')}-${byType.get('month')}-${byType.get('day')} ${byType.get('hour')}:${byType.get('minute')}:${byType.get('second')}`;
  } catch {
    return date.toISOString();
  }
}

/** 格式化开始与结束时间之间的耗时 */
export function formatDuration(startedAt: string | null, finishedAt: string | null): string {
  if (!startedAt || !finishedAt) {
    return '-';
  }
  const ms = Date.parse(finishedAt) - Date.parse(startedAt);
  if (Number.isNaN(ms) || ms < 0) {
    return '-';
  }
  const sec = Math.round(ms / 1000);
  if (sec < 60) {
    return `${sec} 秒`;
  }
  const min = Math.floor(sec / 60);
  const rem = sec % 60;
  return `${min} 分 ${rem} 秒`;
}

/** 按 Unicode 码点统计文本字符长度，与投稿字数限制口径保持一致 */
export function countCodepoints(text: string): number {
  return Array.from(text).length;
}

/** 将字节数格式化为易读的磁盘容量文本 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return '0 B';
  }
  if (bytes < 1024) {
    return `${Math.round(bytes)} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/** 将时间对象按指定时区格式化为网页日期时间输入框所需的 `YYYY-MM-DDTHH:mm` 字符串 */
export function formatDateTimeLocalInTz(date: Date, timezone: string): string {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(date);
    const byType = new Map(parts.map((p) => [p.type, p.value]));
    return `${byType.get('year')}-${byType.get('month')}-${byType.get('day')}T${byType.get('hour')}:${byType.get('minute')}`;
  } catch {
    return date.toISOString().slice(0, 16);
  }
}
