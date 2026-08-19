import { describe, expect, test, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

const lineClientMocks = vi.hoisted(() => ({
  getProfile: vi.fn(),
  replyMessage: vi.fn(),
  pushMessage: vi.fn(),
}));

const credentialStoreMocks = vi.hoisted(() => ({
  readLineCredential: vi.fn(),
}));

// Stub the DB graph — these tests focus on webhook guard behavior and the
// first-contact friend registration path without touching real D1/LINE.
vi.mock('@line-crm/db', () => ({
  applyMileageRulesForEvent: vi.fn(),
  upsertFriend: vi.fn(),
  updateFriendFollowStatus: vi.fn(),
  getFriendByLineUserId: vi.fn(),
  getFriendByLineUserIdForAccount: vi.fn(),
  getScenarios: vi.fn(),
  getScenariosForAccount: vi.fn().mockResolvedValue([]),
  enrollFriendInScenario: vi.fn(),
  getScenarioSteps: vi.fn(),
  advanceFriendScenario: vi.fn(),
  completeFriendScenario: vi.fn(),
  upsertChatOnMessage: vi.fn(),
  getActiveTenantLineAccounts: vi.fn().mockResolvedValue([]),
  jstNow: vi.fn(),
  toJstString: vi.fn((date: Date) => date.toISOString()),
  computeNextDeliveryAt: vi.fn(),
  resolveStepContent: vi.fn(),
  addTagToFriend: vi.fn(),
  getEntryRouteByRefCode: vi.fn(),
  getMessageTemplateById: vi.fn(),
  getTemplateById: vi.fn(),
}));

vi.mock('@line-crm/line-sdk', async () => {
  const actual = await vi.importActual<typeof import('@line-crm/line-sdk')>('@line-crm/line-sdk');
  return {
    ...actual,
    verifySignature: vi.fn(),
    LineClient: vi.fn().mockImplementation(() => lineClientMocks),
  };
});

vi.mock('../services/event-bus.js', () => ({
  fireEvent: vi.fn().mockResolvedValue(undefined),
  logOutgoingMessage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../services/local-line-proxy.js', () => ({
  dispatchLineProxyLocally: vi.fn().mockResolvedValue(new Response(null, { status: 200 })),
}));

vi.mock('../custom/pharmacy/provisioning/line-credential-store.js', () => credentialStoreMocks);

vi.mock('../custom/pharmacy/growth-loop/access.js', () => ({
  isPharmacyModeAccount: vi.fn().mockResolvedValue(false),
}));

vi.mock('../services/step-delivery.js', () => ({
  buildMessage: vi.fn(),
  expandVariables: vi.fn(),
  resolveMetadata: vi.fn(),
  messageToLogPayload: vi.fn(),
}));

import { LineClient, verifySignature } from '@line-crm/line-sdk';
import {
  addTagToFriend,
  applyMileageRulesForEvent,
  advanceFriendScenario,
  completeFriendScenario,
  computeNextDeliveryAt,
  enrollFriendInScenario,
  getEntryRouteByRefCode,
  getFriendByLineUserIdForAccount,
  getActiveTenantLineAccounts,
  getMessageTemplateById,
  getScenarioSteps,
  getScenariosForAccount,
  jstNow,
  resolveStepContent,
  updateFriendFollowStatus,
  upsertChatOnMessage,
  upsertFriend,
} from '@line-crm/db';
import { fireEvent } from '../services/event-bus.js';
import { readLineCredential } from '../custom/pharmacy/provisioning/line-credential-store.js';
import { webhook } from './webhook.js';

function setupApp() {
  const app = new Hono();
  app.route('/', webhook);
  return app;
}

function withWebhookIdentity(
  db: D1Database,
  identity: {
    botUserId: string;
    accountId: string;
    tenantId: string;
    channelSecret: string;
    channelAccessToken: string;
  } | null = {
    botUserId: 'bot',
    accountId: 'account-env',
    tenantId: 'tenant-env',
    channelSecret: 'env-default-secret',
    channelAccessToken: 'env-default-token',
  },
): D1Database {
  return {
    ...db,
    prepare(sql: string) {
      if (!sql.includes('pharmacy_line_channel_identities')) return db.prepare(sql);
      return {
        bind(destination: string) {
          return {
            first: async () => identity?.botUserId === destination
              ? {
                  id: identity.accountId,
                  tenant_id: identity.tenantId,
                  channel_secret: identity.channelSecret,
                  channel_access_token: identity.channelAccessToken,
                }
              : null,
          };
        },
      } as unknown as D1PreparedStatement;
    },
  } as D1Database;
}

const emptyDb = {
  prepare: vi.fn(() => ({
    bind: vi.fn(() => ({ first: vi.fn().mockResolvedValue(null) })),
  })),
} as unknown as D1Database;

const baseEnv = {
  DB: withWebhookIdentity(emptyDb),
  LINE_CREDENTIAL_KEY_V1: 'root-key-for-webhook-tests-v1',
  LINE_CHANNEL_SECRET: 'env-default-secret',
  LINE_CHANNEL_ACCESS_TOKEN: 'env-default-token',
} as Record<string, unknown>;

const baseExecutionCtx = {
  waitUntil: vi.fn(),
  passThroughOnException: vi.fn(),
  props: {},
} as unknown as ExecutionContext;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(readLineCredential).mockImplementation(async (_db, _rootSecret, input) =>
    input.kind === 'channel_secret' ? 'env-default-secret' : 'env-default-token');
  vi.mocked(getActiveTenantLineAccounts).mockResolvedValue([{
    id: 'account-env',
    tenant_id: 'tenant-env',
    is_active: 1,
    channel_secret: 'env-default-secret',
    channel_access_token: 'env-default-token',
  } as never]);
});

