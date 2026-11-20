import {
  type ErrorCode,
  HostMascotIdSchema,
  PIPELINE_STAGES,
  type RunEvent,
  type RunEventLevel,
  type RunStageRecord,
  type RunStatus,
  type RunSummary,
  type Stage,
  type StageStatus,
  type Trigger,
} from '@aidaily/contracts';
import { type DatabaseSync, inTransaction } from '../db.js';

/** 校验分页上限参数为不超过指定最大值的正整数 */
function clampLimit(limit: number, maxLimit = 500): number {
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new RangeError(`查询数量上限 limit 必须为正整数: ${String(limit)}`);
  }
  return Math.min(limit, maxLimit);
}

/** 互斥锁原子抢占或接管的执行结果 */
export type LockAcquireResult =
  | { acquired: true; takenOverFrom?: LockRow }
  | { acquired: false; holder: LockRow };

/** 数据库 `runs` 表原始行结构 */
interface RunRow {
  id: string;
  trigger: Trigger;
  schedule_id: string | null;
  status: RunStatus;
  current_stage: Stage | null;
  item_count: number;
  not_before_at: string | null;
  host_id: string | null;
  bgm_file: string | null;
  media_dirty: number;
  config_snapshot: string;
  cancel_requested: number;
  attempt: number;
  error_code: ErrorCode | null;
  error: string | null;
  pid: number | null;
  heartbeat_at: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  retry_deadline_at: string | null;
}

/** 包含配置快照、取消标志与进程心跳的单期任务完整表记录 */
export interface RunRowDetail extends RunSummary {
  configSnapshotJson: string;
  cancelRequested: boolean;
  pid: number | null;
  heartbeatAt: string | null;
}

/** 数据库 `run_stages` 表行结构 */
interface RunStageRow {
  run_id: string;
  stage: Stage;
  status: StageStatus;
  attempt: number;
  started_at: string | null;
  finished_at: string | null;
  error: string | null;
  checkpoint_path: string | null;
}

/** 数据库 `run_events` 表行结构 */
interface RunEventRow {
  id: number;
  run_id: string;
  ts: string;
  level: RunEventLevel;
  stage: Stage | null;
  item_id: string | null;
  type: string;
  message: string;
  data: string | null;
}

/** 任务互斥运行锁的数据库行结构 */
export interface LockRow {
  name: string;
  ownerRun: string | null;
  pid: number | null;
  acquiredAt: string | null;
  heartbeatAt: string | null;
}

/** 将任务表原始行映射为列表摘要对象 */
function mapRunSummary(row: RunRow): RunSummary {
  return {
    id: row.id,
    trigger: row.trigger,
    scheduleId: row.schedule_id,
    status: row.status,
    currentStage: row.current_stage,
    itemCount: row.item_count,
    notBeforeAt: row.not_before_at ?? null,
    hostId: HostMascotIdSchema.safeParse(row.host_id).data ?? null,
    bgmFile: row.bgm_file,
    mediaDirty: row.media_dirty === 1,
    attempt: row.attempt,
    errorCode: row.error_code,
    error: row.error,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    retryDeadlineAt: row.retry_deadline_at,
  };
}

/** 将任务表原始行映射为包含配置快照的完整对象 */
function mapRunRowDetail(row: RunRow): RunRowDetail {
  return {
    ...mapRunSummary(row),
    configSnapshotJson: row.config_snapshot,
    cancelRequested: row.cancel_requested === 1,
    pid: row.pid,
    heartbeatAt: row.heartbeat_at,
  };
}

/** 将步骤状态行映射为业务对象 */
function mapRunStage(row: RunStageRow): RunStageRecord {
  return {
    runId: row.run_id,
    stage: row.stage,
    status: row.status,
    attempt: row.attempt,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    error: row.error,
    checkpointPath: row.checkpoint_path,
  };
}

