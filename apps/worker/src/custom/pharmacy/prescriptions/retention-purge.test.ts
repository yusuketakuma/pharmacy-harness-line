import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import {
  purgePrescriptionFilesPastRetention,
  reconcilePrescriptionDeletionIntents,
} from './retention-purge.js';
import {
  cancelDeletionIntent,
  commitPrescriptionDeletionIntent,
  createDeletionIntent,
  markDeletionOutcomeUnknown,
  readRetentionFence,
} from '../retention/deletion-intents.js';
import { prepareRetentionFence } from '../retention/fence.js';

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
  transaction<T>(fn: () => T): () => T;
};
const Sqlite = require(join(DB_ROOT, 'node_modules/better-sqlite3')) as
  new (filename: string) => Sqlite3Database;

/** Adapts better-sqlite3 to the D1 surface the worker uses. */
function d1From(sqlite: Sqlite3Database): D1Database {
  const statement = (sql: string, values: unknown[] = []) => ({
    bind: (...next: unknown[]) => statement(sql, next),
    first: async () => sqlite.prepare(sql).get(...values) ?? null,
    all: async () => ({ success: true, results: sqlite.prepare(sql).all(...values), meta: {} }),
    runSync: () => {
      const info = sqlite.prepare(sql).run(...values);
      return { success: true, meta: { changes: info.changes }, results: [] };
    },
    run: async () => {
      const info = sqlite.prepare(sql).run(...values);
      return { success: true, meta: { changes: info.changes }, results: [] };
    },
  });
  return {
    prepare: (sql: string) => statement(sql),
    batch: async <T>(statements: D1PreparedStatement[]) => {
      const run = sqlite.transaction(() => statements.map(
        (item) => (item as unknown as { runSync(): D1Result }).runSync(),
      ));
      return run() as unknown as D1Result<T>[];
    },
  } as unknown as D1Database;
}

