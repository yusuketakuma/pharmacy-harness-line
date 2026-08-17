import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  claim: vi.fn(),
  acknowledge: vi.fn(),
  listEvents: vi.fn(),
}));

vi.mock('./service.js', () => ({
  listActivityNotifications: mocks.list,
  claimActivityNotification: mocks.claim,
  acknowledgeActivityNotification: mocks.acknowledge,
  listActivityNotificationEvents: mocks.listEvents,
}));

import { activityNotificationRoutes } from './routes.js';

const env = { DB: {} as D1Database };

function app(withStaff = true) {
  const root = new Hono<{
    Bindings: { DB: D1Database };
    Variables: { staff: { id: string; name: string; role: 'admin' } | undefined };
  }>();
  root.use('*', async (c, next) => {
    if (withStaff) c.set('staff', { id: 'staff-1', name: 'Staff', role: 'admin' });
    await next();
  });
  root.route('/', activityNotificationRoutes);
  return root;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.list.mockResolvedValue([{ id: 'notification-1', status: 'unread' }]);
  mocks.claim.mockResolvedValue({ id: 'notification-1', status: 'claimed' });
  mocks.acknowledge.mockResolvedValue({ id: 'notification-1', status: 'acknowledged' });
  mocks.listEvents.mockResolvedValue([{ id: 'event-1', event_type: 'created' }]);
});

describe('pharmacy activity notification routes', () => {
  it('requires both authentication and an account scope for inbox reads', async () => {
    await expect(app(false).request('/api/custom/pharmacy/activity-notifications?line_account_id=account-1', {}, env))
      .resolves.toHaveProperty('status', 401);
    const response = await app().request('/api/custom/pharmacy/activity-notifications', {}, env);
    expect(response.status).toBe(400);
    expect(mocks.list).not.toHaveBeenCalled();
  });

  it('lists only the authenticated staff recipient within the requested account', async () => {
    const response = await app().request(
      '/api/custom/pharmacy/activity-notifications?line_account_id=account-1&status=unread&limit=20',
      {}, env,
    );
    expect(response.status).toBe(200);
    expect(mocks.list).toHaveBeenCalledWith(
      env.DB, 'account-1', 'staff-1', { status: 'unread', limit: 20 },
    );
    await expect(response.json()).resolves.toEqual({ notifications: [
      { id: 'notification-1', status: 'unread' },
    ] });
  });

  it('uses the authenticated staff id for claim and acknowledgement', async () => {
    const claim = await app().request(
      '/api/custom/pharmacy/activity-notifications/notification-1/claim?line_account_id=account-1',
      { method: 'POST' }, env,
    );
    expect(claim.status).toBe(200);
    expect(mocks.claim).toHaveBeenCalledWith(env.DB, 'account-1', 'notification-1', 'staff-1');

    const ack = await app().request(
      '/api/custom/pharmacy/activity-notifications/notification-1/ack?line_account_id=account-1',
      { method: 'POST' }, env,
    );
    expect(ack.status).toBe(200);
    expect(mocks.acknowledge).toHaveBeenCalledWith(env.DB, 'account-1', 'notification-1', 'staff-1');
  });

  it('does not expose internal conflict details', async () => {
    mocks.claim.mockRejectedValue(new Error('activity notification claim conflict'));
    const response = await app().request(
      '/api/custom/pharmacy/activity-notifications/notification-1/claim?line_account_id=account-1',
      { method: 'POST' }, env,
    );
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: 'Notification state changed; retry' });
  });
});
