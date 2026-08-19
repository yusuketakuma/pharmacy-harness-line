import { describe, expect, it } from 'vitest';
import { startupErrorMessage } from './startup-error.js';

describe('startupErrorMessage', () => {
  it('keeps attacker-controlled error text as plain text', () => {
    const value = '<img src=x onerror=alert(1)>';
    expect(startupErrorMessage(new Error(value))).toBe(value);
  });

  it('handles non-Error startup failures', () => {
    expect(startupErrorMessage('LIFF failed')).toBe('LIFF failed');
  });
});
