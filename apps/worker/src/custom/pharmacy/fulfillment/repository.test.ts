import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { URL } from 'node:url';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import {
  createFulfillmentQuote,
  getLatestFulfillmentQuote,
  quoteAllowsAcceptance,
} from './repository.js';

function sqliteDb() {
  const sqlite = new DatabaseSync(':memory:');
  const baseline = readFileSync(new URL('../../../../../../packages/db/migrations/001_v033_baseline.sql', import.meta.url), 'utf8');
  // Only the surrounding identities are reduced; quote/event schemas are the shipped contract.
  sqlite.exec(`CREATE TABLE pharmacy_prescription_submissions (id TEXT, line_account_id TEXT, status TEXT, source_handoff_id TEXT, UNIQUE(id, line_account_id));
    CREATE TABLE pharmacy_myna_handoffs (id TEXT, line_account_id TEXT, correlation_id TEXT, UNIQUE(id, line_account_id));
    INSERT INTO pharmacy_prescription_submissions VALUES ('submission-1', 'account-1', 'received', 'handoff-1');
    INSERT INTO pharmacy_myna_handoffs VALUES ('handoff-1', 'account-1', 'synthetic-correlation');`);
  for (const table of ['pharmacy_fulfillment_quotes', 'pharmacy_myna_events']) {
    sqlite.exec(baseline.match(new RegExp(`CREATE TABLE ${table} \\([\\s\\S]*?\\n\\);`))![0]);
  }
  let afterRead: (() => void) | undefined;
  const prepare = (sql: string) => ({ bind: (...values: SQLInputValue[]) => ({
    sql, values,
    first: async () => {
      const row = sqlite.prepare(sql).get(...values) ?? null;
      if (sql.startsWith('SELECT s.id')) afterRead?.();
      return row;
    },
    run: async () => ({ success: true, meta: { changes: Number(sqlite.prepare(sql).run(...values).changes) } }),
  }) });
  const db = { prepare, batch: async (statements: Array<{ sql: string; values: SQLInputValue[] }>) => {
    sqlite.exec('BEGIN');
    try {
      const results = statements.map(({ sql, values }) => ({ success: true, results: sqlite.prepare(sql).all(...values) }));
      sqlite.exec('COMMIT');
      return results;
    } catch (error) { sqlite.exec('ROLLBACK'); throw error; }
  } } as unknown as D1Database;
  return { sqlite, db, afterRead: (action: () => void) => { afterRead = action; } };
}

describe('FulfillmentQuote SQL concurrency and atomicity', () => {
  const input = { decision: 'fulfillable' as const, reasonCodes: [], requirements: [], estimatedReadyAt: null, validUntil: null };

  it('rejects a stale revision without appending a quote or event and preserves legacy writes', async () => {
    const { db, sqlite } = sqliteDb();
    try {
      const first = await createFulfillmentQuote(db, 'account-1', 'submission-1', 'staff-1', { ...input, expectedRevision: 0 });
      expect(first.revision).toBe(1);
      await expect(createFulfillmentQuote(db, 'account-1', 'submission-1', 'staff-1', { ...input, expectedRevision: 0 })).rejects.toThrow('conflict');
      expect(sqlite.prepare('SELECT COUNT(*) AS count FROM pharmacy_myna_events').get()?.count).toBe(1);
      expect((await createFulfillmentQuote(db, 'account-1', 'submission-1', 'staff-1', input)).revision).toBe(2);
      await expect(createFulfillmentQuote(db, 'account-b', 'submission-1', 'staff-1', input)).rejects.toThrow('not found');
    } finally { sqlite.close(); }
  });

  it('rechecks submission status in the write, not just the preflight read', async () => {
    const { db, sqlite, afterRead } = sqliteDb();
    try {
      afterRead(() => sqlite.exec("UPDATE pharmacy_prescription_submissions SET status = 'cancelled'"));
      await expect(createFulfillmentQuote(db, 'account-1', 'submission-1', 'staff-1', input)).rejects.toThrow('conflict');
      expect(sqlite.prepare('SELECT COUNT(*) AS count FROM pharmacy_fulfillment_quotes').get()?.count).toBe(0);
      expect(sqlite.prepare('SELECT COUNT(*) AS count FROM pharmacy_myna_events').get()?.count).toBe(0);
    } finally { sqlite.close(); }
  });

  it('rolls back the quote when recording its linked event fails', async () => {
    const { db, sqlite } = sqliteDb();
    try {
      sqlite.exec("CREATE TRIGGER fail_event BEFORE INSERT ON pharmacy_myna_events BEGIN SELECT RAISE(ABORT, 'synthetic event failure'); END");
      await expect(createFulfillmentQuote(db, 'account-1', 'submission-1', 'staff-1', input)).rejects.toThrow('synthetic event failure');
      expect(sqlite.prepare('SELECT COUNT(*) AS count FROM pharmacy_fulfillment_quotes').get()?.count).toBe(0);
    } finally { sqlite.close(); }
  });
});

