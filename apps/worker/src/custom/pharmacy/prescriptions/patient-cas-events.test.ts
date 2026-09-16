import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { DB_PACKAGE_ROOT, Sqlite, d1FromSqlite } from '../test-sqlite.js';
import { cancelPrescription, reservePrescriptionResubmission, submitPrescription } from './repository.js';

describe('patient prescription CAS audit events', () => {
  it.each(['submit', 'cancel', 'resubmit'] as const)('records one event for the winning %s update', async (action) => {
    const sqlite = new Sqlite(':memory:');
    const expectedUpdatedAt = '2026-09-05T00:00:00.000Z';
    const patient = { lineAccountId: 'account-a', friendId: 'friend-a' };
    try {
      sqlite.pragma('foreign_keys = ON');
      sqlite.exec(readFileSync(join(DB_PACKAGE_ROOT, 'bootstrap.sql'), 'utf8'));
      sqlite.prepare(`INSERT INTO line_accounts (id, channel_id, name, channel_access_token, channel_secret)
        VALUES ('account-a','channel-a','Synthetic','synthetic-token','synthetic-secret')`).run();
      sqlite.prepare(`INSERT INTO friends (id, line_user_id, line_account_id)
        VALUES ('friend-a','synthetic-user','account-a')`).run();
      sqlite.prepare(`INSERT INTO pharmacy_prescription_submissions
        (id, line_account_id, friend_id, idempotency_key, status, upload_revision,
         original_prescription_consent_at, readiness_notice_consent_at, created_at, updated_at)
        VALUES ('submission-a','account-a','friend-a','synthetic-submission-key', ?, 1,
                ?, ?, ?, ?)`).run(
        action === 'resubmit' ? 'needs_resubmission' : 'draft',
        expectedUpdatedAt, expectedUpdatedAt, expectedUpdatedAt, expectedUpdatedAt,
      );
      if (action === 'submit') {
        sqlite.prepare(`INSERT INTO pharmacy_prescription_files
          (id, submission_id, revision, position, r2_key, content_type, byte_size,
           sha256, state, created_at, updated_at)
          VALUES ('file-a','submission-a',1,1,'custom/pharmacy/prescriptions/submission-a/1/file-a',
                  'image/jpeg',1,?,'ready',?,?)`).run('a'.repeat(64), expectedUpdatedAt, expectedUpdatedAt);
      }
      const db = d1FromSqlite(sqlite);
      const execute = () => action === 'submit'
        ? submitPrescription(db, patient, 'submission-a', {
          expectedUpdatedAt, desiredPickupAt: null,
          originalPrescriptionConsent: true, readinessNoticeConsent: true,
        })
        : action === 'cancel'
          ? cancelPrescription(db, patient, 'submission-a', expectedUpdatedAt)
          : reservePrescriptionResubmission(db, patient, 'submission-a', expectedUpdatedAt);
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-09-05T01:00:00.000Z'));
      await execute();
      await expect(execute()).rejects.toThrow(/prescription .* conflict/);
      expect(sqlite.prepare('SELECT COUNT(*) AS count FROM pharmacy_prescription_events').get())
        .toEqual({ count: 1 });
      expect(sqlite.prepare('SELECT status, upload_revision FROM pharmacy_prescription_submissions WHERE id = ?').get('submission-a'))
        .toEqual({ status: action === 'submit' ? 'received' : action === 'cancel' ? 'cancelled' : 'needs_resubmission',
          upload_revision: action === 'resubmit' ? 2 : 1 });
    } finally {
      vi.useRealTimers();
      sqlite.close();
    }
  });
});
