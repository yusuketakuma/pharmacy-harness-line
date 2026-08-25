import { describe, expect, it } from 'vitest';
import { getActivePatientWorkCounts } from './active-work.js';

describe('pharmacy feature active work counts', () => {
  it('returns fixed non-PHI counts from one account-scoped query', async () => {
    const calls: Array<{ sql: string; values: unknown[] }> = [];
    const db = { prepare: (sql: string) => ({ bind: (...values: unknown[]) => ({ first: async () => {
      calls.push({ sql, values });
      return {
        prescription_intake: 2,
        electronic_prescription: 1,
        patient_intake: 5,
        continuity: 3,
        medication_followup: 4,
        emergency_contraception: 1,
        manual_chat: 6,
        pharmacy_info: 1,
      };
    } }) }) } as unknown as D1Database;
    await expect(getActivePatientWorkCounts(
      db, 'account-a', new Date('2026-08-21T00:00:00.000Z'),
    )).resolves.toEqual({
      prescription_intake: 2, electronic_prescription: 1, patient_intake: 5,
      continuity: 3, medication_followup: 4, emergency_contraception: 1,
      manual_chat: 6, pharmacy_info: 1,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].values).toEqual([
      'account-a', 'account-a', 'account-a', 'account-a', 'account-a', 'account-a',
      '2026-08-21T00:00:00.000Z', 'account-a', 'account-a',
    ]);
    expect(calls[0].sql).toContain('expires_at > ?');
    expect(calls[0].sql).toContain('archived_at IS NULL');
    expect(calls[0].sql).toContain("chat.status != 'resolved'");
    expect(calls[0].sql).toContain('pharmacy_public_profiles');
  });
});
