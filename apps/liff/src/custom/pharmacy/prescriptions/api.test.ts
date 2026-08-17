import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../lib/liff-auth.js', () => ({
  getIdToken: () => 'id-token',
  getLiffId: () => 'liff-1',
}));

import { prescriptionApi } from './api.js';

afterEach(() => vi.restoreAllMocks());

describe('prescriptionApi', () => {
  it('uploads the original image body with LINE auth and LIFF account context', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ file: { id: 'file-1', state: 'ready' } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    const image = new Blob([new Uint8Array([0x89, 0x50])], { type: 'image/png' });

    await prescriptionApi.upload('submission-1', 2, image);

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain(
      '/api/liff/pharmacy/prescriptions/submission-1/files/2?liffId=liff-1',
    );
    expect(init).toMatchObject({
      method: 'PUT',
      body: image,
      headers: { Authorization: 'Bearer id-token', 'Content-Type': 'image/png' },
    });
    expect((init?.headers as Record<string, string>)['X-Line-Harness-Source']).toBeUndefined();
  });

  it('surfaces the status and safe API body on failure', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: 'Prescription changed' }), {
        status: 409,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    await expect(prescriptionApi.history()).rejects.toMatchObject({
      status: 409,
      body: { error: 'Prescription changed' },
    });
  });
});
