import { Hono, type Context } from 'hono';
import type { Env } from '../../../index.js';
import { getPharmacyAccountId } from '../account.js';
import { resolveAccessiblePharmacyTenant } from '../growth-loop/access.js';
import { readJsonObject } from '../json.js';
import {
  grantPharmacyBetaMembership,
  listPharmacyBetaMemberships,
  transitionPharmacyBetaMembership,
} from './repository.js';

export const betaMembershipRoutes = new Hono<Env>();

type Scope = {
  accountId: string;
  staff: { id: string; name: string; role: 'owner' | 'admin' | 'staff' };
};

async function scope(c: Context<Env>): Promise<Scope | Response> {
  const accountId = getPharmacyAccountId(c) ?? c.req.query('accountId');
  const staff = c.get('staff');
  if (!accountId) return c.json({ success: false, error: 'line_account_id is required' }, 400);
  if (!staff) return c.json({ success: false, error: 'Unauthorized' }, 401);
  if (staff.role !== 'owner' && staff.role !== 'admin') {
    return c.json({ success: false, error: 'Forbidden' }, 403);
  }
  const tenantId = await resolveAccessiblePharmacyTenant(c.env.DB, staff, accountId);
  if (!tenantId || tenantId !== c.get('tenantId')) {
    return c.json({ success: false, error: 'Forbidden' }, 403);
  }
  return { accountId, staff };
}

function canonicalExpiry(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return null;
  const canonical = new Date(parsed).toISOString();
  return canonical === value ? canonical : null;
}

function transitionError(c: Context<Env>, error: unknown): Response {
  const message = error instanceof Error ? error.message : '';
  if (message.startsWith('invalid ')) {
    return c.json({ success: false, error: 'Invalid input' }, 400);
  }
  if (message === 'beta membership not found') {
    return c.json({ success: false, error: 'Membership not found' }, 404);
  }
  if (message === 'adult family verification required') {
    return c.json({ success: false, error: 'Adult family access requires pharmacy verification' }, 403);
  }
  if (message === 'patient not found') {
    return c.json({ success: false, error: 'Patient not found' }, 404);
  }
  if (message.includes('already exists') || message.includes('conflict') || message.includes('expired')) {
    return c.json({ success: false, error: 'Membership state changed; retry' }, 409);
  }
  return c.json({ success: false, error: 'Membership operation failed' }, 500);
}

betaMembershipRoutes.get('/api/custom/pharmacy/beta-memberships', async (c) => {
  const account = await scope(c);
  if (account instanceof Response) return account;
  return c.json({
    success: true,
    data: { memberships: await listPharmacyBetaMemberships(c.env.DB, account.accountId) },
  });
});

betaMembershipRoutes.post('/api/custom/pharmacy/beta-memberships', async (c) => {
  const account = await scope(c);
  if (account instanceof Response) return account;
  const body = await readJsonObject(c.req);
  const expiresAt = canonicalExpiry(body?.expiresAt);
  if (!body || typeof body.patientId !== 'string' || !expiresAt) {
    return c.json({ success: false, error: 'patientId and canonical expiresAt are required' }, 400);
  }
  try {
    const membership = await grantPharmacyBetaMembership(c.env.DB, {
      lineAccountId: account.accountId,
      patientId: body.patientId,
      expiresAt,
      actorStaffId: account.staff.id,
    });
    return c.json({ success: true, data: { membership } }, 201);
  } catch (error) {
    return transitionError(c, error);
  }
});

async function transition(c: Context<Env>, action: 'suspend' | 'resume' | 'revoke'): Promise<Response> {
  const account = await scope(c);
  if (account instanceof Response) return account;
  const body = await readJsonObject(c.req);
  const membershipId = c.req.param('id');
  const expectedVersion = typeof body?.expectedVersion === 'number'
    ? body.expectedVersion
    : null;
  const reasonCode = typeof body?.reasonCode === 'string' ? body.reasonCode : null;
  if (!membershipId || !body || expectedVersion === null || !Number.isSafeInteger(expectedVersion) ||
      expectedVersion < 1 || (action === 'revoke' && !reasonCode)) {
    return c.json({ success: false, error: 'expectedVersion and transition data are required' }, 400);
  }
  try {
    const membership = await transitionPharmacyBetaMembership(c.env.DB, {
      lineAccountId: account.accountId,
      membershipId,
      action,
      expectedVersion,
      actorStaffId: account.staff.id,
      ...(action === 'revoke' ? { reasonCode: reasonCode! } : {}),
    });
    return c.json({ success: true, data: { membership } });
  } catch (error) {
    return transitionError(c, error);
  }
}

betaMembershipRoutes.post('/api/custom/pharmacy/beta-memberships/:id/suspend', (c) => transition(c, 'suspend'));
betaMembershipRoutes.post('/api/custom/pharmacy/beta-memberships/:id/resume', (c) => transition(c, 'resume'));
betaMembershipRoutes.post('/api/custom/pharmacy/beta-memberships/:id/revoke', (c) => transition(c, 'revoke'));
