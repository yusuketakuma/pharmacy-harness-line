import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the LINE SDK so we can assert exactly what gets pushed without hitting
// the network. pushMessage is a shared spy across all LineClient instances.
const pushMessage = vi.fn().mockResolvedValue({});
const LineClientMock = vi.fn().mockImplementation(function (token: string) {
  return { __token: token, pushMessage };
});
vi.mock('@line-crm/line-sdk', () => ({ LineClient: LineClientMock }));

// Mock the db helpers the notifier resolves through.
const dbMocks = {
  getAffiliateById: vi.fn(),
  getFriendById: vi.fn(),
  getLineAccountById: vi.fn(),
};
vi.mock('@line-crm/db', () => dbMocks);

const getActiveMappedAccountTenantId = vi.fn();
vi.mock('./step-delivery.js', () => ({ getActiveMappedAccountTenantId }));

const deliverTrackedLinePush = vi.fn();
vi.mock('./outbound-line-delivery.js', () => ({ deliverTrackedLinePush }));

const {
  notifyAffiliate,
  notifyAffiliateFriendAdd,
  notifyAffiliateApproval,
} = await import('./affiliate-notifier.js');

const DB = {} as D1Database;
const env = { LINE_CHANNEL_ACCESS_TOKEN: 'env-token' };
const RETRY_KEY = '11111111-1111-4111-8111-111111111111';

beforeEach(() => {
  vi.clearAllMocks();
  pushMessage.mockResolvedValue({});
  getActiveMappedAccountTenantId.mockResolvedValue('tenant-1');
  deliverTrackedLinePush.mockImplementation(async (params) => {
    await params.send(params.request, params.operationId);
    return 'sent';
  });
});

describe('notifyAffiliate', () => {
  it('does not send without a stable source retry key', async () => {
    dbMocks.getAffiliateById.mockResolvedValue({ id: 'aff-1', friend_id: 'fr-1' });
    dbMocks.getFriendById.mockResolvedValue({
      id: 'fr-1',
      line_user_id: 'Uaaa',
      line_account_id: null,
    });

    await notifyAffiliate(DB, env, 'aff-1', 'hello', undefined as never);

    expect(pushMessage).not.toHaveBeenCalled();
  });

  it('pushes to the affiliate friend via the account token', async () => {
    dbMocks.getAffiliateById.mockResolvedValue({ id: 'aff-1', friend_id: 'fr-1' });
    dbMocks.getFriendById.mockResolvedValue({
      id: 'fr-1',
      line_user_id: 'Uaaa',
      line_account_id: 'acct-1',
    });
    dbMocks.getLineAccountById.mockResolvedValue({ channel_access_token: 'acct-token' });

    await notifyAffiliate(DB, env, 'aff-1', 'hello', RETRY_KEY);

    expect(LineClientMock).toHaveBeenCalledWith('acct-token');
    expect(pushMessage).toHaveBeenCalledWith(
      'Uaaa', [{ type: 'text', text: 'hello' }], RETRY_KEY,
    );
    expect(deliverTrackedLinePush).toHaveBeenCalledWith(expect.objectContaining({
      operationId: RETRY_KEY,
      tenantId: 'tenant-1',
      lineAccountId: 'acct-1',
      friendId: 'fr-1',
      source: 'affiliate',
    }));
  });

  it('does not send when the friend has no account authority', async () => {
    dbMocks.getAffiliateById.mockResolvedValue({ id: 'aff-1', friend_id: 'fr-1' });
    dbMocks.getFriendById.mockResolvedValue({
      id: 'fr-1',
      line_user_id: 'Uaaa',
      line_account_id: null,
    });

    await notifyAffiliate(DB, env, 'aff-1', 'hello', RETRY_KEY);

    expect(dbMocks.getLineAccountById).not.toHaveBeenCalled();
    expect(deliverTrackedLinePush).not.toHaveBeenCalled();
    expect(LineClientMock).not.toHaveBeenCalled();
    expect(pushMessage).not.toHaveBeenCalled();
  });

  it('does not fall back to the env token for an unmapped account', async () => {
    dbMocks.getAffiliateById.mockResolvedValue({ id: 'aff-1', friend_id: 'fr-1' });
    dbMocks.getFriendById.mockResolvedValue({
      id: 'fr-1', line_user_id: 'Uaaa', line_account_id: 'acct-1',
    });
    getActiveMappedAccountTenantId.mockResolvedValue(null);

    await notifyAffiliate(DB, env, 'aff-1', 'hello', RETRY_KEY);

    expect(dbMocks.getLineAccountById).not.toHaveBeenCalled();
    expect(LineClientMock).not.toHaveBeenCalled();
    expect(pushMessage).not.toHaveBeenCalled();
  });

  it('accepts a settled ledger replay without calling LINE again', async () => {
    dbMocks.getAffiliateById.mockResolvedValue({ id: 'aff-1', friend_id: 'fr-1' });
    dbMocks.getFriendById.mockResolvedValue({
      id: 'fr-1', line_user_id: 'Uaaa', line_account_id: 'acct-1',
    });
    dbMocks.getLineAccountById.mockResolvedValue({ channel_access_token: 'acct-token' });
    deliverTrackedLinePush.mockResolvedValue('already_sent');

    await notifyAffiliate(DB, env, 'aff-1', 'hello', RETRY_KEY);

    expect(deliverTrackedLinePush).toHaveBeenCalledOnce();
    expect(pushMessage).not.toHaveBeenCalled();
  });

  it('skips silently when the affiliate has no bound friend', async () => {
    dbMocks.getAffiliateById.mockResolvedValue({ id: 'aff-1', friend_id: null });

    await notifyAffiliate(DB, env, 'aff-1', 'hello', RETRY_KEY);

    expect(dbMocks.getFriendById).not.toHaveBeenCalled();
    expect(pushMessage).not.toHaveBeenCalled();
  });

  it('skips silently when the affiliate does not exist', async () => {
    dbMocks.getAffiliateById.mockResolvedValue(null);

    await notifyAffiliate(DB, env, 'nope', 'hello', RETRY_KEY);

    expect(pushMessage).not.toHaveBeenCalled();
  });

  it('skips silently when the bound friend has no line_user_id', async () => {
    dbMocks.getAffiliateById.mockResolvedValue({ id: 'aff-1', friend_id: 'fr-1' });
    dbMocks.getFriendById.mockResolvedValue({ id: 'fr-1', line_user_id: '', line_account_id: null });

    await notifyAffiliate(DB, env, 'aff-1', 'hello', RETRY_KEY);

    expect(pushMessage).not.toHaveBeenCalled();
  });

  it('does not throw when pushMessage rejects (best-effort)', async () => {
    dbMocks.getAffiliateById.mockResolvedValue({ id: 'aff-1', friend_id: 'fr-1' });
    dbMocks.getFriendById.mockResolvedValue({
      id: 'fr-1',
      line_user_id: 'Uaaa',
      line_account_id: 'acct-1',
    });
    dbMocks.getLineAccountById.mockResolvedValue({ channel_access_token: 'acct-token' });
    pushMessage.mockRejectedValue(new Error('LINE 500'));

    await expect(notifyAffiliate(DB, env, 'aff-1', 'hello', RETRY_KEY))
      .resolves.toBeUndefined();
  });

  it('does not throw when a db lookup rejects (best-effort)', async () => {
    dbMocks.getAffiliateById.mockRejectedValue(new Error('db down'));
    await expect(notifyAffiliate(DB, env, 'aff-1', 'hello', RETRY_KEY))
      .resolves.toBeUndefined();
    expect(pushMessage).not.toHaveBeenCalled();
  });
});

