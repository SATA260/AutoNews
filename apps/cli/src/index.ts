import { spawn } from 'node:child_process';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  HostMascotIdSchema,
  PIPELINE_STAGES,
  type RunStatus,
  RunStatusSchema,
  type ScheduleCutoffMode,
  ScheduleCutoffModeSchema,
  ScheduleTimeSchema,
  type Stage,
  StageSchema,
  type Trigger,
  TriggerSchema,
} from '@aidaily/contracts';
import { type Core, createCore, LockBusyError } from '@aidaily/core';
import { Command, CommanderError } from 'commander';
import {
  buildPatchFromDotPath,
  CliUsageError,
  getByDotPath,
  parseCliValue,
} from './config-path.js';
import {
  formatDoctorReportText,
  formatDraftReviewText,
  formatRetryOptionsText,
  formatRunDetailText,
  formatRunEventLine,
  formatRunsTable,
  formatSchedulesTable,
  formatSourcesTable,
  formatSourceTestText,
} from './format.js';

/** 命令行输出流注入接口，便于测试捕获标准输出与错误输出 */
export interface CliIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

/** 全局公共命令行选项 */
interface GlobalCliOpts {
  json?: boolean;
  root?: string;
}

const DEFAULT_IO: CliIo = {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
};

const EDIT_SUB_STEPS = ['summarize', 'polish', 'factcheck'] as const;

/** 从当前执行的子命令向上合并全局选项，同时支持在子命令前后传入 `--json` 与 `--root` */
function getGlobals(cmd: Command): GlobalCliOpts {
  return cmd.optsWithGlobals<GlobalCliOpts>();
}

/** 将字符串参数解析并校验为安全范围内的正整数（禁止前导零与超大整数静默舍入），不合法时抛出退出码 2 对应的参数错误 */
function parsePositiveInt(raw: string, flagName: string): number {
  const trimmed = raw.trim();
  if (!/^[1-9]\d*$/.test(trimmed)) {
    throw new CliUsageError(`参数 ${flagName} 必须为正整数，当前传入: ${raw}`);
  }
  const num = Number.parseInt(trimmed, 10);
  if (!Number.isSafeInteger(num) || num <= 0 || String(num) !== trimmed) {
    throw new CliUsageError(`参数 ${flagName} 必须为安全范围内的正整数，当前传入: ${raw}`);
  }
  return num;
}

/** 分页查询指定任务当前已有的最大日志事件编号，避免续跑监听回放过旧事件 */
async function getLatestEventId(core: Core, runId: string): Promise<number> {
  let cursor = 0;
  while (true) {
    const batch = await core.tasks.events(runId, cursor, 500);
    if (batch.length === 0) {
      return cursor;
    }
    for (const ev of batch) {
      if (ev.id > cursor) {
        cursor = ev.id;
      }
    }
    if (batch.length < 500) {
      return cursor;
    }
  }
}

/** 注册单次生效的中断信号处理器；首次收到 Ctrl-C 执行回调并立即卸载自身，使二次按键可触发进程默认强退 */
function attachSingleSigint(onFirstInterrupt: () => void): () => void {
  const handler = () => {
    process.off('SIGINT', handler);
    onFirstInterrupt();
  };
  process.on('SIGINT', handler);
  return () => {
    process.off('SIGINT', handler);
  };
}

/** 递归检测任意命令节点是否已经解析到 `--json` 标志，或检查命令行标志序列中的独立 `--json` 选项 */
function hasJsonFlag(program: Command, argv: readonly string[]): boolean {
  const checkCmd = (cmd: Command): boolean => {
    if ((cmd.opts() as GlobalCliOpts).json) {
      return true;
    }
    return cmd.commands.some((sub) => checkCmd(sub));
  };
  if (checkCmd(program)) {
    return true;
  }

  const valueFlags = new Set([
    '-n',
    '--items',
    '--root',
    '--trigger',
    '--schedule-id',
    '--from',
    '--status',
    '--limit',
    '--reason',
    '--title',
    '--desc-file',
    '--tags',
    '--bvid',
    '--time',
    '--name',
    '--cli',
    '--host',
    '--bgm',
    '--since',
    '--cutoff',
    '--max-age-hours',
    '--import',
  ]);
  let skipNextValue = false;
  for (const token of argv) {
    if (token === '--') {
      break;
    }
    if (skipNextValue) {
      skipNextValue = false;
      // 布尔同名标志（例如 x-login --status --json）后面紧跟另一个选项时，不能误吞下一个标志
      if (!token.startsWith('-')) {
        continue;
      }
    }
    if (token === '--json' || token === '--json=true') {
      return true;
    }
    if (valueFlags.has(token)) {
      skipNextValue = true;
    }
  }
  return false;
}

/** 构造用于写入标准输出的格式化函数（JSON 或人类可读文本） */
function createPrinter(io: CliIo, jsonMode: boolean) {
  return (payload: unknown, text: string): void => {
    if (jsonMode) {
      io.stdout(`${JSON.stringify(payload, null, 2)}\n`);
    } else {
      io.stdout(`${text}\n`);
    }
  };
}

/** 递归为命令及全部子命令挂载公共选项、统一输出回调与异常捕获钩子，防止直接调用 process.exit */
function configureCommandTree(cmd: Command, io: CliIo, isRoot = false): void {
  cmd.exitOverride();
  cmd.configureOutput({
    writeOut: (str) => io.stdout(str),
    writeErr: (str) => io.stderr(str),
  });
  if (!isRoot) {
    cmd.option('--json', '以结构化 JSON 格式输出命令结果');
    cmd.option('--root <dir>', '显式指定项目根目录（包含 config/settings.yaml）');
  }
  for (const sub of cmd.commands) {
    configureCommandTree(sub, io, false);
  }
}

/** 调用外部交互式或系统工具子进程并等待退出，返回其退出码 */
async function spawnInheritProcess(bin: string, args: string[]): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const child = spawn(bin, args, { stdio: 'inherit' });
    child.on('error', reject);
    child.on('close', (code) => resolve(code ?? 1));
  });
}

/** 根据命令行动作中发生的异常归类标准进程退出码 */
function mapErrorToExitCode(err: unknown): number {
  if (err instanceof CommanderError) {
    if (err.code === 'commander.helpDisplayed' || err.code === 'commander.version') {
      return 0;
    }
    return 2;
  }
  if (
    err instanceof CliUsageError ||
    err instanceof RangeError ||
    (err instanceof Error && err.name === 'ZodError')
  ) {
    return 2;
  }
  if (err instanceof LockBusyError || (err instanceof Error && err.name === 'LockBusyError')) {
    return 3;
  }
  return 1;
}

