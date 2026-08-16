import { describe, expect, it, vi } from 'vitest';
import { resolvePrescriptionPatient } from './patient.js';

function dbReturning(row: unknown) {
  const first = vi.fn().mockResolvedValue(row);
  const bind = vi.fn().mockReturnValue({ first });
  const prepare = vi.fn().mockReturnValue({ bind });
  return { db: { prepare } as unknown as D1Database, prepare, bind };
}

describe('resolvePrescriptionPatient', () => {
  it('binds LINE user, LIFF, and verified login channel in one scoped query', async () => {
    const { db, prepare, bind } = dbReturning({
      line_account_id: 'account-1',
      friend_id: 'friend-1',
    });

    await expect(
      resolvePrescriptionPatient(db, 'liff-1', {
        lineUserId: 'U1',
        loginChannelId: 'login-1',
      }),
    ).resolves.toEqual({ lineAccountId: 'account-1', friendId: 'friend-1' });

    expect(prepare.mock.calls[0][0]).toContain(
      'f.line_account_id = la.id AND f.line_user_id = ?',
    );
    expect(bind).toHaveBeenCalledWith('U1', 'liff-1', 'login-1');
  });

  it('fails closed when the scoped account/friend pair does not exist', async () => {
    const { db } = dbReturning(null);
    await expect(
      resolvePrescriptionPatient(db, 'other-liff', {
        lineUserId: 'U1',
        loginChannelId: 'other-channel',
      }),
    ).resolves.toBeNull();
  });

  it('does not query globally when liffId is absent', async () => {
    const { db, prepare } = dbReturning(null);
    await expect(
      resolvePrescriptionPatient(db, '', {
        lineUserId: 'U1',
        loginChannelId: 'login-1',
      }),
    ).resolves.toBeNull();
    expect(prepare).not.toHaveBeenCalled();
  });
});
