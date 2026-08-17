import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  acknowledgePrescriptionPrintTask,
  claimPrescriptionPrintTask,
  preparePrescriptionPrintTask,
} from '../../../apps/worker/src/custom/pharmacy/print/repository.js';

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

function seed(sqlite: Database.Database): void {
  sqlite.prepare(
    `INSERT INTO line_accounts
       (id, channel_id, name, channel_access_token, channel_secret, created_at, updated_at)
     VALUES ('account-a', 'channel-a', 'A', 'token', 'secret', ?, ?)`,
  ).run('2026-08-18T00:00:00Z', '2026-08-18T00:00:00Z');
  sqlite.prepare(
    `INSERT INTO friends (id, line_user_id, line_account_id, created_at, updated_at)
     VALUES ('friend-a', 'line-a', 'account-a', ?, ?)`,
  ).run('2026-08-18T00:00:00Z', '2026-08-18T00:00:00Z');
  sqlite.prepare(
    `INSERT INTO pharmacy_prescription_submissions
       (id, line_account_id, friend_id, idempotency_key, status,
        active_revision, upload_revision, created_at, updated_at)
     VALUES ('submission-a', 'account-a', 'friend-a', 'submission-key-a', 'received', 1, 1, ?, ?)`,
  ).run('2026-08-18T00:00:00Z', '2026-08-18T00:00:00Z');
  sqlite.prepare(
    `INSERT INTO pharmacy_prescription_files
       (id, submission_id, revision, position, r2_key, content_type, byte_size, sha256, state, created_at, updated_at)
     VALUES (?, 'submission-a', ?, 1, ?, 'image/png', 8, ?, 'ready', ?, ?)`,
  ).run('file-1', 1, 'custom/pharmacy/prescriptions/submission-a/file-1', 'a'.repeat(64), '2026-08-18T00:00:00Z', '2026-08-18T00:00:00Z');
}

describe('custom_009 pharmacy web print task', () => {
  it('is replay-safe and contains no resident-agent or printer telemetry states', () => {
    const sqlite = new Database(':memory:');
    sqlite.pragma('foreign_keys = ON');
    sqlite.exec(readFileSync(join(ROOT, 'bootstrap.sql'), 'utf8'));
    expect(() => sqlite.exec(readFileSync(
      join(ROOT, 'migrations/custom_009_pharmacy_print_queue.sql'), 'utf8',
    ))).not.toThrow();
    const sql = sqlite.prepare(
      `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'pharmacy_print_tasks'`,
    ).get() as { sql: string };
    expect(sql.sql).not.toMatch(/agent|dead_letter|paper_empty|ink_or_toner|printer_unavailable/);
  });

  it('allows one browser session to handle only the current account revision', async () => {
    const sqlite = new Database(':memory:');
    sqlite.pragma('foreign_keys = ON');
    sqlite.exec(readFileSync(join(ROOT, 'bootstrap.sql'), 'utf8'));
    seed(sqlite);
    const db = d1From(sqlite);

    const task = await preparePrescriptionPrintTask(db, 'account-a', 'submission-a');
    expect(task).toMatchObject({ revision: 1, status: 'pending' });
    await expect(claimPrescriptionPrintTask(db, 'account-b', task!.id, 'staff-b', 'session-b'))
      .resolves.toBeNull();
    await expect(claimPrescriptionPrintTask(db, 'account-a', task!.id, 'staff-a', 'session-a'))
      .resolves.toMatchObject({ status: 'handling' });
    await expect(claimPrescriptionPrintTask(db, 'account-a', task!.id, 'staff-a', 'session-b'))
      .resolves.toBeNull();
    await expect(acknowledgePrescriptionPrintTask(db, 'account-a', task!.id, 'staff-a', 'session-a'))
      .resolves.toMatchObject({ status: 'acknowledged' });
    await expect(acknowledgePrescriptionPrintTask(db, 'account-a', task!.id, 'staff-a', 'session-a'))
      .resolves.toMatchObject({ status: 'acknowledged' });
  });

  it('cancels an old revision and never acknowledges it after replacement', async () => {
    const sqlite = new Database(':memory:');
    sqlite.pragma('foreign_keys = ON');
    sqlite.exec(readFileSync(join(ROOT, 'bootstrap.sql'), 'utf8'));
    seed(sqlite);
    const db = d1From(sqlite);
    const oldTask = await preparePrescriptionPrintTask(db, 'account-a', 'submission-a');
    await claimPrescriptionPrintTask(db, 'account-a', oldTask!.id, 'staff-a', 'session-a');

    sqlite.prepare(`UPDATE pharmacy_prescription_submissions SET active_revision = 2, upload_revision = 2 WHERE id = 'submission-a'`).run();
    sqlite.prepare(
      `INSERT INTO pharmacy_prescription_files
         (id, submission_id, revision, position, r2_key, content_type, byte_size, sha256, state, created_at, updated_at)
       VALUES ('file-2', 'submission-a', 2, 1, 'custom/pharmacy/prescriptions/submission-a/file-2', 'image/png', 8, ?, 'ready', ?, ?)`,
    ).run('b'.repeat(64), '2026-08-18T00:01:00Z', '2026-08-18T00:01:00Z');

    await expect(preparePrescriptionPrintTask(db, 'account-a', 'submission-a'))
      .resolves.toMatchObject({ revision: 2, status: 'pending' });
    await expect(acknowledgePrescriptionPrintTask(db, 'account-a', oldTask!.id, 'staff-a', 'session-a'))
      .resolves.toBeNull();
    expect(sqlite.prepare(`SELECT status FROM pharmacy_print_tasks WHERE id = ?`).get(oldTask!.id))
      .toEqual({ status: 'cancelled' });
  });
});