/** 绑定核心引擎的辅助执行器：自动打开与关闭数据库连接，并把返回值转为进程退出码 */
async function withCore(
  globalOpts: GlobalCliOpts,
  fn: (core: Core) => Promise<number | undefined>,
): Promise<number> {
  const core = await createCore(globalOpts.root ? { rootDir: globalOpts.root } : undefined);
  try {
    const code = await fn(core);
    return code ?? 0;
  } finally {
    await core.close();
  }
}

/** 构建完整的 `aidaily` 命令行命令树并连接所有核心业务操作 */
export function buildProgram(io: CliIo = DEFAULT_IO, onExitCode?: (code: number) => void): Command {
  const program = new Command();
  program
    .name('aidaily')
    .description('AI 每日报自动化视频生产与发布命令行工具')
    .version('0.1.0')
    .option('--json', '以结构化 JSON 格式输出命令结果', false)
    .option('--root <dir>', '显式指定项目根目录（包含 config/settings.yaml）');

  /** 记录当前命令结束时的退出码 */
  const setExit = (code: number): void => {
    onExitCode?.(code);
  };

  /** 监听前台执行任务并实时输出进度事件（支持首次 Ctrl-C 发出安全取消请求、二次按键强退） */
  const watchForegroundTask = async (
    core: Core,
    runId: string,
    afterId: number,
    jsonMode: boolean,
    workPromise: Promise<unknown>,
  ): Promise<void> => {
    const watchCtrl = new AbortController();
    const timezone = core.config.getSettings().timezone;
    const detachSigint = attachSingleSigint(() => {
      void core.tasks.cancel(runId).catch((cancelErr) => {
        if (!jsonMode) {
          io.stderr(
            `发送取消请求失败: ${cancelErr instanceof Error ? cancelErr.message : String(cancelErr)}\n`,
          );
        }
      });
    });

    const watchPromise = core.tasks
      .watch(
        runId,
        (ev) => {
          if (!jsonMode) {
            io.stdout(`${formatRunEventLine(ev, timezone)}\n`);
          }
        },
        watchCtrl.signal,
        { afterId, pollMs: 120 },
      )
      .catch((watchErr) => {
        if (watchCtrl.signal.aborted) {
          return;
        }
        if (!jsonMode) {
          io.stderr(
            `日志监听异常结束: ${watchErr instanceof Error ? watchErr.message : String(watchErr)}\n`,
          );
        }
      });

    try {
      await workPromise;
      await watchPromise;
    } catch (err) {
      watchCtrl.abort();
      await watchPromise;
      throw err;
    } finally {
      watchCtrl.abort();
      detachSigint();
    }
  };

  // 1. aidaily run -n <N> [--since <expr>] [--detach] [--trigger ...] [--schedule-id ...]
  program
    .command('run')
    .description('生成并运行一期 AI 每日报任务（必须通过 -n 指定新闻条数）')
    .requiredOption('-n, --items <N>', '本期新闻条数（必填正整数，无默认值）')
    .option(
      '--since <expr>',
      '最早新闻时间下限（支持 12h / 24h / 48h / today / last-published / YYYY-MM-DD / ISO）',
    )
    .option('--host <id>', '指定主播：deepseek、gpt、gemini 或 claude')
    .option('--bgm <file>', '指定曲库中的背景音乐文件名')
    .option('--detach', '在后台独立工作进程中执行并立即返回', false)
    .option('--trigger <trigger>', '触发来源 (manual-cli | manual-web | schedule)', 'manual-cli')
    .option('--schedule-id <id>', '关联定时任务 ID')
    .action(
      async (
        opts: {
          items: string;
          since?: string;
          detach: boolean;
          trigger: string;
          scheduleId?: string;
          host?: string;
          bgm?: string;
        },
        cmd: Command,
      ) => {
        const gOpts = getGlobals(cmd);
        const jsonMode = Boolean(gOpts.json);
        const print = createPrinter(io, jsonMode);

        const itemCount = parsePositiveInt(opts.items, '-n/--items');
        const triggerResult = TriggerSchema.safeParse(opts.trigger);
        if (!triggerResult.success) {
          throw new CliUsageError(
            `非法的 --trigger 取值 "${opts.trigger}"，仅支持 manual-cli / manual-web / schedule`,
          );
        }
        const trigger: Trigger = triggerResult.data;
        const host = opts.host ? HostMascotIdSchema.safeParse(opts.host) : null;
        if (host && !host.success) throw new CliUsageError('无效的主播标识');

        const code = await withCore(gOpts, async (core) => {
          try {
            if (opts.detach) {
              const { runId } = await core.tasks.start({
                itemCount,
                notBeforeAt: opts.since,
                hostId: host?.success ? host.data : undefined,
                bgmFile: opts.bgm,
                trigger,
                scheduleId: opts.scheduleId,
                detach: true,
              });
              print(
                { runId, itemCount, notBeforeAt: opts.since ?? null, trigger, detached: true },
                `已提交后台任务 ${runId}（目标 ${itemCount} 条新闻），可用 aidaily logs ${runId} -f 查看进度。`,
              );
              return 0;
            }

            let createdRunId = '';
            const watchCtrl = new AbortController();
            const timezone = core.config.getSettings().timezone;
            let watchPromise: Promise<void> = Promise.resolve();
            let detachSigint: (() => void) | undefined;

            try {
              const res = await core.tasks.start({
                itemCount,
                notBeforeAt: opts.since,
                hostId: host?.success ? host.data : undefined,
                bgmFile: opts.bgm,
                trigger,
                scheduleId: opts.scheduleId,
                detach: false,
                onCreated: (rid) => {
                  createdRunId = rid;
                  detachSigint = attachSingleSigint(() => {
                    void core.tasks.cancel(rid).catch((cancelErr) => {
                      if (!jsonMode) {
                        io.stderr(
                          `发送取消请求失败: ${cancelErr instanceof Error ? cancelErr.message : String(cancelErr)}\n`,
                        );
                      }
                    });
                  });
                  watchPromise = core.tasks
                    .watch(
                      rid,
                      (ev) => {
                        if (!jsonMode) {
                          io.stdout(`${formatRunEventLine(ev, timezone)}\n`);
                        }
                      },
                      watchCtrl.signal,
                      { pollMs: 120 },
                    )
                    .catch((watchErr) => {
                      if (watchCtrl.signal.aborted) {
                        return;
                      }
                      if (!jsonMode) {
                        io.stderr(
                          `日志监听异常结束: ${watchErr instanceof Error ? watchErr.message : String(watchErr)}\n`,
                        );
                      }
                    });
                },
              });
              createdRunId = res.runId;
              await watchPromise;
            } catch (err) {
              watchCtrl.abort();
              await watchPromise;
              throw err;
            } finally {
              watchCtrl.abort();
              detachSigint?.();
            }

            const detail = await core.tasks.get(createdRunId);
            print(
              detail,
              `\n任务 ${detail.id} 当前状态：${detail.status}（阶段：${detail.currentStage ?? '-'}）`,
            );
            return 0;
          } catch (err) {
            if (
              (err instanceof LockBusyError ||
                (err instanceof Error && err.name === 'LockBusyError')) &&
              trigger === 'schedule'
            ) {
              print({ skipped: true, reason: err.message }, `定时任务已跳过：${err.message}`);
              return 0;
            }
            throw err;
          }
        });
        setExit(code);
      },
    );

  // 2. aidaily resume <runId> [--from <stage>] [--latest-config] [--detach]
  program
    .command('resume')
    .description('恢复中断/失败的任务，或从指定历史阶段重新执行')
    .argument('<runId>', '任务 ID')
    .option('--from <stage>', '从指定自动化阶段重新开始并作废归档之后产物')
    .option('--latest-config', '使用磁盘最新配置刷新本期任务快照', false)
    .option('--detach', '在后台独立进程中异步恢复', false)
    .action(
      async (
        runId: string,
        opts: { from?: string; latestConfig: boolean; detach: boolean },
        cmd: Command,
      ) => {
        const gOpts = getGlobals(cmd);
        const jsonMode = Boolean(gOpts.json);
        const print = createPrinter(io, jsonMode);

        let fromStage: Stage | undefined;
        if (opts.from !== undefined) {
          const parsed = StageSchema.safeParse(opts.from);
          if (!parsed.success || !(PIPELINE_STAGES as readonly string[]).includes(parsed.data)) {
            throw new CliUsageError(
              `非法的重跑阶段 "${opts.from}"，支持: ${PIPELINE_STAGES.join(', ')}`,
            );
          }
          fromStage = parsed.data;
        }

        const code = await withCore(gOpts, async (core) => {
          if (opts.detach) {
            await core.tasks.resume(runId, {
              fromStage,
              useLatestConfig: opts.latestConfig,
              detach: true,
            });
            print(
              {
                runId,
                fromStage: fromStage ?? null,
                latestConfig: opts.latestConfig,
                detached: true,
              },
              `已提交后台恢复任务 ${runId}${fromStage ? `（起点：${fromStage}）` : '（从断点继续）'}。`,
            );
            return 0;
          }

          const afterId = await getLatestEventId(core, runId);
          await watchForegroundTask(
            core,
            runId,
            afterId,
            jsonMode,
            core.tasks.resume(runId, {
              fromStage,
              useLatestConfig: opts.latestConfig,
              detach: false,
            }),
          );
          const detail = await core.tasks.get(runId);
          print(detail, `\n任务 ${detail.id} 恢复完成，当前状态：${detail.status}`);
          return 0;
        });
        setExit(code);
      },
    );

  // 3. aidaily retry-item <runId> <itemIds...> [--from summarize|polish|factcheck] [--latest-config] [--detach]
  program
    .command('retry-item')
    .description(
      '重新处理一条或多条新闻（支持空格或逗号分隔多个 ID 并发执行），完成后统一重新编排与合成',
    )
    .argument('<runId>', '任务 ID')
    .argument('<itemIds...>', '一个或多个新闻条目 ID')
    .option('--from <step>', '起始处理子步骤 (summarize | polish | factcheck)')
    .option('--latest-config', '使用磁盘最新配置刷新本期快照', false)
    .option('--detach', '在后台独立进程中异步重做', false)
    .action(
      async (
        runId: string,
        rawItemIds: string[],
        opts: { from?: string; latestConfig: boolean; detach: boolean },
        cmd: Command,
      ) => {
        const gOpts = getGlobals(cmd);
        const jsonMode = Boolean(gOpts.json);
        const print = createPrinter(io, jsonMode);

        const itemIds = Array.from(
          new Set(
            rawItemIds
              .flatMap((token) => token.split(','))
              .map((id) => id.trim())
              .filter(Boolean),
          ),
        );
        if (itemIds.length === 0) {
          throw new CliUsageError('请至少提供一个新闻条目 ID');
        }
        const singleItemId = itemIds.length === 1 ? itemIds[0] : undefined;

        let fromStep: (typeof EDIT_SUB_STEPS)[number] | undefined;
        if (opts.from !== undefined) {
          if (!(EDIT_SUB_STEPS as readonly string[]).includes(opts.from)) {
            throw new CliUsageError(
              `非法的条目重跑步骤 "${opts.from}"，支持: ${EDIT_SUB_STEPS.join(', ')}`,
            );
          }
          fromStep = opts.from as (typeof EDIT_SUB_STEPS)[number];
        }

        const code = await withCore(gOpts, async (core) => {
          if (opts.detach) {
            await core.tasks.retryItems(runId, itemIds, {
              fromStep,
              useLatestConfig: opts.latestConfig,
              detach: true,
            });
            print(
              {
                runId,
                ...(singleItemId !== undefined ? { itemId: singleItemId } : {}),
                itemIds,
                fromStep: fromStep ?? 'summarize',
                detached: true,
              },
              singleItemId !== undefined
                ? `已提交后台单条重试：任务 ${runId} 条目 ${singleItemId}。`
                : `已提交后台批量并发重试：任务 ${runId} 共 ${itemIds.length} 条新闻（${itemIds.join(', ')}）。`,
            );
            return 0;
          }

          const afterId = await getLatestEventId(core, runId);
          await watchForegroundTask(
            core,
            runId,
            afterId,
            jsonMode,
            core.tasks.retryItems(runId, itemIds, {
              fromStep,
              useLatestConfig: opts.latestConfig,
              detach: false,
            }),
          );
          const detail = await core.tasks.get(runId);
          print(detail, `\n新闻条目重试完成，任务 ${detail.id} 当前状态：${detail.status}`);
          return 0;
        });
        setExit(code);
      },
    );

  // 4. aidaily retry-options <runId>
  program
    .command('retry-options')
    .description('查询指定任务当前允许的断点续跑点、可重跑阶段与截止时间')
    .argument('<runId>', '任务 ID')
    .action(async (runId: string, _opts: Record<string, unknown>, cmd: Command) => {
      const gOpts = getGlobals(cmd);
      const print = createPrinter(io, Boolean(gOpts.json));
      const code = await withCore(gOpts, async (core) => {
        const opts = await core.tasks.getRetryOptions(runId);
        print(opts, formatRetryOptionsText(opts, core.config.getSettings().timezone));
        return 0;
      });
      setExit(code);
    });

  // 5. aidaily abandon <runId>
  program
    .command('abandon')
    .description('放弃未完成或不再发布的任务，并立即释放其预留的新闻文章')
    .argument('<runId>', '任务 ID')
    .action(async (runId: string, _opts: Record<string, unknown>, cmd: Command) => {
      const gOpts = getGlobals(cmd);
      const print = createPrinter(io, Boolean(gOpts.json));
      const code = await withCore(gOpts, async (core) => {
        await core.tasks.abandon(runId);
        print({ runId, abandoned: true }, `已放弃任务 ${runId} 并释放占用的候选文章。`);
        return 0;
      });
      setExit(code);
    });

  // 6. aidaily cancel <runId>
  program
    .command('cancel')
    .description('向排队中或正在执行的任务发出停止信号（停止后仍可随时恢复）')
    .argument('<runId>', '任务 ID')
    .action(async (runId: string, _opts: Record<string, unknown>, cmd: Command) => {
      const gOpts = getGlobals(cmd);
      const print = createPrinter(io, Boolean(gOpts.json));
      const code = await withCore(gOpts, async (core) => {
        await core.tasks.cancel(runId);
        print({ runId, cancelRequested: true }, `已向任务 ${runId} 发送取消请求。`);
        return 0;
      });
      setExit(code);
    });

  // 7. aidaily runs [--status <s,...>] [--limit 20]
  program
    .command('runs')
    .description('查看历史与当前视频生成任务列表')
    .option('--status <statuses>', '按任务状态筛选（支持逗号分隔多状态）')
    .option('--limit <n>', '返回最大条数', '20')
    .action(async (opts: { status?: string; limit: string }, cmd: Command) => {
      const gOpts = getGlobals(cmd);
      const print = createPrinter(io, Boolean(gOpts.json));
      const limit = parsePositiveInt(opts.limit, '--limit');

      let statuses: RunStatus[] | undefined;
      if (opts.status !== undefined) {
        statuses = opts.status
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
          .map((raw) => {
            const parsed = RunStatusSchema.safeParse(raw);
            if (!parsed.success) {
              throw new CliUsageError(`无效的任务状态过滤条件: ${raw}`);
            }
            return parsed.data;
          });
        if (statuses.length === 0) {
          throw new CliUsageError('参数 --status 不能为空，请至少指定一个有效任务状态');
        }
      }

      const code = await withCore(gOpts, async (core) => {
        const list = await core.tasks.list({ status: statuses, limit });
        print(list, formatRunsTable(list, core.config.getSettings().timezone));
        return 0;
      });
      setExit(code);
    });

  // 8. aidaily show <runId> [--items]
  program
    .command('show')
    .description('查看单期任务的阶段进展、新闻条目与产物清单')
    .argument('<runId>', '任务 ID')
    .option('--items', '同时输出各条新闻在写稿与核查阶段的全部版本历史', false)
    .action(async (runId: string, opts: { items: boolean }, cmd: Command) => {
      const gOpts = getGlobals(cmd);
      const jsonMode = Boolean(gOpts.json);
      const print = createPrinter(io, jsonMode);

      const code = await withCore(gOpts, async (core) => {
        const detail = await core.tasks.get(runId);
        if (!opts.items) {
          print(detail, formatRunDetailText(detail, core.config.getSettings().timezone, false));
          return 0;
        }
        const itemHistories = await Promise.all(
          detail.items.map(async (item) => ({
            itemId: item.id,
            versions: await core.tasks.getItemHistory(item.id),
          })),
        );
        const text = `${formatRunDetailText(detail, core.config.getSettings().timezone, true)}\n\n版本与核查历史条数:\n${itemHistories
          .map(
            (h) =>
              `  - ${h.itemId}: ${h.versions.map((v) => `${v.kind}(#${v.round})`).join(' -> ') || '暂无'}`,
          )
          .join('\n')}`;
        print({ ...detail, itemHistories }, text);
        return 0;
      });
      setExit(code);
    });

  // 9. aidaily logs <runId> [-f]
  program
    .command('logs')
    .description('查看或实时追踪某期任务的执行事件日志')
    .argument('<runId>', '任务 ID')
    .option('-f, --follow', '持续实时跟随最新事件日志', false)
    .action(async (runId: string, opts: { follow: boolean }, cmd: Command) => {
      const gOpts = getGlobals(cmd);
      const jsonMode = Boolean(gOpts.json);

      const code = await withCore(gOpts, async (core) => {
        const timezone = core.config.getSettings().timezone;
        await core.tasks.get(runId);

        const collected: Awaited<ReturnType<Core['tasks']['events']>> = [];
        let cursor = 0;
        while (true) {
          const batch = await core.tasks.events(runId, cursor, 500);
          if (batch.length === 0) {
            break;
          }
          for (const ev of batch) {
            cursor = Math.max(cursor, ev.id);
            collected.push(ev);
          }
          if (batch.length < 500) {
            break;
          }
        }

        if (!opts.follow) {
          if (jsonMode) {
            io.stdout(`${JSON.stringify(collected, null, 2)}\n`);
          } else {
            for (const ev of collected) {
              io.stdout(`${formatRunEventLine(ev, timezone)}\n`);
            }
          }
          return 0;
        }

        for (const ev of collected) {
          io.stdout(jsonMode ? `${JSON.stringify(ev)}\n` : `${formatRunEventLine(ev, timezone)}\n`);
        }

        const ctrl = new AbortController();
        const detachSigint = attachSingleSigint(() => ctrl.abort());
        try {
          await core.tasks.watch(
            runId,
            (ev) => {
              io.stdout(
                jsonMode ? `${JSON.stringify(ev)}\n` : `${formatRunEventLine(ev, timezone)}\n`,
              );
            },
            ctrl.signal,
            { afterId: cursor, pollMs: 150 },
          );
        } finally {
          detachSigint();
        }
        return 0;
      });
      setExit(code);
    });

  // 10. aidaily review <runId> [--open]
  program
    .command('review')
    .description('查看待审核成片标题、章节简介、标签与文件位置')
    .argument('<runId>', '任务 ID')
    .option('--open', '使用系统默认视频播放器打开成片', false)
    .action(async (runId: string, opts: { open: boolean }, cmd: Command) => {
      const gOpts = getGlobals(cmd);
      const print = createPrinter(io, Boolean(gOpts.json));

      const code = await withCore(gOpts, async (core) => {
        const draft = await core.publish.getDraft(runId);
        const absVideoPath = core.tasks.resolveArtifact(runId, 'output/video.mp4');
        const absCoverPath = core.tasks.resolveArtifact(runId, 'output/cover.jpg');
        if (opts.open) {
          if (!fsSync.existsSync(absVideoPath)) {
            throw new Error(`找不到待预览的视频成片文件: ${absVideoPath}`);
          }
          const openCode = await spawnInheritProcess('open', [absVideoPath]);
          if (openCode !== 0) {
            throw new Error(`调用系统播放器打开视频失败（退出码 ${openCode}）`);
          }
        }
        print(
          { ...draft, absVideoPath, absCoverPath },
          formatDraftReviewText(draft, absVideoPath, absCoverPath),
        );
        return 0;
      });
      setExit(code);
    });

  // 10b. aidaily cover <runId> [--title <t>] [--subtitle <s>]
  program
    .command('cover')
    .description('查看本期封面文字；传入 --title / --subtitle 时修改文字并只重新生成封面图片')
    .argument('<runId>', '任务 ID')
    .option('--title <title>', '封面主标题（可用 *星号* 包住要高亮的词，\\n 可手动换行）')
    .option('--subtitle <subtitle>', '封面副标题（传空字符串表示不要副标题）')
    .action(async (runId: string, opts: { title?: string; subtitle?: string }, cmd: Command) => {
      const gOpts = getGlobals(cmd);
      const print = createPrinter(io, Boolean(gOpts.json));
      const code = await withCore(gOpts, async (core) => {
        const changed = opts.title !== undefined || opts.subtitle !== undefined;
        const state = changed
          ? await core.publish.updateCover(runId, { title: opts.title, subtitle: opts.subtitle })
          : await core.publish.getCover(runId);
        const absCoverPath = core.tasks.resolveArtifact(runId, 'output/cover.jpg');
        const sourceText = { manual: '人工修改', package: 'AI 编排生成', fallback: '自动截取' }[
          state.source
        ];
        print(
          { ...state, absCoverPath },
          [
            changed ? '封面文字已保存，封面图片已重新生成。' : '本期封面文字：',
            `  主标题：${state.text.title}`,
            `  副标题：${state.text.subtitle || '（无）'}`,
            `  来源：${sourceText}`,
            `  封面图片：${absCoverPath}`,
          ].join('\n'),
        );
        return 0;
      });
      setExit(code);
    });

  // 11. aidaily approve <runId> [--title <t>] [--desc-file <f>] [--tags a,b] [--detach]
  program
    .command('approve')
    .description('确认成片审核通过，可选更新文案后立即投稿 B 站（强制开启 AI 声明）')
    .argument('<runId>', '任务 ID')
    .option('--title <title>', '投稿前覆盖视频标题')
    .option('--desc-file <file>', '从本地文本文件读取并覆盖视频简介')
    .option('--tags <tags>', '用逗号分隔覆盖视频标签列表')
    .option('--detach', '在后台独立进程中执行上传并返回', false)
    .action(
      async (
        runId: string,
        opts: { title?: string; descFile?: string; tags?: string; detach: boolean },
        cmd: Command,
      ) => {
        const gOpts = getGlobals(cmd);
        const print = createPrinter(io, Boolean(gOpts.json));

        let description: string | undefined;
        if (opts.descFile) {
          description = await fs.readFile(path.resolve(opts.descFile), 'utf8');
        }
        const tags =
          opts.tags !== undefined
            ? opts.tags
                .split(',')
                .map((t) => t.trim())
                .filter(Boolean)
            : undefined;

        const code = await withCore(gOpts, async (core) => {
          if (opts.title !== undefined || description !== undefined || tags !== undefined) {
            await core.publish.updateDraft(runId, {
              title: opts.title,
              description,
              tags,
            });
          }
          await core.publish.approve(runId, { detach: opts.detach });
          const pub = (await core.tasks.get(runId)).publishRecord;
          print(
            { runId, detached: opts.detach, publishRecord: pub },
            opts.detach
              ? `已提交后台上传任务 ${runId}。`
              : `任务 ${runId} 已完成 B 站投稿${pub?.bvid ? `（BV 号：${pub.bvid}）` : ''}。`,
          );
          return 0;
        });
        setExit(code);
      },
    );

  // 12. aidaily reject <runId> [--reason <r>]
  program
    .command('reject')
    .description('人工审核驳回本期内容，并立即释放所占用的候选文章')
    .argument('<runId>', '任务 ID')
    .option('--reason <reason>', '填写驳回原因说明')
    .action(async (runId: string, opts: { reason?: string }, cmd: Command) => {
      const gOpts = getGlobals(cmd);
      const print = createPrinter(io, Boolean(gOpts.json));
      const code = await withCore(gOpts, async (core) => {
        await core.publish.reject(runId, opts.reason);
        print({ runId, rejected: true, reason: opts.reason ?? null }, `已驳回任务 ${runId}。`);
        return 0;
      });
      setExit(code);
    });

  // 13. aidaily consume <runId>
  program
    .command('consume')
    .description('不向 B 站投稿发布，仅将本期已选新闻计入历史已播库并释放多余文章')
    .argument('<runId>', '任务 ID')
    .action(async (runId: string, _opts: Record<string, unknown>, cmd: Command) => {
      const gOpts = getGlobals(cmd);
      const print = createPrinter(io, Boolean(gOpts.json));
      const code = await withCore(gOpts, async (core) => {
        await core.publish.markConsumed(runId);
        print({ runId, consumedOnly: true }, `已将任务 ${runId} 标记为本地仅消费完结。`);
        return 0;
      });
      setExit(code);
    });

  // 14. aidaily publish-retry <runId> [--detach]
  program
    .command('publish-retry')
    .description('对明确发布失败的期次重新发起 B 站上传（不适用于状态不明任务）')
    .argument('<runId>', '任务 ID')
    .option('--detach', '在后台独立进程中重传', false)
    .action(async (runId: string, opts: { detach: boolean }, cmd: Command) => {
      const gOpts = getGlobals(cmd);
      const print = createPrinter(io, Boolean(gOpts.json));
      const code = await withCore(gOpts, async (core) => {
        await core.publish.retry(runId, { detach: opts.detach });
        const pub = (await core.tasks.get(runId)).publishRecord;
        print(
          { runId, detached: opts.detach, publishRecord: pub },
          opts.detach
            ? `已提交后台重传任务 ${runId}。`
            : `任务 ${runId} 重试上传成功${pub?.bvid ? `（BV 号：${pub.bvid}）` : ''}。`,
        );
        return 0;
      });
      setExit(code);
    });

  // 15. aidaily publish-confirm <runId> (--not-published | --bvid <BV>)
  program
    .command('publish-confirm')
    .description('对上传途中中断且状态不明的期次人工核对定案')
    .argument('<runId>', '任务 ID')
    .option('--not-published', '确认平台未收到稿件，重置为可重传状态', false)
    .option('--bvid <bvid>', '确认平台已收稿并填写对应 BV 号完成消费提交')
    .action(async (runId: string, opts: { notPublished: boolean; bvid?: string }, cmd: Command) => {
      const gOpts = getGlobals(cmd);
      const print = createPrinter(io, Boolean(gOpts.json));

      const hasNotPublished = Boolean(opts.notPublished);
      const hasBvid = Boolean(opts.bvid);
      if (hasNotPublished === hasBvid) {
        throw new CliUsageError('必须且仅能传入 --not-published 或 --bvid <BV号> 其中之一');
      }

      const code = await withCore(gOpts, async (core) => {
        if (hasNotPublished) {
          await core.publish.confirmUncertain(runId, { published: false });
          print(
            { runId, published: false },
            `已确认任务 ${runId} 平台尚未收稿，现在可通过 publish-retry 重试上传。`,
          );
        } else if (opts.bvid) {
          await core.publish.confirmUncertain(runId, { published: true, bvid: opts.bvid });
          print(
            { runId, published: true, bvid: opts.bvid },
            `已确认任务 ${runId} 收稿成功（${opts.bvid}）并完成新闻消费提交。`,
          );
        }
        return 0;
      });
      setExit(code);
    });

  // 16. aidaily config get [path] / set <path> <value>
  const configCmd = program.command('config').description('读写全局系统配置（支持点号嵌套路径）');

  configCmd
    .command('get')
    .description('读取整份系统配置或指定点号路径的当前值')
    .argument('[dotPath]', '可选配置路径，例如 ai.stages.polish.model')
    .action(async (dotPath: string | undefined, _opts: Record<string, unknown>, cmd: Command) => {
      const gOpts = getGlobals(cmd);
      const print = createPrinter(io, Boolean(gOpts.json));
      const code = await withCore(gOpts, async (core) => {
        const val = getByDotPath(core.config.getSettings(), dotPath);
        const text =
          typeof val === 'string' || typeof val === 'number' || typeof val === 'boolean'
            ? String(val)
            : JSON.stringify(val, null, 2);
        print(val, text);
        return 0;
      });
      setExit(code);
    });

  configCmd
    .command('set')
    .description('修改指定配置路径的值并写回 YAML 配置文件（保留原注释）')
    .argument('<dotPath>', '配置路径，例如 ai.stages.polish.model')
    .argument('<rawValue>', '新的配置值（支持数字、布尔值、JSON 或纯文本）')
    .action(
      async (dotPath: string, rawValue: string, _opts: Record<string, unknown>, cmd: Command) => {
        const gOpts = getGlobals(cmd);
        const print = createPrinter(io, Boolean(gOpts.json));
        const parsedVal = parseCliValue(rawValue);
        const patch = buildPatchFromDotPath(dotPath, parsedVal);

        const code = await withCore(gOpts, async (core) => {
          let updated: Awaited<ReturnType<Core['config']['updateSettings']>>;
          try {
            updated = await core.config.updateSettings(patch);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            if (msg.includes('校验失败') || (err instanceof Error && err.name === 'ZodError')) {
              throw new CliUsageError(msg);
            }
            throw err;
          }
          const savedValue = getByDotPath(updated, dotPath);
          print(
            { path: dotPath, value: savedValue },
            `已更新配置 ${dotPath} = ${JSON.stringify(savedValue)}`,
          );
          return 0;
        });
        setExit(code);
      },
    );

  // 17. aidaily sources [list | test <id>]
  const sourcesCmd = program
    .command('sources')
    .description('查看订阅信源健康状态或试抓单个信源')
    .action(async (_opts: Record<string, unknown>, cmd: Command) => {
      const gOpts = getGlobals(cmd);
      const print = createPrinter(io, Boolean(gOpts.json));
      const code = await withCore(gOpts, async (core) => {
        const list = await core.sources.list();
        print(list, formatSourcesTable(list, core.config.getSettings().timezone));
        return 0;
      });
      setExit(code);
    });

  sourcesCmd
    .command('list')
    .description('列出全部订阅信源及其抓取健康统计')
    .action(async (_opts: Record<string, unknown>, cmd: Command) => {
      const gOpts = getGlobals(cmd);
      const print = createPrinter(io, Boolean(gOpts.json));
      const code = await withCore(gOpts, async (core) => {
        const list = await core.sources.list();
        print(list, formatSourcesTable(list, core.config.getSettings().timezone));
        return 0;
      });
      setExit(code);
    });

  sourcesCmd
    .command('test')
    .description('对指定信源立即执行一次直接试抓诊断')
    .argument('<sourceId>', '信源 ID')
    .action(async (sourceId: string, _opts: Record<string, unknown>, cmd: Command) => {
      const gOpts = getGlobals(cmd);
      const print = createPrinter(io, Boolean(gOpts.json));
      const code = await withCore(gOpts, async (core) => {
        const result = await core.sources.test(sourceId);
        print(result, formatSourceTestText(result));
        return result.ok ? 0 : 1;
      });
      setExit(code);
    });

  // 18. aidaily schedule list | create | update | remove | sync
  const scheduleCmd = program.command('schedule').description('管理每天自动运行的 macOS 定时任务');

  scheduleCmd
    .command('list')
    .description('查看所有已配置的定时任务与系统挂载状态')
    .action(async (_opts: Record<string, unknown>, cmd: Command) => {
      const gOpts = getGlobals(cmd);
      const print = createPrinter(io, Boolean(gOpts.json));
      const code = await withCore(gOpts, async (core) => {
        const jobs = await core.scheduler.list();
        print(jobs, formatSchedulesTable(jobs, core.config.getSettings().timezone));
        return 0;
      });
      setExit(code);
    });

  scheduleCmd
    .command('create')
    .description('新建每日定时任务（执行时间和新闻条数均必须显式填写，不设默认值）')
    .requiredOption('--time <HH:mm>', '每日执行时间（24 小时制 HH:mm，必填）')
    .requiredOption('-n, --items <N>', '每次抓取制作的新闻条数（正整数，必填）')
    .option('--name <name>', '自定义定时任务名称')
    .option('--cutoff <mode>', '最早新闻时间策略 (none | since_last_published | hours)', 'none')
    .option('--max-age-hours <H>', '当策略为 hours 时的回溯小时数（正整数）')
    .option('--bgm <file>', '指定曲库中的背景音乐文件名')
    .option('--disabled', '创建后先保持停用状态，暂不挂载到系统调度器', false)
    .action(
      async (
        opts: {
          time: string;
          items: string;
          name?: string;
          cutoff: string;
          maxAgeHours?: string;
          bgm?: string;
          disabled: boolean;
        },
        cmd: Command,
      ) => {
        const gOpts = getGlobals(cmd);
        const print = createPrinter(io, Boolean(gOpts.json));

        const timeRes = ScheduleTimeSchema.safeParse(opts.time);
        if (!timeRes.success) {
          throw new CliUsageError(
            timeRes.error.issues[0]?.message ?? `非法的定时时间: ${opts.time}`,
          );
        }
        const itemCount = parsePositiveInt(opts.items, '-n/--items');
        const cutoffRes = ScheduleCutoffModeSchema.safeParse(opts.cutoff);
        if (!cutoffRes.success) {
          throw new CliUsageError(
            `非法的 --cutoff 策略 "${opts.cutoff}"，仅支持 none / since_last_published / hours`,
          );
        }
        const cutoffMode: ScheduleCutoffMode = cutoffRes.data;
        const maxAgeHours =
          opts.maxAgeHours !== undefined
            ? parsePositiveInt(opts.maxAgeHours, '--max-age-hours')
            : undefined;
        if (cutoffMode === 'hours' && maxAgeHours === undefined) {
          throw new CliUsageError('当 --cutoff 为 hours 时必须传入正整数 --max-age-hours');
        }
        if (cutoffMode !== 'hours' && maxAgeHours !== undefined) {
          throw new CliUsageError('--max-age-hours 仅在 --cutoff hours 时有效');
        }

        const code = await withCore(gOpts, async (core) => {
          const job = await core.scheduler.create({
            name: opts.name,
            time: timeRes.data,
            itemCount,
            cutoffMode,
            maxAgeHours,
            bgmFile: opts.bgm,
            enabled: !opts.disabled,
          });
          print(job, formatSchedulesTable([job], core.config.getSettings().timezone));
          return 0;
        });
        setExit(code);
      },
    );

  scheduleCmd
    .command('update')
    .description('修改指定定时任务的触发时间、每期条数或启停状态')
    .argument('<id>', '定时任务 ID')
    .option('--name <name>', '新的任务名称')
    .option('--time <HH:mm>', '新的每日触发时间（HH:mm）')
    .option('-n, --items <N>', '新的每期新闻条数上限')
    .option('--cutoff <mode>', '新的最早新闻时间策略 (none | since_last_published | hours)')
    .option('--max-age-hours <H>', '当策略为 hours 时的回溯小时数（正整数）')
    .option('--bgm <file>', '曲库文件名；传 auto 恢复自动选择')
    .option('--enable', '启用并挂载到系统调度器', false)
    .option('--disable', '停用并从系统调度器卸载', false)
    .action(
      async (
        id: string,
        opts: {
          name?: string;
          time?: string;
          items?: string;
          cutoff?: string;
          maxAgeHours?: string;
          bgm?: string;
          enable: boolean;
          disable: boolean;
        },
        cmd: Command,
      ) => {
        const gOpts = getGlobals(cmd);
        const print = createPrinter(io, Boolean(gOpts.json));

        if (opts.enable && opts.disable) {
          throw new CliUsageError('不能同时传入 --enable 和 --disable');
        }
        let nextTime: string | undefined;
        if (opts.time !== undefined) {
          const parsedTime = ScheduleTimeSchema.safeParse(opts.time);
          if (!parsedTime.success) {
            throw new CliUsageError(
              parsedTime.error.issues[0]?.message ?? `非法的定时时间: ${opts.time}`,
            );
          }
          nextTime = parsedTime.data;
        }
        const nextItems =
          opts.items !== undefined ? parsePositiveInt(opts.items, '-n/--items') : undefined;
        let nextCutoffMode: ScheduleCutoffMode | undefined;
        if (opts.cutoff !== undefined) {
          const cutoffRes = ScheduleCutoffModeSchema.safeParse(opts.cutoff);
          if (!cutoffRes.success) {
            throw new CliUsageError(
              `非法的 --cutoff 策略 "${opts.cutoff}"，仅支持 none / since_last_published / hours`,
            );
          }
          nextCutoffMode = cutoffRes.data;
        }
        const nextMaxAgeHours =
          opts.maxAgeHours !== undefined
            ? parsePositiveInt(opts.maxAgeHours, '--max-age-hours')
            : undefined;
        const nextEnabled = opts.enable ? true : opts.disable ? false : undefined;

        const code = await withCore(gOpts, async (core) => {
          const updated = await core.scheduler.update(id, {
            name: opts.name,
            time: nextTime,
            itemCount: nextItems,
            cutoffMode: nextCutoffMode,
            maxAgeHours: nextMaxAgeHours,
            bgmFile: opts.bgm === 'auto' ? null : opts.bgm,
            enabled: nextEnabled,
          });
          print(updated, formatSchedulesTable([updated], core.config.getSettings().timezone));
          return 0;
        });
        setExit(code);
      },
    );

  scheduleCmd
    .command('remove')
    .description('删除指定定时任务并移除对应系统调度配置')
    .argument('<id>', '定时任务 ID')
    .action(async (id: string, _opts: Record<string, unknown>, cmd: Command) => {
      const gOpts = getGlobals(cmd);
      const print = createPrinter(io, Boolean(gOpts.json));
      const code = await withCore(gOpts, async (core) => {
        await core.scheduler.remove(id);
        print({ id, removed: true }, `已删除并卸载定时任务 ${id}。`);
        return 0;
      });
      setExit(code);
    });

  scheduleCmd
    .command('sync')
    .description('将数据库中的所有定时任务重新同步到 macOS launchd')
    .action(async (_opts: Record<string, unknown>, cmd: Command) => {
      const gOpts = getGlobals(cmd);
      const print = createPrinter(io, Boolean(gOpts.json));
      const code = await withCore(gOpts, async (core) => {
        await core.scheduler.sync();
        const jobs = await core.scheduler.list();
        print({ synced: jobs.length, jobs }, `已全量同步 ${jobs.length} 条定时任务到系统调度器。`);
        return 0;
      });
      setExit(code);
    });

  // 19. aidaily models [--cli agy]
  program
    .command('models')
    .description('查询指定调用方式提供的模型列表')
    .option('--cli <cli>', '本机 CLI 或 HTTP API 的配置名称', 'agy')
    .action(async (opts: { cli: string }, cmd: Command) => {
      const gOpts = getGlobals(cmd);
      const print = createPrinter(io, Boolean(gOpts.json));
      const code = await withCore(gOpts, async (core) => {
        const models = await core.system.listModels(opts.cli);
        const text =
          models.length > 0 ? models.map((m) => `  - ${m}`).join('\n') : '未查询到可用模型。';
        print(
          { cli: opts.cli, models },
          `调用方式「${opts.cli}」的模型列表（共 ${models.length} 个）\n${text}`,
        );
        return 0;
      });
      setExit(code);
    });

  // 20. aidaily doctor
  program
    .command('doctor')
    .description('检查 Node、大模型工具、音视频依赖、Chromium、投稿工具、语音合成与磁盘空间')
    .action(async (_opts: Record<string, unknown>, cmd: Command) => {
      const gOpts = getGlobals(cmd);
      const print = createPrinter(io, Boolean(gOpts.json));
      const code = await withCore(gOpts, async (core) => {
        const report = await core.system.doctor();
        print(report, formatDoctorReportText(report, core.config.getSettings().timezone));
        return report.ok ? 0 : 1;
      });
      setExit(code);
    });

  // 21. aidaily bili login
  const biliCmd = program.command('bili').description('B 站账号登录与凭据辅助操作');

  biliCmd
    .command('login')
    .description('调用 biliup 启动交互式扫码登录，Cookie 保存到配置指定路径')
    .action(async (_opts: Record<string, unknown>, cmd: Command) => {
      const gOpts = getGlobals(cmd);
      const code = await withCore(gOpts, async (core) => {
        const { bin, args } = core.publish.biliLoginCommand();
        return spawnInheritProcess(bin, args);
      });
      setExit(code);
    });

  // 22. aidaily x-login [--import <file>] [--status]
  program
    .command('x-login')
    .description('管理 X (Twitter) 网页抓取登录态 Cookie（支持交互式浏览器登录或导入 Cookie 文件）')
    .option('--import <file>', '从本地 Netscape cookies.txt 或 JSON Cookie 导出文件导入')
    .option('--status', '仅查看当前 X Cookie 配置与有效性状态', false)
    .action(async (opts: { import?: string; status: boolean }, cmd: Command) => {
      const gOpts = getGlobals(cmd);
      const print = createPrinter(io, Boolean(gOpts.json));

      if (opts.status && opts.import) {
        throw new CliUsageError('不能同时传入 --status 和 --import');
      }

      const code = await withCore(gOpts, async (core) => {
        if (opts.status) {
          const status = await core.sources.getXAuthStatus();
          print(status, `${status.detail}\n凭证路径: ${status.cookiePath}`);
          return 0;
        }
        if (opts.import) {
          const absFile = path.resolve(opts.import);
          const raw = await fs.readFile(absFile, 'utf8');
          const status = await core.sources.importXCookies(raw);
          print(status, `X Cookie 导入成功：${status.detail}\n已保存至: ${status.cookiePath}`);
          return 0;
        }
        const status = await core.sources.loginXInteractive();
        print(status, `X 登录完成：${status.detail}\n已保存至: ${status.cookiePath}`);
        return 0;
      });
      setExit(code);
    });

  configureCommandTree(program, io, true);
  return program;
}