/** 将事件日志行映射为业务对象并反序列化附加 JSON 数据 */
function mapRunEvent(row: RunEventRow): RunEvent {
  return {
    id: row.id,
    runId: row.run_id,
    ts: row.ts,
    level: row.level,
    stage: row.stage,
    itemId: row.item_id,
    type: row.type,
    message: row.message,
    data: row.data ? (JSON.parse(row.data) as unknown) : null,
  };
}

/** 可更新的任务状态辅助字段集合 */
export interface RunStatusUpdateFields {
  currentStage?: Stage | null;
  errorCode?: ErrorCode | null;
  error?: string | null;
  pid?: number | null;
  heartbeatAt?: string | null;
  startedAt?: string | null;
  finishedAt?: string | null;
  retryDeadlineAt?: string | null;
  cancelRequested?: number;
  configSnapshotJson?: string;
}

/** 构造任务状态更新语句的 SET 子句与参数列表 */
function buildRunUpdateClause(
  status: RunStatus,
  opts?: RunStatusUpdateFields,
): { sets: string[]; params: Array<string | number | null> } {
  const sets = ['status = ?'];
  const params: Array<string | number | null> = [status];

  if (opts?.currentStage !== undefined) {
    sets.push('current_stage = ?');
    params.push(opts.currentStage);
  }
  if (opts?.errorCode !== undefined) {
    sets.push('error_code = ?');
    params.push(opts.errorCode);
  }
  if (opts?.error !== undefined) {
    sets.push('error = ?');
    params.push(opts.error);
  }
  if (opts?.pid !== undefined) {
    sets.push('pid = ?');
    params.push(opts.pid);
  }
  if (opts?.heartbeatAt !== undefined) {
    sets.push('heartbeat_at = ?');
    params.push(opts.heartbeatAt);
  }
  if (opts?.startedAt !== undefined) {
    sets.push('started_at = ?');
    params.push(opts.startedAt);
  }
  if (opts?.finishedAt !== undefined) {
    sets.push('finished_at = ?');
    params.push(opts.finishedAt);
  }
  if (opts?.retryDeadlineAt !== undefined) {
    sets.push('retry_deadline_at = ?');
    params.push(opts.retryDeadlineAt);
  }
  if (opts?.cancelRequested !== undefined) {
    sets.push('cancel_requested = ?');
    params.push(opts.cancelRequested);
  }
  if (opts?.configSnapshotJson !== undefined) {
    sets.push('config_snapshot = ?');
    params.push(opts.configSnapshotJson);
  }

  return { sets, params };
}

