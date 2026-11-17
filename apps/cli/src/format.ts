import type {
  DoctorReport,
  PublishDraft,
  RetryOptions,
  RunDetail,
  RunEvent,
  RunSummary,
  ScheduleJob,
  SourceHealth,
  SourceTestResult,
} from '@aidaily/contracts';

const RUN_STATUS_LABELS: Record<string, string> = {
  queued: '排队中',
  running: '运行中',
  skipped: '已跳过',
  failed: '已失败',
  cancelled: '已取消',
  interrupted: '已中断',
  awaiting_review: '待审核',
  rejected: '已驳回',
  publishing: '上传中',
  publish_failed: '发布失败',
  publish_uncertain: '状态待确认',
  published: '已发布',
  abandoned: '已放弃',
};

/** 计算字符串在等宽终端中的显示宽度（中日韩表意文字、全角符号及增补平面宽字符按 2 列计算） */
function displayWidth(text: string): number {
  let width = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    const isWide =
      (code >= 0x1100 && code <= 0x115f) ||
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe10 && code <= 0xfe6f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      code >= 0x20000;
    width += isWide ? 2 : 1;
  }
  return width;
}

/** 将单元格文本右侧补足空格以对齐终端等宽表格 */
function padCell(text: string, targetWidth: number): string {
  const diff = Math.max(0, targetWidth - displayWidth(text));
  return `${text}${' '.repeat(diff)}`;
}