/** 执行一次完整的命令行解析与业务分发，并返回标准退出码（0 成功 / 1 运行错误 / 2 参数错误 / 3 锁被占用） */
export async function runCli(argv: readonly string[], io: CliIo = DEFAULT_IO): Promise<number> {
  let exitCode = 0;
  const program = buildProgram(io, (code) => {
    exitCode = code;
  });

  try {
    await program.parseAsync([...argv], { from: 'user' });
    return exitCode;
  } catch (err) {
    const mappedCode = mapErrorToExitCode(err);
    const jsonRequested = hasJsonFlag(program, argv);

    if (err instanceof CommanderError) {
      if (mappedCode !== 0 && jsonRequested) {
        io.stderr(`${JSON.stringify({ error: err.message, code: mappedCode })}\n`);
      }
      return mappedCode;
    }

    const msg = err instanceof Error ? err.message : String(err);
    if (jsonRequested) {
      io.stderr(`${JSON.stringify({ error: msg, code: mappedCode })}\n`);
    } else {
      io.stderr(`错误: ${msg}\n`);
    }
    return mappedCode;
  }
}

/** 判断当前文件是否直接作为可执行入口脚本启动（兼容含中文的路径对比） */
function isMainModule(metaUrl: string): boolean {
  const arg = process.argv[1];
  if (!arg) {
    return false;
  }
  try {
    return fsSync.realpathSync(fileURLToPath(metaUrl)) === fsSync.realpathSync(arg);
  } catch {
    return false;
  }
}

if (isMainModule(import.meta.url)) {
  process.exitCode = await runCli(process.argv.slice(2));
}
