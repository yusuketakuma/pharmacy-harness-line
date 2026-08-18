import type { MiddlewareHandler } from 'hono';
import type { Env } from '../../index.js';
import { resolveAccessiblePharmacyTenant } from './growth-loop/access.js';

type QueryContext = { req: { query(name: string): string | undefined } };

export function getPharmacyAccountId(c: QueryContext): string | null {
  return c.req.query('line_account_id') || null;
}

export const pharmacyAccountGuard: MiddlewareHandler<Env> = async (c, next) => {
  const lineAccountId = c.req.query('line_account_id') ?? c.req.query('accountId');
  if (!lineAccountId) return c.json({ error: 'line_account_id is required' }, 400);

  const staff = c.get('staff');
  if (!staff) return c.json({ error: 'Unauthorized' }, 401);
  const tenantId = await resolveAccessiblePharmacyTenant(c.env.DB, staff, lineAccountId);
  if (!tenantId || tenantId !== c.get('tenantId')) {
    return c.json({ error: 'Forbidden' }, 403);
  }

  c.set('pharmacyTenantId', tenantId);
  c.set('pharmacyLineAccountId', lineAccountId);
  await next();
};
