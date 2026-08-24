import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import {
  backfillIncomingImageTracking,
  incomingImageRetentionReadiness,
  purgeTrackedIncomingImages,
  reconcileIncomingImageInventory,
} from './incoming-images.js';

const DB_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../../../../packages/db');
const require = createRequire(import.meta.url);
type SqliteStatement = {
  get(...values: unknown[]): unknown;
  all(...values: unknown[]): unknown[];
  run(...values: unknown[]): { changes: number };
  runSync(): D1Result;
};
type Sqlite3Database = {
  pragma(sql: string): unknown;
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  transaction<T>(fn: () => T): () => T;
};
const Sqlite = require(join(DB_ROOT, 'node_modules/better-sqlite3')) as
  new (filename: string) => Sqlite3Database;

function d1From(sqlite: Sqlite3Database): D1Database {
  const statement = (sql: string, values: unknown[] = []) => ({
    bind: (...next: unknown[]) => statement(sql, next),
    first: async <T>() => (sqlite.prepare(sql).get(...values) as T | undefined) ?? null,
    all: async <T>() => ({
      success: true, results: sqlite.prepare(sql).all(...values) as T[], meta: {},
    }) as D1Result<T>,
    runSync: () => {
      const info = sqlite.prepare(sql).run(...values);
      return { success: true, meta: { changes: info.changes }, results: [] };
    },
    run: async () => statement(sql, values).runSync(),
  });
  return {
    prepare: (sql: string) => statement(sql),
    batch: async <T>(statements: D1PreparedStatement[]) => sqlite.transaction(() =>
      statements.map((item) => (item as unknown as SqliteStatement).runSync() as D1Result<T>),
    )(),
  } as unknown as D1Database;
}

const NOW = new Date('2026-08-20T00:00:00.000Z');
const EXECUTION = {
  operationId: 'operation-incoming-test',
  executionId: 'execution-incoming-test',
  fenceToken: 'i'.repeat(32),
  executorSubject: 'test-worker',
  tenantId: 'tenant-a',
  lineAccountId: 'account-a',
  environment: 'test',
};
const KEY = 'tenants/tenant-a/accounts/account-a/incoming/line-message-1.jpg';

