import { afterEach, describe, test, expect, vi } from 'vitest';
import { fetchAndStoreIncomingImage } from './incoming-image.js';

function makeR2Stub() {
  const store = new Map<string, { data: ArrayBuffer; contentType: string }>();
  return {
    put: vi.fn(async (key: string, data: ArrayBuffer, opts: { httpMetadata?: { contentType?: string } }) => {
      store.set(key, { data, contentType: opts.httpMetadata?.contentType ?? '' });
      return null;
    }),
    _store: store,
  };
}

describe('fetchAndStoreIncomingImage', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('Content API 成功時に R2 PUT して URL を返す', async () => {
    const r2 = makeR2Stub();
    const signal = new AbortController().signal;
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(signal);
    const fetchMock = vi.fn(async () =>
      new Response(new ArrayBuffer(100), {
        status: 200,
        headers: { 'Content-Type': 'image/jpeg' },
      }),
    );

    const result = await fetchAndStoreIncomingImage({
      r2: r2 as unknown as R2Bucket,
      fetch: fetchMock,
      workerUrl: 'https://worker.example.com',
      channelAccessToken: 'token-abc',
      tenantId: 'tenant-a',
      accountId: 'acc-1',
      messageId: 'msg-xyz',
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api-data.line.me/v2/bot/message/msg-xyz/content',
      expect.objectContaining({
        headers: { Authorization: 'Bearer token-abc' },
        signal,
      }),
    );
    expect(timeout).toHaveBeenCalledWith(10_000);
    expect(r2.put).toHaveBeenCalled();
    const [key, , opts] = r2.put.mock.calls[0];
    expect(key).toBe('tenants/tenant-a/accounts/acc-1/incoming/msg-xyz.jpg');
    expect(opts.httpMetadata?.contentType).toBe('image/jpeg');
    expect(result?.originalContentUrl).toBe(
      'https://worker.example.com/api/images/tenants/tenant-a/accounts/acc-1/incoming/msg-xyz.jpg',
    );
    expect(result?.previewImageUrl).toBe(result?.originalContentUrl);
  });

  test('Content API が非 200 を返したら null', async () => {
    const r2 = makeR2Stub();
    const fetchMock = vi.fn(async () => new Response(null, { status: 401 }));

    const result = await fetchAndStoreIncomingImage({
      r2: r2 as unknown as R2Bucket,
      fetch: fetchMock,
      workerUrl: 'https://worker.example.com',
      channelAccessToken: 'token-bad',
      tenantId: 'tenant-a',
      accountId: 'acc-1',
      messageId: 'msg-y',
    });

    expect(result).toBeNull();
    expect(r2.put).not.toHaveBeenCalled();
  });

  test('R2 PUT が throw したら null', async () => {
    const r2 = makeR2Stub();
    r2.put.mockRejectedValueOnce(new Error('R2 down'));
    const fetchMock = vi.fn(async () =>
      new Response(new ArrayBuffer(50), {
        status: 200,
        headers: { 'Content-Type': 'image/png' },
      }),
    );

    const result = await fetchAndStoreIncomingImage({
      r2: r2 as unknown as R2Bucket,
      fetch: fetchMock,
      workerUrl: 'https://worker.example.com',
      channelAccessToken: 'token-abc',
      tenantId: 'tenant-a',
      accountId: 'acc-1',
      messageId: 'msg-z',
    });

    expect(result).toBeNull();
  });

  test('Content-Length がなくても 10 MiB を超える画像は保存しない', async () => {
    const r2 = makeR2Stub();
    const fetchMock = vi.fn(async () =>
      new Response(new Uint8Array(10 * 1024 * 1024 + 1), {
        status: 200,
        headers: { 'Content-Type': 'image/jpeg' },
      }),
    );

    const result = await fetchAndStoreIncomingImage({
      r2: r2 as unknown as R2Bucket,
      fetch: fetchMock,
      workerUrl: 'https://worker.example.com',
      channelAccessToken: 'token-abc',
      tenantId: 'tenant-a',
      accountId: 'acc-1',
      messageId: 'msg-large',
    });

    expect(result).toBeNull();
    expect(r2.put).not.toHaveBeenCalled();
  });

  test('upstream error detail をログへ出さない', async () => {
    const r2 = makeR2Stub();
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const fetchMock = vi.fn(async () => {
      throw new Error('sensitive-upstream-detail');
    });

    const result = await fetchAndStoreIncomingImage({
      r2: r2 as unknown as R2Bucket,
      fetch: fetchMock,
      workerUrl: 'https://worker.example.com',
      channelAccessToken: 'token-abc',
      tenantId: 'tenant-a',
      accountId: 'acc-1',
      messageId: 'msg-error',
    });

    expect(result).toBeNull();
    expect(error.mock.calls.flat().map(String).join(' ')).not.toContain('sensitive-upstream-detail');
  });

  test('Content-Type から拡張子を判定 (png)', async () => {
    const r2 = makeR2Stub();
    const fetchMock = vi.fn(async () =>
      new Response(new ArrayBuffer(50), {
        status: 200,
        headers: { 'Content-Type': 'image/png' },
      }),
    );

    await fetchAndStoreIncomingImage({
      r2: r2 as unknown as R2Bucket,
      fetch: fetchMock,
      workerUrl: 'https://worker.example.com',
      channelAccessToken: 'token-abc',
      tenantId: 'tenant-a',
      accountId: 'a',
      messageId: 'm-png',
    });

    const [key] = r2.put.mock.calls[0];
    expect(key).toBe('tenants/tenant-a/accounts/a/incoming/m-png.png');
  });
});
