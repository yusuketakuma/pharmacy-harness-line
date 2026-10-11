import Database from 'better-sqlite3';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyD1Migrations, buildMigrationLedgerSql } from '../src/migrations.js';
import { splitSqlStatements } from '../../db/scripts/split-sql-statements.mjs';

const dir = new URL('../../db/migrations/', import.meta.url).pathname;
const names = ['030_custom_082_pharmacy_cron_scan_indexes.sql', '031_custom_083_pharmacy_status_notification_work.sql'];
const migrations = new Map(names.map((name) => [name, Buffer.from(readFileSync(join(dir, name)))]));
function load() {
  const db = new Database(':memory:');
  for (const file of readdirSync(dir)
    .filter((file) => file.endsWith('.sql') && file < '030_')
    .sort()) {
    for (const statement of splitSqlStatements(readFileSync(join(dir, file), 'utf8'))) {
      try {
        db.exec(statement);
      } catch (error) {
        if (!(error instanceof Error) || !/duplicate column name|already exists/i.test(error.message)) throw error;
      }
    }
  }
  db.exec(buildMigrationLedgerSql([], new Map()));
  return db;
}
function executor(db: Database.Database, failure: 'rollback' | 'response-loss' | null = null) {
  let used = false;
  return async ({ sql, params = [] }: { sql: string; params?: unknown[] }) => {
    if (sql.includes(';')) {
      const inject = failure && !used && sql.includes('pharmacy_status_notification_work');
      if (inject) used = true;
      db.transaction(() => {
        db.exec(sql);
        if (inject && failure === 'rollback') throw new Error('synthetic interrupted atomic migration');
      })();
      if (inject && failure === 'response-loss') throw new Error('synthetic lost migration response');
      return { success: true, result: [{ results: [] }] };
    }
    const statement = db.prepare(sql);
    let results: unknown[] = [];
    if (statement.reader) results = statement.all(...params);
    else statement.run(...params);
    return { success: true, result: [{ results }] };
  };
}
function apply(db: Database.Database, execute = executor(db), sources = migrations) {
  return applyD1Migrations({
    creds: { accountId: 'synthetic', apiToken: 'synthetic' },
    databaseId: 'synthetic',
    names,
    migrations: sources,
    requireChecksumLedger: true,
    execute,
  });
}

describe('030/031 through the actual migration engine with local SQLite', () => {
  it('rolls back 031 schema and ledger together and resumes after interruption', async () => {
    const db = load();
    try {
      await expect(apply(db, executor(db, 'rollback'))).rejects.toThrow('interrupted');
      expect(db.prepare(`SELECT name FROM _line_harness_migrations ORDER BY name`).all()).toEqual([{ name: names[0] }]);
      expect(db.prepare(`SELECT name FROM sqlite_master WHERE name='pharmacy_status_notification_work'`).all()).toEqual(
        [],
      );
      await apply(db);
      expect(db.prepare(`SELECT COUNT(*) AS n FROM _line_harness_migrations`).get()).toEqual({ n: 2 });
      const replay = await apply(db);
      expect(replay.every((result) => result.alreadyApplied)).toBe(true);
    } finally {
      db.close();
    }
  });
  it('reconciles a committed migration whose response was lost and rejects changed bytes', async () => {
    const db = load();
    try {
      await apply(db, executor(db, 'response-loss'));
      expect(db.prepare(`SELECT COUNT(*) AS n FROM _line_harness_migrations`).get()).toEqual({ n: 2 });
      const changed = new Map(migrations);
      changed.set(names[1], Buffer.concat([migrations.get(names[1]) ?? Buffer.alloc(0), Buffer.from('\n-- changed')]));
      await expect(apply(db, executor(db), changed)).rejects.toThrow('changed after it was applied');
    } finally {
      db.close();
    }
  });
});
