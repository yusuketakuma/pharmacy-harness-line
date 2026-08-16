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
import { cleanupPrescriptionImages } from '../../../apps/worker/src/custom/pharmacy/prescriptions/cleanup.js';
import { deliverPrescriptionNotification } from '../../../apps/worker/src/custom/pharmacy/prescriptions/notifications.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

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

  beforeEach(() => {
    sqlite = new Database(':memory:');
    sqlite.pragma('foreign_keys = ON');
    sqlite.exec(readFileSync(join(ROOT, 'bootstrap.sql'), 'utf8'));
    sqlite.prepare(
      `INSERT INTO line_accounts
         (id, channel_id, name, channel_access_token, channel_secret,
          login_channel_id, liff_id, created_at, updated_at)
       VALUES (?, 'channel-synthetic', 'Synthetic Pharmacy', 'account-token',
               'secret', 'login-synthetic', 'liff-synthetic', ?, ?)`,
    ).run(patient.lineAccountId, '2026-08-17T00:00:00.000Z', '2026-08-17T00:00:00.000Z');
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
      submissionId,
      { proxyBaseUrl: 'https://worker.synthetic', proxyDispatch },
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
    await upload(submission.id as string, 1, 'a');
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
    await submitPrescription(db, patient, submission.id as string, submission.updated_at as string);
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
    await submitPrescription(
      db,
      patient,
      submission.id as string,
      detail!.submission.updated_at as string,
    );
    await notify(submission.id as string);
    detail = await getAdminPrescriptionDetail(db, patient.lineAccountId, submission.id as string);
    expect(detail?.submission.active_revision).toBe(2);

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
      expect(request.headers.get('Authorization')).toBe('Bearer account-token');
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
});
