import { createRequire } from 'node:module';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { listMynaHandoffs, recordMynaVerification } from './repository.js';

const require = createRequire(import.meta.url);
const Sqlite = require('../../../../../../packages/db/node_modules/better-sqlite3') as
  new (filename: string) => {
    exec(sql: string): void;
    prepare(sql: string): {
      reader: boolean;
      get(...values: unknown[]): unknown;
      all(...values: unknown[]): unknown[];
      run(...values: unknown[]): { changes: number };
    };
    transaction<T extends unknown[], R>(fn: (...args: T) => R): (...args: T) => R;
    close(): void;
  };

const CREATED_AT = '2026-08-19T00:00:00.000Z';

// Only the columns the Myna verification path touches; the production schema
// lives in packages/db/migrations/custom_005_pharmacy_myna.sql.
const SCHEMA = `
  CREATE TABLE pharmacy_myna_handoffs (
    id TEXT PRIMARY KEY, line_account_id TEXT NOT NULL, friend_id TEXT NOT NULL,
    patient_id TEXT, expectation_id TEXT, method TEXT NOT NULL, status TEXT NOT NULL,
    source TEXT NOT NULL, correlation_id TEXT NOT NULL, launched_at TEXT,
    patient_reported_at TEXT, expires_at TEXT NOT NULL, closed_at TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE pharmacy_prescription_expectations (
    id TEXT PRIMARY KEY, line_account_id TEXT NOT NULL, friend_id TEXT NOT NULL,
    patient_id TEXT, handoff_id TEXT NOT NULL UNIQUE, method TEXT NOT NULL,
    receipt_status TEXT NOT NULL, shadow_submission_id TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE pharmacy_myna_verifications (
    id TEXT PRIMARY KEY, handoff_id TEXT NOT NULL, line_account_id TEXT NOT NULL,
    status TEXT NOT NULL, verified_by TEXT NOT NULL, verified_at TEXT NOT NULL,
    reason_code TEXT, note TEXT, source_system TEXT NOT NULL, source_reference TEXT,
    created_at TEXT NOT NULL
  );
  CREATE TABLE pharmacy_myna_events (
    id TEXT PRIMARY KEY, handoff_id TEXT NOT NULL, line_account_id TEXT NOT NULL,
    event_type TEXT NOT NULL, actor_type TEXT NOT NULL, actor_id TEXT,
    correlation_id TEXT NOT NULL, schema_version INTEGER NOT NULL DEFAULT 1,
    metadata_json TEXT NOT NULL DEFAULT '{}', occurred_at TEXT NOT NULL
  );
  CREATE TABLE pharmacy_prescription_submissions (
    id TEXT PRIMARY KEY, line_account_id TEXT NOT NULL, friend_id TEXT NOT NULL,
    idempotency_key TEXT NOT NULL, status TEXT NOT NULL, active_revision INTEGER,
    upload_revision INTEGER, requested_at TEXT, created_at TEXT, updated_at TEXT,
    intake_required INTEGER, intake_method TEXT, source_handoff_id TEXT,
    UNIQUE (line_account_id, friend_id, idempotency_key)
  );
  CREATE TABLE pharmacy_prescription_events (
    id TEXT PRIMARY KEY, submission_id TEXT NOT NULL, actor_type TEXT, actor_id TEXT,
    event_type TEXT, from_status TEXT, to_status TEXT, revision INTEGER, created_at TEXT
  );
`;

