import { describe, expect, test, vi } from 'vitest';
import { resolveActiveLineAccountIdByLiffId } from './liff-account.js';

function database(result: { id: string } | null) {
  const first = vi.fn().mockResolvedValue(result);
  const bind = vi.fn(() => ({ first }));
  const prepare = vi.fn(() => ({ bind }));
  return { db: { prepare } as unknown as D1Database, prepare, bind };
}

describe('resolveActiveLineAccountIdByLiffId', () => {
  test('does not query without a LIFF id', async () => {
    const { db, prepare } = database({ id: 'account-1' });
    await expect(resolveActiveLineAccountIdByLiffId(db, undefined)).resolves.toBeNull();
    expect(prepare).not.toHaveBeenCalled();
  });

  test('returns only the active account selected by LIFF id', async () => {
    const { db, prepare, bind } = database({ id: 'account-1' });
    await expect(resolveActiveLineAccountIdByLiffId(db, 'liff-1')).resolves.toBe('account-1');
    expect(prepare).toHaveBeenCalledWith(
      'SELECT id FROM line_accounts WHERE liff_id = ? AND is_active = 1',
    );
    expect(bind).toHaveBeenCalledWith('liff-1');
  });
});
