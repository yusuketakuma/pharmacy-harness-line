import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { LineClient, Message } from '@line-crm/line-sdk';
import type { Friend } from '@line-crm/db';

const dbMocks = vi.hoisted(() => ({
  getLineAccountById: vi.fn(),
  getTemplateById: vi.fn(),
}));

const logOutgoingMessage = vi.hoisted(() => vi.fn());
const deliverTrackedLineReply = vi.hoisted(() => vi.fn(async (params: { send: () => Promise<void> }) => {
  await params.send();
  return 'sent';
}));

vi.mock('@line-crm/db', () => ({
  getLineAccountById: dbMocks.getLineAccountById,
  getTemplateById: dbMocks.getTemplateById,
}));

vi.mock('./event-bus.js', () => ({ logOutgoingMessage }));
vi.mock('./outbound-line-delivery.js', () => ({ deliverTrackedLineReply }));

vi.mock('./step-delivery.js', () => ({
  resolveMetadata: vi.fn().mockResolvedValue({}),
  expandVariables: vi.fn((content: string) => content),
  isDeterministicInvalidReplyToken: vi.fn((error: unknown) => error instanceof Error
    && error.message.includes('400')
    && error.message.includes('Invalid reply token')),
  buildMessage: vi.fn((messageType: string, content: string) => {
    if (messageType === 'flex') {
      return { type: 'flex', altText: 'あなたのHarnessマイル', contents: JSON.parse(content) };
    }
    return { type: 'text', text: content };
  }),
  messageToLogPayload: vi.fn((message: Message) => message.type === 'flex'
    ? { messageType: 'flex', content: JSON.stringify(message.contents) }
    : { messageType: 'text', content: 'text' }),
}));

import { matchAndReply } from './auto-reply.js';

const friend: Friend = {
  id: 'friend-1',
  line_user_id: 'U123',
  display_name: 'テストユーザー',
  picture_url: null,
  status_message: null,
  is_following: 1,
  user_id: 'user-1',
  line_account_id: 'account-1',
  metadata: '{}',
  first_tracked_link_id: null,
  created_at: '2026-08-11T10:00:00+09:00',
  updated_at: '2026-08-11T10:00:00+09:00',
};

const mileageFlex = JSON.stringify({
  type: 'bubble',
  footer: {
    type: 'box',
    layout: 'vertical',
    contents: [{
      type: 'button',
      action: {
        type: 'uri',
        label: 'マイルを確認する',
        uri: 'https://liff.line.me/{{liff_id}}/?page=affiliate&liffId={{liff_id}}',
      },
    }],
  },
});

function fakeDb() {
  const statement = {
    bind: vi.fn(),
    all: vi.fn().mockResolvedValue({
      results: [{
        id: 'builtin-mileage-wallet-keyword',
        keyword: 'マイル',
        match_type: 'exact',
        response_type: 'flex',
        response_content: mileageFlex,
        template_id: null,
        line_account_id: null,
        is_active: 1,
        created_at: '2026-08-11T10:00:00+09:00',
      }],
    }),
  };
  statement.bind.mockReturnValue(statement);
  return { prepare: vi.fn().mockReturnValue(statement) } as unknown as D1Database;
}

beforeEach(() => {
  vi.clearAllMocks();
  dbMocks.getLineAccountById.mockResolvedValue({
    id: 'account-1',
    is_active: 1,
    liff_id: '123456-AccountOne',
  });
});

