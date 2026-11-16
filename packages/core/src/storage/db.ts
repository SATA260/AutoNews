import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export type { DatabaseSync };

/** 打开或创建 SQLite 数据库文件，并启用 WAL 并发读写模式与外键约束 */
export function openDatabase(dbFile: string): DatabaseSync {
  fs.mkdirSync(path.dirname(dbFile), { recursive: true });
  const db = new DatabaseSync(dbFile);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 5000;');
  return db;
}

/** 在同一个独占写事务中执行回调函数，任意异常自动回滚以保证数据一致性 */
export function inTransaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE;');
  try {
    const result = fn();
    db.exec('COMMIT;');
    return result;
  } catch (err) {
    try {
      db.exec('ROLLBACK;');
    } catch {
      // 忽略事务已自动回滚时再次执行 ROLLBACK 引发的错误
    }
    throw err;
  }
}
