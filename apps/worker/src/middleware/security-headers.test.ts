import { describe, expect, test } from 'vitest';
import { Hono } from 'hono';
import { securityHeadersMiddleware } from './security-headers.js';
import type { Env } from '../index.js';

function app(routeHeaders?: Record<string, string>) {
  const a = new Hono<Env>();
  a.use('*', securityHeadersMiddleware);
  a.get('/x', (c) => {
    for (const [name, value] of Object.entries(routeHeaders ?? {})) c.header(name, value);
    return c.text('ok');
  });
  return a;
}

describe('securityHeadersMiddleware', () => {
  test('sets baseline headers on responses that lack them', async () => {
    const res = await app().fetch(new Request('http://localhost/x'));
    expect(res.headers.get('X-Frame-Options')).toBe('DENY');
    expect(res.headers.get('Content-Security-Policy')).toBe("frame-ancestors 'none'");
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
  });

  test('preserves stricter per-route header values', async () => {
    const res = await app({
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'none'",
    }).fetch(new Request('http://localhost/x'));
    expect(res.headers.get('Referrer-Policy')).toBe('no-referrer');
    expect(res.headers.get('Content-Security-Policy')).toBe("default-src 'none'");
    expect(res.headers.get('X-Frame-Options')).toBe('DENY');
  });
});
