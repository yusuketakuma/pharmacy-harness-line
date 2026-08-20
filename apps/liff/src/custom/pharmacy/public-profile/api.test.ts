import { beforeEach, describe, expect, it, vi } from 'vitest';

const request = vi.hoisted(() => vi.fn());
vi.mock('../request.js', () => ({ requestPharmacyJson: request }));
import { pharmacyPublicProfileApi } from './api.js';

beforeEach(() => vi.clearAllMocks());

describe('pharmacy public profile LIFF API', () => {
  it('uses the shared authenticated pharmacy request boundary', async () => {
    request.mockResolvedValue({ profile: { display_name: 'みどり薬局' } });
    await pharmacyPublicProfileApi.get();
    expect(request).toHaveBeenCalledWith(
      '/api/liff/pharmacy/public-profile',
      '薬局情報を取得できませんでした',
    );
  });
});
