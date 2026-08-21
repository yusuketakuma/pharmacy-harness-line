import { afterEach, describe, expect, it, vi } from 'vitest';
import { log } from './log.js';

afterEach(() => vi.restoreAllMocks());

function lastLine(spy: ReturnType<typeof vi.spyOn>): Record<string, unknown> {
  return JSON.parse(String(spy.mock.calls.at(-1)?.[0])) as Record<string, unknown>;
}

describe('structured log helper', () => {
  it('emits one JSON line with ts/level/event and allowlisted fields only', () => {
    const out = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    log('auth.login_failed', {
      realm: 'tenant',
      ip: '203.0.113.1',
      loginId: 'admin',
      password: 'hunter2hunter2',
      line_user_id: 'U0123456789abcdef',
      answers: { q1: 'x' },
    });
    const line = lastLine(out);
    expect(line).toMatchObject({ level: 'info', event: 'auth.login_failed', realm: 'tenant', ip: '203.0.113.1' });
    expect(typeof line.ts).toBe('string');
    for (const key of ['loginId', 'password', 'line_user_id', 'answers']) {
      expect(line).not.toHaveProperty(key);
    }
  });

  it('shortens Error values to name + message and routes warn/error levels', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    log('authz.denied', { status: 403, err: new TypeError('x'.repeat(500)) }, 'warn');
    expect(lastLine(warn).err).toBe(`TypeError: ${'x'.repeat(189)}`);
    log('webhook.signature_invalid', { destination: 'line' }, 'error');
    expect(lastLine(error)).toMatchObject({ level: 'error', destination: 'line' });
  });
});
