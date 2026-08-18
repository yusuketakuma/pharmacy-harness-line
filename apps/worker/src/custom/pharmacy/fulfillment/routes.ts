import { Hono } from 'hono';
import {
  createFulfillmentQuote,
  getLatestFulfillmentQuote,
  type FulfillmentMethod,
  type FulfillmentQuoteInput,
  type FulfillmentStatus,
} from './repository.js';
import { getPharmacyAccountId } from '../account.js';
import { readJsonObject } from '../json.js';
import { enqueueActivityForAccount } from '../activity-notifications/repository.js'; // custom:pharmacy-activity-notifications
import { canAccessPharmacyOperationsAccount } from '../operations-access.js';

type FulfillmentEnv = {
  Bindings: { DB: D1Database; LINE_CHANNEL_ID?: string };
  Variables: {
    staff: { id: string; name: string; role: 'owner' | 'admin' | 'staff' };
  };
};

export const fulfillmentRoutes = new Hono<FulfillmentEnv>();

fulfillmentRoutes.use('/api/custom/pharmacy/fulfillment-quotes/*', async (c, next) => {
  const staff = c.get('staff');
  const lineAccountId = getPharmacyAccountId(c);
  if (!lineAccountId) return c.json({ error: 'line_account_id is required' }, 400);
  if (!staff) return c.json({ error: 'Unauthorized' }, 401);
  if (!(await canAccessPharmacyOperationsAccount(
    c.env.DB, staff, lineAccountId, c.env.LINE_CHANNEL_ID,
  ))) return c.json({ error: 'Forbidden' }, 403);
  return next();
});

function toQuoteInput(body: Record<string, unknown>): FulfillmentQuoteInput | null {
  if (
    typeof body.decision !== 'string' || !Array.isArray(body.reasonCodes) ||
    !Array.isArray(body.requirements) ||
    !(
      body.estimatedReadyAt === null ||
      (typeof body.estimatedReadyAt === 'string' && Number.isFinite(Date.parse(body.estimatedReadyAt)))
    ) ||
    !(body.validUntil === null ||
      (typeof body.validUntil === 'string' && Number.isFinite(Date.parse(body.validUntil)))) ||
    (body.status !== undefined && typeof body.status !== 'string') ||
    (body.fulfillmentMethod !== undefined && body.fulfillmentMethod !== null && typeof body.fulfillmentMethod !== 'string') ||
    (body.constraints !== undefined && (!Array.isArray(body.constraints) ||
      body.constraints.some((constraint) => typeof constraint !== 'string'))) ||
    (body.reservationExpiresAt !== undefined && body.reservationExpiresAt !== null &&
      (typeof body.reservationExpiresAt !== 'string' || !Number.isFinite(Date.parse(body.reservationExpiresAt))))
  ) return null;
  return {
    decision: body.decision as FulfillmentQuoteInput['decision'],
    reasonCodes: body.reasonCodes as string[],
    requirements: body.requirements as FulfillmentQuoteInput['requirements'],
    estimatedReadyAt: body.estimatedReadyAt as string | null,
    validUntil: body.validUntil as string | null,
    ...(typeof body.status === 'string' ? { status: body.status as FulfillmentStatus } : {}),
    ...(body.fulfillmentMethod === null || typeof body.fulfillmentMethod === 'string'
      ? { fulfillmentMethod: body.fulfillmentMethod as FulfillmentMethod | null }
      : {}),
    ...(Array.isArray(body.constraints) ? { constraints: body.constraints as string[] } : {}),
    ...(body.reservationExpiresAt === null || typeof body.reservationExpiresAt === 'string'
      ? { reservationExpiresAt: body.reservationExpiresAt as string | null }
      : {}),
  };
}

function mapError(error: unknown): { message: string; status: 400 | 404 | 409 } | null {
  const message = error instanceof Error ? error.message : '';
  if (message === 'fulfillment submission not found') {
    return { message: 'Prescription submission not found', status: 404 };
  }
  if (message === 'invalid fulfillment submission state') {
    return { message: '受付内容を確認できない状態です', status: 409 };
  }
  if (message.includes('invalid fulfillment')) return { message: 'Invalid fulfillment quote', status: 400 };
  if (message.includes('conflict')) return { message: 'Fulfillment quote changed; retry', status: 409 };
  return null;
}

fulfillmentRoutes.get('/api/custom/pharmacy/fulfillment-quotes/:submissionId', async (c) => {
  const lineAccountId = getPharmacyAccountId(c);
  if (!lineAccountId) return c.json({ error: 'line_account_id is required' }, 400);
  if (!c.get('staff')) return c.json({ error: 'Unauthorized' }, 401);
  return c.json({ quote: await getLatestFulfillmentQuote(
    c.env.DB, lineAccountId, c.req.param('submissionId'),
  ) });
});

fulfillmentRoutes.post('/api/custom/pharmacy/fulfillment-quotes/:submissionId', async (c) => {
  const lineAccountId = getPharmacyAccountId(c);
  if (!lineAccountId) return c.json({ error: 'line_account_id is required' }, 400);
  const staff = c.get('staff');
  if (!staff) return c.json({ error: 'Unauthorized' }, 401);
  const body = await readJsonObject(c.req);
  const input = body ? toQuoteInput(body) : null;
  if (!input) return c.json({ error: 'Invalid fulfillment quote' }, 400);
  try {
    const quote = await createFulfillmentQuote(
      c.env.DB, lineAccountId, c.req.param('submissionId'), staff.id, input,
    );
    try {
      await enqueueActivityForAccount(
        c.env.DB, lineAccountId, 'fulfillment_quote_created',
        `fulfillment-quote:${quote.submission_id}:${quote.revision}`,
      );
    } catch {
      console.error('[pharmacy-fulfillment] activity notification unavailable');
    }
    return c.json({ quote }, 201);
  } catch (error) {
    const mapped = mapError(error);
    if (mapped) return c.json({ error: mapped.message }, mapped.status);
    throw error;
  }
});
