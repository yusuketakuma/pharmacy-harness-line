import { describe, expect, it } from 'vitest';
import {
  requestId,
  required,
  safeText,
  temporaryPassword,
  workerOrigin,
} from './cli-common.js';

describe('pharmacy CLI common input handling', () => {
  it('keeps shared argument and secret-output contracts consistent', () => {
    expect(required({ tenant: ' tenant-a ' }, 'tenant')).toBe('tenant-a');
    expect(() => required({}, 'tenant')).toThrow('--tenant is required');
    expect(requestId({ 'idempotency-key': 'retry-key-0001' })).toBe('retry-key-0001');
    expect(() => requestId({ 'idempotency-key': 'short' })).toThrow('8 to 128 ASCII');

    const firstPassword = temporaryPassword();
    const secondPassword = temporaryPassword();
    expect(firstPassword).toMatch(/^Tmp-[A-Za-z0-9_-]{32}$/u);
    expect(secondPassword).not.toBe(firstPassword);

    expect(workerOrigin('https://worker.example.test/path')).toBe('https://worker.example.test');
    expect(workerOrigin('http://localhost:8787')).toBe('http://localhost:8787');
    expect(() => workerOrigin('http://worker.example.test')).toThrow('HTTPS origin');
    expect(() => workerOrigin('https://user:pass@worker.example.test')).toThrow('HTTPS origin');
    expect(safeText('bad\u0000message', 'fallback')).toBe('bad message');
    expect(safeText(null, 'fallback')).toBe('fallback');
  });
});