/** 创建任务主表操作对象，管理任务创建、状态流转、心跳与重试期限检查 */
export function createRunsRepo(db: DatabaseSync) {
  return {
    /** 新建一期任务记录，初始状态为排队中 */
    create(input: {
      id: string;
      trigger: Trigger;
      scheduleId?: string | null;
      itemCount: number;
      notBeforeAt?: string | null;
      configSnapshotJson: string;
      createdAt: string;
    }): void {
      db.prepare(`
        INSERT INTO runs (
          id, trigger, schedule_id, status, item_count, not_before_at, config_snapshot, created_at
        ) VALUES (?, ?, ?, 'queued', ?, ?, ?, ?)
      `).run(
        input.id,
        input.trigger,
        input.scheduleId ?? null,
        input.itemCount,
        input.notBeforeAt ?? null,
        input.configSnapshotJson,
        input.createdAt,
      );
    },

    /** 按任务 ID 查询完整任务信息 */
    getById(id: string): RunRowDetail | null {
      const row = db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as RunRow | undefined;
      return row ? mapRunRowDetail(row) : null;
    },

    /** 按状态和游标分页查询任务摘要列表（游标支持 `<createdAt>` 或 `<createdAt>|<id>`） */
    list(q?: { status?: RunStatus[]; limit?: number; before?: string }): RunSummary[] {
      const conditions: string[] = [];
      const params: Array<string | number> = [];

      if (q?.status && q.status.length > 0) {
        const placeholders = q.status.map(() => '?').join(', ');
        conditions.push(`status IN (${placeholders})`);
        params.push(...q.status);
      }
      if (q?.before) {
        const sepIdx = q.before.indexOf('|');
        if (sepIdx !== -1) {
          const beforeTs = q.before.slice(0, sepIdx);
          const beforeId = q.before.slice(sepIdx + 1);
          conditions.push('(created_at < ? OR (created_at = ? AND id < ?))');
          params.push(beforeTs, beforeTs, beforeId);
        } else {
          conditions.push('created_at < ?');
          params.push(q.before);
        }
      }

      const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
      const limit = clampLimit(q?.limit ?? 20, 500);
      params.push(limit);

      const rows = db
        .prepare(`SELECT * FROM runs ${where} ORDER BY created_at DESC, id DESC LIMIT ?`)
        .all(...params) as unknown as RunRow[];
      return rows.map(mapRunSummary);
    },

    /** 更新任务状态及相关时间戳、错误码或配置快照 */
    updateStatus(id: string, status: RunStatus, opts?: RunStatusUpdateFields): void {
      const { sets, params } = buildRunUpdateClause(status, opts);
      params.push(id);
      db.prepare(`UPDATE runs SET ${sets.join(', ')} WHERE id = ?`).run(...params);
    },

    /** 按预期状态与心跳时间戳原子比较并更新任务状态，防止并发覆盖刚恢复的新任务 */
    compareAndUpdateStatus(
      id: string,
      expectedStatuses: RunStatus[],
      expectedHeartbeatAt: string | null | undefined,
      status: RunStatus,
      opts?: RunStatusUpdateFields,
    ): boolean {
      if (expectedStatuses.length === 0) {
        return false;
      }
      const { sets, params } = buildRunUpdateClause(status, opts);
      const statusPlaceholders = expectedStatuses.map(() => '?').join(', ');
      params.push(id, ...expectedStatuses);

      let whereExtra = '';
      if (expectedHeartbeatAt !== undefined) {
        whereExtra = " AND COALESCE(heartbeat_at, '') = COALESCE(?, '')";
        params.push(expectedHeartbeatAt);
      }

      const res = db
        .prepare(
          `UPDATE runs SET ${sets.join(', ')} WHERE id = ? AND status IN (${statusPlaceholders})${whereExtra}`,
        )
        .run(...params);
      return Number(res.changes) > 0;
    },

    /** 更新运行中任务的最新存活心跳时间 */
    setHeartbeat(id: string, ts: string): void {
      db.prepare('UPDATE runs SET heartbeat_at = ? WHERE id = ?').run(ts, id);
    },

    /** 标记用户请求取消该任务，供运行中的执行器安全停止 */
    requestCancel(id: string): void {
      db.prepare('UPDATE runs SET cancel_requested = 1 WHERE id = ?').run(id);
    },

    /** 检查该任务是否收到取消请求 */
    isCancelRequested(id: string): boolean {
      const row = db.prepare('SELECT cancel_requested FROM runs WHERE id = ?').get(id) as
        | { cancel_requested: number }
        | undefined;
      return row?.cancel_requested === 1;
    },

    /** 将任务的总执行尝试次数原子加一并返回最新次数 */
    incrementAttempt(id: string): number {
      const row = db
        .prepare('UPDATE runs SET attempt = attempt + 1 WHERE id = ? RETURNING attempt')
        .get(id) as { attempt: number } | undefined;
      if (!row) {
        throw new Error(`未找到任务记录，无法累加执行次数: ${id}`);
      }
      return row.attempt;
    },

    /** 找出已超出重试保留窗口、需要自动放弃并释放新闻的任务列表（保留已出片的待审核任务） */
    listExpiredRetryable(nowIso: string): RunSummary[] {
      const rows = db
        .prepare(`
          SELECT * FROM runs
          WHERE status IN ('failed', 'cancelled', 'interrupted', 'rejected')
            AND retry_deadline_at IS NOT NULL
            AND retry_deadline_at <= ?
        `)
        .all(nowIso) as unknown as RunRow[];
      return rows.map(mapRunSummary);
    },
  };
}