/** 2026-08-20T12:00Z minus three calendar years is 2023-08-20T12:00Z. */
const NOW = new Date('2026-08-20T12:00:00.000Z');
const KEPT_AT = '2023-08-21T12:00:00.000Z'; // three years minus a day
const PURGED_AT = '2023-08-19T12:00:00.000Z'; // three years plus a day
const EXECUTION = {
  operationId: 'operation-retention-test',
  executionId: 'execution-retention-test',
  fenceToken: 'f'.repeat(32),
  executorSubject: 'test-worker',
  tenantId: 'tenant-a',
  lineAccountId: 'account-a',
  environment: 'test',
};

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
      VALUES ('friend-a', 'U-a', 'account-a', 1, ?, ?)`)
      .run('2019-01-01T00:00:00.000Z', '2019-01-01T00:00:00.000Z');
    sqlite.prepare(`INSERT INTO pharmacy_retention_hold_epochs
      (tenant_id, line_account_id, owner_friend_id, patient_key, epoch, status,
       release_at, reason_code, updated_at)
      VALUES ('tenant-a', 'account-a', 'friend-a', '*', 1, 'released',
              '2020-01-01T00:00:00.000Z', 'test_baseline', ?)`).run(now);
    sqlite.prepare(`INSERT INTO pharmacy_recovery_operations
      (id, tenant_id, line_account_id, environment, operation, status,
       requested_by_issuer, requested_by_subject, approver_issuer, approver_subject,
       executor_issuer, executor_subject, approval_expires_at, job_id, idempotency_key,
       execution_id, fence_id, fence_token, created_at, claimed_at, updated_at)
      VALUES (?, 'tenant-a', 'account-a', 'test', 'retention_delete', 'running',
       'platform-admin', 'requester', 'platform-admin', 'approver',
       'platform-admin', ?, ?, 'job-retention', 'idem-retention', ?, ?, ?, ?, ?, ?)`).run(
      EXECUTION.operationId, EXECUTION.executorSubject, '2099-01-01T00:00:00.000Z',
      EXECUTION.executionId, 'fence-retention-id', EXECUTION.fenceToken, now, now, now,
    );
    sqlite.prepare(`INSERT INTO pharmacy_recovery_execution_fences
      (fence_id, operation_id, tenant_id, line_account_id, environment, execution_id,
       fence_token, owner_issuer, owner_subject, status, expires_at, created_at)
      VALUES ('fence-retention-id', ?, 'tenant-a', 'account-a', 'test', ?, ?,
              'platform-admin', ?, 'active', '2099-01-01T00:00:00.000Z', ?)`).run(
      EXECUTION.operationId, EXECUTION.executionId, EXECUTION.fenceToken,
      EXECUTION.executorSubject, now,
    );
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
    seed();
    db = d1From(sqlite);
  });

  /** Attaches an identified patient to a submission's file, as intake review does. */
  function attachPatient(
    fileId: string,
    patientId: string,
    recordedAt = '2026-08-19T00:00:00.000Z',
    relationship: 'self' | 'other' = 'self',
  ): void {
    sqlite.prepare(`INSERT OR IGNORE INTO pharmacy_patients
      (id, line_account_id, owner_friend_id, relationship, name, name_kana, birth_date,
       created_at, updated_at)
       VALUES (?, 'account-a', 'friend-a', ?, 'Patient', 'ﾊﾟｼｴﾝﾄ', '1990-01-01', ?, ?)`)
      .run(patientId, relationship, recordedAt, recordedAt);
    sqlite.prepare(`INSERT INTO pharmacy_patient_intake_responses
      (id, line_account_id, owner_friend_id, patient_id, revision, schema_version,
       patient_snapshot_json, answers_json, idempotency_key, representative_consent_at,
       privacy_consent_at, created_at)
      VALUES (?, 'account-a', 'friend-a', ?, 1, 1, '{}', '{"a":1}', ?, ?, ?, ?)`)
      .run(`intake-${fileId}`, patientId, `idem-key-${fileId}`, recordedAt, recordedAt, recordedAt);
    sqlite.prepare(`INSERT INTO pharmacy_prescription_patients
      (submission_id, line_account_id, owner_friend_id, patient_id, intake_response_id, created_at)
      VALUES (?, 'account-a', 'friend-a', ?, ?, ?)`)
      .run(`submission-${fileId}`, patientId, `intake-${fileId}`, recordedAt);
  }

  function insertReleasedFile(fileId: string, createdAt: string, state = 'ready'): void {
    insertFile(fileId, createdAt, state);
    attachPatient(fileId, `patient-${fileId}`, '2019-01-01T00:00:00.000Z', 'other');
  }

  function mockImages(
    putImplementation = vi.fn().mockResolvedValue({ key: 'tombstone', etag: 'tombstone-etag' }),
  ): R2Bucket {
    return {
      head: vi.fn().mockResolvedValue({
        etag: 'selected-etag', checksums: { sha256: 'a'.repeat(64) },
      }),
      put: putImplementation,
      delete: vi.fn(),
    } as unknown as R2Bucket;
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
    const status = releaseAt === null || releaseAt > NOW.toISOString() ? 'held' : 'released';
    sqlite.prepare(`INSERT INTO pharmacy_retention_hold_epochs
      (tenant_id, line_account_id, owner_friend_id, patient_key, epoch, status,
       release_at, reason_code, updated_at)
      VALUES ('tenant-a', 'account-a', 'friend-a', ?, 1, ?, ?, 'test_seed', ?)`).run(
      patientId, status, releaseAt, now,
    );
    sqlite.prepare(`INSERT INTO pharmacy_retention_hold_epochs
      (tenant_id, line_account_id, owner_friend_id, patient_key, epoch, status,
       release_at, reason_code, updated_at)
      VALUES ('tenant-a', 'account-a', 'friend-a', '*', 1, ?, ?, 'test_seed', ?)
      ON CONFLICT (tenant_id, line_account_id, owner_friend_id, patient_key)
      DO UPDATE SET epoch = pharmacy_retention_hold_epochs.epoch + 1,
                    status = excluded.status, release_at = excluded.release_at,
                    reason_code = excluded.reason_code, updated_at = excluded.updated_at`).run(
      status, releaseAt, now,
    );
  }

  const purgeOptions = (extra: Record<string, unknown> = {}) => ({
    execution: EXECUTION,
    ...extra,
  });

  test('does not mutate when the recovery execution proof is missing', async () => {
    insertFile('file-without-proof', PURGED_AT);
    const images = mockImages();

    await expect(purgePrescriptionFilesPastRetention(db, images, { now: NOW }))
      .resolves.toEqual({ purged: 0, failed: 0, skipped: 0 });
    expect(images.put).not.toHaveBeenCalled();
    expect(remainingFiles()).toEqual([{ id: 'file-without-proof', state: 'ready' }]);
  });

  test('purges only files unambiguously past the three-year boundary', async () => {
    insertFile('file-kept', KEPT_AT);
    insertReleasedFile('file-purged', PURGED_AT);
    const images = mockImages();

    const result = await purgePrescriptionFilesPastRetention(db, images, purgeOptions({ now: NOW }));

    expect(result).toEqual({ purged: 1, failed: 0, skipped: 0 });
    expect(images.put).toHaveBeenCalledTimes(1);
    expect(images.put).toHaveBeenCalledWith(
      'custom/pharmacy/prescriptions/tenants/tenant-a/submission-file-purged/1/file-purged',
      null,
      expect.objectContaining({ onlyIf: { etagMatches: 'selected-etag' } }),
    );
    expect(remainingFiles()).toEqual([
      { id: 'file-kept', state: 'ready' },
      { id: 'file-purged', state: 'deleted' },
    ]);
  });

  test('records the purge in a log that outlives the purged object', async () => {
    insertReleasedFile('file-purged', PURGED_AT);
    const images = mockImages();

    await purgePrescriptionFilesPastRetention(db, images, purgeOptions({ now: NOW }));

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
    insertFile('file-offset-with-z', '2019-01-01T00:00:00.000+09:00Z');
    insertFile('file-garbage', 'not-a-timestamp');
    const images = mockImages();

    const result = await purgePrescriptionFilesPastRetention(db, images, purgeOptions({ now: NOW }));

    expect(result).toEqual({ purged: 0, failed: 0, skipped: 1 });
    expect(images.put).not.toHaveBeenCalled();
    expect(purgeLog()).toEqual([]);
    expect(remainingFiles().every((row) => row.state === 'ready')).toBe(true);
  });

  test('leaves a file retryable and unlogged when R2 deletion fails', async () => {
    insertReleasedFile('file-purged', PURGED_AT);
    const images = mockImages(vi.fn().mockRejectedValue(new Error('R2 unavailable')));

    const result = await purgePrescriptionFilesPastRetention(db, images, purgeOptions({ now: NOW }));

    expect(result).toEqual({ purged: 0, failed: 1, skipped: 0 });
    expect(purgeLog()).toEqual([]);
    expect(remainingFiles()).toEqual([{ id: 'file-purged', state: 'ready' }]);
  });

  test('does not leave final evidence when the file CAS is lost after R2 deletion', async () => {
    insertReleasedFile('file-finalize-race', PURGED_AT);
    const images = mockImages(vi.fn().mockImplementation(async () => {
      sqlite.prepare(`DELETE FROM pharmacy_prescription_files WHERE id = ?`)
        .run('file-finalize-race');
    }));

    const result = await purgePrescriptionFilesPastRetention(
      db, images, purgeOptions({ now: NOW }),
    );

    expect(result).toEqual({ purged: 0, failed: 1, skipped: 0 });
    expect(purgeLog()).toEqual([]);
    expect(sqlite.prepare(`SELECT status FROM pharmacy_retention_deletion_intents
      WHERE resource_id = 'file-finalize-race'`).get()).toEqual({ status: 'OUTCOME_UNKNOWN' });
  });

  test('does not delete when R2 identity checksum is unavailable or mismatched', async () => {
    insertReleasedFile('file-checksum-mismatch', PURGED_AT);
    const images = {
      head: vi.fn().mockResolvedValue({
        etag: 'selected-etag', checksums: { sha256: 'b'.repeat(64) },
      }),
      put: vi.fn(),
      delete: vi.fn().mockResolvedValue(undefined),
    } as unknown as R2Bucket;

    const result = await purgePrescriptionFilesPastRetention(
      db, images, purgeOptions({ now: NOW }),
    );

    expect(result).toEqual({ purged: 0, failed: 1, skipped: 0 });
    expect(images.delete).not.toHaveBeenCalled();
    expect(purgeLog()).toEqual([]);
    expect(sqlite.prepare(`SELECT status FROM pharmacy_retention_deletion_intents
      WHERE resource_id = 'file-checksum-mismatch'`).get()).toEqual({ status: 'OUTCOME_UNKNOWN' });
  });

  test('does not delete when the R2 checksum changes after selection', async () => {
    insertReleasedFile('file-checksum-race', PURGED_AT);
    const images = {
      head: vi.fn().mockResolvedValue({
        etag: 'selected-etag', checksums: { sha256: 'a'.repeat(64) },
      }),
      put: vi.fn().mockResolvedValue(null),
      delete: vi.fn(),
    } as unknown as R2Bucket;

    await expect(purgePrescriptionFilesPastRetention(
      db, images, purgeOptions({ now: NOW }),
    )).resolves.toEqual({ purged: 0, failed: 1, skipped: 0 });
    expect(images.delete).not.toHaveBeenCalled();
    expect(sqlite.prepare(`SELECT status FROM pharmacy_retention_deletion_intents
      WHERE resource_id = 'file-checksum-race'`).get()).toEqual({ status: 'OUTCOME_UNKNOWN' });
  });

  test('does not erase a replacement that wins the conditional R2 disposition', async () => {
    insertReleasedFile('file-etag-race', PURGED_AT);
    const images = {
      head: vi.fn().mockResolvedValue({
        etag: 'selected-etag', checksums: { sha256: 'a'.repeat(64) },
      }),
      put: vi.fn().mockResolvedValue(null),
      delete: vi.fn(),
    } as unknown as R2Bucket;

    await expect(purgePrescriptionFilesPastRetention(
      db, images, purgeOptions({ now: NOW }),
    )).resolves.toEqual({ purged: 0, failed: 1, skipped: 0 });
    expect(images.put).toHaveBeenCalledWith(
      expect.stringContaining('file-etag-race'),
      null,
      expect.objectContaining({ onlyIf: { etagMatches: 'selected-etag' } }),
    );
    expect(images.delete).not.toHaveBeenCalled();
    expect(sqlite.prepare(`SELECT status FROM pharmacy_retention_deletion_intents
      WHERE resource_id = 'file-etag-race'`).get()).toEqual({ status: 'OUTCOME_UNKNOWN' });
  });

  test('reconciles a missing object exactly once and finalizes the DB batch', async () => {
    insertReleasedFile('file-reconcile-once', PURGED_AT);
    const failingImages = mockImages(vi.fn().mockRejectedValue(new Error('timeout')));
    await purgePrescriptionFilesPastRetention(
      db, failingImages, purgeOptions({ now: NOW }),
    );

    const missingImages = {
      head: vi.fn().mockResolvedValue(null),
      delete: vi.fn(),
    } as unknown as R2Bucket;
    await expect(reconcilePrescriptionDeletionIntents(
      db, missingImages, purgeOptions({ now: NOW }),
    )).resolves.toEqual({ purged: 1, failed: 0, skipped: 0 });
    await expect(reconcilePrescriptionDeletionIntents(
      db, missingImages, purgeOptions({ now: NOW }),
    )).resolves.toEqual({ purged: 0, failed: 0, skipped: 0 });
    expect(purgeLog()).toHaveLength(1);
    expect(sqlite.prepare(`SELECT status FROM pharmacy_retention_deletion_intents
      WHERE resource_id = 'file-reconcile-once'`).get()).toEqual({ status: 'FINALIZED_DELETED' });
  });

  test('reconciles a confirmed R2 tombstone after an unknown outcome', async () => {
    insertReleasedFile('file-reconcile-tombstone', PURGED_AT);
    await purgePrescriptionFilesPastRetention(
      db,
      mockImages(vi.fn().mockRejectedValue(new Error('outcome unknown'))),
      purgeOptions({ now: NOW }),
    );
    const tombstone = {
      head: vi.fn().mockResolvedValue({
        customMetadata: { retentionDisposition: 'pharmacy-retention-v1' },
      }),
    } as unknown as R2Bucket;

    await expect(reconcilePrescriptionDeletionIntents(
      db, tombstone, purgeOptions({ now: NOW }),
    )).resolves.toEqual({ purged: 1, failed: 0, skipped: 0 });
    expect(sqlite.prepare(`SELECT status FROM pharmacy_retention_deletion_intents
      WHERE resource_id = 'file-reconcile-tombstone'`).get())
      .toEqual({ status: 'FINALIZED_DELETED' });
  });

  test('reconcile limit is scoped to the active execution', async () => {
    insertReleasedFile('file-reconcile-scoped', PURGED_AT);
    await purgePrescriptionFilesPastRetention(
      db,
      mockImages(vi.fn().mockRejectedValue(new Error('outcome unknown'))),
      purgeOptions({ now: NOW }),
    );
    sqlite.prepare(`INSERT INTO pharmacy_retention_deletion_intents
      (id, operation_id, execution_id, fence_token, executor_subject, environment,
       tenant_id, line_account_id, owner_friend_id, patient_key, resource_type,
       resource_id, r2_key, stored_sha256, age_reference_at, row_state, row_revision,
       hold_epoch, status, created_at, updated_at)
      VALUES ('foreign-intent', 'other-operation', 'other-execution', ?, 'other-worker',
       'test', 'tenant-a', 'account-a', 'friend-a', '*', 'prescription_file',
       'foreign-resource', 'foreign-key', ?, ?, 'ready', 1, 1, 'OUTCOME_UNKNOWN', ?, ?)`).run(
      'x'.repeat(32), 'b'.repeat(64), PURGED_AT,
      '2019-01-01T00:00:00.000Z', '2019-01-01T00:00:00.000Z',
    );
    const missing = { head: vi.fn().mockResolvedValue(null) } as unknown as R2Bucket;

    await expect(reconcilePrescriptionDeletionIntents(
      db, missing, purgeOptions({ now: NOW, limit: 1 }),
    )).resolves.toEqual({ purged: 1, failed: 0, skipped: 0 });
    expect(sqlite.prepare(`SELECT status FROM pharmacy_retention_deletion_intents
      WHERE id = 'foreign-intent'`).get()).toEqual({ status: 'OUTCOME_UNKNOWN' });
  });

  test('lets only one worker delete the same object generation', async () => {
    insertReleasedFile('file-two-workers', PURGED_AT);
    const images = mockImages();

    const results = await Promise.all([
      purgePrescriptionFilesPastRetention(db, images, purgeOptions({ now: NOW })),
      purgePrescriptionFilesPastRetention(db, images, purgeOptions({ now: NOW })),
    ]);

    expect(results.reduce((total, result) => total + result.purged, 0)).toBe(1);
    expect(images.put).toHaveBeenCalledTimes(1);
    expect(purgeLog()).toHaveLength(1);
  });

  test('is idempotent: a logged purge is never repeated', async () => {
    insertReleasedFile('file-purged', PURGED_AT);
    const images = mockImages();

    await purgePrescriptionFilesPastRetention(db, images, purgeOptions({ now: NOW }));
    const second = await purgePrescriptionFilesPastRetention(db, images, purgeOptions({ now: NOW }));

    expect(second).toEqual({ purged: 0, failed: 0, skipped: 0 });
    expect(images.put).toHaveBeenCalledTimes(1);
    expect(purgeLog()).toHaveLength(1);
  });

  test('still reaps the object of a file already soft-deleted by the workflow cleanup', async () => {
    // cleanupPrescriptionImages marks state='deleted' before calling R2 and gives
    // up on failure. Without this the object could survive past retention.
    insertReleasedFile('file-soft-deleted', PURGED_AT, 'deleted');
    const images = mockImages();

    const result = await purgePrescriptionFilesPastRetention(db, images, purgeOptions({ now: NOW }));

    expect(result).toEqual({ purged: 1, failed: 0, skipped: 0 });
    expect(images.put).toHaveBeenCalledTimes(1);
    expect(purgeLog()).toHaveLength(1);
  });

  test('skips a file whose patient has an active legal hold (custom_038)', async () => {
    insertFile('file-held', PURGED_AT);
    attachPatient('file-held', 'patient-held');
    seedLegalHold('patient-held', null);
    const images = mockImages();

    const result = await purgePrescriptionFilesPastRetention(db, images, purgeOptions({ now: NOW }));

    expect(result).toEqual({ purged: 0, failed: 0, skipped: 1 });
    expect(images.put).not.toHaveBeenCalled();
    expect(purgeLog()).toEqual([]);
    expect(remainingFiles()).toEqual([{ id: 'file-held', state: 'ready' }]);
  });

  test('fails closed for an unlinked submission when its owner has an active legal hold', async () => {
    insertFile('file-unlinked', PURGED_AT);
    insertFile('file-linked', PURGED_AT);
    attachPatient('file-linked', 'patient-held');
    seedLegalHold('patient-held', null);
    const images = mockImages();

    const result = await purgePrescriptionFilesPastRetention(db, images, purgeOptions({ now: NOW }));

    expect(result).toEqual({ purged: 0, failed: 0, skipped: 2 });
    expect(images.put).not.toHaveBeenCalled();
    expect(purgeLog()).toEqual([]);
  });

  test('purges a file whose legal hold was already released', async () => {
    insertFile('file-released', PURGED_AT);
    attachPatient('file-released', 'patient-released', '2019-01-01T00:00:00.000Z');
    seedLegalHold('patient-released', '2024-01-01T00:00:00.000Z'); // released before NOW
    const images = mockImages();

    const result = await purgePrescriptionFilesPastRetention(db, images, purgeOptions({ now: NOW }));

    expect(result).toEqual({ purged: 1, failed: 0, skipped: 0 });
    expect(images.put).toHaveBeenCalledTimes(1);
    expect(purgeLog()).toHaveLength(1);
  });

  test('keeps an old file when a newer prescription event is still retained', async () => {
    insertReleasedFile('file-newer-event', PURGED_AT);
    sqlite.prepare(`INSERT INTO pharmacy_prescription_events
      (id, submission_id, actor_type, event_type, created_at)
      VALUES ('event-newer', 'submission-file-newer-event', 'system',
       'status_changed', '2026-01-01T00:00:00.000Z')`).run();
    const images = mockImages();

    await expect(purgePrescriptionFilesPastRetention(db, images, purgeOptions({ now: NOW })))
      .resolves.toEqual({ purged: 0, failed: 0, skipped: 1 });
    expect(images.put).not.toHaveBeenCalled();
  });

  test('fails closed when an owner LINE message has a non-UTC retention timestamp', async () => {
    insertReleasedFile('file-owner-message', PURGED_AT);
    sqlite.prepare(`INSERT INTO messages_log
      (id, friend_id, direction, message_type, content, line_account_id, created_at)
      VALUES ('message-owner', 'friend-a', 'incoming', 'text', 'message', 'account-a',
       '2026-01-01T09:00:00.000+09:00')`).run();
    const images = mockImages();

    await expect(purgePrescriptionFilesPastRetention(db, images, purgeOptions({ now: NOW })))
      .resolves.toEqual({ purged: 0, failed: 0, skipped: 1 });
    expect(images.put).not.toHaveBeenCalled();
  });

  test('blocks deletion while a DSR is received or identity is not yet assessed', async () => {
    insertReleasedFile('file-dsr-unassessed', PURGED_AT);
    const patientId = 'patient-file-dsr-unassessed';
    seedLegalHold(patientId, '2024-01-01T00:00:00.000Z');
    sqlite.prepare(`UPDATE pharmacy_data_subject_requests
      SET status = 'received', legal_hold = NULL, legal_hold_basis = NULL,
          legal_hold_release_at = NULL, legal_hold_assessed_at = NULL
      WHERE id = ?`).run(`dsr-${patientId}`);
    const images = mockImages();

    const result = await purgePrescriptionFilesPastRetention(
      db, images, purgeOptions({ now: NOW }),
    );

    expect(result).toEqual({ purged: 0, failed: 0, skipped: 1 });
    expect(images.put).not.toHaveBeenCalled();
    expect(sqlite.prepare(`SELECT status FROM pharmacy_retention_hold_epochs
      WHERE patient_key = ?`).get(patientId)).toEqual({ status: 'unknown' });
  });

  test('does not commit after a hold appears between claim and commit', async () => {
    const fileId = 'file-hold-after-claim';
    insertReleasedFile(fileId, PURGED_AT);
    const r2Key = `custom/pharmacy/prescriptions/tenants/tenant-a/submission-${fileId}/1/${fileId}`;
    const fenceScope = {
      tenantId: 'tenant-a', lineAccountId: 'account-a', ownerFriendId: 'friend-a',
      patientId: `patient-${fileId}`,
    };
    const fence = await prepareRetentionFence(db, fenceScope, NOW, EXECUTION);
    const intent = await createDeletionIntent(db, {
      execution: EXECUTION, tenantId: 'tenant-a', lineAccountId: 'account-a',
      ownerFriendId: 'friend-a', patientKey: `patient-${fileId}`,
      resourceType: 'prescription_file', resourceId: fileId, r2Key,
      storedSha256: 'a'.repeat(64), ageReferenceAt: PURGED_AT, rowState: 'ready',
      rowRevision: 1, holdEpoch: fence.epoch, now: NOW.toISOString(),
    });
    expect(intent?.status).toBe('CLAIMED');
    sqlite.prepare(`UPDATE pharmacy_retention_hold_epochs
      SET epoch = epoch + 1, status = 'held' WHERE owner_friend_id = 'friend-a'`).run();
    const blockedFence = await readRetentionFence(db, {
      tenantId: 'tenant-a', lineAccountId: 'account-a', ownerFriendId: 'friend-a',
      patientKey: `patient-${fileId}`,
    });
    await expect(commitPrescriptionDeletionIntent(db, {
      intent: intent!, expectedFence: blockedFence, previousHoldEpoch: intent!.hold_epoch,
      execution: EXECUTION, now: NOW.toISOString(),
    })).resolves.toBe(false);
    expect(sqlite.prepare(`SELECT status FROM pharmacy_retention_deletion_intents
      WHERE resource_id = ?`).get(fileId)).toEqual({ status: 'CLAIMED' });
  });

  test('does not cancel or mark an intent owned by another execution', async () => {
    const fileId = 'file-foreign-execution-intent';
    insertReleasedFile(fileId, PURGED_AT);
    const r2Key = `custom/pharmacy/prescriptions/tenants/tenant-a/submission-${fileId}/1/${fileId}`;
    const fence = await prepareRetentionFence(db, {
      tenantId: 'tenant-a', lineAccountId: 'account-a', ownerFriendId: 'friend-a',
      patientId: `patient-${fileId}`,
    }, NOW, EXECUTION);
    const intent = await createDeletionIntent(db, {
      execution: EXECUTION, tenantId: 'tenant-a', lineAccountId: 'account-a',
      ownerFriendId: 'friend-a', patientKey: `patient-${fileId}`,
      resourceType: 'prescription_file', resourceId: fileId, r2Key,
      storedSha256: 'a'.repeat(64), ageReferenceAt: PURGED_AT, rowState: 'ready',
      rowRevision: 1, holdEpoch: fence.epoch, now: NOW.toISOString(),
    });
    sqlite.prepare(`UPDATE pharmacy_retention_deletion_intents
      SET operation_id = 'foreign-operation', execution_id = 'foreign-execution',
          fence_token = ?, executor_subject = 'foreign-worker'
      WHERE id = ?`).run('x'.repeat(32), intent!.id);

    await expect(cancelDeletionIntent(db, {
      id: intent!.id, status: 'CANCELLED_STALE', reasonCode: 'foreign',
      now: NOW.toISOString(), execution: EXECUTION,
    })).resolves.toBe(false);
    sqlite.prepare(`UPDATE pharmacy_retention_deletion_intents
      SET status = 'DELETE_COMMITTED' WHERE id = ?`).run(intent!.id);
    await expect(markDeletionOutcomeUnknown(db, {
      id: intent!.id, reasonCode: 'foreign', now: NOW.toISOString(), execution: EXECUTION,
    })).resolves.toBe(false);
    expect(sqlite.prepare(`SELECT status FROM pharmacy_retention_deletion_intents
      WHERE id = ?`).get(intent!.id)).toEqual({ status: 'DELETE_COMMITTED' });
  });

  test('does not commit when an authoritative DSR appears without a materialized epoch', async () => {
    const fileId = 'file-dsr-after-claim';
    const patientId = `patient-${fileId}`;
    insertReleasedFile(fileId, PURGED_AT);
    seedLegalHold(patientId, '2024-01-01T00:00:00.000Z');
    sqlite.prepare(`DELETE FROM pharmacy_data_subject_requests WHERE patient_id = ?`).run(patientId);
    const r2Key = `custom/pharmacy/prescriptions/tenants/tenant-a/submission-${fileId}/1/${fileId}`;
    const fence = await prepareRetentionFence(db, {
      tenantId: 'tenant-a', lineAccountId: 'account-a', ownerFriendId: 'friend-a', patientId,
    }, NOW, EXECUTION);
    const intent = await createDeletionIntent(db, {
      execution: EXECUTION, tenantId: 'tenant-a', lineAccountId: 'account-a',
      ownerFriendId: 'friend-a', patientKey: patientId,
      resourceType: 'prescription_file', resourceId: fileId, r2Key,
      storedSha256: 'a'.repeat(64), ageReferenceAt: PURGED_AT, rowState: 'ready',
      rowRevision: 1, holdEpoch: fence.epoch, now: NOW.toISOString(),
    });
    sqlite.prepare(`INSERT INTO pharmacy_data_subject_requests
      (id, tenant_id, line_account_id, owner_friend_id, patient_id, request_type, status,
       reason, submitted_at, created_by, created_at, updated_at)
      VALUES ('dsr-after-claim', 'tenant-a', 'account-a', 'friend-a', ?, 'erasure',
       'received', 'request', ?, 'staff-a', ?, ?)`).run(
      patientId, NOW.toISOString(), NOW.toISOString(), NOW.toISOString(),
    );
    sqlite.prepare(`UPDATE pharmacy_retention_hold_epochs
      SET epoch = epoch + 1, status = 'released'
      WHERE owner_friend_id = 'friend-a' AND patient_key IN (?, '*')`).run(patientId);
    const latestFence = await readRetentionFence(db, {
      tenantId: 'tenant-a', lineAccountId: 'account-a', ownerFriendId: 'friend-a',
      patientKey: patientId,
    });

    await expect(commitPrescriptionDeletionIntent(db, {
      intent: intent!, expectedFence: latestFence, previousHoldEpoch: intent!.hold_epoch,
      execution: EXECUTION, now: NOW.toISOString(),
    })).resolves.toBe(false);
    expect(sqlite.prepare(`SELECT status, hold_epoch FROM pharmacy_retention_deletion_intents
      WHERE resource_id = ?`).get(fileId)).toEqual({
      status: 'CLAIMED', hold_epoch: intent!.hold_epoch,
    });
  });

  test('does not leave file state or purge evidence when the final intent row is gone', async () => {
    insertReleasedFile('file-finalize-cas', PURGED_AT);
    let intercepted = false;
    const racingDb = {
      ...db,
      batch: async <T>(statements: D1PreparedStatement[]) => {
        if (!intercepted && statements.length === 3) {
          intercepted = true;
          sqlite.prepare(`DELETE FROM pharmacy_retention_deletion_intents
            WHERE resource_id = 'file-finalize-cas'`).run();
        }
        return db.batch<T>(statements);
      },
    } as D1Database;

    await expect(purgePrescriptionFilesPastRetention(
      racingDb, mockImages(), purgeOptions({ now: NOW }),
    )).resolves.toEqual({ purged: 0, failed: 1, skipped: 0 });
    expect(sqlite.prepare(`SELECT state FROM pharmacy_prescription_files
      WHERE id = 'file-finalize-cas'`).get()).toEqual({ state: 'ready' });
    expect(sqlite.prepare(`SELECT COUNT(*) AS count FROM pharmacy_phi_retention_purge_log
      WHERE resource_id = 'file-finalize-cas'`).get()).toEqual({ count: 0 });
  });

  test('does not overwrite a DSR hold created after source inventory was read', async () => {
    const fileId = 'file-dsr-during-fence';
    const patientId = `patient-${fileId}`;
    insertReleasedFile(fileId, PURGED_AT);
    seedLegalHold(patientId, '2024-01-01T00:00:00.000Z');
    sqlite.prepare(`DELETE FROM pharmacy_data_subject_requests WHERE patient_id = ?`).run(patientId);
    let injected = false;
    const racingDb = {
      ...db,
      batch: async <T>(statements: D1PreparedStatement[]) => {
        if (!injected) {
          injected = true;
          sqlite.prepare(`INSERT INTO pharmacy_data_subject_requests
            (id, tenant_id, line_account_id, owner_friend_id, patient_id, request_type,
             status, reason, submitted_at, created_by, created_at, updated_at)
            VALUES ('dsr-during-fence', 'tenant-a', 'account-a', 'friend-a', ?,
             'erasure', 'received', 'request', ?, 'staff-a', ?, ?)`).run(
            patientId, NOW.toISOString(), NOW.toISOString(), NOW.toISOString(),
          );
          sqlite.prepare(`UPDATE pharmacy_retention_hold_epochs
            SET epoch = epoch + 1, status = 'unknown', release_at = NULL,
                reason_code = 'dsr_unassessed', updated_at = ?
            WHERE tenant_id = 'tenant-a' AND line_account_id = 'account-a'
              AND owner_friend_id = 'friend-a' AND patient_key IN (?, '*')`).run(
            NOW.toISOString(), patientId,
          );
        }
        return db.batch<T>(statements);
      },
    } as D1Database;

    await expect(prepareRetentionFence(racingDb, {
      tenantId: 'tenant-a', lineAccountId: 'account-a', ownerFriendId: 'friend-a', patientId,
    }, NOW, EXECUTION)).resolves.toMatchObject({ status: 'unknown' });
    expect(sqlite.prepare(`SELECT DISTINCT status FROM pharmacy_retention_hold_epochs
      WHERE owner_friend_id = 'friend-a' AND patient_key IN (?, '*')`).all(patientId))
      .toEqual([{ status: 'unknown' }]);
  });

  test('does not commit a stale prescription key or revision', async () => {
    const fileId = 'file-stale-generation';
    insertReleasedFile(fileId, PURGED_AT);
    const r2Key = `custom/pharmacy/prescriptions/tenants/tenant-a/submission-${fileId}/1/${fileId}`;
    const fence = await prepareRetentionFence(db, {
      tenantId: 'tenant-a', lineAccountId: 'account-a', ownerFriendId: 'friend-a',
      patientId: `patient-${fileId}`,
    }, NOW, EXECUTION);
    const intent = await createDeletionIntent(db, {
      execution: EXECUTION, tenantId: 'tenant-a', lineAccountId: 'account-a',
      ownerFriendId: 'friend-a', patientKey: `patient-${fileId}`,
      resourceType: 'prescription_file', resourceId: fileId, r2Key,
      storedSha256: 'a'.repeat(64), ageReferenceAt: PURGED_AT, rowState: 'ready',
      rowRevision: 1, holdEpoch: fence.epoch, now: NOW.toISOString(),
    });
    sqlite.prepare(`UPDATE pharmacy_prescription_files
      SET r2_key = ?, revision = revision + 1 WHERE id = ?`).run(`${r2Key}-new`, fileId);
    await expect(commitPrescriptionDeletionIntent(db, {
      intent: intent!, expectedFence: fence, previousHoldEpoch: intent!.hold_epoch,
      execution: EXECUTION, now: NOW.toISOString(),
    })).resolves.toBe(false);
    expect(sqlite.prepare(`SELECT status FROM pharmacy_retention_deletion_intents
      WHERE resource_id = ?`).get(fileId)).toEqual({ status: 'CLAIMED' });
  });

  test('derives a released fence from the complete server-side source inventory', async () => {
    sqlite.prepare(`DELETE FROM pharmacy_retention_hold_epochs`).run();
    insertFile('file-derived-fence', PURGED_AT);
    attachPatient('file-derived-fence', 'patient-derived-fence', '2019-01-01T00:00:00.000Z');
    const images = mockImages();

    const result = await purgePrescriptionFilesPastRetention(
      db, images, purgeOptions({ now: NOW }),
    );

    expect(result).toEqual({ purged: 1, failed: 0, skipped: 0 });
    expect(sqlite.prepare(`SELECT status FROM pharmacy_retention_hold_epochs
      WHERE patient_key = 'patient-derived-fence'`).get()).toEqual({ status: 'released' });
    expect(sqlite.prepare(`SELECT status FROM pharmacy_retention_hold_epochs
      WHERE patient_key = '*'`).get()).toEqual({ status: 'released' });
  });

  test('bounds each run so one tick cannot stall on a large backlog', async () => {
    for (let i = 0; i < 5; i++) insertReleasedFile(`file-${i}`, PURGED_AT);
    const images = mockImages();

    const result = await purgePrescriptionFilesPastRetention(db, images, purgeOptions({ now: NOW, limit: 2 }));

    expect(result.purged).toBe(2);
    expect(purgeLog()).toHaveLength(2);
  });

  test('a tenant execution neither selects nor fences another tenant candidate', async () => {
    insertReleasedFile('owned-file', PURGED_AT);
    const at = '2018-01-01T00:00:00.000Z';
    sqlite.prepare(`INSERT INTO line_accounts
      (id, channel_id, name, channel_access_token, channel_secret, created_at, updated_at)
      VALUES ('account-b', 'channel-b', 'b', 'token-b', 'secret-b', ?, ?)`).run(at, at);
    sqlite.prepare(`INSERT INTO tenants
      (id, tenant_code, display_name, status, created_at, updated_at)
      VALUES ('tenant-b', 'pharmacy-b', 'Tenant B', 'active', ?, ?)`).run(at, at);
    sqlite.prepare(`INSERT INTO tenant_line_accounts
      (tenant_id, line_account_id, created_at, updated_at)
      VALUES ('tenant-b', 'account-b', ?, ?)`).run(at, at);
    sqlite.prepare(`INSERT INTO friends
      (id, line_user_id, line_account_id, is_following, created_at, updated_at)
      VALUES ('friend-b', 'U-b', 'account-b', 1, ?, ?)`).run(at, at);
    sqlite.prepare(`INSERT INTO pharmacy_prescription_submissions
      (id, line_account_id, friend_id, idempotency_key, status, active_revision,
       upload_revision, created_at, updated_at)
      VALUES ('submission-foreign', 'account-b', 'friend-b', 'key-foreign', 'closed',
       1, 1, ?, ?)`).run(at, at);
    sqlite.prepare(`INSERT INTO pharmacy_prescription_files
      (id, submission_id, revision, position, r2_key, content_type, byte_size, sha256,
       state, created_at, updated_at)
      VALUES ('foreign-file', 'submission-foreign', 1, 1,
       'custom/pharmacy/prescriptions/tenants/tenant-b/submission-foreign/1/foreign-file',
       'image/jpeg', 1024, ?, 'ready', ?, ?)`).run('b'.repeat(64), at, at);
    const images = mockImages();

    await expect(purgePrescriptionFilesPastRetention(
      db, images, purgeOptions({ now: NOW, limit: 1 }),
    )).resolves.toEqual({ purged: 1, failed: 0, skipped: 0 });
    expect(sqlite.prepare(`SELECT state FROM pharmacy_prescription_files
      WHERE id = 'foreign-file'`).get()).toEqual({ state: 'ready' });
    expect(sqlite.prepare(`SELECT COUNT(*) AS count FROM pharmacy_retention_hold_epochs
      WHERE tenant_id = 'tenant-b'`).get()).toEqual({ count: 0 });
  });

  test('rechecks the shared recovery fence before a subsequent object', async () => {
    insertReleasedFile('file-approval-expiry-a', PURGED_AT);
    insertReleasedFile('file-approval-expiry-b', PURGED_AT);
    let deletes = 0;
    const images = mockImages(vi.fn().mockImplementation(async () => {
      deletes++;
      if (deletes === 1) {
        sqlite.prepare(`UPDATE pharmacy_recovery_operations SET status = 'completed'
          WHERE id = ?`).run(EXECUTION.operationId);
      }
    }));

    const result = await purgePrescriptionFilesPastRetention(
      db, images, purgeOptions({ now: NOW }),
    );

    expect(result.failed).toBeGreaterThanOrEqual(1);
    expect(images.put).toHaveBeenCalledTimes(1);
    expect(sqlite.prepare(`SELECT state FROM pharmacy_prescription_files
      WHERE id = 'file-approval-expiry-b'`).get()).toEqual({ state: 'ready' });
  });
});
