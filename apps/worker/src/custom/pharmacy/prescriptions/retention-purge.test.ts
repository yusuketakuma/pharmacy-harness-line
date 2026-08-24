import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import { purgePrescriptionFilesPastRetention } from './retention-purge.js';

const DB_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../../../../packages/db');
const require = createRequire(import.meta.url);

type SqliteStatement = {
  get(...values: unknown[]): unknown;
  all(...values: unknown[]): unknown[];
  run(...values: unknown[]): { changes: number };
};
type Sqlite3Database = {
  pragma(sql: string): unknown;
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
};
const Sqlite = require(join(DB_ROOT, 'node_modules/better-sqlite3')) as
  new (filename: string) => Sqlite3Database;

/** Adapts better-sqlite3 to the D1 surface the worker uses. */
function d1From(sqlite: Sqlite3Database): D1Database {
  const statement = (sql: string, values: unknown[] = []) => ({
    bind: (...next: unknown[]) => statement(sql, next),
    first: async () => sqlite.prepare(sql).get(...values) ?? null,
    all: async () => ({ success: true, results: sqlite.prepare(sql).all(...values), meta: {} }),
    run: async () => {
      const info = sqlite.prepare(sql).run(...values);
      return { success: true, meta: { changes: info.changes }, results: [] };
    },
  });
  return { prepare: (sql: string) => statement(sql) } as unknown as D1Database;
}

/** 2026-08-20T12:00Z minus three calendar years is 2023-08-20T12:00Z. */
const NOW = new Date('2026-08-20T12:00:00.000Z');
const KEPT_AT = '2023-08-21T12:00:00.000Z'; // three years minus a day
const PURGED_AT = '2023-08-19T12:00:00.000Z'; // three years plus a day

