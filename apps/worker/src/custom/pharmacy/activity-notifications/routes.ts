import { Hono, type Context } from 'hono'
import { getPharmacyAccountId } from '../account.js'
import {
  acknowledgeActivityNotification,
  claimActivityNotification,
  listActivityNotificationEvents,
  listActivityNotifications,
} from './service.js'
import type { ActivityNotificationStatus } from './repository.js'

type ActivityEnv = {
  Bindings: { DB: D1Database }
  Variables: { staff: { id: string; name: string; role: 'owner' | 'admin' | 'staff' } }
}

export const activityNotificationRoutes = new Hono<ActivityEnv>()
const STATUSES = new Set<ActivityNotificationStatus>(['unread', 'claimed', 'acknowledged'])

function accountId(c: Context<ActivityEnv>): string | null {
  return getPharmacyAccountId(c)
}

async function handleError<T>(c: Context<ActivityEnv>, task: () => Promise<T>): Promise<Response> {
  try {
    return c.json(await task())
  } catch (error) {
    const message = error instanceof Error ? error.message : ''
    if (message.includes('not assigned')) return c.json({ error: 'Forbidden' }, 403)
    if (message.includes('not found')) return c.json({ error: 'Notification not found' }, 404)
    if (message.includes('conflict')) return c.json({ error: 'Notification state changed; retry' }, 409)
    throw error
  }
}

activityNotificationRoutes.get('/api/custom/pharmacy/activity-notifications', async (c) => {
  const staff = c.get('staff')
  const lineAccountId = accountId(c)
  if (!staff) return c.json({ error: 'Unauthorized' }, 401)
  if (!lineAccountId) return c.json({ error: 'line_account_id is required' }, 400)
  const statusParam = c.req.query('status') ?? 'unread'
  if (!STATUSES.has(statusParam as ActivityNotificationStatus)) return c.json({ error: 'Invalid status' }, 400)
  const limit = Number(c.req.query('limit') ?? 20)
  if (!Number.isInteger(limit) || limit < 1) return c.json({ error: 'Invalid limit' }, 400)
  return handleError(c, async () => ({ notifications: await listActivityNotifications(
    c.env.DB, lineAccountId, staff.id,
    { status: statusParam as ActivityNotificationStatus, limit: Math.min(100, limit) },
  ) }))
})

activityNotificationRoutes.post('/api/custom/pharmacy/activity-notifications/:id/claim', async (c) => {
  const staff = c.get('staff')
  const lineAccountId = accountId(c)
  if (!staff) return c.json({ error: 'Unauthorized' }, 401)
  if (!lineAccountId) return c.json({ error: 'line_account_id is required' }, 400)
  return handleError(c, async () => {
    const notification = await claimActivityNotification(c.env.DB, lineAccountId, c.req.param('id'), staff.id)
    if (!notification) throw new Error('activity notification not found')
    return { notification }
  })
})

activityNotificationRoutes.post('/api/custom/pharmacy/activity-notifications/:id/ack', async (c) => {
  const staff = c.get('staff')
  const lineAccountId = accountId(c)
  if (!staff) return c.json({ error: 'Unauthorized' }, 401)
  if (!lineAccountId) return c.json({ error: 'line_account_id is required' }, 400)
  return handleError(c, async () => {
    const notification = await acknowledgeActivityNotification(c.env.DB, lineAccountId, c.req.param('id'), staff.id)
    if (!notification) throw new Error('activity notification not found')
    return { notification }
  })
})

activityNotificationRoutes.get('/api/custom/pharmacy/activity-notifications/:id/events', async (c) => {
  const staff = c.get('staff')
  const lineAccountId = accountId(c)
  if (!staff) return c.json({ error: 'Unauthorized' }, 401)
  if (!lineAccountId) return c.json({ error: 'line_account_id is required' }, 400)
  return handleError(c, async () => ({ events: await listActivityNotificationEvents(
    c.env.DB, lineAccountId, c.req.param('id'), staff.id,
  ) }))
})
