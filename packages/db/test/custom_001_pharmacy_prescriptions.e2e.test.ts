import { beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  applyAdminPrescriptionAction,
  getAdminPrescriptionDetail,
  listPrescriptionHistory,
  markPrescriptionFileReady,
  reservePrescriptionDraft,
  reservePrescriptionFile,
  reservePrescriptionResubmission,
  submitPrescription,
} from '../../../apps/worker/src/custom/pharmacy/prescriptions/repository.js';
import { encryptLineCredential } from '../../../apps/worker/src/custom/pharmacy/provisioning/line-credentials.js';
import { cleanupPrescriptionImages } from '../../../apps/worker/src/custom/pharmacy/prescriptions/cleanup.js';
import {
  deliverPrescriptionNotification,
  retryFailedPrescriptionNotifications,
} from '../../../apps/worker/src/custom/pharmacy/prescriptions/notifications.js';
import { savePrescriptionValidity } from '../../../apps/worker/src/custom/pharmacy/growth-loop/repository.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LINE_CREDENTIAL_KEY = 'synthetic-line-credential-root-key-v1';
const LINE_ACCESS_TOKEN = 'synthetic-account-token-with-enough-length-1234567890';
const RECOVERY_EVENT_ID = '123e4567-e89b-42d3-a456-426614174000';

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

