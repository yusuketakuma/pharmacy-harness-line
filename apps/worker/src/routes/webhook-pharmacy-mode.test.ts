import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const mocks = vi.hoisted(() => ({
  pharmacyMode: vi.fn(),
  awardMileage: vi.fn(),
  matchAndReply: vi.fn(),
  fireEvent: vi.fn(),
  recordFollow: vi.fn(),
  recordUnfollow: vi.fn(),
  getProfile: vi.fn(),
}));

const credentialStoreMocks = vi.hoisted(() => ({
  readLineCredential: vi.fn(),
}));

const friend = {
  id: 'friend-1',
  line_user_id: 'U-pharmacy',
  display_name: 'Patient',
  picture_url: null,
  status_message: null,
  is_following: 1,
  user_id: null,
  line_account_id: 'account-pharmacy',
  metadata: '{}',
  first_tracked_link_id: null,
  ref_code: 'ref-none',
  first_followed_at: '2026-08-18T00:00:00Z',
  created_at: '2026-08-18T00:00:00Z',
  updated_at: '2026-08-18T00:00:00Z',
};

const dbMocks = vi.hoisted(() => ({
  upsertFriend: vi.fn(),
  getFriendByLineUserId: vi.fn(),
  getFriendByLineUserIdForAccount: vi.fn(),
  getScenarios: vi.fn(),
  getScenariosForAccount: vi.fn(),
  enrollFriendInScenario: vi.fn(),
  upsertChatOnMessage: vi.fn(),
  getEntryRouteByRefCode: vi.fn(),
  updateFriendFollowStatus: vi.fn(),
}));

vi.mock('@line-crm/db', () => ({
  ...dbMocks,
  updateFriendFollowStatus: dbMocks.updateFriendFollowStatus,
  getActiveTenantLineAccounts: vi.fn().mockResolvedValue([{
    id: 'account-pharmacy',
    tenant_id: 'tenant-pharmacy',
    is_active: 1,
    channel_secret: 'env-default-secret',
    channel_access_token: 'env-default-token',
  }]),
  jstNow: vi.fn().mockReturnValue('2026-08-18T09:00:00+09:00'),
  toJstString: vi.fn((date: Date) => date.toISOString()),
  getMessageTemplateById: vi.fn(),
}));

vi.mock('@line-crm/line-sdk', async () => ({
  ...(await vi.importActual<Record<string, unknown>>('@line-crm/line-sdk')),
  verifySignature: vi.fn().mockResolvedValue(true),
  LineClient: vi.fn().mockImplementation(function () {
    return {
      getProfile: mocks.getProfile,
      pushMessage: vi.fn(),
      replyMessage: vi.fn(),
    };
  }),
}));

vi.mock('../custom/pharmacy/growth-loop/access.js', () => ({
  isPharmacyModeAccount: mocks.pharmacyMode,
}));
vi.mock('../custom/pharmacy/growth-loop/onboarding.js', () => ({
  recordPharmacyFollow: mocks.recordFollow,
  recordPharmacyUnfollowMetrics: mocks.recordUnfollow,
}));
vi.mock('../services/activity-mileage.js', () => ({ awardActivityMileage: mocks.awardMileage }));
vi.mock('../services/auto-reply.js', () => ({ matchAndReply: mocks.matchAndReply }));
vi.mock('../services/event-bus.js', () => ({ fireEvent: mocks.fireEvent }));
vi.mock('../services/immediate-first-step.js', () => ({ pushImmediateFirstStep: vi.fn() }));
vi.mock('../services/local-line-proxy.js', () => ({
  dispatchLineProxyLocally: vi.fn().mockResolvedValue(new Response(null, { status: 200 })),
}));
vi.mock('../custom/pharmacy/provisioning/line-credential-store.js', () => credentialStoreMocks);

import { webhook } from './webhook.js';

function database() {
  return {
    prepare(sql: string) {
      const statement = {
        bind: vi.fn(),
        run: vi.fn().mockResolvedValue({ meta: { changes: 1 } }),
        first: vi.fn().mockResolvedValue(
          sql.includes('pharmacy_line_channel_identities')
            ? {
                id: 'account-pharmacy',
                tenant_id: 'tenant-pharmacy',
                channel_secret: 'env-default-secret',
                channel_access_token: 'env-default-token',
              }
            : null,
        ),
        all: vi.fn().mockResolvedValue({ results: [] }),
      };
      statement.bind.mockReturnValue(statement);
      return statement;
    },
  } as unknown as D1Database;
}