describe('POST /webhook — DoS defenses (#104)', () => {
  test('rejects with 413 when Content-Length declares an oversized body', async () => {
    const app = setupApp();
    const res = await app.request(
      '/webhook',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': String(2 * 1024 * 1024), // 2 MiB > 1 MiB cap
          'X-Line-Signature': 'whatever',
        },
        body: JSON.stringify({ events: [] }),
      },
      baseEnv,
      baseExecutionCtx,
    );
    expect(res.status).toBe(413);
    // Signature verification must not even be attempted on an oversized body.
    expect(verifySignature).not.toHaveBeenCalled();
  });

  test('rejects with 413 when actual body exceeds the cap even if Content-Length is absent', async () => {
    const app = setupApp();
    const oversizedBody = 'x'.repeat(1024 * 1024 + 1);
    const res = await app.request(
      '/webhook',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Line-Signature': 'whatever',
        },
        body: oversizedBody,
      },
      baseEnv,
      baseExecutionCtx,
    );
    expect(res.status).toBe(413);
    expect(verifySignature).not.toHaveBeenCalled();
  });

  test('rejects malformed JSON before D1 lookup or signature work', async () => {
    vi.mocked(verifySignature).mockResolvedValue(false);

    const app = setupApp();
    const validShapedSignature = 'A'.repeat(43) + '=';
    const res = await app.request(
      '/webhook',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Line-Signature': validShapedSignature,
        },
        body: '{not valid json',
      },
      baseEnv,
      baseExecutionCtx,
    );
    expect(res.status).toBe(200);
    expect(verifySignature).not.toHaveBeenCalled();
  });

  test('does not process a signed webhook when no active tenant owns the channel', async () => {
    vi.mocked(verifySignature).mockResolvedValue(true);
    const executionCtx = {
      waitUntil: vi.fn(),
      passThroughOnException: vi.fn(),
      props: {},
    } as unknown as ExecutionContext;

    const res = await setupApp().request('/webhook', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Line-Signature': `${'A'.repeat(43)}=`,
      },
      body: JSON.stringify({ destination: 'bot', events: [] }),
    }, { ...baseEnv, DB: withWebhookIdentity(emptyDb, null) }, executionCtx);

    expect(res.status).toBe(200);
    expect(executionCtx.waitUntil).not.toHaveBeenCalled();
  });

  test('uses destination to verify exactly one tenant secret', async () => {
    vi.mocked(readLineCredential).mockImplementation(async (_db, _rootSecret, input) =>
      input.kind === 'channel_secret' ? 'secret-99' : 'token-99');
    vi.mocked(verifySignature).mockImplementation(async (secret) => secret === 'secret-99');
    const executionCtx = {
      waitUntil: vi.fn(), passThroughOnException: vi.fn(), props: {},
    } as unknown as ExecutionContext;

    const response = await setupApp().request('/webhook', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Line-Signature': `${'A'.repeat(43)}=`,
      },
      body: JSON.stringify({ destination: 'bot-99', events: [] }),
    }, {
      ...baseEnv,
      DB: withWebhookIdentity(emptyDb, {
        botUserId: 'bot-99', accountId: 'account-99', tenantId: 'tenant-99',
        channelSecret: 'secret-99', channelAccessToken: 'token-99',
      }),
    }, executionCtx);

    expect(response.status).toBe(200);
    expect(verifySignature).toHaveBeenCalledTimes(1);
    expect(verifySignature).toHaveBeenCalledWith(
      'secret-99', expect.any(String), `${'A'.repeat(43)}=`,
    );
    expect(executionCtx.waitUntil).toHaveBeenCalledTimes(1);
  });

  test('fails closed for an unknown destination without testing other tenant secrets', async () => {
    vi.mocked(verifySignature).mockResolvedValue(true);
    const executionCtx = {
      waitUntil: vi.fn(), passThroughOnException: vi.fn(), props: {},
    } as unknown as ExecutionContext;
    const response = await setupApp().request('/webhook', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Line-Signature': `${'A'.repeat(43)}=`,
      },
      body: JSON.stringify({ destination: 'unknown-bot', events: [] }),
    }, { ...baseEnv, DB: withWebhookIdentity(emptyDb, null) }, executionCtx);

    expect(response.status).toBe(200);
    expect(verifySignature).not.toHaveBeenCalled();
    expect(executionCtx.waitUntil).not.toHaveBeenCalled();
  });

  test('derives the tenant account from destination and reads both credentials from the store', async () => {
    vi.mocked(verifySignature).mockResolvedValue(true);
    vi.mocked(readLineCredential).mockImplementation(async (_db, _rootSecret, input) =>
      input.kind === 'channel_secret' ? 'stored-secret' : 'stored-token');
    const db = withWebhookIdentity(emptyDb, {
      botUserId: 'bot',
      accountId: 'account-a',
      tenantId: 'tenant-a',
      channelSecret: 'legacy-secret',
      channelAccessToken: 'legacy-token',
    });
    const executionCtx = {
      waitUntil: vi.fn(), passThroughOnException: vi.fn(), props: {},
    } as unknown as ExecutionContext;

    const response = await setupApp().request('/webhook', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Line-Signature': `${'A'.repeat(43)}=`,
      },
      body: JSON.stringify({ destination: 'bot', events: [] }),
    }, { ...baseEnv, DB: db }, executionCtx);

    expect(response.status).toBe(200);
    expect(readLineCredential).toHaveBeenNthCalledWith(1, db, 'root-key-for-webhook-tests-v1', {
      tenantId: 'tenant-a', lineAccountId: 'account-a', kind: 'channel_secret',
    });
    expect(readLineCredential).toHaveBeenNthCalledWith(2, db, 'root-key-for-webhook-tests-v1', {
      tenantId: 'tenant-a', lineAccountId: 'account-a', kind: 'channel_access_token',
    });
    expect(verifySignature).toHaveBeenCalledWith(
      'stored-secret', expect.any(String), `${'A'.repeat(43)}=`,
    );
    expect(LineClient).toHaveBeenCalledWith('stored-token');
    expect(executionCtx.waitUntil).toHaveBeenCalledOnce();
  });

  test.each([
    ['missing encryption key', undefined],
    ['corrupt credential', 'corrupt'],
  ])('fails closed for %s without verification or event processing', async (_label, mode) => {
    vi.mocked(verifySignature).mockResolvedValue(true);
    if (mode === undefined) {
      vi.mocked(readLineCredential).mockResolvedValue('should-not-be-read');
    } else {
      vi.mocked(readLineCredential).mockResolvedValue(null);
    }
    const db = withWebhookIdentity(emptyDb, {
      botUserId: 'bot',
      accountId: 'account-a',
      tenantId: 'tenant-a',
      channelSecret: 'legacy-secret',
      channelAccessToken: 'legacy-token',
    });
    const executionCtx = {
      waitUntil: vi.fn(), passThroughOnException: vi.fn(), props: {},
    } as unknown as ExecutionContext;

    const response = await setupApp().request('/webhook', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Line-Signature': `${'A'.repeat(43)}=`,
      },
      body: JSON.stringify({ destination: 'bot', events: [] }),
    }, {
      ...baseEnv,
      DB: db,
      LINE_CREDENTIAL_KEY_V1: mode === undefined ? undefined : 'root-key-for-webhook-tests-v1',
    }, executionCtx);

    expect(response.status).toBe(200);
    expect(verifySignature).not.toHaveBeenCalled();
    expect(LineClient).not.toHaveBeenCalled();
    expect(executionCtx.waitUntil).not.toHaveBeenCalled();
  });

  test('rejects unsigned or malformed-signature requests without hitting verifySignature or D1', async () => {
    const app = setupApp();
    const res = await app.request(
      '/webhook',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // Missing X-Line-Signature header entirely.
        },
        body: JSON.stringify({ events: [] }),
      },
      baseEnv,
      baseExecutionCtx,
    );
    expect(res.status).toBe(200);
    // Fast-rejected before any crypto / DB work.
    expect(verifySignature).not.toHaveBeenCalled();
  });
});