/** 创建任务步骤记录操作对象，管理各步骤的完成情况与作废标记 */
export function createRunStagesRepo(db: DatabaseSync) {
  return {
    /** 为新建任务在事务内初始化所有自动处理步骤记录 */
    initStages(runId: string): void {
      inTransaction(db, () => {
        const stmt = db.prepare(`
          INSERT OR IGNORE INTO run_stages (run_id, stage, status, attempt)
          VALUES (?, ?, 'pending', 0)
        `);
        for (const stage of PIPELINE_STAGES) {
          stmt.run(runId, stage);
        }
      });
    },

    /** 查询指定任务下全部步骤的执行记录 */
    listByRun(runId: string): RunStageRecord[] {
      const rows = db
        .prepare('SELECT * FROM run_stages WHERE run_id = ?')
        .all(runId) as unknown as RunStageRow[];
      return rows.map(mapRunStage);
    },

    /** 更新指定步骤的状态、耗时时间戳、检查点文件路径或错误信息 */
    markStage(
      runId: string,
      stage: Stage,
      status: StageStatus,
      opts?: {
        incrementAttempt?: boolean;
        startedAt?: string | null;
        finishedAt?: string | null;
        error?: string | null;
        checkpointPath?: string | null;
      },
    ): void {
      const sets = ['status = ?'];
      const params: Array<string | number | null> = [status];

      if (opts?.incrementAttempt) {
        sets.push('attempt = attempt + 1');
      }
      if (opts?.startedAt !== undefined) {
        sets.push('started_at = ?');
        params.push(opts.startedAt);
      }
      if (opts?.finishedAt !== undefined) {
        sets.push('finished_at = ?');
        params.push(opts.finishedAt);
      }
      if (opts?.error !== undefined) {
        sets.push('error = ?');
        params.push(opts.error);
      }
      if (opts?.checkpointPath !== undefined) {
        sets.push('checkpoint_path = ?');
        params.push(opts.checkpointPath);
      }

      params.push(runId, stage);
      db.prepare(`UPDATE run_stages SET ${sets.join(', ')} WHERE run_id = ? AND stage = ?`).run(
        ...params,
      );
    },

    /** 从指定步骤重跑时，把受影响的后续步骤标记为作废并清除旧检查点引用 */
    markStaleFrom(runId: string, stagesToInvalidate: Stage[]): void {
      if (stagesToInvalidate.length === 0) {
        return;
      }
      const placeholders = stagesToInvalidate.map(() => '?').join(', ');
      db.prepare(`
        UPDATE run_stages
        SET status = 'stale', checkpoint_path = NULL, error = NULL
        WHERE run_id = ? AND stage IN (${placeholders}) AND status != 'pending'
      `).run(runId, ...stagesToInvalidate);
    },
  };
}

