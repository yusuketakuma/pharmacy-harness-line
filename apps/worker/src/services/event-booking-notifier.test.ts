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
import {
  renderEventNotificationText,
  sendEventBookingNotification,
} from './event-booking-notifier.js';

const baseCtx = {
  eventName: 'AAA説明会',
  startsAtJst: '2026-06-01 10:00',
  venueName: '渋谷ベース',
  venueUrl: 'https://maps.example/x',
};

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

test('retry key が無い通知は LINE call 前に拒否する', async () => {
  const fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);

  await expect(sendEventBookingNotification({
    channelAccessToken: 'token',
    toLineUserId: 'U1',
    kind: 'received_pending',
    ctx: baseCtx,
  } as never)).rejects.toThrow('LINE retry key required');
  expect(fetchMock).not.toHaveBeenCalled();
});

test('account-scoped event notification is persisted before the LINE push', async () => {
  await sendEventBookingNotification({
    db: {} as D1Database,
    tenantId: 'tenant-1',
    lineAccountId: 'account-1',
    friendId: 'friend-1',
    channelAccessToken: 'token',
    toLineUserId: 'U1',
    retryKey: 'operation-1',
    kind: 'received_pending',
    ctx: baseCtx,
  });

  expect(outboundDeliveryMocks.deliverTrackedLinePush).toHaveBeenCalledWith(
    expect.objectContaining({
      db: expect.anything(),
      operationId: 'operation-1',
      tenantId: 'tenant-1',
      lineAccountId: 'account-1',
      friendId: 'friend-1',
      messageType: 'text',
      source: 'automation',
      request: expect.objectContaining({ to: 'U1' }),
    }),
  );
  expect(pushMessage).toHaveBeenCalledWith('U1', expect.any(Array), 'operation-1');
});

test('already_sent is treated as a successful event notification', async () => {
  outboundDeliveryMocks.deliverTrackedLinePush.mockResolvedValueOnce('already_sent');

  await expect(sendEventBookingNotification({
    db: {} as D1Database,
    tenantId: 'tenant-1',
    lineAccountId: 'account-1',
    friendId: 'friend-1',
    channelAccessToken: 'token',
    toLineUserId: 'U1',
    retryKey: 'operation-1',
    kind: 'received_pending',
    ctx: baseCtx,
  })).resolves.toBeUndefined();
  expect(pushMessage).not.toHaveBeenCalled();
});

test('unresolved event delivery does not report success', async () => {
  outboundDeliveryMocks.deliverTrackedLinePush.mockResolvedValueOnce('reconciliation_required');

  await expect(sendEventBookingNotification({
    db: {} as D1Database,
    tenantId: 'tenant-1',
    lineAccountId: 'account-1',
    friendId: 'friend-1',
    channelAccessToken: 'token',
    toLineUserId: 'U1',
    retryKey: 'operation-1',
    kind: 'received_pending',
    ctx: baseCtx,
  })).rejects.toThrow('OUTBOUND_LINE_RECONCILIATION_REQUIRED');
});

