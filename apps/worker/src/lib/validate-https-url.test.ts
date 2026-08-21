import { describe, expect, test } from 'vitest';
import { validateHttpsUrl } from './validate-https-url.js';

describe('validateHttpsUrl', () => {
  test('accepts public https URL', () => {
    expect(validateHttpsUrl('https://hooks.example.com/x?y={z}')).toBeNull();
  });
  test.each([
    'http://example.com/',
    'https://127.0.0.1/',
    'https://10.0.0.1/',
    'https://[::1]/',
    'https://localhost/',
    'https://foo.localhost/',
    'https://metadata.internal/',
    'https://intranet/',
    'https://user:pw@example.com/',
    'not a url',
    '',
  ])('rejects %s', (u) => {
    expect(validateHttpsUrl(u)).not.toBeNull();
  });
});
