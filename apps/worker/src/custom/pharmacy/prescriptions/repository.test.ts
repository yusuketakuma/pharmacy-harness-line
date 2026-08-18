import { describe, expect, it, vi } from 'vitest';
import {
  applyAdminPrescriptionAction,
  cancelPrescription,
  listPrescriptionHistory,
  markPrescriptionFileDeleted,
  markPrescriptionFileReady,
  reservePrescriptionResubmission,
  getAdminPrescriptionFile,
  getAdminPrescriptionDetail,
  getAdminPrescriptionStats,
  listAdminPrescriptionQueue,
  reservePrescriptionDraft,
  reservePrescriptionFile,
} from './repository.js';

function fakeDb(row: unknown, batchChanges = 1) {
  const calls: Array<{ sql: string; values: unknown[]; operation: string }> = [];
  const prepare = vi.fn((sql: string) => ({
    bind: (...values: unknown[]) => ({
      sql,
      values,
      run: async () => {
        calls.push({ sql, values, operation: 'run' });
        return { success: true, meta: { changes: 1 } };
      },
      first: async () => {
        calls.push({ sql, values, operation: 'first' });
        if (sql.includes('FROM pharmacy_prescription_validities')) {
          return { verification_status: 'verified', valid_until: '2999-12-31' };
        }
        return row;
      },
      all: async () => {
        calls.push({ sql, values, operation: 'all' });
        return { results: Array.isArray(row) ? row : [] };
      },
    }),
  }));
  const batch = vi.fn(async (statements: Array<{ sql: string; values: unknown[] }>) => {
    calls.push(...statements.map(({ sql, values }) => ({ sql, values, operation: 'batch' })));
    return statements.map(() => ({ success: true, meta: { changes: batchChanges } }));
  });
  return { db: { prepare, batch } as unknown as D1Database, calls, prepare };
}

describe('reservePrescriptionDraft', () => {
  it('inserts idempotently and reads back only through the patient tenant key', async () => {
    const existing = {
      id: 'submission-1',
      status: 'draft',
      upload_revision: 1,
      updated_at: '2026-08-17T00:00:00.000Z',
    };
    const { db, calls } = fakeDb(existing);

    await expect(
      reservePrescriptionDraft(
        db,
        { lineAccountId: 'account-1', friendId: 'friend-1' },
        {
          idempotencyKey: 'request-123',
          desiredPickupAt: null,
          originalPrescriptionConsent: true,
          readinessNoticeConsent: true,
        },
      ),
    ).resolves.toEqual(existing);

    expect(calls[0].sql).toContain('ON CONFLICT(line_account_id, friend_id, idempotency_key) DO NOTHING');
    expect(calls[1].sql).toContain('INSERT INTO pharmacy_prescription_events');
    expect(calls[2].sql).toContain(
      'WHERE line_account_id = ? AND friend_id = ? AND idempotency_key = ?',
    );
    expect(calls[2].values).toEqual(['account-1', 'friend-1', 'request-123']);
  });

  it('rejects an unsafe idempotency key before touching D1', async () => {
    const { db, prepare } = fakeDb(null);
    await expect(
      reservePrescriptionDraft(
        db,
        { lineAccountId: 'account-1', friendId: 'friend-1' },
        {
          idempotencyKey: 'bad key',
          desiredPickupAt: null,
          originalPrescriptionConsent: false,
          readinessNoticeConsent: false,
        },
      ),
    ).rejects.toThrow('invalid idempotency key');
    expect(prepare).not.toHaveBeenCalled();
  });

  it('pins a family patient and intake revision when the new flow supplies both ids', async () => {
    const existing = {
      id: 'submission-1', status: 'draft', upload_revision: 1,
      updated_at: '2026-08-17T00:00:00.000Z',
      patient_id: 'patient-1', intake_response_id: 'response-1',
    };
    const { db, calls } = fakeDb(existing);
    await reservePrescriptionDraft(db, {
      lineAccountId: 'account-1', friendId: 'friend-1',
    }, {
      idempotencyKey: 'request-123',
      desiredPickupAt: null,
      originalPrescriptionConsent: true,
      readinessNoticeConsent: true,
      patientId: 'patient-1',
      intakeResponseId: 'response-1',
    });
    expect(calls.some((call) => call.sql.includes('intake_required'))).toBe(true);
    expect(calls.some((call) => call.sql.includes('pharmacy_prescription_patients'))).toBe(true);
  });
});

