import type {
  EventRecord,
  EventRole,
  ItemVersion,
  ItemVersionKind,
  LlmCallRecord,
  LlmCallStatus,
  LlmStage,
  PolishedItem,
  RunItemRecord,
  RunItemStatus,
} from '@aidaily/contracts';
import type { DatabaseSync } from '../db.js';

interface EventRow {
  id: string;
  run_id: string;
  rank: number;
  role: EventRole;
  title: string;
  article_ids: string;
  category: string | null;
  entity: string | null;
  score: number;
  public_appeal: number | null;
  reason: string | null;
  refill_round: number;
}

interface RunItemRow {
  id: string;
  run_id: string;
  event_id: string;
  position: number | null;
  status: RunItemStatus;
  revision: number;
  drop_reason: string | null;
  final_json: string | null;
  updated_at: string;
}

interface ItemVersionRow {
  id: number;
  item_id: string;
  kind: ItemVersionKind;
  round: number;
  payload: string;
  created_at: string;
}

interface LlmCallRow {
  id: number;
  run_id: string | null;
  stage: LlmStage | null;
  item_id: string | null;
  cli: string;
  model: string | null;
  attempt: number;
  status: LlmCallStatus;
  duration_ms: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  conversation_id: string | null;
  log_path: string | null;
  created_at: string;
}

function mapEvent(row: EventRow): EventRecord {
  return {
    id: row.id,
    runId: row.run_id,
    rank: row.rank,
    role: row.role,
    title: row.title,
    articleIds: JSON.parse(row.article_ids) as string[],
    category: row.category,
    entity: row.entity,
    score: row.score,
    publicAppeal: row.public_appeal,
    reason: row.reason,
    refillRound: row.refill_round,
  };
}

function mapRunItem(row: RunItemRow): RunItemRecord {
  return {
    id: row.id,
    runId: row.run_id,
    eventId: row.event_id,
    position: row.position,
    status: row.status,
    revision: row.revision,
    dropReason: row.drop_reason,
    finalJson: row.final_json ? (JSON.parse(row.final_json) as PolishedItem) : null,
    updatedAt: row.updated_at,
  };
}

function mapItemVersion(row: ItemVersionRow): ItemVersion {
  return {
    id: row.id,
    itemId: row.item_id,
    kind: row.kind,
    round: row.round,
    payload: JSON.parse(row.payload) as unknown,
    createdAt: row.created_at,
  };
}

function mapLlmCall(row: LlmCallRow): LlmCallRecord {
  return {
    id: row.id,
    runId: row.run_id,
    stage: row.stage,
    itemId: row.item_id,
    cli: row.cli,
    model: row.model,
    attempt: row.attempt,
    status: row.status,
    durationMs: row.duration_ms,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    conversationId: row.conversation_id,
    logPath: row.log_path,
    createdAt: row.created_at,
  };
}

