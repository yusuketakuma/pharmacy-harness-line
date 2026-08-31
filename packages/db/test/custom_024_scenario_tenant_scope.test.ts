import { beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getScenarios, getScenariosForAccount, getScenariosForTenant } from '../src/scenarios.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function d1From(sqlite: Database.Database): D1Database {
  const statement = (sql: string, values: unknown[] = []): D1PreparedStatement => ({
    bind: (...next: unknown[]) => statement(sql, next),
    first: async <T>() => (sqlite.prepare(sql).get(...values) as T | undefined) ?? null,
    all: async <T>() => ({
      success: true,
      results: sqlite.prepare(sql).all(...values) as T[],
      meta: {},
    }) as D1Result<T>,
    raw: async <T>() => sqlite.prepare(sql).raw().all(...values) as T[],
    run: async () => {
      const info = sqlite.prepare(sql).run(...values);
      return { success: true, meta: { changes: info.changes }, results: [] } as unknown as D1Result;
    },
  }) as unknown as D1PreparedStatement;
  return { prepare: (sql: string) => statement(sql) } as unknown as D1Database;
}

function seedTenant(sqlite: Database.Database, suffix: 'a' | 'b'): void {
  const now = '2026-08-19T00:00:00.000+09:00';
  sqlite.prepare(`INSERT INTO line_accounts
    (id, channel_id, name, channel_access_token, channel_secret, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(`account-${suffix}`, `channel-${suffix}`, suffix, `token-${suffix}`, `secret-${suffix}`, now, now);
  sqlite.prepare(`INSERT INTO tenants (id, tenant_code, display_name, status, created_at, updated_at)
    VALUES (?, ?, ?, 'active', ?, ?)`)
    .run(`tenant-${suffix}`, `pharmacy-${suffix}`, `Tenant ${suffix}`, now, now);
  sqlite.prepare(`INSERT INTO tenant_line_accounts (tenant_id, line_account_id, created_at, updated_at)
    VALUES (?, ?, ?, ?)`)
    .run(`tenant-${suffix}`, `account-${suffix}`, now, now);
}

function insertScenario(
  sqlite: Database.Database,
  id: string,
  tenantId: string | null,
  lineAccountId: string | null,
): void {
  const now = '2026-08-19T00:00:00.000+09:00';
  sqlite.prepare(`INSERT INTO scenarios
    (id, name, trigger_type, is_active, delivery_mode, tenant_id, line_account_id, created_at, updated_at)
    VALUES (?, ?, 'friend_add', 1, 'relative', ?, ?, ?, ?)`)
    .run(id, id, tenantId, lineAccountId, now, now);
}

describe('custom_024 scenario tenant scope (M-1)', () => {
  let sqlite: Database.Database;
  let db: D1Database;

  beforeEach(() => {
    sqlite = new Database(':memory:');
    sqlite.pragma('foreign_keys = ON');
    sqlite.exec(readFileSync(join(ROOT, 'bootstrap.sql'), 'utf8'));
    seedTenant(sqlite, 'a');
    seedTenant(sqlite, 'b');
  });

  it('never matches another tenant account-unassigned scenario', async () => {
    insertScenario(sqlite, 'scn-a-global', 'tenant-a', null);
    insertScenario(sqlite, 'scn-b-global', 'tenant-b', null);
    insertScenario(sqlite, 'scn-b-account', 'tenant-b', 'account-b');
    db = d1From(sqlite);

    const forB = await getScenariosForAccount(db, 'account-b');

    expect(forB.map((row) => row.id).sort()).toEqual(['scn-b-account', 'scn-b-global']);
    // The unscoped helper still sees everything — that is exactly why the
    // delivery path must not use it.
    expect((await getScenarios(db)).map((row) => row.id)).toContain('scn-a-global');
  });

  it('drops an unattributed legacy scenario instead of firing it for every tenant', async () => {
    insertScenario(sqlite, 'scn-orphan', null, null);
    db = d1From(sqlite);

    expect(await getScenariosForAccount(db, 'account-a')).toEqual([]);
    expect(await getScenariosForAccount(db, 'account-b')).toEqual([]);
  });

  it('returns nothing when the inbound account is unknown', async () => {
    insertScenario(sqlite, 'scn-a-global', 'tenant-a', null);
    db = d1From(sqlite);

    expect(await getScenariosForAccount(db, null)).toEqual([]);
    expect(await getScenariosForAccount(db, 'account-missing')).toEqual([]);
  });

  // The admin console lists scenarios with no account filter. That is a
  // different question from "which scenarios fire for this inbound account":
  // no filter means "everything this tenant owns", not "no match".
  it('lists the tenant own scenarios, account-bound and account-unassigned alike', async () => {
    insertScenario(sqlite, 'scn-a-global', 'tenant-a', null);
    insertScenario(sqlite, 'scn-a-account', 'tenant-a', 'account-a');
    insertScenario(sqlite, 'scn-b-global', 'tenant-b', null);
    insertScenario(sqlite, 'scn-b-account', 'tenant-b', 'account-b');
    db = d1From(sqlite);

    const forA = await getScenariosForTenant(db, 'tenant-a');

    expect(forA.map((row) => row.id).sort()).toEqual(['scn-a-account', 'scn-a-global']);
    expect(forA.map((row) => row.id)).not.toContain('scn-b-global');
    expect(forA.map((row) => row.id)).not.toContain('scn-b-account');
  });

  it('keeps unattributed legacy scenarios invisible to an attributed tenant', async () => {
    insertScenario(sqlite, 'scn-orphan', null, null);
    insertScenario(sqlite, 'scn-a-global', 'tenant-a', null);
    db = d1From(sqlite);

    // `tenant_id IS ?` (the tags/webhooks convention) keeps NULL-tenant rows
    // mutually invisible instead of leaking them into every tenant list.
    expect((await getScenariosForTenant(db, 'tenant-a')).map((r) => r.id)).toEqual(['scn-a-global']);
    expect((await getScenariosForTenant(db, null)).map((r) => r.id)).toEqual(['scn-orphan']);
  });

});
