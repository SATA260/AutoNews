import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export type { DatabaseSync };

const txDepthByDb = new WeakMap<DatabaseSync, number>();

/** 判断返回值是否像异步 Promise 对象，防止事务回调误传入异步函数导致连接状态错乱 */
function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    'then' in value &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}

/** 打开或创建 SQLite 数据库文件，并启用 WAL 并发读写模式与外键约束 */
export function openDatabase(dbFile: string): DatabaseSync {
  fs.mkdirSync(path.dirname(dbFile), { recursive: true });
  const db = new DatabaseSync(dbFile);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 5000;');
  return db;
}

/** 在同一个独占写事务中执行同步回调函数，支持嵌套保存点，任意异常自动回滚 */
export function inTransaction<T>(db: DatabaseSync, fn: () => T): T {
  const depth = txDepthByDb.get(db) ?? 0;
  const savepointName = `aidaily_sp_${depth}`;
  if (depth === 0) {
    db.exec('BEGIN IMMEDIATE;');
  } else {
    db.exec(`SAVEPOINT ${savepointName};`);
  }
  txDepthByDb.set(db, depth + 1);

  try {
    const result = fn();
    if (isPromiseLike(result)) {
      throw new Error('inTransaction 仅支持同步回调，禁止传入 async 函数');
    }
    if (depth === 0) {
      db.exec('COMMIT;');
    } else {
      db.exec(`RELEASE SAVEPOINT ${savepointName};`);
    }
    return result;
  } catch (err) {
    try {
      if (depth === 0) {
        db.exec('ROLLBACK;');
      } else {
        db.exec(`ROLLBACK TO SAVEPOINT ${savepointName};`);
        db.exec(`RELEASE SAVEPOINT ${savepointName};`);
      }
    } catch {
      // 忽略事务已自动回滚时再次执行回滚引发的错误
    }
    throw err;
  } finally {
    if (depth === 0) {
      txDepthByDb.delete(db);
    } else {
      txDepthByDb.set(db, depth);
    }
  }
}