/** 按指定时区将 UTC ISO 时间戳格式化为可读的本地日期时间文本 */
export function formatTimestampInTz(iso: string | null | undefined, timezone: string): string {
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

/** 格式化两个时间点之间的耗时字符串 */
export function formatDuration(startedAt: string | null, finishedAt: string | null): string {
  if (!startedAt || !finishedAt) {
    return '-';
  }
  const diffMs = Date.parse(finishedAt) - Date.parse(startedAt);
  if (Number.isNaN(diffMs) || diffMs < 0) {
    return '-';
  }
  const totalSec = Math.round(diffMs / 1000);
  if (totalSec < 60) {
    return `${totalSec}s`;
  }
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  return `${mins}m${secs}s`;
}

/** 渲染终端等宽表格文本 */
export function renderTable(headers: string[], rows: string[][]): string {
  const widths = headers.map((h) => displayWidth(h));
  for (const row of rows) {
    row.forEach((cell, idx) => {
      widths[idx] = Math.max(widths[idx] ?? 0, displayWidth(cell));
    });
  }
  const line = (cols: string[]) => cols.map((c, idx) => padCell(c, widths[idx] ?? 0)).join('  ');
  const separator = widths.map((w) => '-'.repeat(w)).join('  ');
  return [line(headers), separator, ...rows.map(line)].join('\n');
}

/** 将单条实时运行事件格式化为易读的单行日志文本 */
export function formatRunEventLine(ev: RunEvent, timezone: string): string {
  const ts = formatTimestampInTz(ev.ts, timezone);
  const stagePart = ev.stage ? `[${ev.stage}] ` : '';
  const itemPart = ev.itemId ? `(${ev.itemId}) ` : '';
  return `${ts} [${ev.level.toUpperCase()}] ${stagePart}${itemPart}${ev.message}`;
}

/** 格式化任务状态摘要表格 */
export function formatRunsTable(runs: RunSummary[], timezone: string): string {
  if (runs.length === 0) {
    return '暂无任务记录。';
  }
  return renderTable(
    ['任务 ID', '状态', '当前阶段', '条数', '触发方式', '耗时', '创建时间'],
    runs.map((r) => [
      r.id,
      RUN_STATUS_LABELS[r.status] ?? r.status,
      r.currentStage ?? '-',
      String(r.itemCount),
      r.scheduleId ? `${r.trigger}(${r.scheduleId})` : r.trigger,
      formatDuration(r.startedAt, r.finishedAt),
      formatTimestampInTz(r.createdAt, timezone),
    ]),
  );
}

/** 格式化单期任务详情文本（可选附带新闻条目和核查版本明细） */
export function formatRunDetailText(
  detail: RunDetail,
  timezone: string,
  includeItems: boolean,
): string {
  const lines: string[] = [
    `任务 ID: ${detail.id}`,
    `状态: ${RUN_STATUS_LABELS[detail.status] ?? detail.status} (${detail.status})`,
    `当前阶段: ${detail.currentStage ?? '-'}`,
    `条数 / 尝试次数: ${detail.itemCount} 条 / 第 ${detail.attempt} 次`,
    `触发方式: ${detail.trigger}${detail.scheduleId ? ` (${detail.scheduleId})` : ''}`,
    `创建时间: ${formatTimestampInTz(detail.createdAt, timezone)}`,
    `开始时间: ${formatTimestampInTz(detail.startedAt, timezone)}`,
    `结束时间: ${formatTimestampInTz(detail.finishedAt, timezone)}`,
  ];
  if (detail.retryDeadlineAt) {
    lines.push(`保留重跑截止: ${formatTimestampInTz(detail.retryDeadlineAt, timezone)}`);
  }
  if (detail.error) {
    lines.push(`错误详情: [${detail.errorCode ?? 'error'}] ${detail.error}`);
  }
  lines.push('');
  lines.push('各阶段状态:');
  lines.push(
    renderTable(
      ['阶段', '状态', '尝试次数', '耗时', '错误信息'],
      detail.stages.map((s) => [
        s.stage,
        s.status,
        String(s.attempt),
        formatDuration(s.startedAt, s.finishedAt),
        s.error ?? '-',
      ]),
    ),
  );

  if (detail.publishRecord) {
    lines.push('');
    lines.push(
      `投稿记录: ${detail.publishRecord.status}${detail.publishRecord.bvid ? ` (BV: ${detail.publishRecord.bvid})` : ''} — ${detail.publishRecord.title ?? ''}`,
    );
  }

  if (includeItems && detail.items.length > 0) {
    lines.push('');
    lines.push('新闻条目:');
    lines.push(
      renderTable(
        ['条目 ID', '位置', '状态', '修改轮次', '标题 / 剔除原因'],
        detail.items.map((item) => [
          item.id,
          item.position !== null ? String(item.position) : '-',
          item.status,
          String(item.revision),
          item.finalJson?.title ?? item.dropReason ?? '-',
        ]),
      ),
    );
  }
  return lines.join('\n');
}

/** 格式化可重试选项说明 */
export function formatRetryOptionsText(opts: RetryOptions, timezone: string): string {
  if (!opts.resumable) {
    return '该任务当前状态不支持恢复或重跑。';
  }
  return [
    `是否可重试: 是`,
    `默认断点续跑阶段: ${opts.resumeFrom ?? '全部自动阶段已完成（可从任一阶段重跑）'}`,
    `允许重跑起点阶段: ${opts.allowedFromStages.join(', ')}`,
    `保留截止时间: ${formatTimestampInTz(opts.retryDeadlineAt, timezone)}`,
  ].join('\n');
}

/** 格式化审核草稿及媒体路径预览文本 */
export function formatDraftReviewText(
  draft: PublishDraft,
  absVideoPath: string,
  absCoverPath: string,
): string {
  return [
    `任务 ID: ${draft.runId}`,
    `当前状态: ${draft.status}`,
    `AI 生成内容声明: ${draft.aiDeclaration ? '已强制开启' : '未开启'}`,
    `标题: ${draft.title}`,
    `标签: ${draft.tags.join(', ')}`,
    `视频路径: ${absVideoPath}`,
    `封面路径: ${absCoverPath}`,
    '简介:',
    draft.description,
  ].join('\n');
}

/** 格式化信源健康状态列表 */
export function formatSourcesTable(sources: SourceHealth[], timezone: string): string {
  if (sources.length === 0) {
    return '暂无信源配置。';
  }
  return renderTable(
    ['ID', '名称', '启用', '池/级别', '健康', '连续失败', '最近抓取', '最近错误'],
    sources.map((s) => [
      s.source.id,
      s.source.name,
      s.source.enabled ? '是' : '否',
      `${s.source.pool}/${s.source.tier}`,
      s.healthy ? '正常' : '异常',
      String(s.state?.consecutiveFailures ?? 0),
      formatTimestampInTz(s.state?.lastFetchedAt, timezone),
      s.state?.lastError ?? '-',
    ]),
  );
}

/** 格式化单个信源试抓诊断文本 */
export function formatSourceTestText(res: SourceTestResult): string {
  const lines = [
    `信源: ${res.sourceId}`,
    `结果: ${res.ok ? '成功' : '失败'} (耗时 ${res.durationMs}ms${res.statusCode ? `, HTTP ${res.statusCode}` : ''})`,
    `抓取条目数: ${res.itemCount}`,
  ];
  if (res.error) {
    lines.push(`错误信息: ${res.error}`);
  }
  if (res.sampleTitles.length > 0) {
    lines.push('示例标题:');
    for (const title of res.sampleTitles) {
      lines.push(`  - ${title}`);
    }
  }
  return lines.join('\n');
}

/** 格式化定时任务清单表格 */
export function formatSchedulesTable(jobs: ScheduleJob[], timezone: string): string {
  if (jobs.length === 0) {
    return '暂无定时任务。请使用 `aidaily schedule create --time <HH:mm> -n <条数>` 新建。';
  }
  return renderTable(
    ['任务 ID', '名称', '每日时间', '条数', '启用', '系统安装', '下次触发时间', '最近运行'],
    jobs.map((j) => [
      j.id,
      j.name,
      j.time,
      String(j.itemCount),
      j.enabled ? '启用' : '停用',
      j.installed ? '已挂载' : '未挂载',
      formatTimestampInTz(j.nextRunAt, timezone),
      j.lastRunId ?? '-',
    ]),
  );
}

/** 格式化环境诊断自检报告文本 */
export function formatDoctorReportText(report: DoctorReport, timezone: string): string {
  const header = `运行环境自检 (${formatTimestampInTz(report.checkedAt, timezone)})：${report.ok ? '通过' : '存在阻塞问题'}`;
  const table = renderTable(
    ['检查项', '状态', '必须项', '详情'],
    report.checks.map((c) => [c.name, c.ok ? '通过' : '失败', c.required ? '是' : '否', c.detail]),
  );
  return `${header}\n\n${table}`;
}
