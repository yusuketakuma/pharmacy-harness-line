import type { MiddlewareHandler } from 'hono';
import type { Env } from '../../index.js';
import { canAccessPharmacyAccount } from './growth-loop/access.js';

type QueryContext = { req: { query(name: string): string | undefined } };

export function getPharmacyAccountId(c: QueryContext): string | null {
  return c.req.query('line_account_id') || null;
}

export const pharmacyAccountGuard: MiddlewareHandler<Env> = async (c, next) => {
  const lineAccountId = c.req.query('line_account_id') ?? c.req.query('accountId');
  if (!lineAccountId) return c.json({ error: 'line_account_id is required' }, 400);

  const staff = c.get('staff');
  if (!staff) return c.json({ error: 'Unauthorized' }, 401);
  if (!(await canAccessPharmacyAccount(c.env.DB, staff, lineAccountId))) {
    return c.json({ error: 'Forbidden' }, 403);
  }

  c.set('pharmacyLineAccountId', lineAccountId);
  await next();
};
