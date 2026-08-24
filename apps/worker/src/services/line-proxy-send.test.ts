import { describe, expect, test, vi } from 'vitest';
import {
  LineHarnessUnknownOutcomeError,
  pushViaHarnessProxy,
  replyViaHarnessProxy,
} from './line-proxy-send.js';

describe('pushViaHarnessProxy', () => {
  test('bounds a hung push and reports the result as unknown', async () => {
    const controller = new AbortController();
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
    const dispatch = vi.fn(() => new Promise<Response>(() => undefined));

    try {
      const pending = pushViaHarnessProxy(
        'https://worker.example.com',
        'channel-token',
        'U00000000000000000000000000000000',
        [{ type: 'text', text: 'test' }],
        'retry-key',
        dispatch,
      );
      const rejection = expect(pending).rejects.toBeInstanceOf(LineHarnessUnknownOutcomeError);

      controller.abort();

      await rejection;
      expect(timeout).toHaveBeenCalledWith(10_000);
    } finally {
      timeout.mockRestore();
    }
  });

  test('treats a proxy 5xx as unknown without exposing its response body', async () => {
    const failure = await pushViaHarnessProxy(
      'https://worker.example.com',
      'channel-token',
      'U00000000000000000000000000000000',
      [{ type: 'text', text: 'test' }],
      'retry-key',
      vi.fn().mockResolvedValue(
        new Response('private upstream detail', { status: 502, statusText: 'Bad Gateway' }),
      ),
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(LineHarnessUnknownOutcomeError);
    expect(String(failure)).not.toContain('private upstream detail');
  });
});

describe('replyViaHarnessProxy', () => {
  test('sends reply messages through the Harness proxy endpoint', async () => {
    let captured: Request | null = null;
    const dispatch = vi.fn(async (request: Request) => {
      captured = request;
      return new Response('{}', { status: 200 });
    });

    await replyViaHarnessProxy(
      'https://worker.example.com/',
      'channel-token',
      'reply-token',
      [{ type: 'text', text: 'マイルはこちらです' }],
      dispatch,
    );

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(captured).not.toBeNull();
    expect(captured!.url).toBe('https://worker.example.com/line-api/v2/bot/message/reply');
    expect(captured!.headers.get('Authorization')).toBe('Bearer channel-token');
    await expect(captured!.json()).resolves.toEqual({
      replyToken: 'reply-token',
      messages: [{ type: 'text', text: 'マイルはこちらです' }],
    });
  });

  test('surfaces proxy failures without retrying a one-time reply token', async () => {
    const dispatch = vi.fn().mockResolvedValue(
      new Response('{"message":"invalid reply token"}', { status: 400, statusText: 'Bad Request' }),
    );

    const failure = await replyViaHarnessProxy(
      'https://worker.example.com',
      'channel-token',
      'used-token',
      [{ type: 'text', text: 'test' }],
      dispatch,
    ).catch((error: unknown) => error);

    expect(String(failure)).toContain('LINE Harness proxy error: 400 Bad Request');
    expect(String(failure)).not.toContain('invalid reply token');
    expect(dispatch).toHaveBeenCalledTimes(1);
  });
});
