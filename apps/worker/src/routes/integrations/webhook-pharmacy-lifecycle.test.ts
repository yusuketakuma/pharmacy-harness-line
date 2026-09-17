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
  followUpPostback: vi.fn(),
  fetchImage: vi.fn(),
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
  first_followed_at: '2026-07-01T00:00:00Z',
  created_at: '2026-08-01T00:00:00Z',
  updated_at: '2026-08-18T00:00:00Z',
};

const dbMocks = vi.hoisted(() => ({
  upsertFriend: vi.fn(),
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

vi.mock('../../custom/pharmacy/growth-loop/access.js', () => ({
  isPharmacyModeAccount: mocks.pharmacyMode,
}));
vi.mock('../../custom/pharmacy/growth-loop/onboarding.js', () => ({
  recordPharmacyFollow: mocks.recordFollow,
  recordPharmacyUnfollowMetrics: mocks.recordUnfollow,
}));
vi.mock('../../custom/pharmacy/medication-followup/webhook.js', () => ({
  handleMedicationFollowUpPostback: mocks.followUpPostback,
}));
vi.mock('../../services/activity-mileage.js', () => ({ awardActivityMileage: mocks.awardMileage }));
vi.mock('../../services/auto-reply.js', () => ({ matchAndReply: mocks.matchAndReply }));
vi.mock('../../services/event-bus.js', () => ({ fireEvent: mocks.fireEvent }));
vi.mock('../../services/immediate-first-step.js', () => ({ pushImmediateFirstStep: vi.fn() }));
vi.mock('../../services/local-line-proxy.js', () => ({
  dispatchLineProxyLocally: vi.fn().mockResolvedValue(new Response(null, { status: 200 })),
}));
vi.mock('../../services/incoming-image.js', () => ({
  fetchAndStoreIncomingImage: mocks.fetchImage,
}));
vi.mock('../../custom/pharmacy/provisioning/line-credential-store.js', () => credentialStoreMocks);

import { webhook } from './webhook.js';

const issuedSql: string[] = [];
const boundArgs: Array<{ sql: string; args: unknown[] }> = [];

function database() {
  return {
    prepare(sql: string) {
      issuedSql.push(sql);
      const statement = {
        bind: vi.fn().mockImplementation((...args: unknown[]) => {
          boundArgs.push({ sql, args });
          return statement;
        }),
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
    LINE_CREDENTIAL_KEY_V1: 'synthetic-line-credential-root-key-v1',
    LINE_CHANNEL_SECRET: 'env-default-secret',
    LINE_CHANNEL_ACCESS_TOKEN: 'env-default-token',
    WORKER_URL: 'https://worker.example',
    IMAGES: {} as R2Bucket,
  }, executionCtx);
  expect(response.status).toBe(200);
  // Await every registered background task for this delivery.
  await Promise.all(
    vi.mocked(executionCtx.waitUntil).mock.calls.map((c) => c[0] as Promise<unknown>),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  issuedSql.length = 0;
  boundArgs.length = 0;
  credentialStoreMocks.readLineCredential.mockImplementation(
    async (_db: D1Database, _rootSecret: string, input: { kind: string }) =>
      input.kind === 'channel_secret' ? 'env-default-secret' : 'env-default-token',
  );
  mocks.pharmacyMode.mockResolvedValue(true);
  mocks.recordFollow.mockResolvedValue(undefined);
  mocks.matchAndReply.mockResolvedValue({ matched: false, replyTokenConsumed: false });
  mocks.getProfile.mockResolvedValue({ displayName: 'Patient' });
  mocks.followUpPostback.mockResolvedValue(undefined);
  mocks.fetchImage.mockResolvedValue(null);
  dbMocks.upsertFriend.mockResolvedValue(friend);
  dbMocks.getFriendByLineUserIdForAccount.mockResolvedValue(friend);
  dbMocks.getScenariosForAccount.mockResolvedValue([]);
  dbMocks.getEntryRouteByRefCode.mockResolvedValue(null);
});

describe('pharmacy LINE lifecycle acceptance', () => {
  it('records a re-follow against the original first_followed_at so growth metrics stay idempotent', async () => {
    // A patient who blocked then re-added the account sends another follow
    // event months later; the friend row keeps its original first_followed_at.
    await deliver({
      type: 'follow',
      replyToken: 'reply-refollow',
      webhookEventId: 'evt-refollow-1',
      source: { type: 'user', userId: 'U-pharmacy' },
    }, database());

    expect(mocks.recordFollow).toHaveBeenCalledOnce();
    expect(mocks.recordFollow).toHaveBeenCalledWith(expect.objectContaining({
      lineAccountId: 'account-pharmacy',
      firstFollowedAt: '2026-07-01T00:00:00Z',
    }));
    expect(mocks.awardMileage).not.toHaveBeenCalled();
  });

  it('writes each event to the durable inbox before processing so redelivery dedups by event id', async () => {
    const db = database();
    await deliver({
      type: 'message',
      replyToken: 'reply-text',
      webhookEventId: 'evt-dup-1',
      message: { type: 'text', id: 'message-1', text: '相談したい' },
      source: { type: 'user', userId: 'U-pharmacy' },
    }, db);

    const receiptWrite = issuedSql.find((sql) =>
      sql.includes('INSERT OR IGNORE INTO pharmacy_webhook_event_receipts'));
    expect(receiptWrite).toBeTruthy();
    expect(mocks.matchAndReply).not.toHaveBeenCalled();
    expect(dbMocks.upsertChatOnMessage).toHaveBeenCalledWith(expect.anything(), friend.id);
  });

  it('logs unsupported message types with a label and never runs auto replies', async () => {
    for (const message of [
      { type: 'video', id: 'm-video' },
      { type: 'audio', id: 'm-audio' },
      { type: 'file', id: 'm-file', fileName: 'memo.pdf' },
      { type: 'location', id: 'm-loc', title: 'Somewhere' },
    ]) {
      await deliver({
        type: 'message',
        replyToken: 'reply-unsupported',
        webhookEventId: `evt-${message.id}`,
        message,
        source: { type: 'user', userId: 'U-pharmacy' },
      }, database());
    }
    expect(mocks.matchAndReply).not.toHaveBeenCalled();
    expect(mocks.fireEvent).not.toHaveBeenCalled();
    // Each unsupported event is still logged inbound with a label, not dropped.
    const inboundWrites = boundArgs.filter(({ sql }) =>
      sql.includes('INTO messages_log') && sql.includes("'incoming'"));
    expect(inboundWrites).toHaveLength(4);
  });

  it('falls back to the image label when the content fetch returns nothing', async () => {
    mocks.fetchImage.mockResolvedValue(null);
    await deliver({
      type: 'message',
      replyToken: 'reply-image',
      webhookEventId: 'evt-image-1',
      message: { type: 'image', id: 'img-1' },
      source: { type: 'user', userId: 'U-pharmacy' },
    }, database());
    // The event is ACKed (deliver asserts 200) and no auto reply runs.
    expect(mocks.matchAndReply).not.toHaveBeenCalled();
    // The fetch actually ran — the fallback label is not just the default.
    expect(mocks.fetchImage).toHaveBeenCalledOnce();
    // The inbound row keeps the neutral label — no fetched URL, no PHI.
    const inbound = boundArgs.find(({ sql }) =>
      sql.includes('INTO messages_log') && sql.includes("'incoming'"));
    expect(inbound).toBeTruthy();
    expect(inbound!.args).toContain('[画像]');
  });

  it('leaves an image event unlogged for the durable retry when the fetch throws', async () => {
    mocks.fetchImage.mockRejectedValue(new Error('synthetic-image-fetch-detail'));
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await deliver({
        type: 'message',
        replyToken: 'reply-image',
        webhookEventId: 'evt-image-2',
        message: { type: 'image', id: 'img-2' },
        source: { type: 'user', userId: 'U-pharmacy' },
      }, database());
      // The fetch ran and failed — the inbox owns the retry.
      expect(mocks.fetchImage).toHaveBeenCalledOnce();
      // The inbound chat row is not written — the durable inbox owns the retry.
      const inbound = boundArgs.find(({ sql }) =>
        sql.includes('INTO messages_log') && sql.includes("'incoming'"));
      expect(inbound).toBeUndefined();
      const logged = consoleError.mock.calls.flatMap((a) => a.map(String)).join('\n');
      expect(logged).not.toContain('synthetic-image-fetch-detail');
    } finally {
      consoleError.mockRestore();
    }
  });

  it('routes medication follow-up postbacks to the pharmacy handler without a second reply', async () => {
    await deliver({
      type: 'postback',
      replyToken: 'reply-postback',
      webhookEventId: 'evt-postback-1',
      postback: { data: 'pharmacy-followup:followup-a:no_issue' },
      source: { type: 'user', userId: 'U-pharmacy' },
    }, database());

    expect(mocks.followUpPostback).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      lineAccountId: 'account-pharmacy',
      friendId: 'friend-1',
      webhookEventId: 'evt-postback-1',
      data: 'pharmacy-followup:followup-a:no_issue',
    }));
    // No generic auto reply or automation fires alongside the pharmacy path.
    expect(mocks.matchAndReply).not.toHaveBeenCalled();
    expect(mocks.fireEvent).not.toHaveBeenCalled();
  });

  it('does not treat API accept as patient delivery: webhook handlers only record inbound state', async () => {
    // Outbound acceptance vs arrival is settled only in outbound_line_deliveries
    // (open/retired/reconciliation) — the webhook path never writes an outgoing
    // 'sent' row for inbound events.
    const db = database();
    await deliver({
      type: 'message',
      replyToken: 'reply-inbound',
      webhookEventId: 'evt-inbound-1',
      message: { type: 'text', id: 'message-2', text: 'お薬について' },
      source: { type: 'user', userId: 'U-pharmacy' },
    }, db);
    const outgoingWrites = issuedSql.filter((sql) =>
      /INTO messages_log/.test(sql) && sql.includes("'outgoing'"));
    expect(outgoingWrites).toEqual([]);
  });
});
