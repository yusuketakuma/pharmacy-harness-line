import { describe, expect, it, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createTrackedLink,
  getOrCreateAutoTrackedLink,
} from '../src/tracked-links.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(__dirname, '..');

const BENIGN = /duplicate column name|already exists/i;

function execSafe(db: Database.Database, sql: string): void {
  for (const stmt of sql
    .split(/;\s*(?:\r?\n|$)/)
    .map((s) => s.trim())
    .filter(Boolean)) {
    try {
      db.exec(stmt);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!BENIGN.test(msg)) throw err;
    }
  }
}

function setupDb(): Database.Database {
  const db = new Database(':memory:');
  execSafe(db, readFileSync(join(PKG_ROOT, 'schema.sql'), 'utf8'));
  return db;
}

function asD1(sqlite: Database.Database): D1Database {
  return {
    prepare(query: string) {
      return {
        bind(...params: unknown[]) {
          const stmt = sqlite.prepare(query);
          return {
            async run() {
              stmt.run(...params);
              return { results: [], success: true, meta: {} };
            },
            async first<T>() {
              return (stmt.get(...params) as T) ?? null;
            },
            async all<T>() {
              return { results: stmt.all(...params) as T[], success: true, meta: {} };
            },
          };
        },
        async run() {
          sqlite.prepare(query).run();
          return { results: [], success: true, meta: {} };
        },
        async first<T>() {
          return (sqlite.prepare(query).get() as T) ?? null;
        },
        async all<T>() {
          return { results: sqlite.prepare(query).all() as T[], success: true, meta: {} };
        },
      };
    },
  } as unknown as D1Database;
}

function insertLineAccount(sqlite: Database.Database, id: string): void {
  sqlite
    .prepare(
      `INSERT INTO line_accounts (id, channel_id, name, channel_access_token, channel_secret)
       VALUES (?, ?, ?, 'token', 'secret')`,
    )
    .run(id, `ch-${id}`, id);
}

function insertLegacyAutoLink(
  sqlite: Database.Database,
  row: {
    id: string;
    originalUrl: string;
    lineAccountId?: string | null;
    name?: string;
    createdAt: string;
    isActive?: number;
  },
): void {
  sqlite
    .prepare(
      `INSERT INTO tracked_links (id, name, original_url, line_account_id, short_code, dedup_key, is_active, click_count, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, NULL, ?, 0, ?, ?)`,
    )
    .run(
      row.id,
      row.name ?? `auto: ${row.originalUrl.slice(0, 60)}`,
      row.originalUrl,
      row.lineAccountId ?? null,
      `sc${row.id}`.slice(0, 7),
      row.isActive ?? 1,
      row.createdAt,
      row.createdAt,
    );
}

function countRows(sqlite: Database.Database, url: string): number {
  const row = sqlite
    .prepare(`SELECT COUNT(*) AS c FROM tracked_links WHERE original_url = ?`)
    .get(url) as { c: number };
  return row.c;
}

describe('getOrCreateAutoTrackedLink', () => {
  let sqlite: Database.Database;
  let db: D1Database;

  beforeEach(() => {
    sqlite = setupDb();
    db = asD1(sqlite);
  });

  it('reuses the same row for repeated sends of the same url+account', async () => {
    insertLineAccount(sqlite, 'acc-1');
    const first = await getOrCreateAutoTrackedLink(db, {
      originalUrl: 'https://example.com/lp',
      lineAccountId: 'acc-1',
    });
    const second = await getOrCreateAutoTrackedLink(db, {
      originalUrl: 'https://example.com/lp',
      lineAccountId: 'acc-1',
    });

    expect(second.id).toBe(first.id);
    expect(second.short_code).toBe(first.short_code);
    expect(countRows(sqlite, 'https://example.com/lp')).toBe(1);
  });

  it('keeps separate rows per account, and NULL account is its own bucket', async () => {
    insertLineAccount(sqlite, 'acc-1');
    insertLineAccount(sqlite, 'acc-2');
    const url = 'https://example.com/lp';
    const acc1 = await getOrCreateAutoTrackedLink(db, { originalUrl: url, lineAccountId: 'acc-1' });
    const acc2 = await getOrCreateAutoTrackedLink(db, { originalUrl: url, lineAccountId: 'acc-2' });
    const noAcc = await getOrCreateAutoTrackedLink(db, { originalUrl: url });
    const noAccAgain = await getOrCreateAutoTrackedLink(db, { originalUrl: url, lineAccountId: null });

    expect(new Set([acc1.id, acc2.id, noAcc.id]).size).toBe(3);
    expect(noAccAgain.id).toBe(noAcc.id);
    expect(countRows(sqlite, url)).toBe(3);
  });

  it('never dedupes manually created links (dedup_key stays NULL)', async () => {
    const url = 'https://example.com/manual';
    const manual1 = await createTrackedLink(db, { name: 'campaign A', originalUrl: url });
    const manual2 = await createTrackedLink(db, { name: 'campaign B', originalUrl: url });
    const auto = await getOrCreateAutoTrackedLink(db, { originalUrl: url });

    expect(manual1.id).not.toBe(manual2.id);
    expect(manual1.dedup_key).toBeNull();
    expect(manual2.dedup_key).toBeNull();
    // auto link is a third, independent row — manual rows are never reused
    expect(auto.id).not.toBe(manual1.id);
    expect(auto.id).not.toBe(manual2.id);
    expect(countRows(sqlite, url)).toBe(3);
  });

  it('reactivates a deactivated auto link instead of returning a dead /t target', async () => {
    const url = 'https://example.com/lp';
    const link = await getOrCreateAutoTrackedLink(db, { originalUrl: url });
    sqlite.prepare(`UPDATE tracked_links SET is_active = 0 WHERE id = ?`).run(link.id);

    const reused = await getOrCreateAutoTrackedLink(db, { originalUrl: url });
    expect(reused.id).toBe(link.id);
    expect(reused.is_active).toBe(1);
    const row = sqlite
      .prepare(`SELECT is_active FROM tracked_links WHERE id = ?`)
      .get(link.id) as { is_active: number };
    expect(row.is_active).toBe(1);
  });

  it('recovers the winner row when a concurrent insert beats the SELECT (race)', async () => {
    const url = 'https://example.com/raced';
    // Simulate the race: the first SELECT-by-dedup_key misses, then another
    // delivery inserts the row before our INSERT runs.
    let selectCount = 0;
    const raced = {
      prepare(query: string) {
        const inner = (db as unknown as { prepare(q: string): unknown }).prepare(query);
        if (/SELECT \* FROM tracked_links WHERE dedup_key = \?/.test(query)) {
          return {
            bind(...params: unknown[]) {
              const bound = (inner as { bind(...p: unknown[]): { first<T>(): Promise<T | null> } }).bind(...params);
              return {
                async first<T>() {
                  selectCount += 1;
                  if (selectCount === 1) {
                    const winner = await getOrCreateAutoTrackedLink(db, { originalUrl: url });
                    expect(winner).toBeTruthy();
                    return null; // pretend our SELECT ran before the winner's INSERT
                  }
                  return bound.first<T>();
                },
              };
            },
          };
        }
        return inner;
      },
    } as unknown as D1Database;

    const link = await getOrCreateAutoTrackedLink(raced, { originalUrl: url });
    expect(countRows(sqlite, url)).toBe(1);
    const row = sqlite
      .prepare(`SELECT id FROM tracked_links WHERE original_url = ?`)
      .get(url) as { id: string };
    expect(link.id).toBe(row.id);
  });
});
