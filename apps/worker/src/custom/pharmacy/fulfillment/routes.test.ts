import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  latest: vi.fn(),
}));

vi.mock('./repository.js', () => ({
  createFulfillmentQuote: mocks.create,
  getLatestFulfillmentQuote: mocks.latest,
}));

import { fulfillmentRoutes } from './routes.js';

const env = { DB: {} as D1Database };

function app() {
  const root = new Hono<{
    Bindings: { DB: D1Database };
    Variables: { staff: { id: string; name: string; role: 'admin' } };
  }>();
  root.use('*', async (c, next) => {
    c.set('staff', { id: 'staff-1', name: 'Staff', role: 'admin' });
    await next();
  });
  root.route('/', fulfillmentRoutes);
  return root;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.latest.mockResolvedValue({ id: 'quote-1', revision: 1, decision: 'fulfillable' });
  mocks.create.mockResolvedValue({ id: 'quote-1', revision: 1, decision: 'conditional' });
});

const quoteBody = {
  decision: 'conditional',
  reasonCodes: ['original_required'],
  requirements: [{ code: 'original_required', status: 'pending' }],
  estimatedReadyAt: null,
  validUntil: null,
};

describe('FulfillmentQuote admin routes', () => {
  it('requires account scope for reads', async () => {
    const response = await app().request('/api/custom/pharmacy/fulfillment-quotes/submission-1', {}, env);
    expect(response.status).toBe(400);
    expect(mocks.latest).not.toHaveBeenCalled();
  });

  it('returns an account-scoped latest quote', async () => {
    const response = await app().request(
      '/api/custom/pharmacy/fulfillment-quotes/submission-1?line_account_id=account-1', {}, env,
    );
    expect(response.status).toBe(200);
    expect(mocks.latest).toHaveBeenCalledWith(env.DB, 'account-1', 'submission-1');
    await expect(response.json()).resolves.toEqual({ quote: {
      id: 'quote-1', revision: 1, decision: 'fulfillable',
    } });
  });

  it('creates a staff-authored revision with the account and staff scope', async () => {
    const response = await app().request(
      '/api/custom/pharmacy/fulfillment-quotes/submission-1?line_account_id=account-1',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(quoteBody) },
      env,
    );
    expect(response.status).toBe(201);
    expect(mocks.create).toHaveBeenCalledWith(
      env.DB, 'account-1', 'submission-1', 'staff-1', quoteBody,
    );
  });

  it('rejects malformed connector input before the repository', async () => {
    const response = await app().request(
      '/api/custom/pharmacy/fulfillment-quotes/submission-1?line_account_id=account-1',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ decision: 'free text' }) },
      env,
    );
    expect(response.status).toBe(400);
    expect(mocks.create).not.toHaveBeenCalled();
  });
});
