import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const mocks = vi.hoisted(() => ({ access: vi.fn(), list: vi.fn(), acknowledge: vi.fn() }));
vi.mock('../operations-access.js', () => ({ canAccessPharmacyOperationsAccount: mocks.access }));
vi.mock('./repository.js', () => ({
  listActivityNotifications: mocks.list,
  acknowledgeActivityNotification: mocks.acknowledge,
}));
import { activityNotificationRoutes } from './routes.js';

const env = { DB: {} as D1Database, LINE_CHANNEL_ID: 'channel-a' };
function app(withStaff = true) {
  const root = new Hono<any>();
  root.use('*', async (c, next) => {
    if (withStaff) c.set('staff', { id: 'staff-a', name: 'Staff', role: 'admin' });
    await next();
  });
  root.route('/', activityNotificationRoutes);
  return root;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.access.mockResolvedValue(true);
  mocks.list.mockResolvedValue([{ id: 'notification-1', acknowledged_at: null }]);
  mocks.acknowledge.mockResolvedValue({ id: 'notification-1', acknowledged_by: 'staff-a' });
});

describe('shared pharmacy activity routes', () => {
  it('rejects cross-account reads before querying the inbox', async () => {
    mocks.access.mockResolvedValue(false);
    const response = await app().request(
      '/api/custom/pharmacy/activity-notifications?line_account_id=account-b', {}, env,
    );
    expect(response.status).toBe(403);
    expect(mocks.list).not.toHaveBeenCalled();
  });

  it('acknowledges one shared account item without a claim step', async () => {
    const response = await app().request(
      '/api/custom/pharmacy/activity-notifications/notification-1/ack?line_account_id=account-a',
      { method: 'POST' }, env,
    );
    expect(response.status).toBe(200);
    expect(mocks.acknowledge).toHaveBeenCalledWith(env.DB, 'account-a', 'notification-1', 'staff-a');
  });
});
