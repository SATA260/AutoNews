import { TZDate } from '@date-fns/tz';

/** 转换后的 UTC 时间区间上下界（均为标准 ISO 字符串） */
export interface TimeRangeBounds {
  fromIso?: string;
  toIso?: string;
}

/** 根据配置时区校验并转换本地年月日时分秒为 UTC 毫秒时间戳 */
function parseLocalBoundaryInTz(opts: {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  ms: number;
  timezone: string;
  rawLabel: string;
}): number {
  const { year, month, day, hour, minute, second, ms, timezone, rawLabel } = opts;
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31 ||
    hour < 0 ||
    hour > 23 ||
    minute < 0 ||
    minute > 59 ||
    second < 0 ||
    second > 59 ||
    ms < 0 ||
    ms > 999
  ) {
    throw new RangeError(`筛选时间「${rawLabel}」日期或时刻超出合法范围`);
  }

  const tzDate = new TZDate(year, month - 1, day, hour, minute, second, ms, timezone);
  if (
    !Number.isFinite(tzDate.getTime()) ||
    tzDate.getFullYear() !== year ||
    tzDate.getMonth() !== month - 1 ||
    tzDate.getDate() !== day ||
    tzDate.getHours() !== hour ||
    tzDate.getMinutes() !== minute
  ) {
    throw new RangeError(`筛选时间「${rawLabel}」不是有效的日历时间`);
  }

  return tzDate.getTime();
}

/** 将单个起止时间输入按边界方向解析为 UTC ISO 字符串 */
function parseTimeBoundaryInput(raw: string, kind: 'from' | 'to', timezone: string): string {
  const trimmed = raw.trim();
  const isEnd = kind === 'to';

  const dateOnlyMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  if (dateOnlyMatch) {
    const msEpoch = parseLocalBoundaryInTz({
      year: Number(dateOnlyMatch[1]),
      month: Number(dateOnlyMatch[2]),
      day: Number(dateOnlyMatch[3]),
      hour: isEnd ? 23 : 0,
      minute: isEnd ? 59 : 0,
      second: isEnd ? 59 : 0,
      ms: isEnd ? 999 : 0,
      timezone,
      rawLabel: trimmed,
    });
    return new Date(msEpoch).toISOString();
  }

  const localDtMatch =
    /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/.exec(trimmed);
  if (localDtMatch) {
    const hasSecond = localDtMatch[6] !== undefined;
    const hasMs = localDtMatch[7] !== undefined;
    const msValue = hasMs ? Number((localDtMatch[7] ?? '').padEnd(3, '0')) : isEnd ? 999 : 0;
    const secondValue = hasSecond ? Number(localDtMatch[6]) : isEnd ? 59 : 0;

    const msEpoch = parseLocalBoundaryInTz({
      year: Number(localDtMatch[1]),
      month: Number(localDtMatch[2]),
      day: Number(localDtMatch[3]),
      hour: Number(localDtMatch[4]),
      minute: Number(localDtMatch[5]),
      second: secondValue,
      ms: msValue,
      timezone,
      rawLabel: trimmed,
    });
    return new Date(msEpoch).toISOString();
  }

  if (
    /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:[zZ]|[+-]\d{2}:?\d{2})$/.test(trimmed)
  ) {
    const parsedMs = Date.parse(trimmed);
    if (!Number.isFinite(parsedMs)) {
      throw new RangeError(`筛选时间格式无效: ${trimmed}`);
    }
    return new Date(parsedMs).toISOString();
  }

  throw new RangeError(
    `无法识别的时间格式「${trimmed}」，请使用 YYYY-MM-DD、YYYY-MM-DD HH:mm 或带时区 ISO 时间`,
  );
}

/**
 * 将起止时间筛选参数按指定时区解析为闭区间 UTC ISO 字符串，并校验起止顺序合法性。
 */
export function resolveTimeRangeBounds(opts: {
  from?: string;
  to?: string;
  timezone: string;
}): TimeRangeBounds {
  const fromRaw = opts.from?.trim() ?? '';
  const toRaw = opts.to?.trim() ?? '';
  const fromIso = fromRaw ? parseTimeBoundaryInput(fromRaw, 'from', opts.timezone) : undefined;
  const toIso = toRaw ? parseTimeBoundaryInput(toRaw, 'to', opts.timezone) : undefined;

  if (fromIso && toIso && Date.parse(fromIso) > Date.parse(toIso)) {
    throw new RangeError('起始时间不能晚于截止时间');
  }

  return {
    ...(fromIso ? { fromIso } : {}),
    ...(toIso ? { toIso } : {}),
  };
}