describe('incoming image retention ledger', () => {
  let sqlite: Sqlite3Database;
  let db: D1Database;

  beforeEach(() => {
    sqlite = new Sqlite(':memory:');
    sqlite.pragma('foreign_keys = ON');
    sqlite.exec(readFileSync(join(DB_ROOT, 'bootstrap.sql'), 'utf8'));
    const at = '2026-08-19T00:00:00.000Z';
    sqlite.prepare(`INSERT INTO line_accounts
      (id, channel_id, name, channel_access_token, channel_secret, created_at, updated_at)
      VALUES ('account-a', 'channel-a', 'a', 'token-a', 'secret-a', ?, ?)`).run(at, at);
    sqlite.prepare(`INSERT INTO tenants
      (id, tenant_code, display_name, status, created_at, updated_at)
      VALUES ('tenant-a', 'pharmacy-a', 'Tenant A', 'active', ?, ?)`).run(at, at);
    sqlite.prepare(`INSERT INTO tenant_line_accounts
      (tenant_id, line_account_id, created_at, updated_at)
      VALUES ('tenant-a', 'account-a', ?, ?)`).run(at, at);
    sqlite.prepare(`INSERT INTO friends
      (id, line_user_id, line_account_id, is_following, created_at, updated_at)
      VALUES ('friend-a', 'U-a', 'account-a', 1, ?, ?)`)
      .run('2019-01-01T00:00:00.000Z', '2019-01-01T00:00:00.000Z');
    sqlite.prepare(`INSERT INTO pharmacy_patients
      (id, line_account_id, owner_friend_id, relationship, name, name_kana, birth_date,
       created_at, updated_at)
      VALUES ('patient-a', 'account-a', 'friend-a', 'self', 'Patient', 'ﾊﾟｼｴﾝﾄ',
              '1990-01-01', '2019-01-01T00:00:00.000Z', '2019-01-01T00:00:00.000Z')`).run();
    sqlite.prepare(`INSERT INTO pharmacy_patient_intake_responses
      (id, line_account_id, owner_friend_id, patient_id, revision, schema_version,
       patient_snapshot_json, answers_json, idempotency_key,
       representative_consent_at, privacy_consent_at, created_at)
      VALUES ('intake-patient-a', 'account-a', 'friend-a', 'patient-a', 1, 1,
              '{}', '{}', 'incoming-patient-a', '2019-01-01T00:00:00.000Z',
              '2019-01-01T00:00:00.000Z', '2019-01-01T00:00:00.000Z')`).run();
    sqlite.prepare(`INSERT INTO pharmacy_retention_hold_epochs
      (tenant_id, line_account_id, owner_friend_id, patient_key, epoch, status,
       release_at, reason_code, updated_at)
      VALUES ('tenant-a', 'account-a', 'friend-a', '*', 1, 'released', ?, 'test', ?)`).run(at, at);
    sqlite.prepare(`INSERT INTO pharmacy_recovery_operations
      (id, tenant_id, line_account_id, environment, operation, status,
       requested_by_issuer, requested_by_subject, approver_issuer, approver_subject,
       executor_issuer, executor_subject, approval_expires_at, job_id, idempotency_key,
       execution_id, fence_id, fence_token, created_at, claimed_at, updated_at)
      VALUES (?, 'tenant-a', 'account-a', 'test', 'retention_delete', 'running',
       'platform-admin', 'requester', 'platform-admin', 'approver',
       'platform-admin', ?, ?, 'job-incoming', 'idem-incoming', ?, ?, ?, ?, ?, ?)`).run(
      EXECUTION.operationId, EXECUTION.executorSubject, '2099-01-01T00:00:00.000Z',
      EXECUTION.executionId, 'fence-incoming-id', EXECUTION.fenceToken, at, at, at,
    );
    sqlite.prepare(`INSERT INTO pharmacy_recovery_execution_fences
      (fence_id, operation_id, tenant_id, line_account_id, environment, execution_id,
       fence_token, owner_issuer, owner_subject, status, expires_at, created_at)
      VALUES ('fence-incoming-id', ?, 'tenant-a', 'account-a', 'test', ?, ?,
              'platform-admin', ?, 'active', '2099-01-01T00:00:00.000Z', ?)`).run(
      EXECUTION.operationId, EXECUTION.executionId, EXECUTION.fenceToken,
      EXECUTION.executorSubject, at,
    );
    db = d1From(sqlite);
  });

  function seedMessage(
    key = KEY,
    createdAt = '2023-01-01T00:00:00.000Z',
    id = `log-${key.split('/').at(-1)}`,
  ): void {
    sqlite.prepare(`INSERT INTO messages_log
      (id, friend_id, direction, message_type, content, line_account_id, created_at)
      VALUES (?, 'friend-a', 'incoming', 'image', ?, 'account-a', ?)`).run(
      id, JSON.stringify({ r2Key: key }), createdAt,
    );
  }

  test('backfills bounded JSON paths idempotently and does not expose IDs in evidence', async () => {
    seedMessage();
    seedMessage('tenants/other/accounts/account-a/incoming/foreign.jpg');
    const first = await backfillIncomingImageTracking(db, { execution: EXECUTION, now: NOW, limit: 2 });
    const second = await backfillIncomingImageTracking(db, { execution: EXECUTION, now: NOW, limit: 2 });

    expect(first).toEqual({ tracked: 1, skipped: 0, blocked: 1 });
    expect(second.tracked).toBe(0);
    expect(sqlite.prepare(
      `SELECT r2_key, tenant_id, line_account_id, status, reason_code
         FROM pharmacy_incoming_image_dispositions`,
    ).all()).toEqual([{
      r2_key: KEY, tenant_id: 'tenant-a', line_account_id: 'account-a',
      status: 'TRACKED', reason_code: 'backfill_tracked',
    }]);
  });

  test('keeps a webhook tracker whose LINE message id differs from the log UUID', async () => {
    seedMessage();
    sqlite.prepare(`INSERT INTO pharmacy_incoming_image_objects
      (r2_key, tenant_id, line_account_id, message_id, stored_at)
      VALUES (?, 'tenant-a', 'account-a', 'line-message-id', ?)`).run(
      KEY, '2019-01-01T00:00:00.000Z',
    );

    await expect(backfillIncomingImageTracking(db, { execution: EXECUTION, now: NOW }))
      .resolves.toEqual({ tracked: 0, skipped: 1, blocked: 0 });
    expect(sqlite.prepare(`SELECT status FROM pharmacy_incoming_image_dispositions
      WHERE r2_key = ?`).get(KEY)).toEqual({ status: 'TRACKED' });
    const images = {
      head: vi.fn().mockResolvedValue({ key: KEY }),
      get: vi.fn().mockResolvedValue({
        arrayBuffer: async () => new TextEncoder().encode('stored-image').buffer,
      }),
      delete: vi.fn().mockResolvedValue(undefined),
    } as unknown as R2Bucket;
    await expect(purgeTrackedIncomingImages(db, images, { execution: EXECUTION, now: NOW }))
      .resolves.toEqual({ purged: 1, failed: 0, skipped: 0 });
  });

  test('purges a tracked image once and ignores its terminal disposition later', async () => {
    seedMessage();
    await backfillIncomingImageTracking(db, { execution: EXECUTION, now: NOW });
    const images = {
      head: vi.fn().mockResolvedValue({ key: KEY }),
      get: vi.fn().mockResolvedValue({
        arrayBuffer: async () => new TextEncoder().encode('stored-image').buffer,
      }),
      delete: vi.fn().mockResolvedValue(undefined),
    } as unknown as R2Bucket;

    await expect(purgeTrackedIncomingImages(db, images, { execution: EXECUTION, now: NOW }))
      .resolves.toEqual({ purged: 1, failed: 0, skipped: 0 });
    expect(images.delete).toHaveBeenCalledWith(KEY);
    expect(sqlite.prepare(
      `SELECT status FROM pharmacy_incoming_image_dispositions WHERE r2_key = ?`,
    ).get(KEY)).toEqual({ status: 'FINALIZED_DELETED' });

    const second = await purgeTrackedIncomingImages(db, images, { execution: EXECUTION, now: NOW });
    expect(second).toEqual({ purged: 0, failed: 0, skipped: 0 });
    expect(images.delete).toHaveBeenCalledTimes(1);
  });

  test('does not delete when the R2 object changes after selection', async () => {
    seedMessage();
    await backfillIncomingImageTracking(db, { execution: EXECUTION, now: NOW });
    const images = {
      head: vi.fn().mockResolvedValue({ key: KEY }),
      get: vi.fn()
        .mockResolvedValueOnce({ arrayBuffer: async () => new TextEncoder().encode('first').buffer })
        .mockResolvedValueOnce({ arrayBuffer: async () => new TextEncoder().encode('replacement').buffer }),
      delete: vi.fn(),
    } as unknown as R2Bucket;

    await expect(purgeTrackedIncomingImages(db, images, { execution: EXECUTION, now: NOW }))
      .resolves.toEqual({ purged: 0, failed: 1, skipped: 0 });
    expect(images.delete).not.toHaveBeenCalled();
    expect(sqlite.prepare(`SELECT status FROM pharmacy_incoming_image_dispositions
      WHERE r2_key = ?`).get(KEY)).toEqual({ status: 'OUTCOME_UNKNOWN' });
  });

  test('rechecks legal hold after R2 selection and before delete commit', async () => {
    seedMessage();
    await backfillIncomingImageTracking(db, { execution: EXECUTION, now: NOW });
    sqlite.prepare(`INSERT INTO staff_members (id, name, role, api_key)
      VALUES ('staff-a', 'Staff', 'staff', 'api-key-a')`).run();
    sqlite.prepare(`INSERT INTO tenant_staff_memberships
      (tenant_id, staff_id, role, created_at, updated_at)
      VALUES ('tenant-a', 'staff-a', 'staff', ?, ?)`).run(NOW.toISOString(), NOW.toISOString());
    sqlite.prepare(`INSERT INTO pharmacy_staff_accounts
      (line_account_id, staff_id, created_at, updated_at)
      VALUES ('account-a', 'staff-a', ?, ?)`).run(NOW.toISOString(), NOW.toISOString());
    const images = {
      head: vi.fn().mockResolvedValue({ key: KEY }),
      get: vi.fn().mockImplementation(async () => {
        sqlite.prepare(`INSERT INTO pharmacy_data_subject_requests
          (id, tenant_id, line_account_id, owner_friend_id, patient_id, request_type,
           status, reason, legal_hold, legal_hold_basis, legal_hold_release_at,
           version, submitted_at, identity_verified_at, legal_hold_assessed_at,
           created_by, created_at, updated_at)
          VALUES ('dsr-race', 'tenant-a', 'account-a', 'friend-a', 'patient-a',
           'erasure', 'legal_hold_assessed', 'request', 1,
           'pharmacist_law_enforcement_regulation_3y', '2029-01-01T00:00:00.000Z',
           1, '2019-01-01T00:00:00.000Z', ?, ?, 'staff-a',
           '2019-01-01T00:00:00.000Z', '2019-01-01T00:00:00.000Z')`).run(
          NOW.toISOString(), NOW.toISOString(),
        );
        return { arrayBuffer: async () => new TextEncoder().encode('stored-image').buffer };
      }),
      delete: vi.fn(),
    } as unknown as R2Bucket;

    await expect(purgeTrackedIncomingImages(db, images, { execution: EXECUTION, now: NOW }))
      .resolves.toEqual({ purged: 0, failed: 0, skipped: 1 });
    expect(images.delete).not.toHaveBeenCalled();
    expect(sqlite.prepare(`SELECT status FROM pharmacy_incoming_image_dispositions
      WHERE r2_key = ?`).get(KEY)).toEqual({ status: 'CANCELLED_HELD' });
  });

  test('reconsiders a cancelled image after the unknown hold is resolved', async () => {
    seedMessage();
    await backfillIncomingImageTracking(db, { execution: EXECUTION, now: NOW });
    sqlite.prepare(`INSERT INTO staff_members (id, name, role, api_key)
      VALUES ('staff-a', 'Staff', 'staff', 'api-key-a')`).run();
    sqlite.prepare(`INSERT INTO tenant_staff_memberships
      (tenant_id, staff_id, role, created_at, updated_at)
      VALUES ('tenant-a', 'staff-a', 'staff', ?, ?)`).run(NOW.toISOString(), NOW.toISOString());
    sqlite.prepare(`INSERT INTO pharmacy_staff_accounts
      (line_account_id, staff_id, created_at, updated_at)
      VALUES ('account-a', 'staff-a', ?, ?)`).run(NOW.toISOString(), NOW.toISOString());
    sqlite.prepare(`INSERT INTO pharmacy_data_subject_requests
      (id, tenant_id, line_account_id, owner_friend_id, patient_id, request_type, status,
       reason, version, submitted_at, created_by, created_at, updated_at)
      VALUES ('dsr-a', 'tenant-a', 'account-a', 'friend-a', 'patient-a', 'erasure',
       'received', 'request', 1, ?, 'staff-a', ?, ?)`).run(
      NOW.toISOString(), NOW.toISOString(), NOW.toISOString(),
    );
    const images = {
      head: vi.fn().mockResolvedValue({ key: KEY }),
      get: vi.fn().mockResolvedValue({
        arrayBuffer: async () => new TextEncoder().encode('stored-image').buffer,
      }),
      delete: vi.fn().mockResolvedValue(undefined),
    } as unknown as R2Bucket;

    await expect(purgeTrackedIncomingImages(db, images, { execution: EXECUTION, now: NOW }))
      .resolves.toEqual({ purged: 0, failed: 0, skipped: 1 });
    sqlite.prepare(`UPDATE pharmacy_data_subject_requests
      SET status = 'rejected', legal_hold = 0, outcome_note = 'closed',
          resolved_at = ?, resolved_by = 'staff-a'
      WHERE id = 'dsr-a'`).run(NOW.toISOString());
    await expect(purgeTrackedIncomingImages(db, images, { execution: EXECUTION, now: NOW }))
      .resolves.toEqual({ purged: 1, failed: 0, skipped: 0 });
    expect(images.delete).toHaveBeenCalledOnce();
  });

  test('keeps a valid image tracked until it reaches the retention boundary', async () => {
    seedMessage(KEY, '2025-01-01T00:00:00.000Z');
    await backfillIncomingImageTracking(db, { execution: EXECUTION, now: NOW });
    const images = { head: vi.fn(), delete: vi.fn() } as unknown as R2Bucket;

    await expect(purgeTrackedIncomingImages(db, images, { execution: EXECUTION, now: NOW }))
      .resolves.toEqual({ purged: 0, failed: 0, skipped: 1 });
    expect(images.head).not.toHaveBeenCalled();
    expect(sqlite.prepare(`SELECT status FROM pharmacy_incoming_image_dispositions
      WHERE r2_key = ?`).get(KEY)).toEqual({ status: 'TRACKED' });
  });

  test('does not let a terminal disposition consume the bounded purge slot', async () => {
    const finalizedKey =
      'tenants/tenant-a/accounts/account-a/incoming/already-finalized.jpg';
    sqlite.prepare(`INSERT INTO pharmacy_incoming_image_objects
      (r2_key, tenant_id, line_account_id, message_id, stored_at)
      VALUES (?, 'tenant-a', 'account-a', 'already-finalized',
       '2018-01-01T00:00:00.000Z')`).run(finalizedKey);
    sqlite.prepare(`INSERT INTO pharmacy_incoming_image_dispositions
      (r2_key, tenant_id, line_account_id, message_id, stored_at, status, source,
       reason_code, hold_epoch, created_at, updated_at)
      VALUES (?, 'tenant-a', 'account-a', 'already-finalized',
       '2018-01-01T00:00:00.000Z', 'FINALIZED_DELETED', 'reconcile',
       'already_finalized', 1, ?, ?)`).run(finalizedKey, NOW.toISOString(), NOW.toISOString());
    seedMessage();
    await backfillIncomingImageTracking(db, { execution: EXECUTION, now: NOW });
    const images = {
      head: vi.fn().mockResolvedValue({ key: KEY }),
      get: vi.fn().mockResolvedValue({
        arrayBuffer: async () => new TextEncoder().encode('stored-image').buffer,
      }),
      delete: vi.fn().mockResolvedValue(undefined),
    } as unknown as R2Bucket;

    await expect(purgeTrackedIncomingImages(
      db, images, { execution: EXECUTION, now: NOW, limit: 1 },
    )).resolves.toEqual({ purged: 1, failed: 0, skipped: 0 });
    expect(images.delete).toHaveBeenCalledWith(KEY);
  });

  test('marks missing objects without attempting deletion', async () => {
    seedMessage();
    await backfillIncomingImageTracking(db, { execution: EXECUTION, now: NOW });
    const images = {
      head: vi.fn().mockResolvedValue(null),
      delete: vi.fn(),
    } as unknown as R2Bucket;

    await expect(purgeTrackedIncomingImages(db, images, { execution: EXECUTION, now: NOW }))
      .resolves.toEqual({ purged: 0, failed: 0, skipped: 1 });
    expect(images.delete).not.toHaveBeenCalled();
    expect(sqlite.prepare(`SELECT status FROM pharmacy_incoming_image_dispositions
      WHERE r2_key = ?`).get(KEY)).toEqual({ status: 'MISSING' });
  });

  test('blocks an ambiguous message ownership mapping', async () => {
    seedMessage();
    seedMessage(KEY, '2023-01-01T00:00:00.000Z', 'log-duplicate');
    await backfillIncomingImageTracking(db, { execution: EXECUTION, now: NOW });
    const images = {
      head: vi.fn().mockResolvedValue({ key: KEY }),
      delete: vi.fn(),
    } as unknown as R2Bucket;

    await expect(purgeTrackedIncomingImages(db, images, { execution: EXECUTION, now: NOW }))
      .resolves.toEqual({ purged: 0, failed: 0, skipped: 1 });
    expect(images.delete).not.toHaveBeenCalled();
    expect(sqlite.prepare(`SELECT status FROM pharmacy_incoming_image_dispositions
      WHERE r2_key = ?`).get(KEY)).toEqual({ status: 'OWNERSHIP_MISMATCH' });
  });

  test('inventory reconciliation marks orphan, missing, and unknown without deletion', async () => {
    seedMessage();
    await backfillIncomingImageTracking(db, { execution: EXECUTION, now: NOW });
    sqlite.prepare(`UPDATE pharmacy_incoming_image_objects SET stored_at = 'unknown'`).run();
    const orphan = 'tenants/tenant-a/accounts/account-a/incoming/orphan.jpg';
    const images = {
      list: vi.fn().mockResolvedValue({ objects: [{ key: orphan }], truncated: false }),
      head: vi.fn().mockResolvedValue(null),
      delete: vi.fn(),
    } as unknown as R2Bucket;

    const result = await reconcileIncomingImageInventory(db, images, {
      execution: EXECUTION, now: NOW,
    });
    expect(result).toMatchObject({ orphan: 1, unknown: 1 });
    expect(images.delete).not.toHaveBeenCalled();
    expect(sqlite.prepare(
      `SELECT status FROM pharmacy_incoming_image_dispositions WHERE r2_key = ?`,
    ).get(orphan)).toEqual({ status: 'ORPHAN' });
  });

  test('readiness is explicitly blocked while cross-domain dependencies are unresolved', async () => {
    await expect(incomingImageRetentionReadiness(db, { execution: EXECUTION })).resolves.toEqual({
      status: 'BLOCKED',
      blockedReasons: [
        'ec_sale_counter_audit_dependency_unresolved',
        'dsr_tombstone_dependency_unresolved',
      ],
      tracked: 0,
      dispositions: 0,
    });
  });
});
