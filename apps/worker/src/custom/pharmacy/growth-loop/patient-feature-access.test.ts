import { describe, expect, it } from 'vitest';
import { listExistingPatientFeatures } from './patient-feature-access.js';

describe('authenticated patient feature access', () => {
  it('returns only fixed feature names from one account-and-owner scoped query', async () => {
    const calls: Array<{ sql: string; values: unknown[] }> = [];
    const db = {
      prepare: (sql: string) => ({ bind: (...values: unknown[]) => ({
        first: async () => {
          calls.push({ sql, values });
          return {
            prescription_intake: 1, electronic_prescription: 0, patient_intake: 1,
            continuity: 0, medication_followup: 1, emergency_contraception: 0,
          };
        },
      }) }),
    } as unknown as D1Database;

    await expect(listExistingPatientFeatures(db, {
      lineAccountId: 'account-a', friendId: 'friend-a',
    })).resolves.toEqual(['prescription_intake', 'patient_intake', 'medication_followup']);

    expect(calls).toHaveLength(1);
    expect(calls[0].values).toEqual([
      'account-a', 'friend-a', 'account-a', 'friend-a', 'account-a', 'friend-a',
      'account-a', 'friend-a', 'account-a', 'friend-a', 'account-a', 'friend-a',
    ]);
    expect(calls[0].sql).not.toMatch(/name|birth|payload|risk|reference/iu);
  });
});