describe('mileage keyword auto reply', () => {
  test('fences a durable reply before calling LINE', async () => {
    const proxyReply = vi.fn().mockResolvedValue(undefined);
    const db = fakeDb();

    const result = await matchAndReply(
      db,
      { replyMessage: vi.fn() } as unknown as LineClient,
      friend,
      'マイル',
      'reply-token',
      {
        tenantId: 'tenant-1',
        eventKey: 'event-1',
        lineAccountId: 'account-1',
        liffUrl: 'https://liff.line.me/default-id',
        replyMessage: proxyReply,
      },
    );

    expect(result).toEqual({ matched: true, replyTokenConsumed: true });
    expect(deliverTrackedLineReply).toHaveBeenCalledWith(expect.objectContaining({
      db,
      tenantId: 'tenant-1',
      lineAccountId: 'account-1',
      friendId: 'friend-1',
      source: 'auto_reply',
      operationId: expect.stringMatching(/^[0-9a-f-]{36}$/u),
    }));
    expect(proxyReply).toHaveBeenCalledOnce();
    expect(logOutgoingMessage).not.toHaveBeenCalled();
  });

  test('returns a pre-LINE ledger failure to the durable inbox', async () => {
    deliverTrackedLineReply.mockRejectedValueOnce(new Error('synthetic D1 prepare failure'));
    const proxyReply = vi.fn();

    await expect(matchAndReply(
      fakeDb(),
      { replyMessage: vi.fn() } as unknown as LineClient,
      friend,
      'マイル',
      'reply-token',
      {
        tenantId: 'tenant-1',
        eventKey: 'event-1',
        lineAccountId: 'account-1',
        liffUrl: 'https://liff.line.me/default-id',
        replyMessage: proxyReply,
      },
    )).rejects.toThrow('synthetic D1 prepare failure');

    expect(proxyReply).not.toHaveBeenCalled();
  });

  test('treats a deterministically rejected reply token as terminal', async () => {
    deliverTrackedLineReply.mockResolvedValueOnce('not_sent');
    const proxyReply = vi.fn();

    await expect(matchAndReply(
      fakeDb(),
      { replyMessage: vi.fn() } as unknown as LineClient,
      friend,
      'マイル',
      'reply-token',
      {
        tenantId: 'tenant-1',
        eventKey: 'event-1',
        lineAccountId: 'account-1',
        liffUrl: 'https://liff.line.me/default-id',
        replyMessage: proxyReply,
      },
    )).resolves.toEqual({ matched: true, replyTokenConsumed: true });

    expect(proxyReply).not.toHaveBeenCalled();
    const options = deliverTrackedLineReply.mock.calls[0]?.[0] as {
      isDeterministicRejection?: (error: unknown) => boolean;
    };
    expect(options.isDeterministicRejection?.(
      new Error('LINE API error: 400 Bad Request — Invalid reply token'),
    )).toBe(true);
    expect(options.isDeterministicRejection?.(
      new Error('LINE API error: 500 Internal Server Error'),
    )).toBe(false);
  });

  test('fails closed when durable tenant/account/event scope is missing', async () => {
    const proxyReply = vi.fn();

    await expect(matchAndReply(
      fakeDb(),
      { replyMessage: vi.fn() } as unknown as LineClient,
      friend,
      'マイル',
      'reply-token',
      {
        lineAccountId: 'account-1',
        liffUrl: 'https://liff.line.me/default-id',
        replyMessage: proxyReply,
      },
    )).rejects.toThrow('AUTO_REPLY_DELIVERY_SCOPE_REQUIRED');

    expect(proxyReply).not.toHaveBeenCalled();
    expect(deliverTrackedLineReply).not.toHaveBeenCalled();
    expect(logOutgoingMessage).not.toHaveBeenCalled();
  });

  test.each([
    ['account-1', '111111-AccountOne'],
    ['account-2', '222222-AccountTwo'],
    ['account-3', '333333-AccountThree'],
    ['account-4', '444444-AccountFour'],
  ])('uses the LIFF ID for receiving %s', async (accountId, liffId) => {
    const db = fakeDb();
    const directReply = vi.fn();
    const proxyReply = vi.fn().mockResolvedValue(undefined);
    dbMocks.getLineAccountById.mockResolvedValue({
      id: accountId,
      is_active: 1,
      liff_id: liffId,
    });

    const result = await matchAndReply(
      db,
      { replyMessage: directReply } as unknown as LineClient,
      { ...friend, line_account_id: accountId },
      'マイル',
      'reply-token',
      {
        tenantId: 'tenant-1',
        eventKey: `event-${accountId}`,
        lineAccountId: accountId,
        workerUrl: 'https://worker.example.com',
        liffUrl: 'https://liff.line.me/default-id',
        replyMessage: proxyReply,
      },
    );

    expect(result).toEqual({ matched: true, replyTokenConsumed: true });
    expect(dbMocks.getLineAccountById).toHaveBeenCalledWith(db, accountId);
    expect(directReply).not.toHaveBeenCalled();
    expect(proxyReply).toHaveBeenCalledTimes(1);

    const sent = proxyReply.mock.calls[0][1][0] as Extract<Message, { type: 'flex' }>;
    const contents = sent.contents as {
      footer: { contents: Array<{ action: { uri: string } }> };
    };
    const button = contents.footer.contents[0];
    expect(button.action.uri).toBe(
      `https://liff.line.me/${liffId}/?page=affiliate&liffId=${liffId}`,
    );
    expect(JSON.stringify(sent)).not.toContain('{{liff_id}}');
    expect(logOutgoingMessage).not.toHaveBeenCalled();
  });

  test('does not use the env fallback without an account scope', async () => {
    const proxyReply = vi.fn().mockResolvedValue(undefined);

    await expect(matchAndReply(
      fakeDb(),
      { replyMessage: vi.fn() } as unknown as LineClient,
      { ...friend, line_account_id: null },
      'マイル',
      'reply-token',
      {
        lineAccountId: null,
        liffUrl: 'https://liff.line.me/999999-Default/?existing=1',
        replyMessage: proxyReply,
      },
    )).rejects.toThrow('AUTO_REPLY_DELIVERY_SCOPE_REQUIRED');

    expect(dbMocks.getLineAccountById).not.toHaveBeenCalled();
    expect(proxyReply).not.toHaveBeenCalled();
  });

  test('does not send another account URL when the receiving account has no LIFF ID', async () => {
    dbMocks.getLineAccountById.mockResolvedValue({
      id: 'account-without-liff',
      is_active: 1,
      liff_id: null,
    });
    const proxyReply = vi.fn().mockResolvedValue(undefined);

    const result = await matchAndReply(
      fakeDb(),
      { replyMessage: vi.fn() } as unknown as LineClient,
      { ...friend, line_account_id: 'account-without-liff' },
      'マイル',
      'reply-token',
      {
        tenantId: 'tenant-1',
        eventKey: 'event-without-liff',
        lineAccountId: 'account-without-liff',
        liffUrl: 'https://liff.line.me/main-account-id',
        replyMessage: proxyReply,
      },
    );

    expect(result).toEqual({ matched: true, replyTokenConsumed: false });
    expect(proxyReply).not.toHaveBeenCalled();
  });
});
