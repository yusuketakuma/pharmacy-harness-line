import { beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createAutomation,
  createAutomationLog,
  deleteAutomation,
  getAutomationById,
  getAutomationLogs,
  getAutomations,
  updateAutomation,
} from '../src/automations.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function d1From(sqlite: Database.Database): D1Database {
  const statement = (sql: string, values: unknown[] = []): D1PreparedStatement => ({
    bind: (...next: unknown[]) => statement(sql, next),
    first: async <T>() => (sqlite.prepare(sql).get(...values) as T | undefined) ?? null,
    all: async <T>() => ({
      results: sqlite.prepare(sql).all(...values) as T[],
      success: true,
      meta: {},
    }),
    run: async () => {
      const result = sqlite.prepare(sql).run(...values);
      return { success: true, meta: { changes: Number(result.changes) } };
    },
  } as unknown as D1PreparedStatement);
  return { prepare: (sql: string) => statement(sql) } as unknown as D1Database;
}

function insertTenant(sqlite: Database.Database, id: string): void {
  const now = '2026-08-31T00:00:00.000+09:00';
  sqlite.prepare(`INSERT INTO tenants
    (id, tenant_code, display_name, status, created_at, updated_at)
    VALUES (?, ?, ?, 'active', ?, ?)`).run(id, id, id, now, now);
}

function insertAccount(sqlite: Database.Database, id: string, tenantId: string): void {
  const now = '2026-08-31T00:00:00.000+09:00';
  sqlite.prepare(`INSERT INTO line_accounts
    (id, channel_id, name, channel_access_token, channel_secret, is_active, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 1, ?, ?)`).run(
    id,
    `channel-${id}`,
    id,
    `token-${id}`,
    `secret-${id}`,
    now,
    now,
  );
  sqlite.prepare(`INSERT INTO tenant_line_accounts
    (tenant_id, line_account_id, created_at, updated_at)
    VALUES (?, ?, ?, ?)`).run(tenantId, id, now, now);
}

function insertAutomation(sqlite: Database.Database, id: string, lineAccountId: string | null): void {
  const now = '2026-08-31T00:00:00.000+09:00';
  sqlite.prepare(`INSERT INTO automations
    (id, name, event_type, conditions, actions, line_account_id, created_at, updated_at)
    VALUES (?, ?, 'message_received', '{}', '[]', ?, ?, ?)`).run(id, id, lineAccountId, now, now);
}

function insertLog(sqlite: Database.Database, id: string, automationId: string): void {
  sqlite.prepare(`INSERT INTO automation_logs
    (id, automation_id, friend_id, event_data, actions_result, status, created_at)
    VALUES (?, ?, ?, ?, ?, 'failed', ?)`).run(
    id,
    automationId,
    null,
    JSON.stringify({ text: 'patient-sensitive-text' }),
    JSON.stringify([{ action: 'send_webhook', success: false, error: 'secret-upstream-body' }]),
    '2026-08-31T00:00:00.000+09:00',
  );
}

describe('automation tenant scope', () => {
  let sqlite: Database.Database;
  let db: D1Database;

  beforeEach(() => {
    sqlite = new Database(':memory:');
    sqlite.pragma('foreign_keys = ON');
    sqlite.exec(readFileSync(join(ROOT, 'bootstrap.sql'), 'utf8'));
    insertTenant(sqlite, 'tenant-a');
    insertTenant(sqlite, 'tenant-b');
    insertAccount(sqlite, 'account-a', 'tenant-a');
    insertAccount(sqlite, 'account-b', 'tenant-b');
    insertAutomation(sqlite, 'automation-a', 'account-a');
    insertAutomation(sqlite, 'automation-b', 'account-b');
    insertAutomation(sqlite, 'automation-global', null);
    insertLog(sqlite, 'log-b', 'automation-b');
    db = d1From(sqlite);
  });

  it('lists only mapped automations for the server tenant and selected account', async () => {
    expect((await getAutomations(db, 'tenant-a')).map((row) => row.id))
      .toEqual(['automation-a']);
    expect(await getAutomations(db, 'tenant-a', 'account-b')).toEqual([]);
    expect((await getAutomations(db, 'tenant-b')).map((row) => row.id))
      .toEqual(['automation-b']);
  });

  it('does not return a foreign detail or logs, and safe log projection omits raw payloads', async () => {
    expect(await getAutomationById(db, 'automation-b', 'tenant-a')).toBeNull();
    expect(await getAutomationById(db, 'automation-global', 'tenant-a')).toBeNull();
    expect(await getAutomationLogs(db, 'automation-b', 'tenant-a', 50)).toEqual([]);

    const logs = await getAutomationLogs(db, 'automation-b', 'tenant-b', 50);
    expect(logs).toMatchObject([{
      id: 'log-b',
      event_data: null,
      actions_result: null,
      status: 'failed',
    }]);
  });

  it('rejects foreign update/delete and only creates an account-mapped automation', async () => {
    expect(await updateAutomation(db, 'automation-b', { name: 'hacked' }, 'tenant-a')).toBe(false);
    expect(await deleteAutomation(db, 'automation-b', 'tenant-a')).toBe(false);
    expect(sqlite.prepare('SELECT name FROM automations WHERE id = ?').get('automation-b'))
      .toEqual({ name: 'automation-b' });

    await expect(createAutomation(db, {
      name: 'foreign',
      eventType: 'message_received',
      actions: [],
      lineAccountId: 'account-b',
      tenantId: 'tenant-a',
    })).resolves.toBeNull();

    const created = await createAutomation(db, {
      name: 'owned',
      eventType: 'message_received',
      actions: [],
      lineAccountId: 'account-a',
      tenantId: 'tenant-a',
    });
    expect(created).toMatchObject({ name: 'owned', line_account_id: 'account-a' });
  });

  it('does not persist event data or raw action errors in new logs', async () => {
    await createAutomationLog(db, {
      automationId: 'automation-a',
      eventData: JSON.stringify({ text: 'patient-sensitive-text' }),
      actionsResult: JSON.stringify([{ action: 'send_webhook', success: false, error: 'secret-upstream-body' }]),
      status: 'failed',
    });

    const row = sqlite.prepare(
      'SELECT event_data, actions_result FROM automation_logs ORDER BY created_at DESC LIMIT 1',
    ).get() as { event_data: string | null; actions_result: string | null };
    expect(row.event_data).toBeNull();
    expect(row.actions_result).toBe('[{"action":"send_webhook","success":false}]');
  });
});
