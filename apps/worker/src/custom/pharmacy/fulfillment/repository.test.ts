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
});
