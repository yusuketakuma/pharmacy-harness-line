import { afterEach, describe, expect, test, vi } from 'vitest';

const outboundDeliveryMocks = vi.hoisted(() => ({
  deliverTrackedLinePush: vi.fn(async (params: {
    operationId: string;
    request: { to: string; messages: unknown[] };
    send: (
      request: { to: string; messages: unknown[] },
      retryKey: string,
    ) => Promise<void>;
  }) => {
    await params.send(params.request, params.operationId);
    return 'sent';
  }),
}));
const pushMessage = vi.hoisted(() => vi.fn());

vi.mock('./outbound-line-delivery.js', () => outboundDeliveryMocks);
vi.mock('@line-crm/line-sdk', () => ({
  LineClient: class {
    pushMessage = pushMessage;
  },
}));

import { renderNotificationText, sendBookingNotification } from './booking-notifier.js';

const ctx = {
  menuName: 'カット',
  staffName: '山田',
  startsAtJst: '2026-05-10 14:00',
  hoursBefore: 2,
};

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

test('retry key が無い通知は LINE call 前に拒否する', async () => {
  const fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);

  await expect(sendBookingNotification({
    channelAccessToken: 'token',
    toLineUserId: 'U1',
    kind: 'requested',
    ctx,
  } as never)).rejects.toThrow('LINE retry key required');
  expect(fetchMock).not.toHaveBeenCalled();
});

test('account-scoped booking notification is persisted before the LINE push', async () => {
  const db = {} as D1Database;

  await sendBookingNotification({
    db,
    tenantId: 'tenant-1',
    lineAccountId: 'account-1',
    friendId: 'friend-1',
    channelAccessToken: 'token',
    toLineUserId: 'U1',
    retryKey: 'operation-1',
    kind: 'requested',
    ctx,
  });

  expect(outboundDeliveryMocks.deliverTrackedLinePush).toHaveBeenCalledWith(
    expect.objectContaining({
      db,
      operationId: 'operation-1',
      tenantId: 'tenant-1',
      lineAccountId: 'account-1',
      friendId: 'friend-1',
      messageType: 'text',
      source: 'automation',
      request: expect.objectContaining({ to: 'U1' }),
    }),
  );
  expect(pushMessage).toHaveBeenCalledWith(
    'U1',
    expect.any(Array),
    'operation-1',
  );
});

describe('renderNotificationText', () => {
  test('受付', () => {
    const text = renderNotificationText('requested', ctx);
    expect(text).toContain('予約リクエストを受け付けました');
    expect(text).toContain('カット');
    expect(text).toContain('山田');
    expect(text).toContain('2026-05-10 14:00');
    expect(text).toContain('お店からの返信をお待ちください');
  });
  test('承認', () => {
    const text = renderNotificationText('approved', ctx);
    expect(text).toContain('予約が確定しました');
    expect(text).toContain('変更・キャンセルはお店に直接ご連絡ください');
  });
  test('拒否', () => {
    expect(renderNotificationText('rejected', ctx)).toContain('お取りできませんでした');
  });
  test('期限切れ', () => {
    expect(renderNotificationText('expired', ctx)).toContain('期限切れ');
  });
  test('前日リマインダ', () => {
    expect(renderNotificationText('day_before', ctx)).toContain('明日のご予約');
  });
  test('当日 N 時間前', () => {
    const t = renderNotificationText('hours_before', ctx);
    expect(t).toContain('本日のご予約まであと 2 時間');
  });
});
