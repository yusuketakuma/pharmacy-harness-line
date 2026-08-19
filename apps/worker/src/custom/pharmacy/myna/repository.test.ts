import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';
import {
  listMynaHandoffs,
  markMynaLaunchRequested,
  recordMynaPatientReport,
  recordMynaVerification,
} from './repository.js';

const require = createRequire(import.meta.url);
const Sqlite = require('../../../../../../packages/db/node_modules/better-sqlite3') as
  new (filename: string) => {
    exec(sql: string): void;
    prepare(sql: string): {
      get(...values: unknown[]): unknown;
      all(...values: unknown[]): unknown[];
      run(...values: unknown[]): { changes: number };
    };
    close(): void;
  };

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

  it('writes the launch transition and its audit event in one batch', async () => {
    const { db, calls } = fakeDb({ handoff: { ...handoff, status: 'CREATED' } });
    await markMynaLaunchRequested(db, 'account-1', 'friend-1', 'handoff-1');
    expect(calls.some((call) => call.sql === 'BATCH 2')).toBe(true);
    expect(calls.some((call) => call.sql.includes("status = 'LAUNCH_REQUESTED'"))).toBe(false);
    expect(calls.some((call) => call.sql.includes('INSERT INTO pharmacy_myna_events'))).toBe(false);
  });

  it('writes the patient report transition and its audit event in one batch', async () => {
    const { db, calls } = fakeDb({ handoff: { ...handoff, status: 'LAUNCH_REQUESTED' } });
    await recordMynaPatientReport(db, 'account-1', 'friend-1', 'handoff-1', 'COMPLETED');
    expect(calls.some((call) => call.sql === 'BATCH 2')).toBe(true);
    expect(calls.some((call) => call.sql.includes('SET status = ?, patient_reported_at'))).toBe(false);
    expect(calls.some((call) => call.sql.includes('INSERT INTO pharmacy_myna_events'))).toBe(false);
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

// Only the handoff table: the listing and the expiry sweep it runs first touch
// nothing else. Production schema lives in
// packages/db/migrations/custom_005_pharmacy_myna.sql.
const HANDOFF_SCHEMA = `
  CREATE TABLE pharmacy_myna_handoffs (
    id TEXT PRIMARY KEY, line_account_id TEXT NOT NULL, friend_id TEXT NOT NULL,
    patient_id TEXT, expectation_id TEXT, method TEXT NOT NULL, status TEXT NOT NULL,
    source TEXT NOT NULL, correlation_id TEXT NOT NULL, launched_at TEXT,
    patient_reported_at TEXT, expires_at TEXT NOT NULL, closed_at TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
`;

function handoffDb() {
  const sqlite = new Sqlite(':memory:');
  sqlite.exec(HANDOFF_SCHEMA);
  const insert = (id: string, patientId: string, createdAt: string, expiresAt: string) =>
    sqlite.prepare(
      `INSERT INTO pharmacy_myna_handoffs
         (id, line_account_id, friend_id, patient_id, expectation_id, method, status,
          source, correlation_id, expires_at, created_at, updated_at)
       VALUES (?, 'account-1', 'friend-1', ?, NULL, 'PAPER', 'CREATED', 'LIFF', ?, ?, ?, ?)`,
    ).run(id, patientId, `correlation-${id}`, expiresAt, createdAt, createdAt);
  const statement = (sql: string, values: unknown[] = []) => ({
    bind: (...next: unknown[]) => statement(sql, next),
    first: async () => sqlite.prepare(sql).get(...values) ?? null,
    all: async () => ({ success: true, results: sqlite.prepare(sql).all(...values), meta: {} }),
    run: async () => ({
      success: true,
      results: [],
      meta: { changes: sqlite.prepare(sql).run(...values).changes },
    }),
  });
  return {
    db: { prepare: (sql: string) => statement(sql) } as unknown as D1Database,
    insert,
    close: () => sqlite.close(),
  };
}

describe('listMynaHandoffs', () => {
  const NOISE_BASE = Date.parse('2026-08-19T00:00:00.000Z');

  it("returns a patient's handoffs from beyond the account-wide first 100", async () => {
    const fake = handoffDb();
    try {
      // Oldest row, so the account-wide DESC page of 100 never reaches it —
      // on a busy account the patient's own detail page would lose it.
      fake.insert('handoff-target', 'patient-x', '2020-01-01T00:00:00.000Z', '2020-01-02T00:00:00.000Z');
      for (let index = 0; index < 120; index += 1) {
        fake.insert(
          `handoff-${index}`, 'patient-other',
          new Date(NOISE_BASE + index * 1000).toISOString(), '2099-01-01T00:00:00.000Z',
        );
      }

      const accountWide = await listMynaHandoffs(fake.db, 'account-1');
      expect(accountWide).toHaveLength(100);
      expect(accountWide.some((item) => item.id === 'handoff-target')).toBe(false);

      const filtered = await listMynaHandoffs(fake.db, 'account-1', undefined, 'patient-x');
      // EXPIRED because the filtered read still runs the expiry sweep first.
      expect(filtered.map((item) => ({ id: item.id, status: item.status })))
        .toEqual([{ id: 'handoff-target', status: 'EXPIRED' }]);
    } finally {
      fake.close();
    }
  });
});
