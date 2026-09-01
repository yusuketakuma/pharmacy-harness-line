import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/liff-auth.js', () => ({
  getIdToken: () => 'id-token',
  getLiffId: () => 'liff-1',
}));

import {
  isUnsupportedPharmacyFeature,
  pharmacyErrorMessage,
  requestPharmacyJson,
  requestPharmacyLiff,
} from './request.js';

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

  it('forwards request options through the JSON helper', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}'));

    await requestPharmacyJson('/api/liff/pharmacy/patients', { method: 'POST' });

    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: 'POST' });
  });

  it('keeps the response status and body on JSON request failures', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
      JSON.stringify({ error: 'Prescription changed' }),
      { status: 409 },
    ));

    await expect(requestPharmacyJson('/api/liff/pharmacy/prescriptions/me'))
      .rejects.toMatchObject({
        message: '内容が更新されています。画面を再読み込みしてください。',
        status: 409,
        body: { error: 'Prescription changed' },
      });
  });

  it('distinguishes previous-Worker feature absence from current binding and auth failures', async () => {
    const errors = [
      {
        error: Object.assign(new Error('old Worker admin gate'), {
          status: 401,
          body: { success: false, error: 'Unauthorized' },
        }),
        unsupported: true,
      },
      {
        error: Object.assign(new Error('route absent'), {
          status: 404,
          routeError: 'route_not_found',
          body: { success: false, error: 'Not found' },
        }),
        unsupported: true,
      },
      {
        error: Object.assign(new Error('current binding missing'), {
          status: 404,
          body: { error: 'Patient account not found' },
        }),
        unsupported: false,
      },
      {
        error: Object.assign(new Error('current token invalid'), {
          status: 401,
          body: { error: 'Unauthorized' },
        }),
        unsupported: false,
      },
    ];

    for (const { error, unsupported } of errors) {
      expect(isUnsupportedPharmacyFeature(error)).toBe(unsupported);
    }
  });

  it('preserves the route-not-found discriminator on JSON request failures', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
      JSON.stringify({ success: false, error: 'Not found' }),
      { status: 404, headers: { 'X-Line-Harness-Error': 'route_not_found' } },
    ));

    await expect(requestPharmacyJson('/api/liff/pharmacy/timeline'))
      .rejects.toMatchObject({
        status: 404,
        routeError: 'route_not_found',
      });
  });

  it('maps 503 (feature unavailable) to a message distinct from server failures', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
      JSON.stringify({ error: 'Myna受付URLが設定されていません' }),
      { status: 503 },
    ));

    await expect(requestPharmacyJson('/api/liff/pharmacy/myna-handoffs'))
      .rejects.toMatchObject({
        message: 'この機能は現在利用できません。薬局にお問い合わせください。',
        status: 503,
      });
  });

  it('shows a safe Japanese message instead of a raw server error', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
      JSON.stringify({ error: 'SQLITE_CONSTRAINT internal detail' }),
      { status: 500 },
    ));

    await expect(requestPharmacyJson('/api/liff/pharmacy/prescriptions/me'))
      .rejects.toMatchObject({
        message: '薬局システムに接続できませんでした。時間をおいて再度お試しください。',
      });
  });

  it('shows only mapped request errors and hides arbitrary runtime details', () => {
    const mapped = Object.assign(new Error('内容が更新されています。画面を再読み込みしてください。'), {
      status: 409,
    });
    expect(pharmacyErrorMessage(mapped, '安全な再試行案内')).toBe(mapped.message);
    expect(pharmacyErrorMessage(new Error('SQLITE_CONSTRAINT internal detail'), '安全な再試行案内'))
      .toBe('安全な再試行案内');
  });
});
