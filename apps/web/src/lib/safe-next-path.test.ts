import { describe, expect, it } from 'vitest';
import { safeNextPath } from './safe-next-path';

describe('safeNextPath', () => {
  it('accepts only same-origin relative paths', () => {
    expect(safeNextPath('/prescriptions?submission=abc')).toBe('/prescriptions?submission=abc');
    expect(safeNextPath('/')).toBe('/');
  });

  it('rejects external destinations after URL parser normalization', () => {
    for (const next of ['/\t/evil.example', '/\n/evil.example', '/\r\\evil.example']) {
      const decoded = new URLSearchParams({ next }).get('next')!;
      expect(new URL(decoded, 'https://admin.example').origin).toBe('https://evil.example');
      expect(safeNextPath(decoded)).toBe('/');
    }
  });

  it('rejects control characters even when the hostname matches the parser base', () => {
    expect(safeNextPath('/\t/admin.invalid')).toBe('/');
  });

  it('rejects normalized login destinations without changing valid queries or fragments', () => {
    for (const next of ['/login#section', '/settings/../login', '/login/']) {
      expect(safeNextPath(next)).toBe('/');
    }
    expect(safeNextPath('/prescriptions?next=%2Flogin#details')).toBe('/prescriptions?next=%2Flogin#details');
  });

  it('falls back to / for anything that could leave the origin', () => {
    for (const bad of [
      '//evil.example',
      '/\\evil.example',
      'https://evil.example',
      'prescriptions',
      '',
      null,
      undefined,
      '/login',
      '/login?reason=expired',
    ]) {
      expect(safeNextPath(bad)).toBe('/');
    }
  });
});