// Redelivery dedup, durable-before-ACK storage, cron recovery, dead-lettering
// and the retention purge are covered against real SQL (schema + migrations)
// in webhook-durable-inbox.test.ts. These stubs cannot express row state.
describe('POST /webhook — postback events', () => {
  test('fires postback_received with postback.data so IF-THEN automations run on rich menu taps', async () => {
    vi.mocked(verifySignature).mockResolvedValue(true);
    vi.mocked(jstNow).mockReturnValue('2026-07-19T12:00:00.000+09:00');
    vi.mocked(getFriendByLineUserIdForAccount).mockResolvedValue({
      id: 'friend-1',
      line_user_id: 'U-existing',
      display_name: 'Existing Friend',
      picture_url: null,
      status_message: null,
      is_following: 1,
      user_id: null,
      line_account_id: null,
      metadata: '{}',
      first_tracked_link_id: null,
      created_at: '2026-07-19T12:00:00.000+09:00',
      updated_at: '2026-07-19T12:00:00.000+09:00',
    });

    const stmt = {
      bind: vi.fn(),
      run: vi.fn().mockResolvedValue({}),
      all: vi.fn().mockResolvedValue({ results: [] }), // no auto_reply match
    };
    stmt.bind.mockReturnValue(stmt);
    const db = withWebhookIdentity(
      { prepare: vi.fn().mockReturnValue(stmt) } as unknown as D1Database,
    );

    const executionCtx = {
      waitUntil: vi.fn(),
      passThroughOnException: vi.fn(),
      props: {},
    } as unknown as ExecutionContext;

    const app = setupApp();
    const validShapedSignature = 'A'.repeat(43) + '=';
    const res = await app.request(
      '/webhook',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Line-Signature': validShapedSignature,
        },
        body: JSON.stringify({
          destination: 'bot',
          events: [
            {
              type: 'postback',
              replyToken: 'reply-token-postback',
              postback: { data: 'tag:premium' },
              timestamp: Date.now(),
              source: { type: 'user', userId: 'U-existing' },
              webhookEventId: 'event-postback-1',
              deliveryContext: { isRedelivery: false },
              mode: 'active',
            },
          ],
        }),
      },
      { ...baseEnv, DB: db },
      executionCtx,
    );

    expect(res.status).toBe(200);
    const processing = vi.mocked(executionCtx.waitUntil).mock.calls[0]?.[0] as Promise<unknown>;
    await processing;

    // No auto-reply matched — the reply token must be handed to the event bus
    // so automations can still use it for free reply delivery.
    expect(fireEvent).toHaveBeenCalledWith(
      db,
      'postback_received',
      {
        friendId: 'friend-1',
        eventData: { text: 'tag:premium', matched: false },
        replyToken: 'reply-token-postback',
      },
      'env-default-token',
      'account-env',
    );
    expect(lineClientMocks.replyMessage).not.toHaveBeenCalled();
  });

  test('silent auto-reply rule suppresses the reply but still fires postback_received as matched', async () => {
    vi.mocked(verifySignature).mockResolvedValue(true);
    vi.mocked(jstNow).mockReturnValue('2026-07-19T12:00:00.000+09:00');
    vi.mocked(getFriendByLineUserIdForAccount).mockResolvedValue({
      id: 'friend-1',
      line_user_id: 'U-existing',
      display_name: 'Existing Friend',
      picture_url: null,
      status_message: null,
      is_following: 1,
      user_id: null,
      line_account_id: null,
      metadata: '{}',
      first_tracked_link_id: null,
      created_at: '2026-07-19T12:00:00.000+09:00',
      updated_at: '2026-07-19T12:00:00.000+09:00',
    });

    const stmt = {
      bind: vi.fn(),
      run: vi.fn().mockResolvedValue({}),
      all: vi.fn().mockResolvedValue({
        results: [
          {
            id: 'rule-1',
            keyword: 'tag:premium',
            match_type: 'exact',
            response_type: 'silent',
            response_content: '',
            template_id: null,
          },
        ],
      }),
    };
    stmt.bind.mockReturnValue(stmt);
    const db = withWebhookIdentity(
      { prepare: vi.fn().mockReturnValue(stmt) } as unknown as D1Database,
    );

    const executionCtx = {
      waitUntil: vi.fn(),
      passThroughOnException: vi.fn(),
      props: {},
    } as unknown as ExecutionContext;

    const app = setupApp();
    const validShapedSignature = 'A'.repeat(43) + '=';
    const res = await app.request(
      '/webhook',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Line-Signature': validShapedSignature,
        },
        body: JSON.stringify({
          destination: 'bot',
          events: [
            {
              type: 'postback',
              replyToken: 'reply-token-postback',
              postback: { data: 'tag:premium' },
              timestamp: Date.now(),
              source: { type: 'user', userId: 'U-existing' },
              webhookEventId: 'event-postback-2',
              deliveryContext: { isRedelivery: false },
              mode: 'active',
            },
          ],
        }),
      },
      { ...baseEnv, DB: db },
      executionCtx,
    );

    expect(res.status).toBe(200);
    const processing = vi.mocked(executionCtx.waitUntil).mock.calls[0]?.[0] as Promise<unknown>;
    await processing;

    // Silent rule: no reply sent, but matched=true and the unconsumed reply
    // token still reaches the event bus (rich menu tap → silent + add_tag flow).
    expect(lineClientMocks.replyMessage).not.toHaveBeenCalled();
    expect(fireEvent).toHaveBeenCalledWith(
      db,
      'postback_received',
      {
        friendId: 'friend-1',
        eventData: { text: 'tag:premium', matched: true },
        replyToken: 'reply-token-postback',
      },
      'env-default-token',
      'account-env',
    );
  });
});

