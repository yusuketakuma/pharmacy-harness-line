import { Hono } from 'hono';
import {
  createFulfillmentQuote,
  getLatestFulfillmentQuote,
  type FulfillmentQuoteInput,
} from './repository.js';

type FulfillmentEnv = {
  Bindings: { DB: D1Database };
  Variables: {
    staff: { id: string; name: string; role: 'owner' | 'admin' | 'staff' };
  };
};

export const fulfillmentRoutes = new Hono<FulfillmentEnv>();

function accountId(c: { req: { query(name: string): string | undefined } }): string | null {
  return c.req.query('line_account_id') || null;
}

async function jsonBody(c: { req: { json<T>(): Promise<T> } }): Promise<Record<string, unknown> | null> {
  try {
    const body = await c.req.json<Record<string, unknown>>();
    return body && typeof body === 'object' && !Array.isArray(body) ? body : null;
  } catch {
    return null;
  }
}

function toQuoteInput(body: Record<string, unknown>): FulfillmentQuoteInput | null {
  if (
    typeof body.decision !== 'string' || !Array.isArray(body.reasonCodes) ||
    !Array.isArray(body.requirements) ||
    !(
      body.estimatedReadyAt === null ||
      (typeof body.estimatedReadyAt === 'string' && Number.isFinite(Date.parse(body.estimatedReadyAt)))
    ) ||
    !(body.validUntil === null ||
      (typeof body.validUntil === 'string' && Number.isFinite(Date.parse(body.validUntil))))
  ) return null;
  return {
    decision: body.decision as FulfillmentQuoteInput['decision'],
    reasonCodes: body.reasonCodes as string[],
    requirements: body.requirements as FulfillmentQuoteInput['requirements'],
    estimatedReadyAt: body.estimatedReadyAt as string | null,
    validUntil: body.validUntil as string | null,
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
  const lineAccountId = accountId(c);
  if (!lineAccountId) return c.json({ error: 'line_account_id is required' }, 400);
  if (!c.get('staff')) return c.json({ error: 'Unauthorized' }, 401);
  return c.json({ quote: await getLatestFulfillmentQuote(
    c.env.DB, lineAccountId, c.req.param('submissionId'),
  ) });
});

fulfillmentRoutes.post('/api/custom/pharmacy/fulfillment-quotes/:submissionId', async (c) => {
  const lineAccountId = accountId(c);
  if (!lineAccountId) return c.json({ error: 'line_account_id is required' }, 400);
  const staff = c.get('staff');
  if (!staff) return c.json({ error: 'Unauthorized' }, 401);
  const body = await jsonBody(c);
  const input = body ? toQuoteInput(body) : null;
  if (!input) return c.json({ error: 'Invalid fulfillment quote' }, 400);
  try {
    const quote = await createFulfillmentQuote(
      c.env.DB, lineAccountId, c.req.param('submissionId'), staff.id, input,
    );
    return c.json({ quote }, 201);
  } catch (error) {
    const mapped = mapError(error);
    if (mapped) return c.json({ error: mapped.message }, mapped.status);
    throw error;
  }
});
