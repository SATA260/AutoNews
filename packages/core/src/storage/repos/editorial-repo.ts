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
import { type DatabaseSync, inTransaction } from '../db.js';

/** 数据库 `events` 表行结构 */
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

/** 数据库 `run_items` 表行结构 */
interface RunItemRow {
  id: string;
  run_id: string;
  event_id: string;
  position: number | null;
  status: RunItemStatus;
  revision: number;
  drop_reason: string | null;
  final_json: string | null;
  image_mode: 'auto' | 'custom' | 'none';
  custom_image_path: string | null;
  custom_image_caption: string | null;
  updated_at: string;
}

/** 数据库 `item_versions` 表行结构 */
interface ItemVersionRow {
  id: number;
  item_id: string;
  kind: ItemVersionKind;
  round: number;
  payload: string;
  created_at: string;
}

/** 数据库 `llm_calls` 表行结构 */
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

/** 将聚类事件数据库行转换为业务对象 */
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

/** 为历史版本或旧数据库记录补齐缺省的顶部进度条短标题，保障旧任务详情正常反序列化 */
export function normalizeStoredPolishedItem(raw: unknown): PolishedItem | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return null;
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.progressLabel === 'string' && obj.progressLabel.trim().length > 0) {
    return raw as PolishedItem;
  }
  const rawBase =
    typeof obj.shortTitle === 'string' && obj.shortTitle.trim().length > 0
      ? obj.shortTitle
      : typeof obj.title === 'string' && obj.title.trim().length > 0
        ? obj.title
        : 'AI资讯速览';
  const chars = Array.from(rawBase.trim());
  let sliced = chars.slice(0, 10).join('');
  if (chars.length > 10 && /\d/.test(chars[9] ?? '') && /\d/.test(chars[10] ?? '')) {
    sliced = sliced.replace(/\d+$/, '');
  }
  let label = sliced.trim();
  if (Array.from(label).length < 4) {
    label = label ? `${label}速览` : 'AI资讯速览';
  }
  label = Array.from(label).slice(0, 10).join('').trim();
  if (Array.from(label).length < 4) {
    label = 'AI资讯速览';
  }
  return {
    ...(obj as unknown as PolishedItem),
    progressLabel: label,
  };
}

/** 将新闻条目数据库行转换为业务对象 */
function mapRunItem(row: RunItemRow): RunItemRecord {
  return {
    id: row.id,
    runId: row.run_id,
    eventId: row.event_id,
    position: row.position,
    status: row.status,
    revision: row.revision,
    dropReason: row.drop_reason,
    finalJson: row.final_json ? normalizeStoredPolishedItem(JSON.parse(row.final_json)) : null,
    imageMode: row.image_mode,
    customImagePath: row.custom_image_path,
    customImageCaption: row.custom_image_caption,
    updatedAt: row.updated_at,
  };
}

/** 将历史版本数据库行转换为业务对象 */
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

/** 将模型调用记录数据库行转换为业务对象 */
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

/** 创建候选新闻事件操作对象，负责存储与清理单期选出的事件聚类 */
export function createEventsRepo(db: DatabaseSync) {
  return {
    /** 在事务内批量写入选出的主选与替补事件记录 */
    insertMany(records: EventRecord[]): void {
      if (records.length === 0) {
        return;
      }
      inTransaction(db, () => {
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
      });
    },

    /** 按排序序号查询某期任务的全部候选事件 */
    listByRun(runId: string): EventRecord[] {
      const rows = db
        .prepare('SELECT * FROM events WHERE run_id = ? ORDER BY rank ASC')
        .all(runId) as unknown as EventRow[];
      return rows.map(mapEvent);
    },

    /** 在事务内清理指定任务的事件、新闻条目及其历史版本记录（用于重新选题前重置） */
    deleteByRun(runId: string): void {
      inTransaction(db, () => {
        db.prepare(
          'DELETE FROM item_versions WHERE item_id IN (SELECT id FROM run_items WHERE run_id = ?)',
        ).run(runId);
        db.prepare('DELETE FROM run_items WHERE run_id = ?').run(runId);
        db.prepare('DELETE FROM events WHERE run_id = ?').run(runId);
      });
    },
  };
}

/** 创建单条新闻稿件读写对象，管理撰写进度、修改轮次和历史版本快照 */
export function createRunItemsRepo(db: DatabaseSync) {
  return {
    /** 在事务内批量创建待处理新闻条目 */
    createMany(items: RunItemRecord[]): void {
      if (items.length === 0) {
        return;
      }
      inTransaction(db, () => {
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
      });
    },

    /** 按条目 ID 查询单条新闻状态 */
    getById(itemId: string): RunItemRecord | null {
      const row = db.prepare('SELECT * FROM run_items WHERE id = ?').get(itemId) as
        | RunItemRow
        | undefined;
      return row ? mapRunItem(row) : null;
    },

    /** 查询指定任务下的所有新闻条目，按最终编排顺序排列 */
    listByRun(runId: string): RunItemRecord[] {
      const rows = db
        .prepare('SELECT * FROM run_items WHERE run_id = ? ORDER BY COALESCE(position, 9999) ASC')
        .all(runId) as unknown as RunItemRow[];
      return rows.map(mapRunItem);
    },

    /** 更新单条新闻的当前状态、打回次数、剔除原因或最终过审定稿 */
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

    /** 追加一条不可变的历史版本记录（如总结草稿、润色稿、核查批注等） */
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

    /** 查询单条新闻在各轮次中产生过的全部版本与核查历史 */
    listVersions(itemId: string): ItemVersion[] {
      const rows = db
        .prepare('SELECT * FROM item_versions WHERE item_id = ? ORDER BY id ASC')
        .all(itemId) as unknown as ItemVersionRow[];
      return rows.map(mapItemVersion);
    },
  };
}

/** 创建大模型调用审计记录操作对象 */
export function createLlmCallsRepo(db: DatabaseSync) {
  return {
    /** 记录单次命令行模型调用的耗时、Token 用量、状态及日志文件位置 */
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

    /** 按时间顺序查询某期任务的全部模型调用审计记录 */
    listByRun(runId: string): LlmCallRecord[] {
      const rows = db
        .prepare('SELECT * FROM llm_calls WHERE run_id = ? ORDER BY id ASC')
        .all(runId) as unknown as LlmCallRow[];
      return rows.map(mapLlmCall);
    },
  };
}