describe('POST /webhook — first-contact existing friends', () => {
  test('auto-registers an unknown text-message sender without firing friend_add handling', async () => {
    vi.mocked(verifySignature).mockResolvedValue(true);
    vi.mocked(getFriendByLineUserIdForAccount).mockResolvedValue(null);
    vi.mocked(jstNow).mockReturnValue('2026-06-18T12:00:00.000+09:00');
    lineClientMocks.getProfile.mockResolvedValue({
      userId: 'U-existing',
      displayName: 'Existing Friend',
      pictureUrl: 'https://example.com/profile.jpg',
      statusMessage: 'hello',
    });
    vi.mocked(upsertFriend).mockResolvedValue({
      id: 'friend-1',
      line_user_id: 'U-existing',
      display_name: 'Existing Friend',
      picture_url: 'https://example.com/profile.jpg',
      status_message: 'hello',
      is_following: 1,
      user_id: null,
      line_account_id: null,
      metadata: '{}',
      first_tracked_link_id: null,
      created_at: '2026-06-18T12:00:00.000+09:00',
      updated_at: '2026-06-18T12:00:00.000+09:00',
    });
    vi.mocked(upsertChatOnMessage).mockResolvedValue({
      id: 'chat-1',
      friend_id: 'friend-1',
      operator_id: null,
      status: 'unread',
      notes: null,
      last_message_at: '2026-06-18T12:00:00.000+09:00',
      created_at: '2026-06-18T12:00:00.000+09:00',
      updated_at: '2026-06-18T12:00:00.000+09:00',
    });

    const stmt = {
      bind: vi.fn(),
      run: vi.fn().mockResolvedValue({}),
      all: vi.fn().mockResolvedValue({ results: [] }),
    };
    stmt.bind.mockReturnValue(stmt);
    const db = withWebhookIdentity(
      { prepare: vi.fn().mockReturnValue(stmt) } as unknown as D1Database,
    );

    const executionCtx = {
      waitUntil: vi.fn(),
      passThroughOnException: vi.fn(),
      props: {},
    } as unknown as ExecutionContext;

    const app = setupApp();
    const validShapedSignature = 'A'.repeat(43) + '=';
    const res = await app.request(
      '/webhook',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Line-Signature': validShapedSignature,
        },
        body: JSON.stringify({
          destination: 'bot',
          events: [
            {
              type: 'message',
              replyToken: 'reply-token',
              message: { type: 'text', id: 'message-1', text: 'こんにちは' },
              timestamp: Date.now(),
              source: { type: 'user', userId: 'U-existing' },
              webhookEventId: 'event-1',
              deliveryContext: { isRedelivery: false },
              mode: 'active',
            },
          ],
        }),
      },
      { ...baseEnv, DB: db },
      executionCtx,
    );

    expect(res.status).toBe(200);
    const processing = vi.mocked(executionCtx.waitUntil).mock.calls[0]?.[0] as Promise<unknown>;
    await processing;

    expect(lineClientMocks.getProfile).toHaveBeenCalledWith('U-existing');
    expect(upsertFriend).toHaveBeenCalledWith(db, {
      lineUserId: 'U-existing',
      lineAccountId: 'account-env',
      displayName: 'Existing Friend',
      pictureUrl: 'https://example.com/profile.jpg',
      statusMessage: 'hello',
    });
    expect(upsertChatOnMessage).toHaveBeenCalledWith(db, 'friend-1');
    expect(stmt.bind.mock.calls.some((values: unknown[]) => values[3] === 'account-env')).toBe(true);
    expect(fireEvent).toHaveBeenCalledWith(
      db,
      'message_received',
      expect.objectContaining({ friendId: 'friend-1' }),
      'env-default-token',
      'account-env',
    );
    expect(applyMileageRulesForEvent).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ eventType: 'message_received', friendId: 'friend-1' }),
    );
    expect(getScenariosForAccount).not.toHaveBeenCalled();
    expect(enrollFriendInScenario).not.toHaveBeenCalled();

    // Keep the unrelated DB stubs quiet but type-checked as mocked imports.
    expect(updateFriendFollowStatus).not.toHaveBeenCalled();
    expect(getScenarioSteps).not.toHaveBeenCalled();
    expect(advanceFriendScenario).not.toHaveBeenCalled();
    expect(completeFriendScenario).not.toHaveBeenCalled();
    expect(computeNextDeliveryAt).not.toHaveBeenCalled();
    expect(resolveStepContent).not.toHaveBeenCalled();
    expect(addTagToFriend).not.toHaveBeenCalled();
    expect(getEntryRouteByRefCode).not.toHaveBeenCalled();
    expect(getMessageTemplateById).not.toHaveBeenCalled();
  });
});

