import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getDue: vi.fn(),
  getFriend: vi.fn(),
  complete: vi.fn(),
  pharmacyMode: vi.fn(),
  tenantId: vi.fn(),
  deliver: vi.fn(),
  account: vi.fn(),
  linePush: vi.fn(),
}));

vi.mock('@line-crm/db', () => ({
  getDueReminderDeliveries: mocks.getDue,
  getFriendById: mocks.getFriend,
  getLineAccountById: mocks.account,
  completeReminderIfDone: mocks.complete,
  jstNow: vi.fn().mockReturnValue('2026-08-18T09:00:00+09:00'),
}));
vi.mock('../custom/pharmacy/growth-loop/access.js', () => ({
  isPharmacyModeAccount: mocks.pharmacyMode,
}));
vi.mock('./step-delivery.js', () => ({
  getActiveMappedAccountTenantId: mocks.tenantId,
}));
vi.mock('./outbound-line-delivery.js', () => ({
  deliverTrackedLinePush: mocks.deliver,
}));
vi.mock('@line-crm/line-sdk', () => ({
  LineClient: class {
    pushMessage = mocks.linePush;
  },
}));

import { processReminderDeliveries } from './reminder-delivery.js';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getDue.mockResolvedValue([{
    id: 'friend-reminder-1',
    friend_id: 'friend-1',
    reminder_id: 'reminder-1',
    steps: [{ id: 'step-1', message_type: 'text', message_content: 'generic reminder' }],
  }]);
  mocks.getFriend.mockResolvedValue({
    id: 'friend-1',
    line_user_id: 'U-friend',
    line_account_id: 'account-pharmacy',
    is_following: 1,
  });
  mocks.pharmacyMode.mockResolvedValue(true);
  mocks.tenantId.mockResolvedValue('tenant-generic');
  mocks.account.mockResolvedValue({ channel_access_token: 'token-generic' });
  mocks.linePush.mockResolvedValue({});
  mocks.deliver.mockImplementation(async (params) => {
    await params.send(params.request, params.operationId);
    return 'sent';
  });
});

describe('generic reminder exclusion for pharmacy accounts', () => {
  it('does not send or complete a due generic reminder', async () => {
    const pushMessage = vi.fn();
    await processReminderDeliveries(
      { prepare: vi.fn() } as unknown as D1Database,
      { pushMessage } as never,
    );

    expect(pushMessage).not.toHaveBeenCalled();
    expect(mocks.complete).not.toHaveBeenCalled();
  });

  it('does not send when the account is no longer mapped to an active tenant', async () => {
    mocks.pharmacyMode.mockResolvedValue(false);
    mocks.tenantId.mockResolvedValue(null);
    const prepare = vi.fn();

    const pushMessage = vi.fn();
    await processReminderDeliveries(
      { prepare } as unknown as D1Database,
      { pushMessage } as never,
    );

    expect(mocks.tenantId).toHaveBeenCalledWith(expect.anything(), 'account-pharmacy');
    expect(prepare).not.toHaveBeenCalled();
    expect(pushMessage).not.toHaveBeenCalled();
    expect(mocks.complete).not.toHaveBeenCalled();
  });

  it('uses one stable LINE retry key for the same reminder step', async () => {
    mocks.pharmacyMode.mockResolvedValue(false);
    mocks.getFriend.mockResolvedValue({
      id: 'friend-1',
      line_user_id: 'U-friend',
      line_account_id: 'account-generic',
      is_following: 1,
    });
    const run = vi.fn().mockResolvedValue({ meta: { changes: 1 } });
    const sql: string[] = [];
    const prepare = vi.fn((statementSql: string) => {
      sql.push(statementSql);
      const statement = {
        bind: vi.fn(() => statement),
        run,
      };
      return statement;
    });
    const pushMessage = vi.fn().mockResolvedValue(undefined);
    const db = { prepare } as unknown as D1Database;

    await processReminderDeliveries(db, { pushMessage } as never);
    await processReminderDeliveries(db, { pushMessage } as never);

    expect(mocks.linePush).toHaveBeenCalledTimes(2);
    const firstRetryKey = mocks.linePush.mock.calls[0]?.[2];
    expect(firstRetryKey).toMatch(/^[0-9a-f-]{36}$/u);
    expect(mocks.linePush.mock.calls[1]?.[2]).toBe(firstRetryKey);
    expect(mocks.deliver).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: 'tenant-generic',
      lineAccountId: 'account-generic',
      friendId: 'friend-1',
      source: 'reminder',
    }));
    expect(sql.filter((statement) => statement.includes('INSERT INTO messages_log'))).toEqual([]);
  });

  it('repairs the delivery marker after an already accepted send without calling LINE', async () => {
    mocks.pharmacyMode.mockResolvedValue(false);
    mocks.getFriend.mockResolvedValue({
      id: 'friend-1',
      line_user_id: 'U-friend',
      line_account_id: 'account-generic',
      is_following: 1,
    });
    mocks.deliver.mockResolvedValue('already_sent');
    const sql: string[] = [];
    const prepare = vi.fn((statementSql: string) => {
      sql.push(statementSql);
      const statement = {
        bind: vi.fn(() => statement),
        run: vi.fn().mockResolvedValue({ meta: { changes: 1 } }),
      };
      return statement;
    });
    const pushMessage = vi.fn();
    const db = { prepare } as unknown as D1Database;

    await processReminderDeliveries(db, { pushMessage } as never);

    expect(pushMessage).not.toHaveBeenCalled();
    expect(sql.some((statement) => statement.includes('friend_reminder_deliveries'))).toBe(true);
    expect(mocks.complete).toHaveBeenCalledWith(db, 'friend-reminder-1', 'reminder-1');
  });

  it('fails closed before the ledger when the mapped account credential disappears', async () => {
    mocks.pharmacyMode.mockResolvedValue(false);
    mocks.getFriend.mockResolvedValue({
      id: 'friend-1',
      line_user_id: 'U-friend',
      line_account_id: 'account-generic',
      is_following: 1,
    });
    mocks.account.mockResolvedValue(null);

    await processReminderDeliveries(
      { prepare: vi.fn() } as unknown as D1Database,
      { pushMessage: vi.fn() } as never,
    );

    expect(mocks.deliver).not.toHaveBeenCalled();
    expect(mocks.linePush).not.toHaveBeenCalled();
    expect(mocks.complete).not.toHaveBeenCalled();
  });
});