/** 创建任务事件流读写对象，供实时日志输出与界面进度追踪使用 */
export function createRunEventsRepo(db: DatabaseSync) {
  return {
    /** 追加写入一条任务运行事件，返回自增事件 ID */
    append(input: {
      runId: string;
      ts: string;
      level: RunEventLevel;
      stage?: Stage | null;
      itemId?: string | null;
      type: string;
      message: string;
      data?: unknown;
    }): number {
      const res = db
        .prepare(`
          INSERT INTO run_events (run_id, ts, level, stage, item_id, type, message, data)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          input.runId,
          input.ts,
          input.level,
          input.stage ?? null,
          input.itemId ?? null,
          input.type,
          input.message,
          input.data !== undefined ? JSON.stringify(input.data) : null,
        );
      return Number(res.lastInsertRowid);
    },

    /** 读取某一类事件里最新的一条，供后续步骤判断这次重跑是否曾经有过稿件编号 */
    latestByType(runId: string, type: string): RunEvent | null {
      const row = db
        .prepare('SELECT * FROM run_events WHERE run_id = ? AND type = ? ORDER BY id DESC LIMIT 1')
        .get(runId, type) as RunEventRow | undefined;
      return row ? mapRunEvent(row) : null;
    },

    /** 按自增游标增量拉取某个任务的新事件列表 */
    listAfter(runId: string, afterId = 0, limit = 200): RunEvent[] {
      const safeLimit = clampLimit(limit, 500);
      const rows = db
        .prepare(`
          SELECT * FROM run_events
          WHERE run_id = ? AND id > ?
          ORDER BY id ASC
          LIMIT ?
        `)
        .all(runId, afterId, safeLimit) as unknown as RunEventRow[];
      return rows.map(mapRunEvent);
    },

    /** 直接按时间正序返回某期任务末尾最近 N 条运行事件，避免全表分页扫描 */
    listRecent(runId: string, limit = 500): RunEvent[] {
      const safeLimit = clampLimit(limit, 500);
      const rows = db
        .prepare(`
          SELECT * FROM run_events
          WHERE run_id = ?
          ORDER BY id DESC
          LIMIT ?
        `)
        .all(runId, safeLimit) as unknown as RunEventRow[];
      return rows.reverse().map(mapRunEvent);
    },
  };
}

/** 创建进程互斥锁读写对象，保证同一时间只有一个生成任务在运行 */
export function createLocksRepo(db: DatabaseSync) {
  return {
    /** 查询当前锁的持有任务、进程号与心跳时间 */
    get(name: string): LockRow | null {
      const row = db.prepare('SELECT * FROM locks WHERE name = ?').get(name) as
        | {
            name: string;
            owner_run: string | null;
            pid: number | null;
            acquired_at: string | null;
            heartbeat_at: string | null;
          }
        | undefined;
      if (!row) {
        return null;
      }
      return {
        name: row.name,
        ownerRun: row.owner_run,
        pid: row.pid,
        acquiredAt: row.acquired_at,
        heartbeatAt: row.heartbeat_at,
      };
    },

    /** 在独占事务内原子抢占或接管过期无效锁，并仅允许子进程认领一次父进程预先登记的占位锁 */
    tryAcquire(input: {
      name: string;
      ownerRun: string;
      pid: number;
      now: string;
      staleMs: number;
      isProcessAlive: (pid: number) => boolean;
      reserved?: boolean;
    }): LockAcquireResult {
      return inTransaction(db, () => {
        const nextAcquiredAt = input.reserved ? null : input.now;
        const existing = this.get(input.name);
        if (existing && existing.ownerRun !== null) {
          if (
            !input.reserved &&
            existing.acquiredAt === null &&
            existing.ownerRun === input.ownerRun &&
            existing.pid === input.pid
          ) {
            this.upsertLock({
              name: input.name,
              ownerRun: input.ownerRun,
              pid: input.pid,
              acquiredAt: input.now,
              heartbeatAt: input.now,
            });
            return { acquired: true };
          }
          const heartbeatMs = existing.heartbeatAt ? Date.parse(existing.heartbeatAt) : Number.NaN;
          const nowMs = Date.parse(input.now);
          const heartbeatStale =
            Number.isNaN(heartbeatMs) || Number.isNaN(nowMs) || nowMs - heartbeatMs > input.staleMs;
          const pidDead = existing.pid === null || !input.isProcessAlive(existing.pid);
          if (!pidDead && !heartbeatStale) {
            return { acquired: false, holder: existing };
          }
          this.upsertLock({
            name: input.name,
            ownerRun: input.ownerRun,
            pid: input.pid,
            acquiredAt: nextAcquiredAt,
            heartbeatAt: input.now,
          });
          return { acquired: true, takenOverFrom: existing };
        }

        this.upsertLock({
          name: input.name,
          ownerRun: input.ownerRun,
          pid: input.pid,
          acquiredAt: nextAcquiredAt,
          heartbeatAt: input.now,
        });
        return { acquired: true };
      });
    },

    /** 写入或更新指定名称的互斥锁记录（仅供锁事务内部或测试直接调用） */
    upsertLock(input: {
      name: string;
      ownerRun: string;
      pid: number;
      acquiredAt: string | null;
      heartbeatAt: string;
    }): void {
      db.prepare(`
        INSERT INTO locks (name, owner_run, pid, acquired_at, heartbeat_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(name) DO UPDATE SET
          owner_run = excluded.owner_run,
          pid = excluded.pid,
          acquired_at = excluded.acquired_at,
          heartbeat_at = excluded.heartbeat_at
      `).run(input.name, input.ownerRun, input.pid, input.acquiredAt, input.heartbeatAt);
    },

    /** 在独占事务内复核锁归属与失效状态后再释放，避免检查与删除之间误删新接管者的锁 */
    releaseIfStale(input: {
      name: string;
      expectedOwnerRun: string;
      expectedPid: number | null;
      now: string;
      staleMs: number;
      isProcessAlive: (pid: number) => boolean;
    }): boolean {
      return inTransaction(db, () => {
        const existing = this.get(input.name);
        if (!existing || existing.ownerRun === null) {
          return false;
        }
        if (existing.ownerRun !== input.expectedOwnerRun || existing.pid !== input.expectedPid) {
          return false;
        }
        const heartbeatMs = existing.heartbeatAt ? Date.parse(existing.heartbeatAt) : Number.NaN;
        const nowMs = Date.parse(input.now);
        const heartbeatStale =
          Number.isNaN(heartbeatMs) || Number.isNaN(nowMs) || nowMs - heartbeatMs > input.staleMs;
        const pidDead = existing.pid === null || !input.isProcessAlive(existing.pid);
        if (!pidDead && !heartbeatStale) {
          return false;
        }
        if (input.expectedPid === null) {
          db.prepare('DELETE FROM locks WHERE name = ? AND owner_run = ? AND pid IS NULL').run(
            input.name,
            input.expectedOwnerRun,
          );
        } else {
          db.prepare('DELETE FROM locks WHERE name = ? AND owner_run = ? AND pid = ?').run(
            input.name,
            input.expectedOwnerRun,
            input.expectedPid,
          );
        }
        return true;
      });
    },

    /** 刷新当前持锁任务与进程的最新心跳时间，若锁已被其他进程接管则返回 false */
    updateHeartbeat(name: string, ownerRun: string, heartbeatAt: string, pid?: number): boolean {
      const res =
        pid !== undefined
          ? db
              .prepare(
                'UPDATE locks SET heartbeat_at = ? WHERE name = ? AND owner_run = ? AND pid = ?',
              )
              .run(heartbeatAt, name, ownerRun, pid)
          : db
              .prepare('UPDATE locks SET heartbeat_at = ? WHERE name = ? AND owner_run = ?')
              .run(heartbeatAt, name, ownerRun);
      return Number(res.changes) > 0;
    },

    /** 释放当前任务持有的互斥锁（传入进程号时仅释放本进程名下的锁，防止误删新接管者的锁） */
    releaseLock(name: string, ownerRun: string, pid?: number): void {
      if (pid !== undefined) {
        db.prepare('DELETE FROM locks WHERE name = ? AND owner_run = ? AND pid = ?').run(
          name,
          ownerRun,
          pid,
        );
        return;
      }
      db.prepare('DELETE FROM locks WHERE name = ? AND owner_run = ?').run(name, ownerRun);
    },
  };
}
