import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);

/** Absolute path of packages/db, for bootstrap.sql / schema.sql / migration fixtures. */
export const DB_PACKAGE_ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../../packages/db',
);

export interface TestSqliteStatement {
  readonly reader: boolean;
  get(...values: unknown[]): unknown;
  all(...values: unknown[]): unknown[];
  run(...values: unknown[]): { changes: number };
}

export interface TestSqliteDatabase {
  pragma(sql: string): unknown;
  exec(sql: string): void;
  prepare(sql: string): TestSqliteStatement;
  transaction<T extends unknown[], R>(fn: (...args: T) => R): (...args: T) => R;
  close(): void;
}

// better-sqlite3 is a packages/db devDependency and pnpm does not hoist it
// into the worker workspace, so tests resolve it by path from this one place.
export const Sqlite = require(
  join(DB_PACKAGE_ROOT, 'node_modules/better-sqlite3'),
) as new (filename: string) => TestSqliteDatabase;

export function openTestSqlite(options?: { foreignKeys?: boolean }): TestSqliteDatabase {
  const sqlite = new Sqlite(':memory:');
  if (options?.foreignKeys) sqlite.pragma('foreign_keys = ON');
  return sqlite;
}

/**
 * Minimal D1Database adapter over better-sqlite3 for unit tests.
 * batch() runs the statements inside a real transaction; any failure rolls
 * the whole batch back like D1's atomic batch semantics.
 */
export function d1FromSqlite(sqlite: TestSqliteDatabase): D1Database {
  const statement = (sql: string, values: unknown[] = []) => ({
    __sql: sql,
    __values: values,
    bind: (...next: unknown[]) => statement(sql, next),
    first: async <T>() => (sqlite.prepare(sql).get(...values) as T | undefined) ?? null,
    all: async <T>() => ({
      success: true,
      results: sqlite.prepare(sql).all(...values) as T[],
      meta: {},
    }),
    run: async () => ({
      success: true,
      meta: { changes: sqlite.prepare(sql).run(...values).changes },
      results: [],
    }),
  });
  return {
    prepare: (sql: string) => statement(sql),
    batch: async (statements: D1PreparedStatement[]) => {
      sqlite.exec('BEGIN');
      try {
        const results = (statements as unknown as Array<{ __sql?: string; __values?: unknown[] }>)
          .map((item) => {
            if (!item.__sql) throw new Error('test adapter statement missing SQL');
            const prepared = sqlite.prepare(item.__sql);
            if (prepared.reader) {
              return {
                success: true,
                meta: { changes: 0 },
                results: prepared.all(...(item.__values ?? [])),
              };
            }
            return {
              success: true,
              meta: { changes: prepared.run(...(item.__values ?? [])).changes },
              results: [],
            };
          });
        sqlite.exec('COMMIT');
        return results;
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    },
  } as unknown as D1Database;
}