describe('admin account-scoped repository', () => {
  it('blocks a new-flow acceptance until the latest fulfillment quote is acceptable', async () => {
    const current = {
      status: 'received', updated_at: '2026-08-17T00:00:00.000Z', intake_required: 1,
    };
    const quote = {
      decision: 'conditional',
      requirements_json: '[{"code":"original_required","status":"pending"}]',
    };
    const calls: Array<{ operation: string }> = [];
    const db = {
      prepare: (sql: string) => ({
        bind: () => ({
          first: async () => {
            calls.push({ operation: 'first' });
            if (sql.includes('pharmacy_prescription_submissions')) return current;
            if (sql.includes('pharmacy_prescription_validities')) return { verification_status: 'verified', valid_until: '2999-12-31' };
            return quote;
          },
          run: async () => { calls.push({ operation: 'run' }); return { meta: { changes: 1 } }; },
          all: async () => ({ results: [] }),
        }),
      }),
      batch: async () => { calls.push({ operation: 'batch' }); return []; },
    } as unknown as D1Database;
    await expect(applyAdminPrescriptionAction(
      db, 'account-1', 'submission-1', 'admin_accept',
      '2026-08-17T00:00:00.000Z', 'staff-1', null,
    )).rejects.toThrow('fulfillment quote not acceptable');
    expect(calls.every((call) => call.operation !== 'batch')).toBe(true);
  });

  it('requires FulfillmentQuote for a Myna-linked submission even without intake_required', async () => {
    const current = {
      status: 'received', updated_at: '2026-08-17T00:00:00.000Z',
      intake_required: 0, source_handoff_id: 'handoff-1',
    };
    const db = {
      prepare: (sql: string) => ({
        bind: () => ({
          first: async () => {
            if (sql.includes('pharmacy_prescription_submissions')) return current;
            if (sql.includes('pharmacy_prescription_validities')) return { verification_status: 'verified', valid_until: '2999-12-31' };
            return null;
          },
          run: async () => ({ meta: { changes: 1 } }),
          all: async () => ({ results: [] }),
        }),
      }),
      batch: async () => [],
    } as unknown as D1Database;
    await expect(applyAdminPrescriptionAction(
      db, 'account-1', 'submission-1', 'admin_accept',
      '2026-08-17T00:00:00.000Z', 'staff-1', null,
    )).rejects.toThrow('fulfillment quote required');
  });

  it('lists a stable queue for one account without image keys or thumbnails', async () => {
    const { db, calls } = fakeDb([{ id: 'submission-1', status: 'received' }]);
    await expect(listAdminPrescriptionQueue(db, 'account-1', {
      status: 'received',
      cursor: { requestedAt: '2026-08-17T00:00:00.000Z', id: 'submission-0' },
      limit: 20,
    })).resolves.toEqual([{ id: 'submission-1', status: 'received' }]);
    expect(calls[0].sql).toContain('s.line_account_id = ?');
    expect(calls[0].sql).toContain('s.status = ?');
    expect(calls[0].sql).toContain('ORDER BY COALESCE(s.requested_at, s.created_at), s.id');
    expect(calls[0].sql).not.toContain('r2_key');
    expect(calls[0].sql).not.toContain('pharmacy_prescription_files');
  });

  it('fails closed when a received prescription has no verified validity', async () => {
    const current = { status: 'received', updated_at: 'v1', intake_required: 0, source_handoff_id: null };
    const calls: string[] = [];
    const db = {
      prepare: (sql: string) => ({ bind: () => ({
        first: async () => {
          calls.push(sql);
          return sql.includes('pharmacy_prescription_submissions') ? current : null;
        },
        run: async () => ({ meta: { changes: 1 } }),
      }) }),
      batch: vi.fn(),
    } as unknown as D1Database;

    await expect(applyAdminPrescriptionAction(
      db, 'account-1', 'submission-1', 'admin_accept', 'v1', 'staff-1', null,
      new Date('2026-08-17T00:00:00.000Z'),
    )).rejects.toThrow(/validity verification required/);
    expect(calls.some((sql) => sql.includes('line_account_id = ?'))).toBe(true);
    expect(db.batch).not.toHaveBeenCalled();
  });

  it('moves a verified but expired prescription to review instead of accepting it', async () => {
    const current = { status: 'received', updated_at: 'v1', intake_required: 0, source_handoff_id: null };
    const batches: Array<Array<{ sql: string; values: unknown[] }>> = [];
    const db = {
      prepare: (sql: string) => ({ bind: (...values: unknown[]) => ({
        sql,
        values,
        first: async () => sql.includes('pharmacy_prescription_submissions')
          ? current
          : { verification_status: 'verified', valid_until: '2026-08-16' },
      }) }),
      batch: async (statements: Array<{ sql: string; values: unknown[] }>) => {
        batches.push(statements);
        return statements.map(() => ({ meta: { changes: 1 } }));
      },
    } as unknown as D1Database;

    await expect(applyAdminPrescriptionAction(
      db, 'account-1', 'submission-1', 'admin_accept', 'v1', 'staff-1', null,
      new Date('2026-08-17T00:00:00.000Z'),
    )).rejects.toThrow(/validity expired/);
    expect(batches[0][0].sql).toContain("verification_status = 'expired_review_required'");
    expect(batches[0][1].sql).toContain('INSERT INTO pharmacy_growth_events');
  });

  it('authorizes a private image by account, submission, and file id', async () => {
    const file = { r2_key: 'private-key', content_type: 'image/png' };
    const { db, calls } = fakeDb(file);
    await expect(getAdminPrescriptionFile(
      db, 'account-1', 'submission-1', 'file-1',
    )).resolves.toEqual(file);
    expect(calls[0].sql).toContain('s.line_account_id = ?');
    expect(calls[0].sql).toContain('f.submission_id = ? AND f.id = ?');
    expect(calls[0].sql).toContain("f.state = 'ready'");
  });

  it('applies an admin transition with scoped CAS and an atomic event', async () => {
    const { db, calls } = fakeDb({
      status: 'received', updated_at: '2026-08-17T00:00:00.000Z',
    });
    await expect(applyAdminPrescriptionAction(
      db,
      'account-1',
      'submission-1',
      'admin_accept',
      '2026-08-17T00:00:00.000Z',
      'staff-1',
      null,
    )).resolves.toMatchObject({ status: 'accepted' });
    const update = calls.find((call) => call.operation === 'batch' && call.sql.includes('UPDATE pharmacy_prescription_submissions'));
    const event = calls.find((call) => call.operation === 'batch' && call.sql.includes('INSERT INTO pharmacy_prescription_events'));
    expect(update?.sql).toContain('line_account_id = ?');
    expect(update?.sql).toContain('status = ? AND updated_at = ?');
    expect(event).toBeDefined();
  });

  it('replays the same admin operation without creating another status event', async () => {
    const batch = vi.fn();
    const db = {
      prepare: (sql: string) => ({
        bind: () => ({
          first: async () => sql.includes('FROM pharmacy_prescription_events e')
            ? {
              id: 'operation-1', actor_id: 'staff-1', from_status: 'received',
              to_status: 'accepted', reason_code: null,
            }
            : null,
          run: async () => ({ meta: { changes: 1 } }),
          all: async () => ({ results: [] }),
        }),
      }),
      batch,
    } as unknown as D1Database;

    await expect(applyAdminPrescriptionAction(
      db, 'account-1', 'submission-1', 'admin_accept',
      'stale-version', 'staff-1', null, 'operation-1',
    )).resolves.toEqual({ status: 'accepted', statusEventId: 'operation-1' });
    expect(batch).not.toHaveBeenCalled();
  });

  it('rejects invalid transitions before writing', async () => {
    const { db, calls } = fakeDb({ status: 'closed', updated_at: 'v1' });
    await expect(applyAdminPrescriptionAction(
      db, 'account-1', 'submission-1', 'admin_accept', 'v1', 'staff-1', null,
    )).rejects.toThrow('invalid prescription transition');
    expect(calls.every((call) => call.operation !== 'batch')).toBe(true);
  });

  it('returns account-scoped pending count and oldest wait', async () => {
    const stats = { pending_count: 2, oldest_wait_at: '2026-08-17T00:00:00Z' };
    const { db, calls } = fakeDb(stats);
    await expect(getAdminPrescriptionStats(db, 'account-1')).resolves.toEqual(stats);
    expect(calls[0].sql).toContain('line_account_id = ?');
    expect(calls[0].sql).toContain("status = 'received'");
  });

  it('loads scoped detail with file metadata but never exposes R2 keys', async () => {
    const values: unknown[] = [
      { id: 'submission-1', status: 'received' },
      [{ id: 'file-1', content_type: 'image/png' }],
      [{ id: 'event-1', event_type: 'status_changed' }],
      { source_id: 'source-1', classification: 'primary', display_name: 'Clinic A' },
      { issued_on: '2026-08-17', valid_until: '2026-08-20', validity_basis: 'default_4_days', verification_status: 'verified' },
    ];
    const calls: string[] = [];
    const db = {
      prepare: (sql: string) => ({
        bind: () => ({
          first: async () => { calls.push(sql); return values.shift(); },
          all: async () => { calls.push(sql); return { results: values.shift() }; },
        }),
      }),
    } as unknown as D1Database;
    await expect(getAdminPrescriptionDetail(
      db, 'account-1', 'submission-1',
    )).resolves.toEqual({
      submission: { id: 'submission-1', status: 'received' },
      files: [{ id: 'file-1', content_type: 'image/png' }],
      events: [{ id: 'event-1', event_type: 'status_changed' }],
      source: { source_id: 'source-1', classification: 'primary', display_name: 'Clinic A' },
      validity: { issued_on: '2026-08-17', valid_until: '2026-08-20', validity_basis: 'default_4_days', verification_status: 'verified' },
    });
    expect(calls.every((sql) => sql.includes('line_account_id = ?'))).toBe(true);
    expect(calls.join('\n')).not.toContain('r2_key');
  });
});