describe('POST /webhook — cross-account credentials', () => {
  function crossAccountDb(target: {
    tenantId: string;
    lineAccountId: string;
    lineUserId: string;
    legacyToken?: string;
  }) {
    const statements = new Map<string, {
      bind: ReturnType<typeof vi.fn>;
      first: ReturnType<typeof vi.fn>;
      all: ReturnType<typeof vi.fn>;
      run: ReturnType<typeof vi.fn>;
    }>();
    const db = {
      prepare(sql: string) {
        const statement = {
          bind: vi.fn(),
          first: vi.fn().mockResolvedValue(
            sql.includes('SELECT user_id FROM friends') ? { user_id: 'user-1' } : null,
          ),
          all: vi.fn().mockResolvedValue(
            sql.includes('SELECT f.provider_line_user_id')
              ? { results: [{
                  line_user_id: target.lineUserId,
                  line_account_id: target.lineAccountId,
                  tenant_id: target.tenantId,
                  channel_access_token: target.legacyToken ?? 'legacy-target-token',
                }] }
              : { results: [] },
          ),
          run: vi.fn().mockResolvedValue({}),
        };
        statement.bind.mockReturnValue(statement);
        statements.set(sql, statement);
        return statement;
      },
    } as unknown as D1Database;
    return { db: withWebhookIdentity(db, {
      botUserId: 'bot',
      accountId: 'account-a',
      tenantId: 'tenant-a',
      channelSecret: 'legacy-secret',
      channelAccessToken: 'legacy-token',
    }), statements };
  }

  async function deliverCrossAccount(db: D1Database) {
    vi.mocked(verifySignature).mockResolvedValue(true);
    vi.mocked(getFriendByLineUserIdForAccount).mockResolvedValue({
      id: 'friend-1',
      line_user_id: 'U-source',
      display_name: 'Source Friend',
      picture_url: null,
      status_message: null,
      is_following: 1,
      user_id: null,
      line_account_id: 'account-a',
      metadata: '{}',
      first_tracked_link_id: null,
      created_at: '2026-08-18T00:00:00.000Z',
      updated_at: '2026-08-18T00:00:00.000Z',
    });
    const executionCtx = {
      waitUntil: vi.fn(), passThroughOnException: vi.fn(), props: {},
    } as unknown as ExecutionContext;
    const response = await setupApp().request('/webhook', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Line-Signature': `${'A'.repeat(43)}=`,
      },
      body: JSON.stringify({ destination: 'bot', events: [{
        type: 'message',
        replyToken: 'reply-token',
        message: { type: 'text', id: 'message-1', text: '体験を完了する' },
        source: { type: 'user', userId: 'U-source' },
      }] }),
    }, { ...baseEnv, DB: db }, executionCtx);
    await (vi.mocked(executionCtx.waitUntil).mock.calls[0]?.[0] as Promise<unknown>);
    expect(response.status).toBe(200);
  }

  test('resolves each same-tenant target token from the encrypted store', async () => {
    vi.mocked(readLineCredential).mockImplementation(async (_db, _rootSecret, input) => {
      if (input.kind === 'channel_secret') return 'stored-source-secret';
      return input.lineAccountId === 'target-account' ? 'stored-target-token' : 'stored-source-token';
    });
    const { db, statements } = crossAccountDb({
      tenantId: 'tenant-a', lineAccountId: 'target-account', lineUserId: 'U-target',
    });

    await deliverCrossAccount(db);

    const targetQuery = [...statements.entries()].find(([sql]) =>
      sql.includes('SELECT f.provider_line_user_id'))?.[0] ?? '';
    expect(targetQuery).toContain('tenant_line_accounts');
    expect(targetQuery).not.toContain('channel_access_token');
    expect(readLineCredential).toHaveBeenCalledWith(db, 'root-key-for-webhook-tests-v1', {
      tenantId: 'tenant-a', lineAccountId: 'target-account', kind: 'channel_access_token',
    });
    expect(LineClient).toHaveBeenNthCalledWith(2, 'stored-target-token');
    expect(lineClientMocks.pushMessage).toHaveBeenCalledWith('U-target', expect.any(Array));
  });

  test('does not notify a target mapped to another tenant', async () => {
    vi.mocked(readLineCredential).mockImplementation(async (_db, _rootSecret, input) =>
      input.kind === 'channel_secret' ? 'stored-source-secret' : 'stored-token');
    const { db } = crossAccountDb({
      tenantId: 'tenant-b', lineAccountId: 'target-account', lineUserId: 'U-target',
    });

    await deliverCrossAccount(db);

    expect(readLineCredential).not.toHaveBeenCalledWith(db, 'root-key-for-webhook-tests-v1', {
      tenantId: 'tenant-b', lineAccountId: 'target-account', kind: 'channel_access_token',
    });
    expect(lineClientMocks.pushMessage).not.toHaveBeenCalled();
    expect(lineClientMocks.replyMessage).not.toHaveBeenCalled();
  });
});
