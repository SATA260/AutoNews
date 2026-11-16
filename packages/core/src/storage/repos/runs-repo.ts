import {
  type ErrorCode,
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
import type { DatabaseSync } from '../db.js';

interface RunRow {
  id: string;
  trigger: Trigger;
  schedule_id: string | null;
  status: RunStatus;
  current_stage: Stage | null;
  item_count: number;
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

export interface RunRowDetail extends RunSummary {
  configSnapshotJson: string;
  cancelRequested: boolean;
  pid: number | null;
  heartbeatAt: string | null;
}

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

export interface LockRow {
  name: string;
  ownerRun: string | null;
  pid: number | null;
  acquiredAt: string | null;
  heartbeatAt: string | null;
}

function mapRunSummary(row: RunRow): RunSummary {
  return {
    id: row.id,
    trigger: row.trigger,
    scheduleId: row.schedule_id,
    status: row.status,
    currentStage: row.current_stage,
    itemCount: row.item_count,
    attempt: row.attempt,
    errorCode: row.error_code,
    error: row.error,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    retryDeadlineAt: row.retry_deadline_at,
  };
}

function mapRunRowDetail(row: RunRow): RunRowDetail {
  return {
    ...mapRunSummary(row),
    configSnapshotJson: row.config_snapshot,
    cancelRequested: row.cancel_requested === 1,
    pid: row.pid,
    heartbeatAt: row.heartbeat_at,
  };
}

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

export function createRunsRepo(db: DatabaseSync) {
  return {
    create(input: {
      id: string;
      trigger: Trigger;
      scheduleId?: string | null;
      itemCount: number;
      configSnapshotJson: string;
      createdAt: string;
    }): void {
      db.prepare(`
        INSERT INTO runs (
          id, trigger, schedule_id, status, item_count, config_snapshot, created_at
        ) VALUES (?, ?, ?, 'queued', ?, ?, ?)
      `).run(
        input.id,
        input.trigger,
        input.scheduleId ?? null,
        input.itemCount,
        input.configSnapshotJson,
        input.createdAt,
      );
    },

    getById(id: string): RunRowDetail | null {
      const row = db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as RunRow | undefined;
      return row ? mapRunRowDetail(row) : null;
    },

    list(q?: { status?: RunStatus[]; limit?: number; before?: string }): RunSummary[] {
      const conditions: string[] = [];
      const params: Array<string | number> = [];

      if (q?.status && q.status.length > 0) {
        const placeholders = q.status.map(() => '?').join(', ');
        conditions.push(`status IN (${placeholders})`);
        params.push(...q.status);
      }
      if (q?.before) {
        conditions.push('created_at < ?');
        params.push(q.before);
      }

      const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
      const limit = q?.limit ?? 20;
      params.push(limit);

      const rows = db
        .prepare(`SELECT * FROM runs ${where} ORDER BY created_at DESC LIMIT ?`)
        .all(...params) as unknown as RunRow[];
      return rows.map(mapRunSummary);
    },

    updateStatus(
      id: string,
      status: RunStatus,
      opts?: {
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
      },
    ): void {
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

      params.push(id);
      db.prepare(`UPDATE runs SET ${sets.join(', ')} WHERE id = ?`).run(...params);
    },

    setHeartbeat(id: string, ts: string): void {
      db.prepare('UPDATE runs SET heartbeat_at = ? WHERE id = ?').run(ts, id);
    },

    requestCancel(id: string): void {
      db.prepare('UPDATE runs SET cancel_requested = 1 WHERE id = ?').run(id);
    },

    isCancelRequested(id: string): boolean {
      const row = db.prepare('SELECT cancel_requested FROM runs WHERE id = ?').get(id) as
        | { cancel_requested: number }
        | undefined;
      return row?.cancel_requested === 1;
    },

    incrementAttempt(id: string): number {
      db.prepare('UPDATE runs SET attempt = attempt + 1 WHERE id = ?').run(id);
      const row = db.prepare('SELECT attempt FROM runs WHERE id = ?').get(id) as {
        attempt: number;
      };
      return row.attempt;
    },

    listExpiredRetryable(nowIso: string): RunSummary[] {
      const rows = db
        .prepare(`
          SELECT * FROM runs
          WHERE status IN ('failed', 'cancelled', 'interrupted', 'rejected', 'awaiting_review')
            AND retry_deadline_at IS NOT NULL
            AND retry_deadline_at <= ?
        `)
        .all(nowIso) as unknown as RunRow[];
      return rows.map(mapRunSummary);
    },
  };
}

export function createRunStagesRepo(db: DatabaseSync) {
  return {
    initStages(runId: string): void {
      const stmt = db.prepare(`
        INSERT OR IGNORE INTO run_stages (run_id, stage, status, attempt)
        VALUES (?, ?, 'pending', 0)
      `);
      for (const stage of PIPELINE_STAGES) {
        stmt.run(runId, stage);
      }
    },

    listByRun(runId: string): RunStageRecord[] {
      const rows = db
        .prepare('SELECT * FROM run_stages WHERE run_id = ?')
        .all(runId) as unknown as RunStageRow[];
      return rows.map(mapRunStage);
    },

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

export function createRunEventsRepo(db: DatabaseSync) {
  return {
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

    listAfter(runId: string, afterId = 0, limit = 200): RunEvent[] {
      const rows = db
        .prepare(`
          SELECT * FROM run_events
          WHERE run_id = ? AND id > ?
          ORDER BY id ASC
          LIMIT ?
        `)
        .all(runId, afterId, limit) as unknown as RunEventRow[];
      return rows.map(mapRunEvent);
    },
  };
}

export function createLocksRepo(db: DatabaseSync) {
  return {
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

    upsertLock(input: {
      name: string;
      ownerRun: string;
      pid: number;
      acquiredAt: string;
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

    updateHeartbeat(name: string, ownerRun: string, heartbeatAt: string): void {
      db.prepare('UPDATE locks SET heartbeat_at = ? WHERE name = ? AND owner_run = ?').run(
        heartbeatAt,
        name,
        ownerRun,
      );
    },

    releaseLock(name: string, ownerRun: string): void {
      db.prepare('DELETE FROM locks WHERE name = ? AND owner_run = ?').run(name, ownerRun);
    },
  };
}
