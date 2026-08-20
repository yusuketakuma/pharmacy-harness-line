import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';
import {
  createMynaHandoff,
  getActivePatientMynaHandoff,
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
    transaction<T extends unknown[], R>(fn: (...args: T) => R): (...args: T) => R;
    close(): void;
  };

function fakeDb(rows: {
  handoff?: Record<string, unknown> | null;
  expectation?: Record<string, unknown> | null;
  latestVerification?: Record<string, unknown> | null;
  batchChanges?: number[];
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
      return statements.map((_statement, index) => ({
        success: true,
        meta: { changes: rows.batchChanges?.[index] ?? 1 },
      }));
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
  it('checks the method capability in the atomic handoff insert', async () => {
    const { db, calls } = fakeDb({ batchChanges: [0, 0, 0] });
    await expect(createMynaHandoff(db, {
      lineAccountId: 'account-1', friendId: 'friend-1', method: 'E_PRESCRIPTION',
      source: 'LIFF', correlationId: 'correlation-1', expiresAt: '2099-08-18T09:00:00.000Z',
    })).rejects.toThrow('FEATURE_DISABLED');
    expect(calls.some((call) => call.sql === 'BATCH 3')).toBe(true);
  });

  it('finds an active electronic handoff by both account and LINE owner', async () => {
    const { db, calls } = fakeDb({ handoff: { ...handoff, status: 'LAUNCH_REQUESTED' } });
    await expect(getActivePatientMynaHandoff(db, 'account-1', 'friend-1'))
      .resolves.toMatchObject({ id: 'handoff-1' });
    const lookup = calls.find((call) => call.sql.includes('ORDER BY created_at DESC'));
    expect(lookup?.sql).toContain('line_account_id = ? AND friend_id = ?');
    expect(lookup?.sql).toContain("'PATIENT_REPORTED_COMPLETE'");
    expect(lookup?.sql).toContain("'SUPPORT_NEEDED'");
    expect(lookup?.values.slice(0, 2)).toEqual(['account-1', 'friend-1']);
  });

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
  const insert = (id: string, patientId: string, createdAt: string, expiresAt: string, status = 'CREATED') =>
    sqlite.prepare(
      `INSERT INTO pharmacy_myna_handoffs
         (id, line_account_id, friend_id, patient_id, expectation_id, method, status,
          source, correlation_id, expires_at, created_at, updated_at)
       VALUES (?, 'account-1', 'friend-1', ?, NULL, 'PAPER', ?, 'LIFF', ?, ?, ?, ?)`,
    ).run(id, patientId, status, `correlation-${id}`, expiresAt, createdAt, createdAt);
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

  it('does not overwrite paper fallback or abandoned terminal reasons with expiry', async () => {
    const fake = handoffDb();
    try {
      fake.insert('paper', 'patient-x', '2020-01-01T00:00:00.000Z', '2020-01-02T00:00:00.000Z', 'PAPER_FALLBACK');
      fake.insert('abandoned', 'patient-x', '2020-01-02T00:00:00.000Z', '2020-01-03T00:00:00.000Z', 'ABANDONED');
      const rows = await listMynaHandoffs(fake.db, 'account-1', undefined, 'patient-x');
      expect(rows.map((row) => row.status)).toEqual(['ABANDONED', 'PAPER_FALLBACK']);
    } finally {
      fake.close();
    }
  });
});

// Real trigger enforcement, not the hand-rolled fakeDb() above: routes.test.ts
// mocks createMynaHandoff entirely, and no other test drives it against a real
// D1Database, so this is the only place the pharmacy_myna_handoffs_expectation_
// scope_insert trigger (custom_022_pharmacy_tenant_integrity.sql) is exercised.
const CREATE_HANDOFF_SCHEMA = `
  CREATE TABLE pharmacy_account_capabilities (
    line_account_id TEXT PRIMARY KEY, mode TEXT NOT NULL, capabilities_json TEXT NOT NULL
  );
  CREATE TABLE pharmacy_myna_handoffs (
    id TEXT PRIMARY KEY, line_account_id TEXT NOT NULL, friend_id TEXT NOT NULL,
    patient_id TEXT, expectation_id TEXT, method TEXT NOT NULL, status TEXT NOT NULL,
    source TEXT NOT NULL, correlation_id TEXT NOT NULL, launched_at TEXT,
    patient_reported_at TEXT, expires_at TEXT NOT NULL, closed_at TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE pharmacy_prescription_expectations (
    id TEXT PRIMARY KEY, line_account_id TEXT NOT NULL, friend_id TEXT NOT NULL,
    patient_id TEXT, handoff_id TEXT NOT NULL, method TEXT NOT NULL,
    receipt_status TEXT NOT NULL, shadow_submission_id TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE pharmacy_myna_events (
    id TEXT PRIMARY KEY, handoff_id TEXT NOT NULL, line_account_id TEXT NOT NULL,
    event_type TEXT NOT NULL, actor_type TEXT NOT NULL, actor_id TEXT,
    correlation_id TEXT NOT NULL, metadata_json TEXT NOT NULL DEFAULT '{}',
    occurred_at TEXT NOT NULL
  );
  -- Verbatim from custom_022_pharmacy_tenant_integrity.sql: the referenced
  -- expectation row must exist in the SAME batch statement order this trigger
  -- checks, i.e. before the handoff insert, not after.
  CREATE TRIGGER pharmacy_myna_handoffs_expectation_scope_insert
    BEFORE INSERT ON pharmacy_myna_handoffs
    WHEN NEW.expectation_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM pharmacy_prescription_expectations AS expectation
       WHERE expectation.id = NEW.expectation_id
         AND expectation.line_account_id = NEW.line_account_id
    )
  BEGIN SELECT RAISE(ABORT, 'PHARMACY_MYNA_EXPECTATION_SCOPE_MISMATCH'); END;
`;

function createHandoffDb() {
  const sqlite = new Sqlite(':memory:');
  sqlite.exec(CREATE_HANDOFF_SCHEMA);
  sqlite.prepare(`INSERT INTO pharmacy_account_capabilities
    (line_account_id, mode, capabilities_json)
    VALUES ('account-1', 'pharmacy', '["prescription_intake"]')`).run();
  const statement = (sql: string, values: unknown[] = []) => ({
    bind: (...next: unknown[]) => statement(sql, next),
    first: async () => sqlite.prepare(sql).get(...values) ?? null,
    all: async () => ({ success: true, results: sqlite.prepare(sql).all(...values), meta: {} }),
    run: () => ({
      success: true,
      results: [],
      meta: { changes: sqlite.prepare(sql).run(...values).changes },
    }),
  });
  return {
    db: {
      prepare: (sql: string) => statement(sql),
      batch: async (statements: Array<{ run(): unknown }>) =>
        sqlite.transaction(() => statements.map((s) => s.run()))(),
    } as unknown as D1Database,
    close: () => sqlite.close(),
  };
}

describe('createMynaHandoff', () => {
  it('creates the handoff and its expectation row together, real trigger enforced', async () => {
    const fake = createHandoffDb();
    try {
      const result = await createMynaHandoff(fake.db, {
        lineAccountId: 'account-1',
        friendId: 'friend-1',
        patientId: undefined,
        method: 'PAPER',
        source: 'LIFF',
        correlationId: 'corr-create-1',
        expiresAt: '2099-08-18T09:00:00.000Z',
      });
      expect(result.handoff.status).toBe('CREATED');
      expect(result.expectation.id).toBe(result.handoff.expectation_id);
    } finally {
      fake.close();
    }
  });
});