function database(expiresAt: string, onBeforeBatch?: () => Promise<void>) {
  const sqlite = new Sqlite(':memory:');
  sqlite.exec(SCHEMA);
  sqlite.prepare(
    `INSERT INTO pharmacy_myna_handoffs
      (id, line_account_id, friend_id, expectation_id, method, status, source,
       correlation_id, expires_at, created_at, updated_at)
     VALUES ('handoff-1', 'account-1', 'friend-1', 'expectation-1', 'E_PRESCRIPTION',
             'PATIENT_REPORTED_COMPLETE', 'LIFF', 'correlation-1', ?, ?, ?)`,
  ).run(expiresAt, CREATED_AT, CREATED_AT);
  sqlite.prepare(
    `INSERT INTO pharmacy_prescription_expectations
      (id, line_account_id, friend_id, handoff_id, method, receipt_status, created_at, updated_at)
     VALUES ('expectation-1', 'account-1', 'friend-1', 'handoff-1', 'E_PRESCRIPTION',
             'EXPECTED', ?, ?)`,
  ).run(CREATED_AT, CREATED_AT);

  let hook = onBeforeBatch;
  type Statement = { sql: string; values: unknown[] };
  const exec = ({ sql, values }: Statement) => {
    const prepared = sqlite.prepare(sql);
    if (prepared.reader) {
      return { success: true, results: prepared.all(...values), meta: { changes: 0 } };
    }
    return { success: true, results: [], meta: { changes: prepared.run(...values).changes } };
  };
  const statement = (sql: string, values: unknown[] = []) => ({
    sql,
    values,
    bind(...next: unknown[]) { return statement(sql, next); },
    async first<T>() { return (sqlite.prepare(sql).get(...values) as T | undefined) ?? null; },
    async all<T>() {
      return { success: true, results: sqlite.prepare(sql).all(...values) as T[], meta: {} };
    },
    async run() { return exec({ sql, values }); },
  });
  const db = {
    prepare: (sql: string) => statement(sql),
    batch: async (items: Statement[]) => {
      if (hook) {
        const pending = hook;
        hook = undefined;
        await pending();
      }
      return sqlite.transaction((batch: Statement[]) => batch.map(exec))(items);
    },
  } as unknown as D1Database;
  const count = (table: string) =>
    (sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  const handoff = () =>
    sqlite.prepare('SELECT status, updated_at FROM pharmacy_myna_handoffs').get() as
      { status: string; updated_at: string };
  return { db, count, handoff, close: () => sqlite.close() };
}

afterEach(() => { vi.useRealTimers(); });

describe('Myna verification write atomicity', () => {
  it('replays the same formal verification without duplicating records', async () => {
    const fake = database('2099-08-19T00:00:00.000Z');
    const input = {
      lineAccountId: 'account-1', handoffId: 'handoff-1', staffId: 'staff-1',
      status: 'E_PRESCRIPTION_RECEIVED' as const, sourceSystem: 'pharmacy-terminal',
      sourceReference: 'same-reference',
    };
    try {
      const first = await recordMynaVerification(fake.db, input);
      const replay = await recordMynaVerification(fake.db, input);
      expect(replay.verification.id).toBe(first.verification.id);
      expect(fake.count('pharmacy_myna_verifications')).toBe(1);
      expect(fake.count('pharmacy_myna_events')).toBe(3);
    } finally {
      fake.close();
    }
  });

  it('rejects a different formal verification after the first result', async () => {
    const fake = database('2099-08-19T00:00:00.000Z');
    try {
      await recordMynaVerification(fake.db, {
        lineAccountId: 'account-1', handoffId: 'handoff-1', staffId: 'staff-1',
        status: 'E_PRESCRIPTION_RECEIVED', sourceSystem: 'pharmacy-terminal',
      });
      await expect(recordMynaVerification(fake.db, {
        lineAccountId: 'account-1', handoffId: 'handoff-1', staffId: 'staff-1',
        status: 'PRESCRIPTION_EXPIRED', sourceSystem: 'pharmacy-terminal',
      })).rejects.toThrow(/conflict/i);
      expect(fake.count('pharmacy_myna_verifications')).toBe(1);
    } finally {
      fake.close();
    }
  });

  it('lets only one of two concurrent verifications take effect', async () => {
    const fake = database('2099-08-19T00:00:00.000Z');
    try {
      const settled = await Promise.allSettled([
        recordMynaVerification(fake.db, {
          lineAccountId: 'account-1', handoffId: 'handoff-1', staffId: 'staff-1',
          status: 'E_PRESCRIPTION_RECEIVED', sourceSystem: 'pharmacy-terminal',
        }),
        recordMynaVerification(fake.db, {
          lineAccountId: 'account-1', handoffId: 'handoff-1', staffId: 'staff-2',
          status: 'SUBMITTED_TO_OTHER_PHARMACY', sourceSystem: 'pharmacy-terminal',
        }),
      ]);

      expect(settled.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(settled.filter((r) => r.status === 'rejected')).toHaveLength(1);
      expect(fake.count('pharmacy_myna_verifications')).toBe(1);
      const winner = settled.find((r) => r.status === 'fulfilled') as
        PromiseFulfilledResult<Awaited<ReturnType<typeof recordMynaVerification>>>;
      expect(fake.handoff().status).toBe(winner.value.handoff.status);
      expect(fake.count('pharmacy_prescription_submissions'))
        .toBe(winner.value.shadowSubmissionId ? 1 : 0);
    } finally {
      fake.close();
    }
  });

  it('writes nothing when the handoff expires between the check and the write', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-19T00:00:00.000Z'));
    const fake = database('2026-08-19T00:00:10.000Z', async () => {
      vi.setSystemTime(new Date('2026-08-19T00:00:20.000Z'));
      await listMynaHandoffs(fake.db, 'account-1');
    });
    try {
      await expect(recordMynaVerification(fake.db, {
        lineAccountId: 'account-1', handoffId: 'handoff-1', staffId: 'staff-1',
        status: 'E_PRESCRIPTION_RECEIVED', sourceSystem: 'pharmacy-terminal',
      })).rejects.toThrow(/conflict/i);

      expect(fake.handoff().status).toBe('EXPIRED');
      expect(fake.count('pharmacy_myna_verifications')).toBe(0);
      expect(fake.count('pharmacy_prescription_submissions')).toBe(0);
      expect(fake.count('pharmacy_prescription_events')).toBe(0);
      expect(fake.count('pharmacy_myna_events')).toBe(0);
    } finally {
      fake.close();
    }
  });
});
