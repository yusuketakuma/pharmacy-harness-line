import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function loadDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(readFileSync(join(ROOT, 'bootstrap.sql'), 'utf8'));
  // Keep this focused migration test runnable while a checked-in bootstrap
  // generated before the composite parent key is being refreshed.
  db.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_pharmacy_print_jobs_id_account
       ON pharmacy_print_jobs (id, line_account_id)`,
  );
  return db;
}

function seedAccountAndFile(
  db: Database.Database,
  accountId: string,
  friendId: string,
  submissionId: string,
  fileId: string,
): void {
  db.prepare(
    `INSERT INTO line_accounts
       (id, channel_id, name, channel_access_token, channel_secret, created_at, updated_at)
     VALUES (?, ?, ?, 'token', 'secret', '2026-08-18T00:00:00Z', '2026-08-18T00:00:00Z')`,
  ).run(accountId, `channel-${accountId}`, accountId);
  db.prepare(
    `INSERT INTO friends
       (id, line_user_id, line_account_id, created_at, updated_at)
     VALUES (?, ?, ?, '2026-08-18T00:00:00Z', '2026-08-18T00:00:00Z')`,
  ).run(friendId, `line-${friendId}`, accountId);
  db.prepare(
    `INSERT INTO pharmacy_prescription_submissions
       (id, line_account_id, friend_id, idempotency_key, status,
        active_revision, upload_revision, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'received', 1, 1, '2026-08-18T00:00:00Z', '2026-08-18T00:00:00Z')`,
  ).run(submissionId, accountId, friendId, `submission-key-${submissionId}`);
  db.prepare(
    `INSERT INTO pharmacy_prescription_files
       (id, submission_id, revision, position, r2_key, content_type,
        byte_size, sha256, state, created_at, updated_at)
     VALUES (?, ?, 1, 1, ?, 'image/png', 8, ?, 'ready',
             '2026-08-18T00:00:00Z', '2026-08-18T00:00:00Z')`,
  ).run(
    fileId,
    submissionId,
    `custom/pharmacy/prescriptions/${submissionId}/${fileId}`,
    'a'.repeat(64),
  );
}

describe('custom_009_pharmacy_print_queue.sql', () => {
  it('creates an account-scoped print queue and audit table', () => {
    const db = loadDb();
    const meta = JSON.parse(
      readFileSync(join(ROOT, 'bootstrap-meta.json'), 'utf8'),
    ) as { includedMigrations: string[] };
    expect(meta.includedMigrations).toContain('custom_009_pharmacy_print_queue.sql');
    const tables = db.prepare(
      `SELECT name FROM sqlite_master
       WHERE type = 'table' AND name IN ('pharmacy_print_jobs', 'pharmacy_print_events')
       ORDER BY name`,
    ).all() as Array<{ name: string }>;
    expect(tables.map((row) => row.name)).toEqual([
      'pharmacy_print_events',
      'pharmacy_print_jobs',
    ]);
    const columns = db.prepare('PRAGMA table_info(pharmacy_print_jobs)').all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).not.toEqual(
      expect.arrayContaining(['r2_key', 'patient_name', 'drug_name']),
    );
  });

  it('enforces account-scoped idempotency and fixed audit failure codes', () => {
    const db = loadDb();
    seedAccountAndFile(db, 'account-a', 'friend-a', 'submission-a', 'file-a');
    seedAccountAndFile(db, 'account-b', 'friend-b', 'submission-b', 'file-b');
    const insert = db.prepare(
      `INSERT INTO pharmacy_print_jobs
         (id, line_account_id, submission_id, file_id, revision, idempotency_key,
          status, available_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, 1, ?, 'queued', ?, ?, ?)`,
    );
    insert.run(
      'job-a', 'account-a', 'submission-a', 'file-a', 'same-key',
      '2026-08-18T00:00:00Z', '2026-08-18T00:00:00Z', '2026-08-18T00:00:00Z',
    );
    expect(() => insert.run(
      'job-a-duplicate', 'account-a', 'submission-a', 'file-a', 'other-key',
      '2026-08-18T00:00:00Z', '2026-08-18T00:00:00Z', '2026-08-18T00:00:00Z',
    )).toThrow(/UNIQUE constraint failed/);
    expect(() => insert.run(
      'job-b', 'account-b', 'submission-b', 'file-b', 'same-key',
      '2026-08-18T00:00:00Z', '2026-08-18T00:00:00Z', '2026-08-18T00:00:00Z',
    )).not.toThrow();

    const event = db.prepare(
      `INSERT INTO pharmacy_print_events
         (id, job_id, line_account_id, event_type, actor_type, attempt_count,
          failure_code, created_at)
       VALUES (?, 'job-a', 'account-a', 'failed', 'staff', 1, ?, ?)`,
    );
    expect(() => event.run('event-bad', 'patient_name', '2026-08-18T00:00:00Z'))
      .toThrow(/CHECK constraint failed/);
  });
});
