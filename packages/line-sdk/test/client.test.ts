import { afterEach, describe, expect, test, vi } from 'vitest';
import { LineClient } from '../src/client.js';

afterEach(() => vi.unstubAllGlobals());

describe('LineClient error messages', () => {
  test.each(['message', 'error'])('does not expose upstream %s through any error entry point', async (field) => {
    const sentinel = 'synthetic-patient-private-details';
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ [field]: sentinel }), {
      status: 400, statusText: 'Bad Request',
    })));
    const client = new LineClient('synthetic-token');
    for (const operation of [
      () => client.request('POST', '/v2/bot/message/push', {}),
      () => client.getDefaultRichMenuId(),
      () => client.uploadRichMenuImage('menu', new ArrayBuffer(0)),
    ]) {
      const error = await operation().catch((error: Error) => error);
      expect(error).toBeInstanceOf(Error);
      expect(String(error)).not.toContain(sentinel);
      expect((error as Error).message).toBe('LINE API error: 400 Bad Request');
    }
  });

  test('preserves successful JSON, accepted retries, and missing default menus', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ displayName: 'synthetic-name' }))
      .mockResolvedValueOnce(new Response(null, { status: 409 }))
      .mockResolvedValueOnce(new Response(null, { status: 404 }));
    vi.stubGlobal('fetch', fetchMock);
    const client = new LineClient('synthetic-token');
    await expect(client.getProfile('synthetic-user')).resolves.toEqual({ displayName: 'synthetic-name' });
    await expect(client.pushMessage('synthetic-user', [{ type: 'text', text: 'test' }], 'retry-key'))
      .resolves.toEqual({ retryAccepted: true });
    await expect(client.getDefaultRichMenuId()).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  test('preserves the fixed invalid-token classification without upstream body details', async () => {
    const body = JSON.stringify({ message: 'Invalid reply token', details: [{ userId: 'Uaaa', secret: 'x' }] });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status: 400, statusText: 'Bad Request' })));
    const client = new LineClient('token');
    await expect(client.request('POST', '/v2/bot/message/push', {})).rejects.toThrow(
      'LINE API error: 400 Bad Request — Invalid reply token',
    );
    await expect(client.request('POST', '/v2/bot/message/push', {})).rejects.not.toThrow('Uaaa');
  });

  test('omit the body when it is not JSON', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>oops Uaaa</html>', { status: 502, statusText: 'Bad Gateway' })));
    const err = await new LineClient('token').request('GET', '/v2/bot/profile/U1').catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe('LINE API error: 502 Bad Gateway');
  });
});
