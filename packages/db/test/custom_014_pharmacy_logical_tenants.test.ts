import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createLineAccount,
  getActiveTenantLineAccounts,
  getLineAccountByIdForTenant,
  getLineAccountsForTenant,
} from '../src/line-accounts.js';
import { upsertFriend } from '../src/friends.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATION_NAME = 'custom_014_pharmacy_logical_tenants.sql';

type RunnableStatement = D1PreparedStatement & { runSync(): D1Result };

function d1From(sqlite: Database.Database): D1Database {
  const statement = (sql: string, values: unknown[] = []): RunnableStatement => ({
    bind: (...next: unknown[]) => statement(sql, next),
    first: async <T>() => (sqlite.prepare(sql).get(...values) as T | undefined) ?? null,
    all: async <T>() => ({
      success: true,
      results: sqlite.prepare(sql).all(...values) as T[],
      meta: {},
    }) as D1Result<T>,
    raw: async <T>() => sqlite.prepare(sql).raw().all(...values) as T[],
    run: async () => statement(sql, values).runSync(),
    runSync: () => {
      const info = sqlite.prepare(sql).run(...values);
      return { success: true, meta: { changes: info.changes }, results: [] } as unknown as D1Result;
    },
  });
  return {
    prepare: (sql: string) => statement(sql),
    batch: async <T>(statements: D1PreparedStatement[]) => sqlite.transaction(() =>
      statements.map((item) => (item as RunnableStatement).runSync() as D1Result<T>),
    )(),
  } as unknown as D1Database;
}

function applyBeforeTenantMigration(db: Database.Database): void {
  db.exec(readFileSync(join(ROOT, 'bootstrap.sql'), 'utf8'));
}

function insertAccount(db: Database.Database, id: string): void {
  db.prepare(`INSERT INTO line_accounts
    (id, channel_id, name, channel_access_token, channel_secret)
    VALUES (?, ?, ?, ?, ?)`)
    .run(id, `channel-${id}`, `Pharmacy ${id}`, `token-${id}`, `secret-${id}`);
  db.prepare(`INSERT INTO tenants (id, tenant_code, display_name)
    VALUES (?, ?, ?)`).run(`tenant:${id}`, id, `Pharmacy ${id}`);
  db.prepare(`INSERT INTO tenant_line_accounts (tenant_id, line_account_id)
    VALUES (?, ?)`).run(`tenant:${id}`, id);
}