describe('pharmacy PHI retention purge (H-5, 3 years)', () => {
  let sqlite: Sqlite3Database;
  let db: D1Database;

  function seed(): void {
    const now = '2026-08-19T00:00:00.000Z';
    sqlite.prepare(`INSERT INTO line_accounts
      (id, channel_id, name, channel_access_token, channel_secret, created_at, updated_at)
      VALUES ('account-a', 'channel-a', 'a', 'token-a', 'secret-a', ?, ?)`).run(now, now);
    sqlite.prepare(`INSERT INTO tenants (id, tenant_code, display_name, status, created_at, updated_at)
      VALUES ('tenant-a', 'pharmacy-a', 'Tenant A', 'active', ?, ?)`).run(now, now);
    sqlite.prepare(`INSERT INTO tenant_line_accounts (tenant_id, line_account_id, created_at, updated_at)
      VALUES ('tenant-a', 'account-a', ?, ?)`).run(now, now);
    sqlite.prepare(`INSERT INTO friends
      (id, line_user_id, line_account_id, is_following, created_at, updated_at)
      VALUES ('friend-a', 'U-a', 'account-a', 1, ?, ?)`).run(now, now);
  }

  /** One submission plus one uploaded file, both stamped with `createdAt`. */
  function insertFile(fileId: string, createdAt: string, state = 'ready'): void {
    sqlite.prepare(`INSERT INTO pharmacy_prescription_submissions
      (id, line_account_id, friend_id, idempotency_key, status, active_revision,
       upload_revision, created_at, updated_at)
      VALUES (?, 'account-a', 'friend-a', ?, 'closed', 1, 1, ?, ?)`)
      .run(`submission-${fileId}`, `key-${fileId}`, createdAt, createdAt);
    sqlite.prepare(`INSERT INTO pharmacy_prescription_files
      (id, submission_id, revision, position, r2_key, content_type, byte_size, sha256,
       state, created_at, updated_at)
      VALUES (?, ?, 1, 1, ?, 'image/jpeg', 1024, ?, ?, ?, ?)`)
      .run(
        fileId,
        `submission-${fileId}`,
        `custom/pharmacy/prescriptions/tenants/tenant-a/submission-${fileId}/1/${fileId}`,
        'a'.repeat(64),
        state,
        createdAt,
        createdAt,
      );
  }

  const remainingFiles = () => (sqlite.prepare(
    `SELECT id, state FROM pharmacy_prescription_files ORDER BY id`,
  ).all() as Array<{ id: string; state: string }>);

  const purgeLog = () => (sqlite.prepare(
    `SELECT * FROM pharmacy_phi_retention_purge_log ORDER BY resource_id`,
  ).all() as Array<Record<string, unknown>>);

  beforeEach(() => {
    sqlite = new Sqlite(':memory:');
    sqlite.pragma('foreign_keys = ON');
    sqlite.exec(readFileSync(join(DB_ROOT, 'bootstrap.sql'), 'utf8'));
    sqlite.exec(readFileSync(
      join(DB_ROOT, 'migrations/custom_037_pharmacy_phi_retention_purge_log.sql'), 'utf8',
    ));
    sqlite.exec(readFileSync(
      join(DB_ROOT, 'migrations/custom_038_pharmacy_data_subject_requests.sql'), 'utf8',
    ));
    seed();
    db = d1From(sqlite);
  });

  /** Attaches an identified patient to a submission's file, as intake review does. */
  function attachPatient(fileId: string, patientId: string): void {
    const now = '2026-08-19T00:00:00.000Z';
    sqlite.prepare(`INSERT OR IGNORE INTO pharmacy_patients
      (id, line_account_id, owner_friend_id, relationship, name, name_kana, birth_date,
       created_at, updated_at)
      VALUES (?, 'account-a', 'friend-a', 'self', 'Patient', 'ﾊﾟｼｴﾝﾄ', '1990-01-01', ?, ?)`)
      .run(patientId, now, now);
    sqlite.prepare(`INSERT INTO pharmacy_patient_intake_responses
      (id, line_account_id, owner_friend_id, patient_id, revision, schema_version,
       patient_snapshot_json, answers_json, idempotency_key, representative_consent_at,
       privacy_consent_at, created_at)
      VALUES (?, 'account-a', 'friend-a', ?, 1, 1, '{}', '{"a":1}', 'idem-key-12345', ?, ?, ?)`)
      .run(`intake-${fileId}`, patientId, now, now, now);
    sqlite.prepare(`INSERT INTO pharmacy_prescription_patients
      (submission_id, line_account_id, owner_friend_id, patient_id, intake_response_id, created_at)
      VALUES (?, 'account-a', 'friend-a', ?, ?, ?)`)
      .run(`submission-${fileId}`, patientId, `intake-${fileId}`, now);
  }

  /** Seeds a legal-hold data subject request for `patientId`. */
  function seedLegalHold(patientId: string, releaseAt: string | null): void {
    const now = '2026-08-19T00:00:00.000Z';
    sqlite.prepare(`INSERT OR IGNORE INTO staff_members
      (id, name, role, api_key) VALUES ('staff-a', 'Staff', 'staff', 'api-key-a')`).run();
    sqlite.prepare(`INSERT OR IGNORE INTO tenant_staff_memberships
      (tenant_id, staff_id, role, created_at, updated_at)
      VALUES ('tenant-a', 'staff-a', 'staff', ?, ?)`).run(now, now);
    sqlite.prepare(`INSERT OR IGNORE INTO pharmacy_staff_accounts
      (line_account_id, staff_id, created_at, updated_at)
      VALUES ('account-a', 'staff-a', ?, ?)`).run(now, now);
    sqlite.prepare(`INSERT INTO pharmacy_data_subject_requests
      (id, tenant_id, line_account_id, owner_friend_id, patient_id, request_type, status,
       reason, legal_hold, legal_hold_basis, legal_hold_release_at, identity_verified_at,
       legal_hold_assessed_at, submitted_at, created_by, created_at, updated_at)
      VALUES (?, 'tenant-a', 'account-a', 'friend-a', ?, 'erasure', 'legal_hold_assessed',
        'requested erasure', 1, 'pharmacist_law_enforcement_regulation_3y', ?, ?, ?, ?, 'staff-a', ?, ?)`)
      .run(`dsr-${patientId}`, patientId, releaseAt, now, now, now, now, now);
  }

  test('purges only files unambiguously past the three-year boundary', async () => {
    insertFile('file-kept', KEPT_AT);
    insertFile('file-purged', PURGED_AT);
    const images = { delete: vi.fn().mockResolvedValue(undefined) } as unknown as R2Bucket;

    const result = await purgePrescriptionFilesPastRetention(db, images, { now: NOW });

    expect(result).toEqual({ purged: 1, failed: 0, skipped: 0 });
    expect(images.delete).toHaveBeenCalledTimes(1);
    expect(images.delete).toHaveBeenCalledWith(
      'custom/pharmacy/prescriptions/tenants/tenant-a/submission-file-purged/1/file-purged',
    );
    expect(remainingFiles()).toEqual([
      { id: 'file-kept', state: 'ready' },
      { id: 'file-purged', state: 'deleted' },
    ]);
  });

  test('records the purge in a log that outlives the purged object', async () => {
    insertFile('file-purged', PURGED_AT);
    const images = { delete: vi.fn().mockResolvedValue(undefined) } as unknown as R2Bucket;

    await purgePrescriptionFilesPastRetention(db, images, { now: NOW });

    expect(purgeLog()).toEqual([{
      id: expect.any(String),
      tenant_id: 'tenant-a',
      line_account_id: 'account-a',
      resource_type: 'prescription_file',
      resource_id: 'file-purged',
      r2_key: 'custom/pharmacy/prescriptions/tenants/tenant-a/submission-file-purged/1/file-purged',
      age_reference_at: PURGED_AT,
      retention_years: 3,
      purged_at: NOW.toISOString(),
    }]);
  });

  test('never deletes a file whose age reference is missing or ambiguous', async () => {
    // Every runtime write is `new Date().toISOString()`. Anything else — an empty
    // string, a date-only value, a JST offset — cannot be compared against a UTC
    // cutoff without guessing, so it is kept rather than guessed at.
    insertFile('file-empty', '');
    insertFile('file-date-only', '2019-01-01');
    insertFile('file-jst', '2019-01-01T00:00:00.000+09:00');
    insertFile('file-garbage', 'not-a-timestamp');
    const images = { delete: vi.fn().mockResolvedValue(undefined) } as unknown as R2Bucket;

    const result = await purgePrescriptionFilesPastRetention(db, images, { now: NOW });

    expect(result).toEqual({ purged: 0, failed: 0, skipped: 0 });
    expect(images.delete).not.toHaveBeenCalled();
    expect(purgeLog()).toEqual([]);
    expect(remainingFiles().every((row) => row.state === 'ready')).toBe(true);
  });

  test('leaves a file retryable and unlogged when R2 deletion fails', async () => {
    insertFile('file-purged', PURGED_AT);
    const images = {
      delete: vi.fn().mockRejectedValue(new Error('R2 unavailable')),
    } as unknown as R2Bucket;

    const result = await purgePrescriptionFilesPastRetention(db, images, { now: NOW });

    expect(result).toEqual({ purged: 0, failed: 1, skipped: 0 });
    expect(purgeLog()).toEqual([]);
    expect(remainingFiles()).toEqual([{ id: 'file-purged', state: 'ready' }]);
  });

  test('is idempotent: a logged purge is never repeated', async () => {
    insertFile('file-purged', PURGED_AT);
    const images = { delete: vi.fn().mockResolvedValue(undefined) } as unknown as R2Bucket;

    await purgePrescriptionFilesPastRetention(db, images, { now: NOW });
    const second = await purgePrescriptionFilesPastRetention(db, images, { now: NOW });

    expect(second).toEqual({ purged: 0, failed: 0, skipped: 0 });
    expect(images.delete).toHaveBeenCalledTimes(1);
    expect(purgeLog()).toHaveLength(1);
  });

  test('still reaps the object of a file already soft-deleted by the workflow cleanup', async () => {
    // cleanupPrescriptionImages marks state='deleted' before calling R2 and gives
    // up on failure. Without this the object could survive past retention.
    insertFile('file-soft-deleted', PURGED_AT, 'deleted');
    const images = { delete: vi.fn().mockResolvedValue(undefined) } as unknown as R2Bucket;

    const result = await purgePrescriptionFilesPastRetention(db, images, { now: NOW });

    expect(result).toEqual({ purged: 1, failed: 0, skipped: 0 });
    expect(images.delete).toHaveBeenCalledTimes(1);
    expect(purgeLog()).toHaveLength(1);
  });

  test('skips a file whose patient has an active legal hold (custom_038)', async () => {
    insertFile('file-held', PURGED_AT);
    attachPatient('file-held', 'patient-held');
    seedLegalHold('patient-held', null);
    const images = { delete: vi.fn().mockResolvedValue(undefined) } as unknown as R2Bucket;

    const result = await purgePrescriptionFilesPastRetention(db, images, { now: NOW });

    expect(result).toEqual({ purged: 0, failed: 0, skipped: 1 });
    expect(images.delete).not.toHaveBeenCalled();
    expect(purgeLog()).toEqual([]);
    expect(remainingFiles()).toEqual([{ id: 'file-held', state: 'ready' }]);
  });

  test('fails closed for an unlinked submission when its owner has an active legal hold', async () => {
    insertFile('file-unlinked', PURGED_AT);
    insertFile('file-linked', PURGED_AT);
    attachPatient('file-linked', 'patient-held');
    seedLegalHold('patient-held', null);
    const images = { delete: vi.fn().mockResolvedValue(undefined) } as unknown as R2Bucket;

    const result = await purgePrescriptionFilesPastRetention(db, images, { now: NOW });

    expect(result).toEqual({ purged: 0, failed: 0, skipped: 2 });
    expect(images.delete).not.toHaveBeenCalled();
    expect(purgeLog()).toEqual([]);
  });

  test('purges a file whose legal hold was already released', async () => {
    insertFile('file-released', PURGED_AT);
    attachPatient('file-released', 'patient-released');
    seedLegalHold('patient-released', '2024-01-01T00:00:00.000Z'); // released before NOW
    const images = { delete: vi.fn().mockResolvedValue(undefined) } as unknown as R2Bucket;

    const result = await purgePrescriptionFilesPastRetention(db, images, { now: NOW });

    expect(result).toEqual({ purged: 1, failed: 0, skipped: 0 });
    expect(images.delete).toHaveBeenCalledTimes(1);
    expect(purgeLog()).toHaveLength(1);
  });

  test('bounds each run so one tick cannot stall on a large backlog', async () => {
    for (let i = 0; i < 5; i++) insertFile(`file-${i}`, PURGED_AT);
    const images = { delete: vi.fn().mockResolvedValue(undefined) } as unknown as R2Bucket;

    const result = await purgePrescriptionFilesPastRetention(db, images, { now: NOW, limit: 2 });

    expect(result.purged).toBe(2);
    expect(purgeLog()).toHaveLength(2);
  });
});