describe('synthetic prescription end-to-end', () => {
  let sqlite: Database.Database;
  let db: D1Database;
  const patient = { lineAccountId: 'account-synthetic', friendId: 'friend-synthetic' };

  beforeEach(async () => {
    sqlite = new Database(':memory:');
    sqlite.pragma('foreign_keys = ON');
    sqlite.exec(readFileSync(join(ROOT, 'bootstrap.sql'), 'utf8'));
    sqlite.prepare(
      `INSERT INTO line_accounts
         (id, channel_id, name, channel_access_token, channel_secret,
          login_channel_id, liff_id, created_at, updated_at)
       VALUES (?, 'channel-synthetic', 'Synthetic Pharmacy', 'encrypted:v1',
               'secret', 'login-synthetic', 'liff-synthetic', ?, ?)`,
    ).run(patient.lineAccountId, '2026-08-17T00:00:00.000Z', '2026-08-17T00:00:00.000Z');
    sqlite.prepare(
      `INSERT INTO tenants (id, tenant_code, display_name, status, created_at, updated_at)
       VALUES ('tenant-synthetic', 'synthetic', 'Synthetic Pharmacy', 'active', ?, ?)`,
    ).run('2026-08-17T00:00:00.000Z', '2026-08-17T00:00:00.000Z');
    sqlite.prepare(
      `INSERT INTO tenant_line_accounts
         (tenant_id, line_account_id, created_at, updated_at)
       VALUES ('tenant-synthetic', ?, ?, ?)`,
    ).run(patient.lineAccountId, '2026-08-17T00:00:00.000Z', '2026-08-17T00:00:00.000Z');
    sqlite.prepare(
      `UPDATE pharmacy_account_capabilities
          SET capabilities_json = ?, updated_at = ?
        WHERE line_account_id = ?`,
    ).run(
      '["prescription_intake"]',
      '2026-08-17T00:00:00.000Z',
      patient.lineAccountId,
    );
    const encrypted = await encryptLineCredential({
      rootSecret: LINE_CREDENTIAL_KEY,
      tenantId: 'tenant-synthetic',
      lineAccountId: patient.lineAccountId,
      kind: 'channel_access_token',
      credential: LINE_ACCESS_TOKEN,
    });
    sqlite.prepare(
      `INSERT INTO pharmacy_line_credentials
        (tenant_id, line_account_id, credential_kind, nonce, ciphertext,
         key_version, revision, lookup_digest, created_at, updated_at)
       VALUES (?, ?, 'channel_access_token', ?, ?, ?, 1, ?, ?, ?)`,
    ).run(
      'tenant-synthetic', patient.lineAccountId, encrypted.nonce,
      encrypted.ciphertext, encrypted.keyVersion, encrypted.lookupDigest,
      '2026-08-17T00:00:00.000Z', '2026-08-17T00:00:00.000Z',
    );
    sqlite.prepare(
      `INSERT INTO friends
         (id, line_user_id, line_account_id, display_name, created_at, updated_at)
       VALUES (?, 'U00000000000000000000000000000000', ?, 'Synthetic Patient', ?, ?)`,
    ).run(
      patient.friendId,
      patient.lineAccountId,
      '2026-08-17T00:00:00.000Z',
      '2026-08-17T00:00:00.000Z',
    );
    db = d1From(sqlite);
  });

  it('runs submit, replacement, admin completion, automatic LINE notification, and retention cleanup', async () => {
    const objects = new Map<string, Uint8Array>();
    const notifications: Request[] = [];
    const proxyDispatch = vi.fn(async (request: Request) => {
      notifications.push(request);
      return new Response('{}', { status: 200 });
    });
    const notify = (submissionId: string) => deliverPrescriptionNotification(
      db,
      patient.lineAccountId,
      submissionId,
      {
        proxyBaseUrl: 'https://worker.synthetic',
        proxyDispatch,
        lineCredentialKey: LINE_CREDENTIAL_KEY,
      },
    );
    const upload = async (submissionId: string, position: number, marker: string) => {
      const file = await reservePrescriptionFile(db, patient, submissionId, position, {
        contentType: 'image/png',
        byteSize: 8,
        sha256: marker.repeat(64),
      });
      objects.set(file.r2_key, new Uint8Array([position]));
      if (file.state !== 'ready') {
        await markPrescriptionFileReady(db, patient, submissionId, file.id, file.sha256);
      }
      return file;
    };

    const submission = await reservePrescriptionDraft(db, patient, {
      idempotencyKey: 'synthetic-mobile-request',
      desiredPickupAt: '2026-08-18T03:00:00.000Z',
      originalPrescriptionConsent: true,
      readinessNoticeConsent: true,
    });
    const firstFile = await upload(submission.id as string, 1, 'a');
    expect(firstFile.r2_key).toMatch(
      /^custom\/pharmacy\/prescriptions\/tenants\/tenant-synthetic\//,
    );
    expect(sqlite.prepare(
      `SELECT s.status, s.updated_at,
              s.original_prescription_consent_at IS NOT NULL AS original_consent,
              s.readiness_notice_consent_at IS NOT NULL AS notice_consent,
              COUNT(f.id) AS file_count,
              SUM(f.state = 'ready') AS ready_count
         FROM pharmacy_prescription_submissions s
         LEFT JOIN pharmacy_prescription_files f ON f.submission_id = s.id
        WHERE s.id = ?
        GROUP BY s.id`,
    ).get(submission.id)).toMatchObject({
      status: 'draft',
      updated_at: submission.updated_at,
      original_consent: 1,
      notice_consent: 1,
      file_count: 1,
      ready_count: 1,
    });
    await submitPrescription(db, patient, submission.id as string, {
      expectedUpdatedAt: submission.updated_at as string,
      desiredPickupAt: null,
      originalPrescriptionConsent: true,
      readinessNoticeConsent: true,
    });
    await expect(notify(submission.id as string)).resolves.toEqual({ status: 'sent' });

    let detail = await getAdminPrescriptionDetail(db, patient.lineAccountId, submission.id as string);
    expect(detail?.submission.active_revision).toBe(1);
    await applyAdminPrescriptionAction(
      db,
      patient.lineAccountId,
      submission.id as string,
      'admin_request_resubmission',
      detail!.submission.updated_at as string,
      'staff-synthetic',
      'blurred',
    );
    await notify(submission.id as string);

    detail = await getAdminPrescriptionDetail(db, patient.lineAccountId, submission.id as string);
    await reservePrescriptionResubmission(
      db,
      patient,
      submission.id as string,
      detail!.submission.updated_at as string,
    );
    await upload(submission.id as string, 1, 'b');
    detail = await getAdminPrescriptionDetail(db, patient.lineAccountId, submission.id as string);
    expect(detail?.submission.active_revision).toBe(1);
    expect(detail?.submission.upload_revision).toBe(2);

    await upload(submission.id as string, 2, 'c');
    await submitPrescription(db, patient, submission.id as string, {
      expectedUpdatedAt: detail!.submission.updated_at as string,
      desiredPickupAt: null,
      originalPrescriptionConsent: true,
      readinessNoticeConsent: true,
    });
    await notify(submission.id as string);
    detail = await getAdminPrescriptionDetail(db, patient.lineAccountId, submission.id as string);
    expect(detail?.submission.active_revision).toBe(2);

    await savePrescriptionValidity(db, {
      lineAccountId: patient.lineAccountId,
      submissionId: submission.id as string,
      issuedOn: '2026-08-17',
      validUntil: '2099-01-01',
      validityBasis: 'prescriber_specified',
      verificationStatus: 'verified',
      staffId: 'staff-synthetic',
    });

    for (const action of ['admin_accept', 'admin_ready', 'admin_close'] as const) {
      await applyAdminPrescriptionAction(
        db,
        patient.lineAccountId,
        submission.id as string,
        action,
        detail!.submission.updated_at as string,
        'staff-synthetic',
        null,
      );
      await notify(submission.id as string);
      detail = await getAdminPrescriptionDetail(db, patient.lineAccountId, submission.id as string);
    }
    expect(detail?.submission.status).toBe('closed');

    const history = await listPrescriptionHistory(db, patient);
    expect(history).toHaveLength(1);
    expect(JSON.stringify(history)).not.toContain('r2_key');
    expect(JSON.stringify(history)).not.toContain('thumbnail');
    expect(notifications).toHaveLength(6);
    for (const request of notifications) {
      expect(request.headers.get('Authorization')).toBe(`Bearer ${LINE_ACCESS_TOKEN}`);
      expect(request.headers.get('X-Line-Harness-Source')).toBeNull();
    }

    sqlite.prepare(
      `UPDATE pharmacy_prescription_submissions
          SET closed_at = '2026-06-01T00:00:00.000Z'
        WHERE id = ?`,
    ).run(submission.id);
    const bucket = {
      delete: async (key: string) => { objects.delete(key); },
    } as unknown as R2Bucket;
    await expect(cleanupPrescriptionImages(db, bucket, {
      now: new Date('2026-08-17T12:00:00.000Z'),
      limit: 10,
    })).resolves.toEqual({ claimed: 3, deleted: 3, failed: 0, skipped: 0 });
    expect(objects.size).toBe(0);
  });

  it.each([
    { outcome: 'attempted', occurredAt: new Date(Date.now() - 16 * 60_000).toISOString(), sent: 1, skipped: 0, requests: 1 },
    { outcome: 'attempted', occurredAt: new Date(Date.now() - 25 * 60 * 60_000).toISOString(), sent: 0, skipped: 1, requests: 0 },
    { outcome: 'attempted', occurredAt: '2099-01-01T00:00:00.000Z', sent: 0, skipped: 0, requests: 0 },
    { outcome: 'failed', occurredAt: '2020-01-01T00:00:00.000Z', sent: 1, skipped: 0, requests: 1 },
    { outcome: 'sent', occurredAt: '2020-01-01T00:00:00.000Z', sent: 1, skipped: 0, requests: 0 },
  ] as const)(
    'reconciles a $outcome side-effect row after isolate eviction without a failure audit',
    async ({ outcome, occurredAt, sent, skipped, requests: expectedRequests }) => {
      sqlite.prepare(
        `INSERT INTO pharmacy_prescription_submissions
           (id, line_account_id, friend_id, idempotency_key, status,
            active_revision, upload_revision, readiness_notice_consent_at,
            requested_at, created_at, updated_at)
         VALUES ('submission-recovery', ?, ?, 'recovery', 'ready',
                 1, 1, '2026-08-17T00:00:00.000Z',
                 '2026-08-17T00:00:00.000Z', '2026-08-17T00:00:00.000Z',
                 '2026-08-17T00:00:00.000Z')`,
      ).run(patient.lineAccountId, patient.friendId);
      sqlite.prepare(
        `INSERT INTO pharmacy_prescription_events
           (id, submission_id, actor_type, actor_id, event_type,
            from_status, to_status, revision, created_at)
         VALUES (?, 'submission-recovery', 'staff', 'staff-synthetic', 'status_changed',
                 'accepted', 'ready', 1, '2026-08-17T00:00:00.000Z')`,
      ).run(RECOVERY_EVENT_ID);
      sqlite.prepare(
        `INSERT INTO pharmacy_notification_events
           (id, line_account_id, friend_id, message_id, category, outcome,
            occurred_at, idempotency_key, created_at)
         VALUES ('notification-recovery', ?, ?, 'prescription_status_v1',
                 'transactional_care', ?, ?, ?, ?)`,
      ).run(
        patient.lineAccountId, patient.friendId, outcome, occurredAt,
        RECOVERY_EVENT_ID, occurredAt,
      );

      const requests: Request[] = [];
      await expect(retryFailedPrescriptionNotifications(db, {
        proxyBaseUrl: 'https://worker.synthetic',
        proxyDispatch: async (request) => {
          requests.push(request);
          return new Response('{}', { status: 200 });
        },
        lineCredentialKey: LINE_CREDENTIAL_KEY,
      })).resolves.toEqual({ sent, failed: 0, skipped });

      expect(requests).toHaveLength(expectedRequests);
      if (requests[0]) {
        expect(requests[0].headers.get('X-Line-Retry-Key')).toBe(RECOVERY_EVENT_ID);
      }
      expect(sqlite.prepare(
        `SELECT outcome FROM pharmacy_notification_events
          WHERE line_account_id = ? AND idempotency_key = ?`,
      ).get(patient.lineAccountId, RECOVERY_EVENT_ID)).toEqual({
        outcome: sent === 1 ? 'sent' : 'attempted',
      });
      expect(sqlite.prepare(
        `SELECT COUNT(*) AS count FROM pharmacy_prescription_events
          WHERE submission_id = 'submission-recovery'
            AND event_type = 'notification_sent' AND actor_id = ?`,
      ).get(RECOVERY_EVENT_ID)).toEqual({ count: sent });
    },
  );

  it('rechecks linked patient authority before resubmission and its audit event', async () => {
    const now = '2026-08-17T00:00:00.000Z';
    const linkedPatientId = 'patient-linked';
    const submissionId = 'submission-linked';
    const intakeId = 'intake-linked';
    sqlite.prepare(`INSERT INTO pharmacy_patients
      (id, line_account_id, owner_friend_id, relationship, name, name_kana, birth_date, created_at, updated_at)
      VALUES (?, ?, ?, 'self', 'Linked Patient', 'LINKED PATIENT', '1990-01-01', ?, ?)`).run(
      linkedPatientId, patient.lineAccountId, patient.friendId, now, now,
    );
    sqlite.prepare(`INSERT INTO pharmacy_patient_intake_responses
      (id, line_account_id, owner_friend_id, patient_id, revision, schema_version,
       patient_snapshot_json, answers_json, idempotency_key, representative_consent_at,
       privacy_consent_at, created_at)
      VALUES (?, ?, ?, ?, 1, 1, '{}', '{}', ?, ?, ?, ?)`).run(
      intakeId, patient.lineAccountId, patient.friendId, linkedPatientId,
      'intake-linked-key', now, now, now,
    );
    sqlite.prepare(`INSERT INTO pharmacy_prescription_submissions
      (id, line_account_id, friend_id, idempotency_key, status, active_revision,
       upload_revision, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'needs_resubmission', 1, 1, ?, ?)`).run(
      submissionId, patient.lineAccountId, patient.friendId, 'submission-linked-key', now, now,
    );
    sqlite.prepare(`INSERT INTO pharmacy_prescription_patients
      (submission_id, line_account_id, owner_friend_id, patient_id, intake_response_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?)`).run(
      submissionId, patient.lineAccountId, patient.friendId, linkedPatientId, intakeId, now,
    );

    await reservePrescriptionResubmission(db, patient, submissionId, now);
    const first = sqlite.prepare(`SELECT upload_revision, updated_at
      FROM pharmacy_prescription_submissions WHERE id = ?`).get(submissionId) as {
      upload_revision: number; updated_at: string;
    };
    const eventsBeforeRevoke = sqlite.prepare(`SELECT COUNT(*) AS count
      FROM pharmacy_prescription_events WHERE submission_id = ?`).get(submissionId) as { count: number };
    sqlite.prepare(`INSERT INTO pharmacy_patient_owner_controls
      (line_account_id, patient_id, owner_friend_id, binding_suspended_at, binding_reason_code, version, updated_at)
      VALUES (?, ?, ?, ?, 'binding_suspended', 1, ?)`).run(
      patient.lineAccountId, linkedPatientId, patient.friendId, now, now,
    );

    await expect(reservePrescriptionResubmission(db, patient, submissionId, first.updated_at))
      .rejects.toThrow(/resubmission conflict/i);
    expect(sqlite.prepare(`SELECT upload_revision, updated_at
      FROM pharmacy_prescription_submissions WHERE id = ?`).get(submissionId)).toEqual(first);
    expect(sqlite.prepare(`SELECT COUNT(*) AS count
      FROM pharmacy_prescription_events WHERE submission_id = ?`).get(submissionId))
      .toEqual(eventsBeforeRevoke);
  });

  it('allows an active minor proxy to read linked history, then hides it after revoke', async () => {
    const now = '2026-08-17T00:00:00.000Z';
    const childId = 'patient-child-proxy';
    const intakeId = 'intake-child-proxy';
    sqlite.prepare(`INSERT INTO pharmacy_patients
      (id, line_account_id, owner_friend_id, relationship, name, name_kana, birth_date, created_at, updated_at)
      VALUES (?, ?, ?, 'child', 'Proxy Child', 'PROXY CHILD', '2018-01-01', ?, ?)`).run(
      childId, patient.lineAccountId, patient.friendId, now, now,
    );
    sqlite.prepare(`INSERT INTO pharmacy_patient_intake_responses
      (id, line_account_id, owner_friend_id, patient_id, revision, schema_version,
       patient_snapshot_json, answers_json, idempotency_key, representative_consent_at,
       privacy_consent_at, created_at)
      VALUES (?, ?, ?, ?, 1, 1, '{}', '{}', ?, ?, ?, ?)`).run(
      intakeId, patient.lineAccountId, patient.friendId, childId,
      'intake-child-proxy-key', now, now, now,
    );
    sqlite.prepare(`INSERT INTO pharmacy_patient_proxy_grants
      (id, line_account_id, patient_id, actor_friend_id, permission_code, basis_code,
       terms_version, terms_hash, granted_at, expires_at, version, created_at, updated_at)
      VALUES ('grant-child-proxy', ?, ?, ?, 'patient_intake_v1', 'self_attested_guardian',
              1, ?, ?, '2099-01-01T00:00:00.000Z', 1, ?, ?)`).run(
      patient.lineAccountId, childId, patient.friendId, 'a'.repeat(64), now, now, now,
    );

    const submission = await reservePrescriptionDraft(db, patient, {
      idempotencyKey: 'child-proxy-history',
      desiredPickupAt: null,
      originalPrescriptionConsent: true,
      readinessNoticeConsent: true,
      patientId: childId,
      intakeResponseId: intakeId,
    });
    await expect(listPrescriptionHistory(db, patient)).resolves.toEqual([
      expect.objectContaining({ id: submission.id }),
    ]);

    sqlite.prepare(`UPDATE pharmacy_patient_proxy_grants
      SET revoked_at = ?, revoke_reason_code = 'user_revoked', version = version + 1, updated_at = ?
      WHERE id = 'grant-child-proxy'`).run(now, now);

    await expect(listPrescriptionHistory(db, patient)).resolves.toEqual([]);
  });
});
