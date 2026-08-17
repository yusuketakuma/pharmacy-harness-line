import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/liff-auth.js', () => ({
  getIdToken: () => 'id-token',
  getLiffId: () => 'liff-1',
}));

import { requestPharmacyLiff } from './request.js';

afterEach(() => vi.restoreAllMocks());

describe('requestPharmacyLiff', () => {
  it('adds the LIFF context and LINE identity to custom requests', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}'));

    await requestPharmacyLiff('/api/liff/pharmacy/patients', {
      headers: { 'Content-Type': 'application/json' },
    });

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain('/api/liff/pharmacy/patients?liffId=liff-1');
    expect(init).toMatchObject({
      headers: {
        Authorization: 'Bearer id-token',
        'Content-Type': 'application/json',
      },
    });
  });
});
