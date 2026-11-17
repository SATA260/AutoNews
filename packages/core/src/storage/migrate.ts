import { type DatabaseSync, inTransaction } from './db.js';
import { MIGRATION_001, type Migration } from './migrations/001_init.js';
import { MIGRATION_002 } from './migrations/002_workflow.js';

const MIGRATIONS: readonly Migration[] = [MIGRATION_001, MIGRATION_002];

/** 按版本号顺序幂等地执行尚未应用的数据库表结构迁移脚本 */
export function runMigrations(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);

  const appliedRows = db.prepare('SELECT version FROM schema_migrations').all() as Array<{
    version: number;
  }>;
  const applied = new Set(appliedRows.map((row) => row.version));

  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) {
      continue;
    }
    inTransaction(db, () => {
      db.exec(migration.sql);
      db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(
        migration.version,
        new Date().toISOString(),
      );
    });
  }
}
