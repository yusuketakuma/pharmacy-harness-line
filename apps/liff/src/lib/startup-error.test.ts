import { describe, expect, it, vi } from 'vitest';
import { STARTUP_ERROR_MESSAGE, startupErrorMessage } from './startup-error.js';

describe('startupErrorMessage', () => {
  it('shows only a fixed patient-facing message and keeps the raw error out of the screen', () => {
    const value = '<img src=x onerror=alert(1)>';
    expect(startupErrorMessage(new Error(value))).toBe(STARTUP_ERROR_MESSAGE);
    expect(startupErrorMessage('LIFF failed')).toBe(STARTUP_ERROR_MESSAGE);
    expect(STARTUP_ERROR_MESSAGE).toContain('LINEのトーク画面からもう一度開いてください');
  });

  it('logs the original error to the console for debugging', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const err = new Error('boom');
    startupErrorMessage(err);
    expect(spy).toHaveBeenCalledWith('liff startup failed', err);
    spy.mockRestore();
  });
});