describe('patient history, cancellation, and resubmission', () => {
  const patient = { lineAccountId: 'account-1', friendId: 'friend-1' };

  it('lists owned submission history without selecting image rows or keys', async () => {
    const { db, calls } = fakeDb([{ id: 'submission-1', status: 'received' }]);
    await expect(listPrescriptionHistory(db, patient)).resolves.toEqual([
      { id: 'submission-1', status: 'received' },
    ]);
    expect(calls[0].sql).not.toContain('pharmacy_prescription_files');
    expect(calls[0].sql).not.toContain('r2_key');
    expect(calls[0].values).toEqual(['account-1', 'friend-1']);
  });

  it('cancels only patient-cancellable state with CAS and returns owned live object keys', async () => {
    const { db, calls } = fakeDb([
      { id: 'file-1', r2_key: 'custom/pharmacy/prescriptions/submission-1/1/file-1' },
    ]);
    await expect(cancelPrescription(
      db, patient, 'submission-1', '2026-08-17T00:00:00.000Z',
    )).resolves.toEqual([
      { id: 'file-1', r2_key: 'custom/pharmacy/prescriptions/submission-1/1/file-1' },
    ]);
    expect(calls[0].sql).toContain("status IN ('draft','received')");
    expect(calls[0].sql).toContain('updated_at = ?');
    expect(calls[1].sql).toContain('patient_cancelled');
    expect(calls[2].sql).toContain("f.state != 'deleted'");
  });

  it('reserves the next upload revision without replacing active_revision', async () => {
    const { db, calls } = fakeDb(null);
    await reservePrescriptionResubmission(
      db, patient, 'submission-1', '2026-08-17T00:00:00.000Z',
    );
    expect(calls[0].sql).toContain('upload_revision = upload_revision + 1');
    expect(calls[0].sql).not.toContain('active_revision =');
    expect(calls[0].sql).toContain("status = 'needs_resubmission'");
    expect(calls[1].sql).toContain("'revision_reserved'");
  });

  it('rejects stale cancellation and resubmission updates', async () => {
    const { db } = fakeDb([], 0);
    await expect(cancelPrescription(db, patient, 'submission-1', 'stale'))
      .rejects.toThrow('prescription cancel conflict');
    await expect(reservePrescriptionResubmission(db, patient, 'submission-1', 'stale'))
      .rejects.toThrow('prescription resubmission conflict');
  });

  it('marks an owned file deleted and records its PHI-free event', async () => {
    const { db, calls } = fakeDb([]);
    await markPrescriptionFileDeleted(db, patient, 'submission-1', 'file-1');
    expect(calls[0].sql).toContain("SET state = 'deleted'");
    expect(calls[0].sql).toContain('s.line_account_id = ? AND s.friend_id = ?');
    expect(calls[1].sql).toContain("'file_deleted'");
  });
});

