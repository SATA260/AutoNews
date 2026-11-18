import path from 'node:path';
import {
  COVER_TEXT_LIMITS,
  type ContentLimits,
  type IssuePackage,
  IssuePackageSchema,
  type Settings,
} from '@aidaily/contracts';
import { buildNarrationParagraph } from '@aidaily/tts';
import { TZDate } from '@date-fns/tz';
import { format } from 'date-fns';
import type { CoreContext } from '../context.js';
import { lockRunBgm } from '../media/bgm.js';
import { inTransaction } from '../storage/db.js';
import { writeFileAtomic } from '../storage/files.js';
import { invokeStageLlm } from './llm.js';
import { getRunPersona } from './personas.js';
import { precheckIssuePackage } from './prechecks.js';
import { renderPromptTemplate } from './prompts.js';
import { resolveContentLimits } from './s4-polish.js';

const MAX_PACKAGE_PRECHECK_RETRIES = 2;

/** 整期节目编排阶段完成后写入检查点的结果数据 */
export interface PackageCheckpoint {
  issueNumber: string;
  date: string;
  packageData: IssuePackage;
}

/**
 * 执行整期节目编排与投稿包装阶段：
 * 根据事件重要度安排播出顺序并突出头条，生成开场导语、动态结尾互动引导、B 站标题、导览与标签，
 * 对输出结果进行字数与格式预检（最多重试 2 次）并将最终播出序号写回数据库。
 */
export async function runPackageStage(
  ctx: CoreContext,
  runId: string,
  settings: Settings,
  opts?: {
    signal?: AbortSignal;
    limitsOverride?: Partial<ContentLimits>;
  },
): Promise<PackageCheckpoint> {
  const run = ctx.repos.runs.getById(runId);
  if (!run) {
    throw new Error(`未找到任务记录: ${runId}`);
  }

  const events = ctx.repos.events.listByRun(runId);
  const eventById = new Map(events.map((e) => [e.id, e]));
  const passedItems = ctx.repos.runItems
    .listByRun(runId)
    .filter((item) => item.status === 'passed' && item.finalJson !== null)
    .sort((a, b) => {
      const rankA = eventById.get(a.eventId)?.rank ?? 9999;
      const rankB = eventById.get(b.eventId)?.rank ?? 9999;
      return rankA - rankB;
    });

  if (passedItems.length === 0) {
    throw new Error(`任务 ${runId} 没有已过审的新闻条目，无法进行整期编排`);
  }

  const limits = resolveContentLimits(settings, opts?.limitsOverride);
  const tzNow = new TZDate(ctx.now().getTime(), settings.timezone);
  const dateStr = format(tzNow, 'yyyy-MM-dd');
  const issueNumber = `VOL.${format(tzNow, 'yyyy.MM.dd')}`;
  const weekdays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'] as const;
  const dateDisplay = `${tzNow.getMonth() + 1}月${tzNow.getDate()}日${weekdays[tzNow.getDay()] ?? ''}`;

  const itemsPayload = passedItems.map((item) => {
    const ev = eventById.get(item.eventId);
    return {
      itemId: item.id,
      title: item.finalJson?.title ?? ev?.title ?? '',
      shortTitle: item.finalJson?.shortTitle ?? '',
      category: item.finalJson?.category ?? ev?.category ?? '',
      entity: item.finalJson?.entity ?? ev?.entity ?? '',
      summary: item.finalJson?.summary ?? '',
      highlight: item.finalJson?.highlight ?? '',
      keyPoints: item.finalJson?.keyPoints ?? [],
      narration: item.finalJson?.narration ?? [],
      score: ev?.score ?? 5,
      publicAppeal: ev?.publicAppeal ?? 5,
    };
  });

  const extraTagQuota = Math.max(
    0,
    settings.publish.bilibili.tagsMax - settings.publish.bilibili.defaultTags.length,
  );
  const publishLimits = {
    titleMax: settings.publish.bilibili.titleMax,
    extraTagsMax: extraTagQuota,
  };

  const persona = await getRunPersona(ctx, runId);
  const basePrompt = await renderPromptTemplate('s6-package.md', {
    personaJson: persona ? JSON.stringify(persona, null, 2) : '无特定角色',
    date: dateStr,
    dateDisplay,
    issueNumber,
    passedItemsJson: JSON.stringify(itemsPayload, null, 2),
    contentLimitsJson: JSON.stringify(limits, null, 2),
    publishLimitsJson: JSON.stringify(publishLimits, null, 2),
    coverTitleMax: String(COVER_TEXT_LIMITS.titleMax),
    coverSubtitleMax: String(COVER_TEXT_LIMITS.subtitleMax),
  });

  const expectedItemIds = passedItems.map((i) => i.id);
  let prompt = basePrompt;
  let lastErrors: string[] = [];

  for (let attempt = 0; attempt <= MAX_PACKAGE_PRECHECK_RETRIES; attempt++) {
    if (opts?.signal?.aborted) {
      throw new DOMException('已取消', 'AbortError');
    }

    const res = await invokeStageLlm({
      ctx,
      settings,
      stage: 'package',
      runId,
      prompt,
      schema: IssuePackageSchema,
      signal: opts?.signal,
    });

    const check = precheckIssuePackage({
      pkg: res.data,
      expectedItemIds,
      limits,
      publishConfig: settings.publish.bilibili,
      metaTextBlacklist: settings.editorial.metaTextBlacklist,
      compact: settings.issue.minScore !== undefined,
      forbiddenTokens: persona?.forbiddenTokens,
      hostSelfName: persona?.selfName,
    });

    if (check.passed) {
      const nowIso = ctx.now().toISOString();
      inTransaction(ctx.db, () => {
        for (const item of ctx.repos.runItems.listByRun(runId)) {
          if (item.position !== null) {
            ctx.repos.runItems.updateItem(item.id, { position: null, updatedAt: nowIso });
          }
        }
        res.data.order.forEach((itemId, idx) => {
          ctx.repos.runItems.updateItem(itemId, {
            position: idx + 1,
            updatedAt: nowIso,
          });
        });
      });

      await lockRunBgm(ctx, runId);
      const itemById = new Map(passedItems.map((item) => [item.id, item]));
      const paragraphs = [
        buildNarrationParagraph(res.data.intro.narration),
        ...res.data.order.map((id) =>
          buildNarrationParagraph(itemById.get(id)?.finalJson?.narration ?? []),
        ),
        buildNarrationParagraph(res.data.outro.narration),
      ].filter((text) => text.length > 0);
      await writeFileAtomic(
        path.join(ctx.paths.runDir(runId), 'narration.txt'),
        paragraphs.length > 0 ? `${paragraphs.join('\n\n')}\n` : '\n',
      );
      return {
        issueNumber,
        date: dateStr,
        packageData: res.data,
      };
    }

    lastErrors = check.errors;
    prompt = `${basePrompt}\n\n[上次编排输出未通过规则校验，请逐条修正以下问题后重新输出]:\n${check.errors.map((e) => `- ${e}`).join('\n')}`;
  }

  throw new Error(`整期编排经过重试后仍未通过规则校验: ${lastErrors.join('; ')}`);
}
