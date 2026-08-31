import { beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createEntryRoute, getEntryRouteFunnel } from '../src/entry-routes.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function d1From(sqlite: Database.Database): D1Database {
  const statement = (sql: string, values: unknown[] = []): D1PreparedStatement => ({
    bind: (...next: unknown[]) => statement(sql, next),
    first: async <T>() => (sqlite.prepare(sql).get(...values) as T | undefined) ?? null,
    run: async () => {
      const info = sqlite.prepare(sql).run(...values);
      return { success: true, meta: { changes: info.changes }, results: [] } as unknown as D1Result;
    },
  }) as unknown as D1PreparedStatement;
  return { prepare: (sql: string) => statement(sql) } as unknown as D1Database;
}

describe('005 custom_062 ref tracking tenant scope', () => {
  let sqlite: Database.Database;
  let db: D1Database;

  beforeEach(() => {
    sqlite = new Database(':memory:');
    sqlite.pragma('foreign_keys = ON');
    sqlite.exec(readFileSync(join(ROOT, 'bootstrap.sql'), 'utf8'));
    sqlite.exec(`
      INSERT INTO tenants (id, tenant_code, display_name) VALUES
        ('tenant-a', 'a', 'A'), ('tenant-b', 'b', 'B');
      INSERT INTO line_accounts
        (id, channel_id, name, channel_access_token, channel_secret) VALUES
        ('account-a', 'channel-a', 'A', 'token-a', 'secret-a'),
        ('account-b', 'channel-b', 'B', 'token-b', 'secret-b');
      INSERT INTO tenant_line_accounts (tenant_id, line_account_id) VALUES
        ('tenant-a', 'account-a'), ('tenant-b', 'account-b');
      INSERT INTO friends (id, line_user_id, line_account_id, ref_code) VALUES
        ('friend-a', 'line-a', 'account-a', 'shared-ref'),
        ('friend-b', 'line-b', 'account-b', 'shared-ref');
    `);
    db = d1From(sqlite);
  });

  it('backfills and counts only tracking rows owned by the route tenant', async () => {
    sqlite.exec(`INSERT INTO ref_tracking (id, ref_code, friend_id) VALUES
      ('tracking-a', 'shared-ref', 'friend-a'),
      ('tracking-b', 'shared-ref', 'friend-b')`);

    const route = await createEntryRoute(db, {
      refCode: 'shared-ref', name: 'Tenant A route', tenantId: 'tenant-a',
    });

    expect(sqlite.prepare(
      `SELECT entry_route_id FROM ref_tracking WHERE id = 'tracking-a'`,
    ).get()).toEqual({ entry_route_id: route.id });
    expect(sqlite.prepare(
      `SELECT entry_route_id FROM ref_tracking WHERE id = 'tracking-b'`,
    ).get()).toEqual({ entry_route_id: null });
    await expect(getEntryRouteFunnel(db, route.id)).resolves.toEqual({
      click_count: 1,
      friend_add_count: 1,
      form_submission_count: 0,
      cv_count: 0,
    });
  });

  it('rejects a direct cross-tenant route attribution', async () => {
    const route = await createEntryRoute(db, {
      refCode: 'tenant-a-ref', name: 'Tenant A route', tenantId: 'tenant-a',
    });

    expect(() => sqlite.prepare(
      `INSERT INTO ref_tracking (id, ref_code, friend_id, entry_route_id)
       VALUES ('cross-tenant', 'tenant-a-ref', 'friend-b', ?)`,
    ).run(route.id)).toThrow(/REF_TRACKING_ENTRY_ROUTE_TENANT_SCOPE_MISMATCH/);
  });

  it('preserves tracking for the isolated legacy-global scope', async () => {
    sqlite.exec(`
      INSERT INTO line_accounts
        (id, channel_id, name, channel_access_token, channel_secret)
        VALUES ('account-global', 'channel-global', 'Global', 'token-global', 'secret-global');
      INSERT INTO friends (id, line_user_id, line_account_id, ref_code)
        VALUES ('friend-global', 'line-global', 'account-global', 'global-ref');
      INSERT INTO ref_tracking (id, ref_code, friend_id)
        VALUES ('tracking-global', 'global-ref', 'friend-global');
    `);

    const route = await createEntryRoute(db, { refCode: 'global-ref', name: 'Global route' });

    await expect(getEntryRouteFunnel(db, route.id)).resolves.toMatchObject({
      click_count: 1,
      friend_add_count: 1,
    });
  });
});
