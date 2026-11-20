import { ScheduleTimeSchema } from '@aidaily/contracts';
import { TZDate } from '@date-fns/tz';

/** 允许补触发刚因系统休眠而错过定时点的时间宽限窗口（2 小时） */
export const DEFAULT_CATCHUP_GRACE_MS = 2 * 60 * 60 * 1000;

/** 调度器读取的单条定时任务最小字段集合 */
export interface DaemonScheduleEntry {
  id: string;
  name: string;
  time: string;
  itemCount: number;
  bgmFile: string | null;
  enabled: boolean;
  lastTriggeredAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** 单次定时触发决策项 */
export interface DueScheduleTrigger {
  job: DaemonScheduleEntry;
  slotKey: string;
  scheduledAtMs: number;
}

/** 检查一轮定时计划后的汇总决策结果 */
export interface SchedulePlanResult {
  dueJobs: DueScheduleTrigger[];
  nextRunAt: string | null;
  nextScheduleName: string | null;
  prunedTriggeredSlots: Record<string, string>;
}

/** 将时间戳格式化为指定时区下的 `YYYY-MM-DD` 日期键，可选按本地日历天偏移 */
export function formatDateKeyInTimezone(ms: number, timezone: string, dayOffset = 0): string {
  const base = new TZDate(ms, timezone);
  const zoned =
    dayOffset === 0
      ? base
      : new TZDate(
          base.getFullYear(),
          base.getMonth(),
          base.getDate() + dayOffset,
          12,
          0,
          0,
          0,
          timezone,
        );
  const y = String(zoned.getFullYear()).padStart(4, '0');
  const m = String(zoned.getMonth() + 1).padStart(2, '0');
  const d = String(zoned.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** 计算指定日期与每日时间在目标时区下对应的精确 UTC 毫秒时间戳 */
export function computeScheduledSlotMs(
  dateKey: string,
  timeExpr: string,
  timezone: string,
): number {
  const [yStr, mStr, dStr] = dateKey.split('-');
  const validatedTime = ScheduleTimeSchema.parse(timeExpr);
  const [hhStr, mmStr] = validatedTime.split(':');
  const target = new TZDate(
    Number(yStr),
    Number(mStr) - 1,
    Number(dStr),
    Number(hhStr),
    Number(mmStr),
    0,
    0,
    timezone,
  );
  return target.getTime();
}

/** 按照配置时区计算已启用定时任务的下一次触发时间（返回 UTC ISO 字符串，未启用则返回 null） */
export function computeNextScheduleRunAt(
  timeExpr: string,
  enabled: boolean,
  now: Date,
  timezone: string,
): string | null {
  if (!enabled) {
    return null;
  }
  const validated = ScheduleTimeSchema.parse(timeExpr);
  const [hhStr, mmStr] = validated.split(':');
  const hour = Number(hhStr);
  const minute = Number(mmStr);

  const tzNow = new TZDate(now.getTime(), timezone);
  let target = new TZDate(
    tzNow.getFullYear(),
    tzNow.getMonth(),
    tzNow.getDate(),
    hour,
    minute,
    0,
    0,
    timezone,
  );
  if (target.getTime() <= now.getTime()) {
    target = new TZDate(
      tzNow.getFullYear(),
      tzNow.getMonth(),
      tzNow.getDate() + 1,
      hour,
      minute,
      0,
      0,
      timezone,
    );
  }
  return new Date(target.getTime()).toISOString();
}

/**
 * 评估当前时刻应当立即触发的定时任务与最近一次未来触发时间：
 * - 新建或刚改到今天已过去时间的任务不会立刻补跑，必须等到下一次命中时刻；
 * - 若系统休眠跨越触发点但在宽限窗口内（默认 2 小时），唤醒后会补触发一次并记录今日槽位防重复；
 * - 自动裁掉历史跨天的 `triggeredSlots` 键，保证状态文件长期保持固定极小体积。
 */
export function evaluateDueSchedules(opts: {
  schedules: readonly DaemonScheduleEntry[];
  timezone: string;
  nowMs: number;
  triggeredSlots: Readonly<Record<string, string>>;
  catchUpGraceMs?: number;
}): SchedulePlanResult {
  const catchUpGraceMs = opts.catchUpGraceMs ?? DEFAULT_CATCHUP_GRACE_MS;
  const todayKey = formatDateKeyInTimezone(opts.nowMs, opts.timezone, 0);
  const yesterdayKey = formatDateKeyInTimezone(opts.nowMs, opts.timezone, -1);
  const nowDate = new Date(opts.nowMs);

  const dueJobs: DueScheduleTrigger[] = [];
  const prunedTriggeredSlots: Record<string, string> = {};
  for (const [jobId, slot] of Object.entries(opts.triggeredSlots)) {
    if (slot.startsWith(`${todayKey}@`)) {
      prunedTriggeredSlots[jobId] = slot;
      continue;
    }
    if (slot.startsWith(`${yesterdayKey}@`)) {
      const timePart = slot.slice(yesterdayKey.length + 1);
      try {
        const slotMs = computeScheduledSlotMs(yesterdayKey, timePart, opts.timezone);
        if (opts.nowMs - slotMs <= catchUpGraceMs) {
          prunedTriggeredSlots[jobId] = slot;
        }
      } catch {
        // 忽略格式异常的历史槽位键并顺便清理
      }
    }
  }

  let earliestNextMs = Number.POSITIVE_INFINITY;
  let nextRunAt: string | null = null;
  let nextScheduleName: string | null = null;

  for (const job of opts.schedules) {
    if (!job.enabled) {
      continue;
    }

    const nextIso = computeNextScheduleRunAt(job.time, true, nowDate, opts.timezone);
    if (nextIso) {
      const nextMs = Date.parse(nextIso);
      if (nextMs < earliestNextMs) {
        earliestNextMs = nextMs;
        nextRunAt = nextIso;
        nextScheduleName = job.name;
      }
    }

    const createdMs = Date.parse(job.createdAt);
    const updatedMs = Date.parse(job.updatedAt);
    const baselineMs = Math.max(
      Number.isFinite(createdMs) ? createdMs : 0,
      Number.isFinite(updatedMs) ? updatedMs : 0,
    );

    for (const dateKey of [todayKey, yesterdayKey]) {
      const slotMs = computeScheduledSlotMs(dateKey, job.time, opts.timezone);
      const slotKey = `${dateKey}@${job.time}`;
      if (opts.nowMs < slotMs || opts.nowMs - slotMs > catchUpGraceMs) {
        continue;
      }
      if (prunedTriggeredSlots[job.id] === slotKey) {
        break;
      }
      if (slotMs < baselineMs) {
        continue;
      }
      if (job.lastTriggeredAt) {
        const lastTriggeredMs = Date.parse(job.lastTriggeredAt);
        if (Number.isFinite(lastTriggeredMs) && lastTriggeredMs >= slotMs - 60_000) {
          prunedTriggeredSlots[job.id] = slotKey;
          break;
        }
      }

      dueJobs.push({
        job,
        slotKey,
        scheduledAtMs: slotMs,
      });
      break;
    }
  }

  return {
    dueJobs,
    nextRunAt,
    nextScheduleName,
    prunedTriggeredSlots,
  };
}
