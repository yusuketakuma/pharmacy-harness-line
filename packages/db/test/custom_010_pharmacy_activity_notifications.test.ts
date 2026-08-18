import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  acknowledgeActivityNotification,
  createActivityNotification,
  listActivityNotifications,
} from '../../../apps/worker/src/custom/pharmacy/activity-notifications/repository.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

type RunnableStatement = D1PreparedStatement & { runSync(): D1Result };
function d1From(sqlite: Database.Database): D1Database {
  const statement = (sql: string, values: unknown[] = []): RunnableStatement => ({
    bind: (...next: unknown[]) => statement(sql, next),
    first: async <T>() => (sqlite.prepare(sql).get(...values) as T | undefined) ?? null,
    all: async <T>() => ({ success: true, results: sqlite.prepare(sql).all(...values) as T[], meta: {} }) as D1Result<T>,
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

function load(): { sqlite: Database.Database; db: D1Database } {
  const sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  sqlite.exec(readFileSync(join(ROOT, 'bootstrap.sql'), 'utf8'));
  sqlite.prepare(
    `INSERT INTO line_accounts
       (id, channel_id, name, channel_access_token, channel_secret, created_at, updated_at)
     VALUES ('account-a', 'channel-a', 'A', 'token', 'secret', ?, ?)`,
  ).run('2026-08-18T00:00:00Z', '2026-08-18T00:00:00Z');
  return { sqlite, db: d1From(sqlite) };
}

describe('custom_010 shared pharmacy activity inbox', () => {
  it('is replay-safe and stores no recipient, raw key, payload, or PHI columns', () => {
    const { sqlite } = load();
    expect(() => sqlite.exec(readFileSync(
      join(ROOT, 'migrations/custom_010_pharmacy_activity_notifications.sql'), 'utf8',
    ))).not.toThrow();
    const columns = sqlite.prepare(`PRAGMA table_info(pharmacy_activity_notifications)`).all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).not.toEqual(expect.arrayContaining([
      'staff_id', 'idempotency_key', 'payload_json', 'patient_name', 'line_user_id',
    ]));
  });

  it('creates one account item per source event and never returns its dedupe material', async () => {
    const { sqlite, db } = load();
    const first = await createActivityNotification(db, {
      lineAccountId: 'account-a', activityType: 'prescription_received', idempotencyKey: 'submission:opaque-1',
    });
    const retry = await createActivityNotification(db, {
      lineAccountId: 'account-a', activityType: 'prescription_received', idempotencyKey: 'submission:opaque-1',
    });
    expect(retry?.id).toBe(first?.id);
    expect(sqlite.prepare(`SELECT COUNT(*) AS count FROM pharmacy_activity_notifications`).get())
      .toEqual({ count: 1 });
    expect(JSON.stringify(await listActivityNotifications(db, 'account-a', false, 20)))
      .not.toContain('opaque-1');
  });

  it('one acknowledgement closes the shared item and retries idempotently', async () => {
    const { db } = load();
    const item = await createActivityNotification(db, {
      lineAccountId: 'account-a', activityType: 'prescription_received', idempotencyKey: 'source-1',
    });
    await expect(acknowledgeActivityNotification(db, 'account-a', item!.id, 'staff-a'))
      .resolves.toMatchObject({ acknowledged_by: 'staff-a' });
    await expect(acknowledgeActivityNotification(db, 'account-a', item!.id, 'staff-b'))
      .resolves.toMatchObject({ acknowledged_by: 'staff-a' });
    await expect(listActivityNotifications(db, 'account-a', false, 20)).resolves.toEqual([]);
    await expect(listActivityNotifications(db, 'account-a', true, 20)).resolves.toHaveLength(1);
  });
});
