import { describe, expect, it } from 'vitest';
import { assessPatientRetention, assessRetention } from './legal-hold.js';

describe('retention assessment', () => {
  it('blocks deletion when the latest PHI source is unknown', () => {
    expect(assessRetention(null, new Date('2026-08-20T00:00:00.000Z'))).toEqual({
      status: 'unknown',
      releaseAt: null,
    });
  });

  it('uses the three-valued result for valid held and released timestamps', () => {
    expect(assessRetention('2026-08-20T00:00:00.000Z', new Date('2026-08-20T00:00:00.000Z')))
      .toEqual({ status: 'held', releaseAt: '2029-08-20T00:00:00.000Z' });
    expect(assessRetention('2020-08-20T00:00:00.000Z', new Date('2026-08-20T00:00:00.000Z')))
      .toEqual({ status: 'released', releaseAt: '2023-08-20T00:00:00.000Z' });
  });

  it('blocks malformed and invalid clock values as unknown', () => {
    expect(assessRetention('2026-08-20', new Date('2026-08-20T00:00:00.000Z')).status)
      .toBe('unknown');
    expect(assessRetention('not-a-timestamp', new Date('invalid')).status).toBe('unknown');
  });

  it('maps a source query failure to unknown', async () => {
    const failingDb = {
      prepare: () => ({ bind: () => ({ first: async () => { throw new Error('source unavailable'); } }) }),
    } as unknown as D1Database;
    await expect(assessPatientRetention(failingDb, {
      tenantId: 'tenant-a', lineAccountId: 'account-a', ownerFriendId: 'friend-a', patientId: 'patient-a',
    }, new Date('2026-08-20T00:00:00.000Z'))).resolves.toEqual({ status: 'unknown', releaseAt: null });
  });

  it('treats one invalid source timestamp as unknown even beside a valid source', async () => {
    const db = {
      prepare: () => ({
        bind: () => ({
          first: async () => ({ count: 1 }),
          all: async () => ({
            results: [
              { recorded_at: '2020-01-01T00:00:00.000Z' },
              { recorded_at: 'invalid-source-date' },
            ],
          }),
        }),
      }),
    } as unknown as D1Database;
    await expect(assessPatientRetention(db, {
      tenantId: 'tenant-a', lineAccountId: 'account-a',
      ownerFriendId: 'friend-a', patientId: 'patient-a',
    }, new Date('2026-08-20T00:00:00.000Z'))).resolves.toEqual({
      status: 'unknown', releaseAt: null,
    });
  });
});