describe('submitPrescription', () => {
  it('atomically requires consent and 1-4 contiguous ready files before activation', async () => {
    const { submitPrescription } = await import('./repository.js');
    const { db, calls } = fakeDb(null);
    await submitPrescription(
      db,
      { lineAccountId: 'account-1', friendId: 'friend-1' },
      'submission-1',
      '2026-08-17T00:00:00.000Z',
    );
    expect(calls[0].sql).toContain('original_prescription_consent_at IS NOT NULL');
    expect(calls[0].sql).toContain('readiness_notice_consent_at IS NOT NULL');
    expect(calls[0].sql).toContain("f.state = 'ready'");
    expect(calls[0].sql).toContain('f.submission_id = s.id');
    expect(calls[0].sql).not.toContain('f.submission_id = id');
    expect(calls[0].sql).toContain('MIN(f.position) = 1');
    expect(calls[0].sql).toContain('MAX(f.position) = COUNT(*)');
    expect(calls[0].sql).toContain('active_revision = upload_revision');
    expect(calls[1].sql).toContain('INSERT INTO pharmacy_prescription_events');
  });

  it('returns a conflict when the conditional update changes no row', async () => {
    const { submitPrescription } = await import('./repository.js');
    const { db } = fakeDb(null, 0);
    await expect(submitPrescription(
      db,
      { lineAccountId: 'account-1', friendId: 'friend-1' },
      'submission-1',
      'stale-version',
    )).rejects.toThrow('prescription submit conflict');
  });
});

