import { describe, expect, it, vi } from 'vitest';
import { recordMynaPatientReport, recordMynaVerification } from './repository.js';

function fakeDb(rows: {
  handoff?: Record<string, unknown> | null;
  expectation?: Record<string, unknown> | null;
  latestVerification?: Record<string, unknown> | null;
}) {
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const prepare = vi.fn((sql: string) => ({
    bind: (...values: unknown[]) => ({
      first: async () => {
        calls.push({ sql, values });
        if (sql.includes('FROM pharmacy_myna_handoffs')) return rows.handoff ?? null;
        if (sql.includes('FROM pharmacy_prescription_expectations')) return rows.expectation ?? null;
        if (sql.includes('FROM pharmacy_myna_verifications')) return rows.latestVerification ?? null;
        return null;
      },
      all: async () => {
        calls.push({ sql, values });
        return { results: [] };
      },
      run: async () => {
        calls.push({ sql, values });
        return { success: true, meta: { changes: 1 } };
      },
    }),
  }));
  const db = {
    prepare,
    batch: async (statements: unknown[]) => {
      calls.push({ sql: `BATCH ${statements.length}`, values: [] });
      return statements.map(() => ({ success: true, meta: { changes: 1 } }));
    },
  } as unknown as D1Database;
  return { db, calls };
}

const handoff = {
  id: 'handoff-1', line_account_id: 'account-1', friend_id: 'friend-1', patient_id: null,
  expectation_id: 'expectation-1', method: 'E_PRESCRIPTION', status: 'PATIENT_REPORTED_COMPLETE',
  source: 'LIFF', correlation_id: 'corr-1', launched_at: '2026-08-17T09:00:00.000Z',
  patient_reported_at: null, expires_at: '2099-08-18T09:00:00.000Z', closed_at: null,
  created_at: '2026-08-17T09:00:00.000Z', updated_at: '2026-08-17T09:00:00.000Z',
};

describe('Myna handoff repository', () => {
  it('records a patient report without changing official receipt state', async () => {
    const { db, calls } = fakeDb({ handoff });
    const result = await recordMynaPatientReport(
      db, 'account-1', 'friend-1', 'handoff-1', 'COMPLETED',
    );
    expect(result.status).toBe('PATIENT_REPORTED_COMPLETE');
    expect(calls.some((call) => call.sql.includes("status = 'RECEIVED'"))).toBe(false);
  });

  it('creates the official receipt projection only for a pharmacy verification', async () => {
    const { db, calls } = fakeDb({
      handoff,
      expectation: {
        id: 'expectation-1', handoff_id: 'handoff-1', line_account_id: 'account-1',
        friend_id: 'friend-1', patient_id: null, method: 'E_PRESCRIPTION',
        receipt_status: 'EXPECTED', shadow_submission_id: null,
      },
    });
    const result = await recordMynaVerification(db, {
      lineAccountId: 'account-1',
      handoffId: 'handoff-1',
      staffId: 'staff-1',
      status: 'E_PRESCRIPTION_RECEIVED',
      sourceSystem: 'pharmacy-terminal',
      sourceReference: 'opaque-ref-1',
    });
    expect(result.receiptStatus).toBe('RECEIVED');
    expect(result.shadowSubmissionId).toBe('submission-handoff-1');
    expect(calls.some((call) => call.sql === 'BATCH 8')).toBe(true);
    expect(calls.some((call) => call.sql.includes('myna_number'))).toBe(false);
    expect(calls.some((call) => call.sql.includes('prescription_json'))).toBe(false);
  });

  it('does not turn a paper handoff into an electronic prescription receipt', async () => {
    const { db, calls } = fakeDb({
      handoff: { ...handoff, method: 'PAPER' },
      expectation: {
        id: 'expectation-1', handoff_id: 'handoff-1', line_account_id: 'account-1',
        friend_id: 'friend-1', patient_id: null, method: 'PAPER',
        receipt_status: 'EXPECTED', shadow_submission_id: null,
      },
    });
    await expect(recordMynaVerification(db, {
      lineAccountId: 'account-1', handoffId: 'handoff-1', staffId: 'staff-1',
      status: 'E_PRESCRIPTION_RECEIVED', sourceSystem: 'pharmacy-terminal',
    })).rejects.toThrow('invalid Myna verification');
    expect(calls.some((call) => call.sql.startsWith('BATCH'))).toBe(false);
  });

  it('records an expired prescription without creating a receipt projection', async () => {
    const { db } = fakeDb({
      handoff,
      expectation: {
        id: 'expectation-1', handoff_id: 'handoff-1', line_account_id: 'account-1',
        friend_id: 'friend-1', patient_id: null, method: 'E_PRESCRIPTION',
        receipt_status: 'EXPECTED', shadow_submission_id: null,
      },
    });
    const result = await recordMynaVerification(db, {
      lineAccountId: 'account-1', handoffId: 'handoff-1', staffId: 'staff-1',
      status: 'PRESCRIPTION_EXPIRED', sourceSystem: 'pharmacy-terminal',
    });
    expect(result.receiptStatus).toBe('EXPIRED');
    expect(result.shadowSubmissionId).toBeNull();
    expect(result.handoff.status).toBe('EXPIRED');
  });
});