function fakeDb(firstRows: unknown[]): {
  db: D1Database;
  calls: Array<{ sql: string; values: unknown[]; operation: string }>;
} {
  const calls: Array<{ sql: string; values: unknown[]; operation: string }> = [];
  const rows = [...firstRows];
  const prepare = vi.fn((sql: string) => ({
    bind: (...values: unknown[]) => ({
      sql, values,
      first: async () => {
        calls.push({ sql, values, operation: 'first' });
        return rows.shift() ?? null;
      },
      run: async () => {
        calls.push({ sql, values, operation: 'run' });
        return { success: true, meta: { changes: 1 } };
      },
    }),
  }));
  const batch = async (statements: Array<{ sql: string; values: unknown[] }>) => statements.map(({ sql, values }, index) => {
    calls.push({ sql, values, operation: 'batch' });
    return { success: true, results: index === 0 ? [rows.shift()].filter(Boolean) : [] };
  });
  return { db: { prepare, batch } as unknown as D1Database, calls };
}

describe('FulfillmentQuote repository', () => {
  it('creates an immutable, account-scoped quote revision', async () => {
    const { db, calls } = fakeDb([
      { id: 'submission-1', status: 'received' },
      {
        id: 'quote-1', submission_id: 'submission-1', line_account_id: 'account-1',
        revision: 1, decision: 'conditional', reason_codes_json: '["original_required"]',
        requirements_json: '[{"code":"original_required","status":"pending"}]',
        estimated_ready_at: null, valid_until: null, created_by: 'staff-1', created_at: '2026-08-17T08:00:00Z',
      },
    ]);
    await expect(createFulfillmentQuote(db, 'account-1', 'submission-1', 'staff-1', {
      decision: 'conditional',
      reasonCodes: ['original_required'],
      requirements: [{ code: 'original_required', status: 'pending' }],
      estimatedReadyAt: '2026-08-17T10:00:00.000Z',
      validUntil: '2026-08-17T09:00:00.000Z',
    })).resolves.toMatchObject({ id: 'quote-1', revision: 1 });
    expect(calls[0].sql).toContain('line_account_id = ?');
    expect(calls[1].sql).toContain('INSERT INTO pharmacy_fulfillment_quotes');
    expect(calls[1].sql).toContain('RETURNING');
  });

  it('rejects free-form or unsupported quote input before D1 writes', async () => {
    const { db, calls } = fakeDb([{ id: 'submission-1', status: 'received' }]);
    await expect(createFulfillmentQuote(db, 'account-1', 'submission-1', 'staff-1', {
      decision: 'conditional',
      reasonCodes: ['患者名を含む自由記述'],
      requirements: [],
      estimatedReadyAt: null,
      validUntil: null,
    })).rejects.toThrow('invalid fulfillment quote');
    expect(calls).toHaveLength(1);
  });

  it('allows acceptance only for fulfillable or fully satisfied conditional quotes', () => {
    expect(quoteAllowsAcceptance({ decision: 'fulfillable', requirements: [] })).toBe(true);
    expect(quoteAllowsAcceptance({ decision: 'conditional', requirements: [
      { code: 'original_required', status: 'satisfied' },
    ] })).toBe(true);
    expect(quoteAllowsAcceptance({ decision: 'conditional', requirements: [
      { code: 'original_required', status: 'pending' },
    ] })).toBe(false);
    expect(quoteAllowsAcceptance({ decision: 'needs_confirmation', requirements: [] })).toBe(false);
  });

  it('does not accept a quote whose availability status is not actionable', () => {
    const quote = {
      decision: 'fulfillable' as const,
      requirements: [],
      status: 'UNAVAILABLE' as const,
    };
    expect(quoteAllowsAcceptance(quote)).toBe(false);
    expect(quoteAllowsAcceptance({ ...quote, status: 'AVAILABLE' })).toBe(true);
  });

  it('does not accept an expired FulfillmentQuote', () => {
    expect(quoteAllowsAcceptance({
      decision: 'fulfillable', requirements: [], status: 'AVAILABLE',
      validUntil: '2026-08-17T09:59:59.000Z',
    }, new Date('2026-08-17T10:00:00.000Z'))).toBe(false);
    expect(quoteAllowsAcceptance({
      decision: 'fulfillable', requirements: [], status: 'AVAILABLE',
      validUntil: '2026-08-17T10:00:01.000Z',
    }, new Date('2026-08-17T10:00:00.000Z'))).toBe(true);
  });

  it('loads the newest quote inside the requested account', async () => {
    const quote = {
      id: 'quote-2', submission_id: 'submission-1', line_account_id: 'account-1',
      revision: 2, decision: 'fulfillable', reason_codes_json: '[]', requirements_json: '[]',
      estimated_ready_at: null, valid_until: null, created_by: 'staff-1', created_at: '2026-08-17T08:00:00Z',
    };
    const { db, calls } = fakeDb([quote]);
    await expect(getLatestFulfillmentQuote(db, 'account-1', 'submission-1')).resolves.toMatchObject({
      id: 'quote-2', revision: 2, decision: 'fulfillable', reasonCodes: [], requirements: [],
    });
    expect(calls[0].sql).toContain('line_account_id = ? AND submission_id = ?');
    expect(calls[0].values).toEqual(['account-1', 'submission-1']);
  });

  it('keeps FulfillmentQuote as one compatibility contract while projecting fulfillment fields', async () => {
    const { db, calls } = fakeDb([
      { id: 'submission-1', status: 'received' },
      {
        id: 'quote-3', submission_id: 'submission-1', line_account_id: 'account-1',
        revision: 3, decision: 'fulfillable', reason_codes_json: '[]', requirements_json: '[]',
        status: 'AVAILABLE', fulfillment_method: 'PICKUP', constraints_json: '["stock_check"]',
        reservation_expires_at: '2026-08-17T12:00:00Z', confirmed_by: 'staff-1',
        confirmed_at: '2026-08-17T10:00:00Z', estimated_ready_at: '2026-08-17T11:00:00Z',
        valid_until: '2026-08-17T12:00:00Z', created_by: 'staff-1', created_at: '2026-08-17T10:00:00Z',
      },
    ]);
    await expect(createFulfillmentQuote(db, 'account-1', 'submission-1', 'staff-1', {
      decision: 'fulfillable', reasonCodes: [], requirements: [],
      estimatedReadyAt: '2026-08-17T11:00:00Z', validUntil: '2026-08-17T12:00:00Z',
      status: 'AVAILABLE', fulfillmentMethod: 'PICKUP', constraints: ['stock_check'],
      reservationExpiresAt: '2026-08-17T12:00:00Z',
    })).resolves.toMatchObject({
      status: 'AVAILABLE', fulfillmentMethod: 'PICKUP', constraints: ['stock_check'],
      confirmedBy: 'staff-1',
    });
    expect(calls[1].sql).toContain('constraints_json');
    expect(calls[1].sql).toContain('confirmed_by');
  });

  it('records the quote-issued event for a Myna-linked submission', async () => {
    const { db, calls } = fakeDb([
      {
        id: 'submission-1', status: 'received', source_handoff_id: 'handoff-1',
        correlation_id: 'corr-1234',
      },
      {
        id: 'quote-4', submission_id: 'submission-1', line_account_id: 'account-1',
        revision: 1, decision: 'fulfillable', reason_codes_json: '[]', requirements_json: '[]',
        status: 'AVAILABLE', fulfillment_method: 'PICKUP', constraints_json: '[]',
        reservation_expires_at: null, confirmed_by: 'staff-1', confirmed_at: '2026-08-17T10:00:00Z',
        estimated_ready_at: null, valid_until: null, created_by: 'staff-1', created_at: '2026-08-17T10:00:00Z',
      },
    ]);
    await createFulfillmentQuote(db, 'account-1', 'submission-1', 'staff-1', {
      decision: 'fulfillable', reasonCodes: [], requirements: [], estimatedReadyAt: null, validUntil: null,
      status: 'AVAILABLE', fulfillmentMethod: 'PICKUP', constraints: [],
    });
    expect(calls.some((call) => call.sql.includes('FULFILLMENT_QUOTE_ISSUED'))).toBe(true);
  });
});