describe('prescription file persistence', () => {
  it('reserves pending storage only through the owned current upload revision', async () => {
    const existing = {
      id: 'file-1',
      r2_key: 'custom/pharmacy/prescriptions/submission-1/1/file-1',
      content_type: 'image/png',
      byte_size: 8,
      sha256: 'a'.repeat(64),
      state: 'pending',
      revision: 1,
      position: 1,
    };
    const { db, calls } = fakeDb(existing);
    await expect(reservePrescriptionFile(
      db,
      { lineAccountId: 'account-1', friendId: 'friend-1' },
      'submission-1',
      1,
      { contentType: 'image/png', byteSize: 8, sha256: 'a'.repeat(64) },
    )).resolves.toEqual(existing);
    expect(calls[0].sql).toContain("s.status IN ('draft','needs_resubmission')");
    expect(calls[0].sql).toContain('s.line_account_id = ? AND s.friend_id = ?');
    expect(calls[1].sql).toContain("f.state IN ('pending','ready')");
    expect(calls[1].sql).toContain('SET updated_at = ?');
    expect(calls[2].sql).toContain('f.submission_id = ? AND s.line_account_id = ? AND s.friend_id = ?');
  });

  it('rejects a different image replayed into the same position', async () => {
    const { db } = fakeDb({
      id: 'file-1', r2_key: 'key', content_type: 'image/png', byte_size: 8,
      sha256: 'b'.repeat(64), state: 'ready', revision: 1, position: 1,
    });
    await expect(reservePrescriptionFile(
      db,
      { lineAccountId: 'account-1', friendId: 'friend-1' },
      'submission-1',
      1,
      { contentType: 'image/png', byteSize: 8, sha256: 'a'.repeat(64) },
    )).rejects.toThrow('prescription file position conflict');
  });

  it('marks only the exact pending owned file ready', async () => {
    const { db, calls } = fakeDb(null);
    await markPrescriptionFileReady(
      db,
      { lineAccountId: 'account-1', friendId: 'friend-1' },
      'submission-1',
      'file-1',
      'a'.repeat(64),
    );
    expect(calls[0].sql).toContain("f.state = 'pending'");
    expect(calls[0].sql).toContain('s.line_account_id = ? AND s.friend_id = ?');
  });
});
