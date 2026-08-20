import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getPharmacyPublicProfile,
  savePharmacyPublicProfile,
} from './repository.js';

const run = vi.fn().mockResolvedValue({ meta: { changes: 1 } });
const first = vi.fn();
const db = {
  prepare: vi.fn((sql: string) => ({
    bind: (...values: unknown[]) => ({ run: () => run(sql, values), first: () => first(sql, values) }),
  })),
} as unknown as D1Database;

const input = {
  lineAccountId: 'account-a',
  staffId: 'staff-a',
  displayName: 'みどり薬局',
  phone: '03-1234-5678',
  postalCode: '100-0001',
  address: '東京都千代田区千代田1-1',
  businessHours: '月〜金 9:00〜18:00\n土 9:00〜13:00',
  closureNotice: '日曜・祝日は休業です',
  accessNote: '駅東口から徒歩3分',
  parkingNote: '店舗前に2台分あります',
  googleMapsUrl: 'https://www.google.com/maps/search/?api=1&query=test',
};

beforeEach(() => vi.clearAllMocks());

describe('pharmacy public profile repository', () => {
  it('reads one profile only by account scope', async () => {
    first.mockResolvedValue({ line_account_id: 'account-a' });
    await getPharmacyPublicProfile(db, 'account-a');
    expect(first).toHaveBeenCalledWith(expect.stringContaining('WHERE account.id = ?'), ['account-a']);
  });

  it('writes normalized public fields under the authorized account and staff', async () => {
    await savePharmacyPublicProfile(db, input);
    expect(run).toHaveBeenCalledWith(expect.stringContaining('pharmacy_public_profiles'), expect.arrayContaining([
      'account-a', 'みどり薬局', '03-1234-5678', 'staff-a',
    ]));
  });

  it.each([
    ['javascript:alert(1)', 'invalid pharmacy public profile'],
    ['https://evil.example/maps', 'invalid pharmacy public profile'],
  ])('rejects a non-Google maps URL: %s', async (googleMapsUrl, message) => {
    await expect(savePharmacyPublicProfile(db, { ...input, googleMapsUrl }))
      .rejects.toThrow(message);
    expect(run).not.toHaveBeenCalled();
  });

  it('rejects unbounded text and unsafe telephone characters before D1', async () => {
    await expect(savePharmacyPublicProfile(db, { ...input, businessHours: 'x'.repeat(2001) }))
      .rejects.toThrow('invalid pharmacy public profile');
    await expect(savePharmacyPublicProfile(db, { ...input, phone: '03-1234<script>' }))
      .rejects.toThrow('invalid pharmacy public profile');
    await expect(savePharmacyPublicProfile(db, { ...input, phone: '(03)1234-5678' }))
      .rejects.toThrow('invalid pharmacy public profile');
    expect(run).not.toHaveBeenCalled();
  });
});
