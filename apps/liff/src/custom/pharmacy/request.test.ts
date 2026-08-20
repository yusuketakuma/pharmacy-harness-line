import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/liff-auth.js', () => ({
  getIdToken: () => 'id-token',
  getLiffId: () => 'liff-1',
}));

import { requestPharmacyJson, requestPharmacyLiff } from './request.js';

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

  it('keeps the response status and body on JSON request failures', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
      JSON.stringify({ error: 'Prescription changed' }),
      { status: 409 },
    ));

    await expect(requestPharmacyJson('/api/liff/pharmacy/prescriptions/me', 'Prescription API'))
      .rejects.toMatchObject({
        message: '内容が更新されています。画面を再読み込みしてください。',
        status: 409,
        body: { error: 'Prescription changed' },
      });
  });

  it('shows a safe Japanese message instead of a raw server error', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
      JSON.stringify({ error: 'SQLITE_CONSTRAINT internal detail' }),
      { status: 500 },
    ));

    await expect(requestPharmacyJson('/api/liff/pharmacy/prescriptions/me', 'Prescription API'))
      .rejects.toMatchObject({
        message: '薬局システムに接続できませんでした。時間をおいて再度お試しください。',
      });
  });
});
