import { describe, expect, it, vi } from 'vitest';
import {
  createFulfillmentQuote,
  getLatestFulfillmentQuote,
  quoteAllowsAcceptance,
} from './repository.js';

function fakeDb(firstRows: unknown[]): {
  db: D1Database;
  calls: Array<{ sql: string; values: unknown[]; operation: string }>;
} {
  const calls: Array<{ sql: string; values: unknown[]; operation: string }> = [];
  const rows = [...firstRows];
  const prepare = vi.fn((sql: string) => ({
    bind: (...values: unknown[]) => ({
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
  return { db: { prepare } as unknown as D1Database, calls };
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