async function deliver(event: Record<string, unknown>, db: D1Database) {
  const app = new Hono();
  app.route('/', webhook);
  const executionCtx = {
    waitUntil: vi.fn(),
    passThroughOnException: vi.fn(),
    props: {},
  } as unknown as ExecutionContext;
  const response = await app.request('/webhook', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Line-Signature': `${'A'.repeat(43)}=`,
    },
    body: JSON.stringify({ destination: 'bot', events: [event] }),
  }, {
    DB: db,
    LINE_CREDENTIAL_KEY_V1: 'root-key-for-pharmacy-tests-v1',
    LINE_CHANNEL_SECRET: 'env-default-secret',
    LINE_CHANNEL_ACCESS_TOKEN: 'env-default-token',
  }, executionCtx);
  expect(response.status).toBe(200);
  await (vi.mocked(executionCtx.waitUntil).mock.calls[0]?.[0] as Promise<unknown>);
}

beforeEach(() => {
  vi.clearAllMocks();
  credentialStoreMocks.readLineCredential.mockImplementation(
    async (_db: D1Database, _rootSecret: string, input: { kind: string }) =>
      input.kind === 'channel_secret' ? 'env-default-secret' : 'env-default-token',
  );
  mocks.pharmacyMode.mockResolvedValue(true);
  mocks.recordFollow.mockResolvedValue(undefined);
  mocks.matchAndReply.mockResolvedValue({ matched: false, replyTokenConsumed: false });
  mocks.getProfile.mockResolvedValue({ displayName: 'Patient' });
  dbMocks.upsertFriend.mockResolvedValue(friend);
  dbMocks.getFriendByLineUserIdForAccount.mockResolvedValue(friend);
  dbMocks.getScenarios.mockResolvedValue([]);
  dbMocks.getScenariosForAccount.mockResolvedValue([]);
  dbMocks.getEntryRouteByRefCode.mockResolvedValue(null);
});

describe('pharmacy-mode webhook allowlist', () => {
  it('records pharmacy onboarding but skips generic follow side effects', async () => {
    await deliver({
      type: 'follow',
      replyToken: 'reply-follow',
      source: { type: 'user', userId: 'U-pharmacy' },
    }, database());

    expect(mocks.recordFollow).toHaveBeenCalledOnce();
    expect(mocks.awardMileage).not.toHaveBeenCalled();
    expect(dbMocks.getScenariosForAccount).not.toHaveBeenCalled();
    expect(dbMocks.enrollFriendInScenario).not.toHaveBeenCalled();
    expect(mocks.fireEvent).not.toHaveBeenCalled();
  });

  it('keeps inbound text in manual chat but skips generic automation and mileage', async () => {
    await deliver({
      type: 'message',
      replyToken: 'reply-text',
      message: { type: 'text', id: 'message-1', text: '相談したい' },
      source: { type: 'user', userId: 'U-pharmacy' },
    }, database());

    expect(dbMocks.upsertChatOnMessage).toHaveBeenCalledWith(expect.anything(), friend.id);
    expect(mocks.awardMileage).not.toHaveBeenCalled();
    expect(mocks.matchAndReply).not.toHaveBeenCalled();
    expect(mocks.fireEvent).not.toHaveBeenCalled();
  });

  it('logs postbacks without running generic auto replies or automations', async () => {
    await deliver({
      type: 'postback',
      replyToken: 'reply-postback',
      postback: { data: 'generic-action' },
      source: { type: 'user', userId: 'U-pharmacy' },
    }, database());

    expect(mocks.matchAndReply).not.toHaveBeenCalled();
    expect(mocks.fireEvent).not.toHaveBeenCalled();
  });

  it('updates unfollow state only inside the verified LINE account', async () => {
    await deliver({
      type: 'unfollow',
      source: { type: 'user', userId: 'U-pharmacy' },
    }, database());

    expect(dbMocks.updateFriendFollowStatus).toHaveBeenCalledWith(
      expect.anything(), 'U-pharmacy', false, 'account-pharmacy',
    );
    expect(mocks.recordUnfollow).toHaveBeenCalledWith(expect.objectContaining({
      lineAccountId: 'account-pharmacy', lineUserId: 'U-pharmacy',
    }));
  });
});