describe('notifyAffiliateFriendAdd', () => {
  beforeEach(() => {
    dbMocks.getAffiliateById.mockResolvedValue({ id: 'aff-1', friend_id: 'fr-1' });
    dbMocks.getFriendById.mockResolvedValue({
      id: 'fr-1',
      line_user_id: 'Uaaa',
      line_account_id: 'acct-1',
    });
    dbMocks.getLineAccountById.mockResolvedValue({ channel_access_token: 'acct-token' });
  });

  it('does not send without the source event id', async () => {
    await notifyAffiliateFriendAdd(DB, env, 'aff-1', 'キャンペーンA', undefined as never);
    expect(pushMessage).not.toHaveBeenCalled();
  });

  it('includes the offer name when present', async () => {
    await notifyAffiliateFriendAdd(DB, env, 'aff-1', 'キャンペーンA', 'link-1:friend-1');
    const text = pushMessage.mock.calls[0][1][0].text as string;
    expect(text).toContain('🎉 あなたの紹介リンクから友だち追加がありました！');
    expect(text).toContain('案件: キャンペーンA');
    expect(text).toContain('『アフィリ』と送るとマイページで実績を確認できます');
    expect(pushMessage.mock.calls[0][2]).toMatch(/^[0-9a-f-]{36}$/u);
  });

  it('uses 汎用リンク when offer name is null', async () => {
    await notifyAffiliateFriendAdd(DB, env, 'aff-1', null, 'link-2:friend-1');
    const text = pushMessage.mock.calls[0][1][0].text as string;
    expect(text).toContain('案件: 汎用リンク');
  });
});

describe('notifyAffiliateApproval', () => {
  beforeEach(() => {
    dbMocks.getAffiliateById.mockResolvedValue({ id: 'aff-1', friend_id: 'fr-1' });
    dbMocks.getFriendById.mockResolvedValue({
      id: 'fr-1',
      line_user_id: 'Uaaa',
      line_account_id: 'acct-1',
    });
    dbMocks.getLineAccountById.mockResolvedValue({ channel_access_token: 'acct-token' });
  });

  it('does not send without the source event id', async () => {
    await notifyAffiliateApproval(DB, env, 'aff-1', '案件X', 12345, undefined as never);
    expect(pushMessage).not.toHaveBeenCalled();
  });

  it('includes the offer + formatted reward when the offer is present', async () => {
    await notifyAffiliateApproval(DB, env, 'aff-1', '案件X', 12345, 'conversion-1');
    const text = pushMessage.mock.calls[0][1][0].text as string;
    expect(text).toContain('✅ 成果が承認されました！');
    expect(text).toContain('案件: 案件X');
    expect(text).toContain('確定報酬: ¥12,345');
    expect(text).toContain('『アフィリ』と送るとマイページで確認できます');
    expect(pushMessage.mock.calls[0][2]).toMatch(/^[0-9a-f-]{36}$/u);
  });

  it('omits the reward line for an offer-less attribution', async () => {
    await notifyAffiliateApproval(DB, env, 'aff-1', null, 0, 'conversion-2');
    const text = pushMessage.mock.calls[0][1][0].text as string;
    expect(text).toContain('✅ 成果が承認されました！');
    expect(text).not.toContain('案件:');
    expect(text).not.toContain('確定報酬');
  });
});
