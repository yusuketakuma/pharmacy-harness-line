import { describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock('./sender.js', () => ({ sendPharmacyAutomatedPush: mocks.send }));
import { processDuePrescriptionValidityReminders } from './validity.js';

function fakeDb() {
  const calls: string[] = [];
  const db = {
    prepare: (sql: string) => ({
      bind: (..._values: unknown[]) => ({
        all: async () => ({ results: [{ submission_id: 'submission-1', line_account_id: 'account-a', friend_id: 'friend-a', valid_until: '2026-08-21', line_user_id: 'U-a', channel_access_token: 'token' }] }),
        run: async () => { calls.push(sql); return { meta: { changes: 1 } }; },
      }),
    }),
  } as unknown as D1Database;
  return { db, calls };
}

describe('prescription validity reminders', () => {
  it('claims, sends, and marks a verified validity once', async () => {
    const { db, calls } = fakeDb();
    mocks.send.mockResolvedValue(undefined);
    const result = await processDuePrescriptionValidityReminders(db, {
      proxyBaseUrl: 'https://worker.example',
      now: new Date('2026-08-20T00:00:00.000Z'),
    });
    expect(result.sent).toBe(1);
    expect(calls.filter((sql) => sql.startsWith('UPDATE pharmacy_prescription_validities')).length).toBe(2);
  });
});
