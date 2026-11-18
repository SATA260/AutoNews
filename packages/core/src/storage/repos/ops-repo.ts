import type { PublishRecord, PublishStatus, ScheduleJob } from '@aidaily/contracts';
import { type DatabaseSync, inTransaction } from '../db.js';

/** 数据库 `schedules` 表行结构 */
interface ScheduleRow {
  id: string;
  name: string;
  time_expr: string;
  item_count: number;
  bgm_file: string | null;
  enabled: number;
  last_run_id: string | null;
  last_triggered_at: string | null;
  created_at: string;
  updated_at: string;
}

/** 数据库 `publish_records` 表行结构 */
interface PublishRow {
  run_id: string;
  platform: 'bilibili';
  title: string | null;
  description: string | null;
  tags: string | null;
  status: PublishStatus;
  bvid: string | null;
  attempts: number;
  error: string | null;
  updated_at: string;
}

/** 将定时任务数据库行映射为基础定时任务对象 */
function mapSchedule(row: ScheduleRow): Omit<ScheduleJob, 'installed' | 'nextRunAt'> {
  return {
    id: row.id,
    name: row.name,
    time: row.time_expr,
    itemCount: row.item_count,
    bgmFile: row.bgm_file,
    enabled: row.enabled === 1,
    lastRunId: row.last_run_id,
    lastTriggeredAt: row.last_triggered_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** 将发布记录数据库行映射为业务对象 */
function mapPublishRecord(row: PublishRow): PublishRecord {
  return {
    runId: row.run_id,
    platform: row.platform,
    title: row.title,
    description: row.description,
    tags: row.tags ? (JSON.parse(row.tags) as string[]) : [],
    status: row.status,
    bvid: row.bvid,
    attempts: row.attempts,
    error: row.error,
    updatedAt: row.updated_at,
  };
}

/** 创建定时任务数据库操作对象，负责定时配置的增删改查 */
export function createSchedulesRepo(db: DatabaseSync) {
  return {
    /** 列出所有手动创建的定时任务，按每日执行时间升序排列 */
    list(): Array<Omit<ScheduleJob, 'installed' | 'nextRunAt'>> {
      const rows = db
        .prepare('SELECT * FROM schedules ORDER BY time_expr ASC, created_at ASC')
        .all() as unknown as ScheduleRow[];
      return rows.map(mapSchedule);
    },

    /** 按定时任务 ID 查询单条记录 */
    getById(id: string): Omit<ScheduleJob, 'installed' | 'nextRunAt'> | null {
      const row = db.prepare('SELECT * FROM schedules WHERE id = ?').get(id) as
        | ScheduleRow
        | undefined;
      return row ? mapSchedule(row) : null;
    },

    /** 新增一条定时任务（必须显式传入执行时间与每期条数） */
    create(input: {
      id: string;
      name: string;
      time: string;
      itemCount: number;
      bgmFile?: string | null;
      enabled: boolean;
      now: string;
    }): Omit<ScheduleJob, 'installed' | 'nextRunAt'> {
      db.prepare(`
        INSERT INTO schedules (id, name, time_expr, item_count, bgm_file, enabled, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.id,
        input.name,
        input.time,
        input.itemCount,
        input.bgmFile ?? null,
        input.enabled ? 1 : 0,
        input.now,
        input.now,
      );
      const created = this.getById(input.id);
      if (!created) {
        throw new Error(`创建定时任务失败: ${input.id}`);
      }
      return created;
    },

    /** 更新指定定时任务的名称、执行时间、条数、启停状态或最近运行记录 */
    update(
      id: string,
      patch: {
        name?: string;
        time?: string;
        itemCount?: number;
        bgmFile?: string | null;
        enabled?: boolean;
        lastRunId?: string;
        lastTriggeredAt?: string;
        now: string;
      },
    ): Omit<ScheduleJob, 'installed' | 'nextRunAt'> | null {
      const sets = ['updated_at = ?'];
      const params: Array<string | number | null> = [patch.now];

      if (patch.name !== undefined) {
        sets.push('name = ?');
        params.push(patch.name);
      }
      if (patch.time !== undefined) {
        sets.push('time_expr = ?');
        params.push(patch.time);
      }
      if (patch.itemCount !== undefined) {
        sets.push('item_count = ?');
        params.push(patch.itemCount);
      }
      if (patch.bgmFile !== undefined) {
        sets.push('bgm_file = ?');
        params.push(patch.bgmFile);
      }
      if (patch.enabled !== undefined) {
        sets.push('enabled = ?');
        params.push(patch.enabled ? 1 : 0);
      }
      if (patch.lastRunId !== undefined) {
        sets.push('last_run_id = ?');
        params.push(patch.lastRunId);
      }
      if (patch.lastTriggeredAt !== undefined) {
        sets.push('last_triggered_at = ?');
        params.push(patch.lastTriggeredAt);
      }

      params.push(id);
      const res = db.prepare(`UPDATE schedules SET ${sets.join(', ')} WHERE id = ?`).run(...params);
      if (Number(res.changes) === 0) {
        return null;
      }
      return this.getById(id);
    },

    /** 按 ID 删除指定定时任务 */
    remove(id: string): boolean {
      const res = db.prepare('DELETE FROM schedules WHERE id = ?').run(id);
      return Number(res.changes) > 0;
    },
  };
}

/** 创建 B 站投稿发布记录操作对象，管理草稿保存与发布结果追踪 */
export function createPublishRepo(db: DatabaseSync) {
  return {
    /** 写入或重置一期任务的视频投稿草稿，严禁覆盖已发布、上传中或状态不明的投稿记录 */
    upsertDraft(input: {
      runId: string;
      title: string;
      description: string;
      tags: string[];
      updatedAt: string;
    }): PublishRecord {
      return inTransaction(db, () => {
        const existing = this.getByRun(input.runId);
        if (
          existing &&
          (existing.status === 'publishing' ||
            existing.status === 'published' ||
            existing.status === 'uncertain')
        ) {
          throw new Error(`任务 ${input.runId} 当前投稿状态为 ${existing.status}，禁止重置为草稿`);
        }

        db.prepare(`
          INSERT INTO publish_records (
            run_id, platform, title, description, tags, status, bvid, attempts, error, updated_at
          ) VALUES (?, 'bilibili', ?, ?, ?, 'draft', NULL, 0, NULL, ?)
          ON CONFLICT(run_id) DO UPDATE SET
            title = excluded.title,
            description = excluded.description,
            tags = excluded.tags,
            status = 'draft',
            bvid = NULL,
            attempts = 0,
            error = NULL,
            updated_at = excluded.updated_at
        `).run(
          input.runId,
          input.title,
          input.description,
          JSON.stringify(input.tags),
          input.updatedAt,
        );
        const record = this.getByRun(input.runId);
        if (!record) {
          throw new Error(`写入发布草稿失败: ${input.runId}`);
        }
        return record;
      });
    },

    /**
     * 重新打开已发布任务时，把已发布、仅本地完结或失败的投稿改回可编辑草稿。
     * 清空当前稿件编号和错误说明，保留已经尝试过的次数。
     * 正在上传或结果不明的记录不会被改动。
     */
    resetForRevive(runId: string, updatedAt: string): PublishRecord | null {
      return inTransaction(db, () => {
        const existing = this.getByRun(runId);
        if (!existing) {
          return null;
        }
        if (
          existing.status !== 'published' &&
          existing.status !== 'consumed_only' &&
          existing.status !== 'failed'
        ) {
          return null;
        }
        db.prepare(`
          UPDATE publish_records
          SET status = 'draft', bvid = NULL, error = NULL, updated_at = ?
          WHERE run_id = ?
        `).run(updatedAt, runId);
        return this.getByRun(runId);
      });
    },

    /** 查询指定任务对应的投稿记录 */
    getByRun(runId: string): PublishRecord | null {
      const row = db.prepare('SELECT * FROM publish_records WHERE run_id = ?').get(runId) as
        | PublishRow
        | undefined;
      return row ? mapPublishRecord(row) : null;
    },

    /** 局部更新人工修改后的投稿标题、简介或标签列表（仅允许在草稿或失败状态下编辑） */
    updateDraftFields(
      runId: string,
      patch: { title?: string; description?: string; tags?: string[]; updatedAt: string },
    ): PublishRecord | null {
      return inTransaction(db, () => {
        const existing = this.getByRun(runId);
        if (!existing) {
          return null;
        }
        if (existing.status !== 'draft' && existing.status !== 'failed') {
          throw new Error(`当前投稿状态为 ${existing.status}，不允许修改投稿文案`);
        }

        const sets = ['updated_at = ?'];
        const params: string[] = [patch.updatedAt];

        if (patch.title !== undefined) {
          sets.push('title = ?');
          params.push(patch.title);
        }
        if (patch.description !== undefined) {
          sets.push('description = ?');
          params.push(patch.description);
        }
        if (patch.tags !== undefined) {
          sets.push('tags = ?');
          params.push(JSON.stringify(patch.tags));
        }

        params.push(runId);
        db.prepare(`UPDATE publish_records SET ${sets.join(', ')} WHERE run_id = ?`).run(...params);
        return this.getByRun(runId);
      });
    },

    /** 更新投稿状态、记录上传尝试次数或写入成功后的 B 站 BV 号 */
    updateStatus(
      runId: string,
      status: PublishStatus,
      opts: {
        bvid?: string | null;
        error?: string | null;
        incrementAttempts?: boolean;
        updatedAt: string;
      },
    ): void {
      const sets = ['status = ?', 'updated_at = ?'];
      const params: Array<string | number | null> = [status, opts.updatedAt];

      if (opts?.bvid !== undefined) {
        sets.push('bvid = ?');
        params.push(opts.bvid);
      }
      if (opts?.error !== undefined) {
        sets.push('error = ?');
        params.push(opts.error);
      }
      if (opts?.incrementAttempts) {
        sets.push('attempts = attempts + 1');
      }

      params.push(runId);
      db.prepare(`UPDATE publish_records SET ${sets.join(', ')} WHERE run_id = ?`).run(...params);
    },
  };
}