describe('renderEventNotificationText', () => {
  test('受付（承認待ち）', () => {
    const text = renderEventNotificationText('received_pending', baseCtx);
    expect(text).toContain('イベント申込みを受け付けました');
    expect(text).toContain('AAA説明会');
    expect(text).toContain('2026-06-01 10:00');
    expect(text).toContain('運営の承認をお待ちください');
    expect(text).toContain('渋谷ベース');
  });

  test('受付（即時確定）', () => {
    const text = renderEventNotificationText('received_confirmed', baseCtx);
    expect(text).toContain('予約が確定しました');
    expect(text).toContain('変更・キャンセルは予約履歴画面');
  });

  test('後追い承認確定', () => {
    const text = renderEventNotificationText('confirmed', baseCtx);
    expect(text).toContain('予約が確定しました');
  });

  test('拒否は固定文面（reason は含まない）', () => {
    const text = renderEventNotificationText('rejected', baseCtx);
    expect(text).toContain('お受けできませんでした');
    expect(text).not.toContain('reason');
  });

  test('運営キャンセル', () => {
    const text = renderEventNotificationText('cancelled_by_admin', baseCtx);
    expect(text).toContain('運営側でイベント予約をキャンセル');
    expect(text).toContain('LINE にてご連絡');
  });

  test('前日リマインダ', () => {
    const text = renderEventNotificationText('reminder_day_before', baseCtx);
    expect(text).toContain('明日イベントが開催');
  });

  test('開始 N 時間前リマインダ', () => {
    const text = renderEventNotificationText('reminder_hours_before', {
      ...baseCtx,
      hoursBefore: 2,
    });
    expect(text).toContain('まもなくイベント開始');
    expect(text).toContain('あと 2 時間');
  });

  test('venue が無くてもクラッシュしない', () => {
    const text = renderEventNotificationText('received_pending', {
      eventName: 'X',
      startsAtJst: '2026-06-01 10:00',
    });
    expect(text).toContain('X');
    expect(text).not.toContain('会場:');
  });

  test('venue_url のみ無ければ URL 行が出ない', () => {
    const text = renderEventNotificationText('confirmed', {
      eventName: 'X',
      startsAtJst: '2026-06-01 10:00',
      venueName: '渋谷',
    });
    expect(text).toContain('会場: 渋谷');
    expect(text).not.toContain('https://');
  });
});

describe('renderEventNotificationText — custom extra append', () => {
  const extraConf = '\n当日の Zoom URL: https://us02web.zoom.us/j/123';
  const extraRem = '開始 10 分前に同じ URL からご入室ください';

  test('received_confirmed に confirmationExtra を末尾追記', () => {
    const text = renderEventNotificationText('received_confirmed', {
      ...baseCtx,
      confirmationExtra: extraConf,
    });
    expect(text).toContain('予約が確定しました');
    expect(text.endsWith(extraConf.trim())).toBe(true);
    expect(text).toContain('\n\n' + extraConf.trim());
  });

  test('confirmed (後追い承認) にも confirmationExtra を追記', () => {
    const text = renderEventNotificationText('confirmed', {
      ...baseCtx,
      confirmationExtra: extraConf,
    });
    expect(text.endsWith(extraConf.trim())).toBe(true);
  });

  test('received_pending には confirmationExtra を追記しない', () => {
    const text = renderEventNotificationText('received_pending', {
      ...baseCtx,
      confirmationExtra: extraConf,
    });
    expect(text).not.toContain(extraConf.trim());
  });

  test('rejected / cancelled_by_admin にも confirmationExtra を追記しない', () => {
    const rj = renderEventNotificationText('rejected', { ...baseCtx, confirmationExtra: extraConf });
    const ca = renderEventNotificationText('cancelled_by_admin', { ...baseCtx, confirmationExtra: extraConf });
    expect(rj).not.toContain(extraConf.trim());
    expect(ca).not.toContain(extraConf.trim());
  });

  test('reminder_day_before に reminderExtra を末尾追記', () => {
    const text = renderEventNotificationText('reminder_day_before', {
      ...baseCtx,
      reminderExtra: extraRem,
    });
    expect(text).toContain('明日イベントが開催');
    expect(text.endsWith(extraRem)).toBe(true);
  });

  test('reminder_hours_before に reminderExtra を末尾追記', () => {
    const text = renderEventNotificationText('reminder_hours_before', {
      ...baseCtx,
      hoursBefore: 2,
      reminderExtra: extraRem,
    });
    expect(text).toContain('まもなくイベント開始');
    expect(text.endsWith(extraRem)).toBe(true);
  });

  test('extra が null / 空文字なら追記しない', () => {
    const nullText = renderEventNotificationText('received_confirmed', {
      ...baseCtx,
      confirmationExtra: null,
    });
    const emptyText = renderEventNotificationText('received_confirmed', {
      ...baseCtx,
      confirmationExtra: '',
    });
    const baseText = renderEventNotificationText('received_confirmed', baseCtx);
    expect(nullText).toBe(baseText);
    expect(emptyText).toBe(baseText);
  });

  test('reminder kind に confirmationExtra を渡しても無視', () => {
    const text = renderEventNotificationText('reminder_day_before', {
      ...baseCtx,
      confirmationExtra: extraConf,
    });
    expect(text).not.toContain(extraConf.trim());
  });
});