export function createEventsRepo(db: DatabaseSync) {
  return {
    insertMany(records: EventRecord[]): void {
      const stmt = db.prepare(`
        INSERT INTO events (
          id, run_id, rank, role, title, article_ids, category, entity, score, public_appeal, reason, refill_round
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const r of records) {
        stmt.run(
          r.id,
          r.runId,
          r.rank,
          r.role,
          r.title,
          JSON.stringify(r.articleIds),
          r.category,
          r.entity,
          r.score,
          r.publicAppeal,
          r.reason,
          r.refillRound,
        );
      }
    },

    listByRun(runId: string): EventRecord[] {
      const rows = db
        .prepare('SELECT * FROM events WHERE run_id = ? ORDER BY rank ASC')
        .all(runId) as unknown as EventRow[];
      return rows.map(mapEvent);
    },

    deleteByRun(runId: string): void {
      db.prepare(
        'DELETE FROM item_versions WHERE item_id IN (SELECT id FROM run_items WHERE run_id = ?)',
      ).run(runId);
      db.prepare('DELETE FROM run_items WHERE run_id = ?').run(runId);
      db.prepare('DELETE FROM events WHERE run_id = ?').run(runId);
    },
  };
}

export function createRunItemsRepo(db: DatabaseSync) {
  return {
    createMany(items: RunItemRecord[]): void {
      const stmt = db.prepare(`
        INSERT INTO run_items (
          id, run_id, event_id, position, status, revision, drop_reason, final_json, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const item of items) {
        stmt.run(
          item.id,
          item.runId,
          item.eventId,
          item.position,
          item.status,
          item.revision,
          item.dropReason,
          item.finalJson ? JSON.stringify(item.finalJson) : null,
          item.updatedAt,
        );
      }
    },

    getById(itemId: string): RunItemRecord | null {
      const row = db.prepare('SELECT * FROM run_items WHERE id = ?').get(itemId) as
        | RunItemRow
        | undefined;
      return row ? mapRunItem(row) : null;
    },

    listByRun(runId: string): RunItemRecord[] {
      const rows = db
        .prepare('SELECT * FROM run_items WHERE run_id = ? ORDER BY COALESCE(position, 9999) ASC')
        .all(runId) as unknown as RunItemRow[];
      return rows.map(mapRunItem);
    },

    updateItem(
      itemId: string,
      patch: {
        status?: RunItemStatus;
        position?: number | null;
        revision?: number;
        dropReason?: string | null;
        finalJson?: PolishedItem | null;
        updatedAt: string;
      },
    ): void {
      const sets = ['updated_at = ?'];
      const params: Array<string | number | null> = [patch.updatedAt];

      if (patch.status !== undefined) {
        sets.push('status = ?');
        params.push(patch.status);
      }
      if (patch.position !== undefined) {
        sets.push('position = ?');
        params.push(patch.position);
      }
      if (patch.revision !== undefined) {
        sets.push('revision = ?');
        params.push(patch.revision);
      }
      if (patch.dropReason !== undefined) {
        sets.push('drop_reason = ?');
        params.push(patch.dropReason);
      }
      if (patch.finalJson !== undefined) {
        sets.push('final_json = ?');
        params.push(patch.finalJson ? JSON.stringify(patch.finalJson) : null);
      }

      params.push(itemId);
      db.prepare(`UPDATE run_items SET ${sets.join(', ')} WHERE id = ?`).run(...params);
    },

    appendVersion(input: {
      itemId: string;
      kind: ItemVersionKind;
      round: number;
      payload: unknown;
      createdAt: string;
    }): number {
      const res = db
        .prepare(`
          INSERT INTO item_versions (item_id, kind, round, payload, created_at)
          VALUES (?, ?, ?, ?, ?)
        `)
        .run(input.itemId, input.kind, input.round, JSON.stringify(input.payload), input.createdAt);
      return Number(res.lastInsertRowid);
    },

    listVersions(itemId: string): ItemVersion[] {
      const rows = db
        .prepare('SELECT * FROM item_versions WHERE item_id = ? ORDER BY id ASC')
        .all(itemId) as unknown as ItemVersionRow[];
      return rows.map(mapItemVersion);
    },
  };
}

export function createLlmCallsRepo(db: DatabaseSync) {
  return {
    insert(input: {
      runId?: string | null;
      stage?: LlmStage | null;
      itemId?: string | null;
      cli: string;
      model?: string | null;
      attempt: number;
      status: LlmCallStatus;
      durationMs?: number | null;
      inputTokens?: number | null;
      outputTokens?: number | null;
      conversationId?: string | null;
      logPath?: string | null;
      createdAt: string;
    }): number {
      const res = db
        .prepare(`
          INSERT INTO llm_calls (
            run_id, stage, item_id, cli, model, attempt, status,
            duration_ms, input_tokens, output_tokens, conversation_id, log_path, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          input.runId ?? null,
          input.stage ?? null,
          input.itemId ?? null,
          input.cli,
          input.model ?? null,
          input.attempt,
          input.status,
          input.durationMs ?? null,
          input.inputTokens ?? null,
          input.outputTokens ?? null,
          input.conversationId ?? null,
          input.logPath ?? null,
          input.createdAt,
        );
      return Number(res.lastInsertRowid);
    },

    listByRun(runId: string): LlmCallRecord[] {
      const rows = db
        .prepare('SELECT * FROM llm_calls WHERE run_id = ? ORDER BY id ASC')
        .all(runId) as unknown as LlmCallRow[];
      return rows.map(mapLlmCall);
    },
  };
}
