import { afterEach, describe, expect, test, vi } from 'vitest';
import { LineClient } from '../src/client.js';

afterEach(() => vi.unstubAllGlobals());

describe('LineClient error messages', () => {
  test('carry status and upstream message, never the raw body', async () => {
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
