import { Hono, type Context } from 'hono';
import { getPharmacyAccountId } from '../account.js';
import { canAccessPharmacyOperationsAccount } from '../operations-access.js';
import {
  acknowledgeActivityNotification,
  listActivityNotifications,
} from './repository.js';

type ActivityEnv = {
  Bindings: { DB: D1Database; LINE_CHANNEL_ID?: string };
  Variables: { staff: { id: string; name: string; role: 'owner' | 'admin' | 'staff' } };
};

export const activityNotificationRoutes = new Hono<ActivityEnv>();

async function authorize(c: Context<ActivityEnv>): Promise<string | Response> {
  const staff = c.get('staff');
  if (!staff) return c.json({ error: 'Unauthorized' }, 401);
  const lineAccountId = getPharmacyAccountId(c);
  if (!lineAccountId) return c.json({ error: 'line_account_id is required' }, 400);
  if (!(await canAccessPharmacyOperationsAccount(
    c.env.DB, staff, lineAccountId, c.env.LINE_CHANNEL_ID,
  ))) return c.json({ error: 'Forbidden' }, 403);
  return lineAccountId;
}

activityNotificationRoutes.get('/api/custom/pharmacy/activity-notifications', async (c) => {
  const account = await authorize(c);
  if (account instanceof Response) return account;
  const acknowledged = c.req.query('acknowledged') === '1';
  const limit = Number(c.req.query('limit') ?? 20);
  if (!Number.isInteger(limit) || limit < 1) return c.json({ error: 'Invalid limit' }, 400);
  return c.json({ notifications: await listActivityNotifications(
    c.env.DB, account, acknowledged, Math.min(limit, 100),
  ) });
});

activityNotificationRoutes.post('/api/custom/pharmacy/activity-notifications/:id/ack', async (c) => {
  const account = await authorize(c);
  if (account instanceof Response) return account;
  const notification = await acknowledgeActivityNotification(
    c.env.DB, account, c.req.param('id'), c.get('staff').id,
  );
  return notification
    ? c.json({ notification })
    : c.json({ error: 'Notification not found' }, 404);
});
