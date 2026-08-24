import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, test } from 'vitest';

import {
  _resetCacheForTest as resetDuplicatesCache,
  computeDuplicatesStats,
} from './duplicates-stats.js';
import {
  _resetCacheForTest as resetUsersCache,
  computeUsersGrouped,
} from './users-grouped.js';

const DB_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../../packages/db');
const require = createRequire(import.meta.url);

type SqliteStatement = {
  get(...values: unknown[]): unknown;
  all(...values: unknown[]): unknown[];
  run(...values: unknown[]): { changes: number };
};
type SqliteDatabase = {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
};
const Sqlite = require(join(DB_ROOT, 'node_modules/better-sqlite3')) as
  new (filename: string) => SqliteDatabase;

function d1From(sqlite: SqliteDatabase): D1Database {
  const statement = (sql: string, values: unknown[] = []) => ({
    bind: (...next: unknown[]) => statement(sql, next),
    first: async () => sqlite.prepare(sql).get(...values) ?? null,
    all: async () => ({ success: true, results: sqlite.prepare(sql).all(...values), meta: {} }),
  });
  return { prepare: (sql: string) => statement(sql) } as unknown as D1Database;
}

function seedTenant(sqlite: SqliteDatabase, suffix: 'a' | 'b'): void {
  const now = '2026-08-23T00:00:00.000Z';
  sqlite.prepare(`INSERT INTO line_accounts
    (id, channel_id, name, channel_access_token, channel_secret, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(`account-${suffix}`, `channel-${suffix}`, `Account ${suffix}`, 'token', 'secret', now, now);
  sqlite.prepare(`INSERT INTO tenants
    (id, tenant_code, display_name, status, created_at, updated_at)
    VALUES (?, ?, ?, 'active', ?, ?)`)
    .run(`tenant-${suffix}`, suffix, `Tenant ${suffix}`, now, now);
  sqlite.prepare(`INSERT INTO tenant_line_accounts
    (tenant_id, line_account_id, created_at, updated_at) VALUES (?, ?, ?, ?)`)
    .run(`tenant-${suffix}`, `account-${suffix}`, now, now);
}

function seedFriend(
  sqlite: SqliteDatabase,
  id: string,
  tenantSuffix: 'a' | 'b',
  displayName: string,
  pictureUrl: string | null,
): void {
  const now = '2026-08-23T00:00:00.000Z';
  sqlite.prepare(`INSERT INTO friends
    (id, line_user_id, provider_line_user_id, user_id, display_name, picture_url,
     line_account_id, is_following, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`)
    .run(id, `legacy-${id}`, `provider-${id}`, `user-${id}`, displayName, pictureUrl,
      `account-${tenantSuffix}`, now, now);
}

describe('tenant analytics SQL', () => {
  beforeEach(() => {
    resetDuplicatesCache();
    resetUsersCache();
  });

  test('keeps rows, identities, and cached results inside each tenant', async () => {
    const sqlite = new Sqlite(':memory:');
    sqlite.exec(readFileSync(join(DB_ROOT, 'bootstrap.sql'), 'utf8'));
    seedTenant(sqlite, 'a');
    seedTenant(sqlite, 'b');
    const sharedPicture = `https://sprofile.line-scdn.net/${'x'.repeat(90)}`;
    seedFriend(sqlite, 'friend-a1', 'a', 'A One', sharedPicture);
    seedFriend(sqlite, 'friend-a2', 'a', 'A Two', null);
    seedFriend(sqlite, 'friend-b1', 'b', 'B One', sharedPicture);
    const db = d1From(sqlite);

    const usersA = await computeUsersGrouped(db, 'tenant-a');
    const usersB = await computeUsersGrouped(db, 'tenant-b');
    const duplicatesA = await computeDuplicatesStats(db, 'tenant-a');
    const duplicatesB = await computeDuplicatesStats(db, 'tenant-b');

    expect(usersA.rows.map((row) => row.displayName).sort()).toEqual(['A One', 'A Two']);
    expect(usersA.rows.flatMap((row) => row.accounts.map((account) => account.accountId)))
      .toEqual(['account-a', 'account-a']);
    expect(usersB.rows.map((row) => row.displayName)).toEqual(['B One']);
    expect(duplicatesA.total_following).toBe(2);
    expect(duplicatesA.per_account.map((row) => row.account_id)).toEqual(['account-a']);
    expect(duplicatesB.total_following).toBe(1);
    expect(duplicatesB.per_account.map((row) => row.account_id)).toEqual(['account-b']);
  });
});