describe(MIGRATION_NAME, () => {
  it('keeps each LINE account in an isolated tenant by default', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    applyBeforeTenantMigration(db);
    insertAccount(db, 'account-a');
    insertAccount(db, 'account-b');

    expect(db.prepare(`SELECT tenant_code FROM tenants ORDER BY tenant_code`).all())
      .toEqual([{ tenant_code: 'account-a' }, { tenant_code: 'account-b' }]);

    const mappings = db.prepare(`
      SELECT tenant_id, line_account_id
        FROM tenant_line_accounts
       ORDER BY line_account_id
    `).all();
    expect(mappings).toEqual([
      { tenant_id: 'tenant:account-a', line_account_id: 'account-a' },
      { tenant_id: 'tenant:account-b', line_account_id: 'account-b' },
    ]);
    expect(db.prepare(`SELECT line_account_id, mode FROM pharmacy_account_capabilities
      ORDER BY line_account_id`).all()).toEqual([
      { line_account_id: 'account-a', mode: 'pharmacy' },
      { line_account_id: 'account-b', mode: 'pharmacy' },
    ]);
  });

  it('allows multiple accounts in one tenant but never one account in multiple tenants', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    applyBeforeTenantMigration(db);
    insertAccount(db, 'account-a');
    insertAccount(db, 'account-b');
    db.prepare(`INSERT INTO tenants
      (id, tenant_code, display_name, status, created_at, updated_at)
      VALUES ('tenant-shared', 'shared', 'Shared pharmacy', 'active', '2026-08-18', '2026-08-18')`).run();

    db.prepare(`UPDATE tenant_line_accounts SET tenant_id = 'tenant-shared'
      WHERE line_account_id IN ('account-a', 'account-b')`).run();
    expect(db.prepare(`SELECT COUNT(*) AS count FROM tenant_line_accounts
      WHERE tenant_id = 'tenant-shared'`).get()).toEqual({ count: 2 });

    expect(() => db.prepare(`INSERT INTO tenant_line_accounts
      (tenant_id, line_account_id, created_at)
      VALUES ('tenant:account-a', 'account-a', '2026-08-18')`).run())
      .toThrow(/UNIQUE constraint failed/i);
  });

  it('treats pharmacy codes as case-insensitive login identifiers', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    applyBeforeTenantMigration(db);
    insertAccount(db, 'account-a');

    expect(() => db.prepare(`INSERT INTO tenants
      (id, tenant_code, display_name, status, created_at, updated_at)
      VALUES ('tenant-duplicate', 'ACCOUNT-A', 'Duplicate', 'active', '2026-08-18', '2026-08-18')`).run())
      .toThrow(/UNIQUE constraint failed/i);
  });

  it('scopes account reads and atomically maps newly created accounts to one tenant', async () => {
    const sqlite = new Database(':memory:');
    sqlite.pragma('foreign_keys = ON');
    applyBeforeTenantMigration(sqlite);
    insertAccount(sqlite, 'account-a');
    insertAccount(sqlite, 'account-b');
    const db = d1From(sqlite);

    await expect(getLineAccountsForTenant(db, 'tenant:account-a'))
      .resolves.toMatchObject([{ id: 'account-a' }]);
    await expect(getLineAccountByIdForTenant(db, 'tenant:account-a', 'account-b'))
      .resolves.toBeNull();

    const created = await createLineAccount(db, {
      tenantId: 'tenant:account-a',
      channelId: 'channel-new',
      name: 'New account',
      channelAccessToken: 'token-new',
      channelSecret: 'secret-new',
    });
    expect(created.id).toBeTruthy();
    expect(sqlite.prepare(`SELECT tenant_id FROM tenant_line_accounts
      WHERE line_account_id = ?`).get(created.id))
      .toEqual({ tenant_id: 'tenant:account-a' });
    await expect(getLineAccountByIdForTenant(db, 'tenant:account-b', created.id))
      .resolves.toBeNull();

    sqlite.prepare(`UPDATE tenants SET status = 'suspended' WHERE id = 'tenant:account-a'`).run();
    await expect(getActiveTenantLineAccounts(db))
      .resolves.toMatchObject([{ id: 'account-b', tenant_id: 'tenant:account-b' }]);
  });

  it('never projects legacy plaintext credentials into tenant-scoped runtime reads', async () => {
    const sqlite = new Database(':memory:');
    sqlite.pragma('foreign_keys = ON');
    applyBeforeTenantMigration(sqlite);
    insertAccount(sqlite, 'account-a');
    const db = d1From(sqlite);

    const list = await getLineAccountsForTenant(db, 'tenant:account-a');
    const one = await getLineAccountByIdForTenant(db, 'tenant:account-a', 'account-a');
    const active = await getActiveTenantLineAccounts(db);

    for (const account of [...list, one!, ...active]) {
      expect(account.channel_access_token).toBe('legacy:unavailable');
      expect(account.channel_secret).toBe('legacy:unavailable');
      expect(account.login_channel_secret).toBeNull();
      expect(JSON.stringify(account)).not.toContain('token-account-a');
      expect(JSON.stringify(account)).not.toContain('secret-account-a');
    }
  });

  it('keeps the same LINE user isolated as distinct friends in different accounts', async () => {
    const sqlite = new Database(':memory:');
    sqlite.pragma('foreign_keys = ON');
    applyBeforeTenantMigration(sqlite);
    insertAccount(sqlite, 'account-a');
    insertAccount(sqlite, 'account-b');
    sqlite.prepare(`INSERT INTO friends
      (id, line_user_id, display_name, is_following, line_account_id, created_at, updated_at)
      VALUES ('friend-a', 'U-shared', 'Account A patient', 1, 'account-a', '2026-08-18', '2026-08-18')`).run();
    const db = d1From(sqlite);

    const accountBFriend = await upsertFriend(db, {
      lineUserId: 'U-shared',
      displayName: 'Account B patient',
      lineAccountId: 'account-b',
    } as Parameters<typeof upsertFriend>[1]);

    expect(sqlite.prepare(`SELECT display_name, line_account_id FROM friends
      WHERE id = 'friend-a'`).get()).toEqual({
      display_name: 'Account A patient',
      line_account_id: 'account-a',
    });
    expect(accountBFriend).toMatchObject({
      id: expect.not.stringMatching(/^friend-a$/),
      line_user_id: 'U-shared',
      display_name: 'Account B patient',
      line_account_id: 'account-b',
    });
    expect(sqlite.prepare(`SELECT line_user_id FROM friends WHERE id = ?`)
      .get(accountBFriend.id)).toEqual({ line_user_id: `friend-key:${accountBFriend.id}` });
    expect(sqlite.prepare(`SELECT COUNT(*) AS count FROM friends
      WHERE provider_line_user_id = 'U-shared'`).get()).toEqual({ count: 2 });
  });


});
