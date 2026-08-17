import { Hono } from 'hono';
import type { Context } from 'hono';
import type { Env } from '../../../index.js';
import { canAccessPharmacyAccount, hasPharmacyCapability } from './access.js';
import {
  classifySubmissionSource,
  createMedicalSource,
  getGrowthDashboard,
  getPharmacyCapabilityConfig,
  savePharmacyCapabilityConfig,
  savePrescriptionValidity,
  setMedicalSourceActive,
} from './repository.js';

export const pharmacyGrowthLoopRoutes = new Hono<Env>();

async function accountScope(c: Context<Env>): Promise<
  { accountId: string; staff: { id: string; role: 'owner' | 'admin' | 'staff' } } | Response
> {
  const accountId = c.req.query('line_account_id') ?? c.req.query('accountId');
  const staff = c.get('staff');
  if (!accountId) return c.json({ success: false, error: 'line_account_id is required' }, 400);
  if (!staff || !(await canAccessPharmacyAccount(c.env.DB, staff, accountId))) {
    return c.json({ success: false, error: 'pharmacy account access denied' }, 403);
  }
  return { accountId, staff };
}

async function requireCapability(c: Context<Env>, accountId: string, capability: Parameters<typeof hasPharmacyCapability>[2]): Promise<Response | null> {
  if (!(await hasPharmacyCapability(c.env.DB, accountId, capability))) {
    return c.json({ success: false, error: 'pharmacy capability is not enabled' }, 403);
  }
  return null;
}

pharmacyGrowthLoopRoutes.get('/api/custom/pharmacy/growth/config', async (c) => {
  const scope = await accountScope(c);
  if (scope instanceof Response) return scope;
  const config = await getPharmacyCapabilityConfig(c.env.DB, scope.accountId);
  return c.json({ success: true, data: config });
});

pharmacyGrowthLoopRoutes.put('/api/custom/pharmacy/growth/config', async (c) => {
  const scope = await accountScope(c);
  if (scope instanceof Response) return scope;
  if (scope.staff.role !== 'owner') return c.json({ success: false, error: 'owner role required' }, 403);
  const body = await c.req.json<{
    capabilities?: unknown;
    proactiveMonthlyLimit?: unknown;
    unfollowAlertState?: unknown;
  }>().catch(() => ({} as { capabilities?: unknown; proactiveMonthlyLimit?: unknown; unfollowAlertState?: unknown }));
  if (!Array.isArray(body.capabilities) || body.capabilities.some((value) => typeof value !== 'string')) {
    return c.json({ success: false, error: 'capabilities must be an array' }, 400);
  }
  if (body.unfollowAlertState !== undefined && body.unfollowAlertState !== 'alert_only') {
    return c.json({ success: false, error: 'unfollow monitoring is alert-only in Release 1' }, 400);
  }
  const limit = body.proactiveMonthlyLimit === undefined ? 1 : Number(body.proactiveMonthlyLimit);
  const alertState = 'alert_only';
  try {
    const config = await savePharmacyCapabilityConfig(c.env.DB, scope.accountId, body.capabilities, limit, alertState);
    return c.json({ success: true, data: config });
  } catch (error) {
    return c.json({ success: false, error: error instanceof Error ? error.message : 'invalid config' }, 400);
  }
});

pharmacyGrowthLoopRoutes.get('/api/custom/pharmacy/growth/dashboard', async (c) => {
  const scope = await accountScope(c);
  if (scope instanceof Response) return scope;
  const denied = await requireCapability(c, scope.accountId, 'pharmacy_dashboard');
  if (denied) return denied;
  const from = c.req.query('from') ?? new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const to = c.req.query('to') ?? new Date().toISOString();
  const fromTime = Date.parse(from);
  const toTime = Date.parse(to);
  if (!Number.isFinite(fromTime) || !Number.isFinite(toTime) || fromTime >= toTime) {
    return c.json({ success: false, error: 'invalid dashboard range' }, 400);
  }
  const data = await getGrowthDashboard(c.env.DB, scope.accountId, from, to);
  return c.json({ success: true, data });
});

pharmacyGrowthLoopRoutes.get('/api/custom/pharmacy/growth/sources', async (c) => {
  const scope = await accountScope(c);
  if (scope instanceof Response) return scope;
  const denied = await requireCapability(c, scope.accountId, 'pharmacy_dashboard');
  if (denied) return denied;
  const rows = await c.env.DB.prepare(
    `SELECT id, display_name, classification, is_active, created_at, updated_at
       FROM pharmacy_medical_sources WHERE line_account_id = ? ORDER BY display_name, id`,
  ).bind(scope.accountId).all();
  return c.json({ success: true, data: rows.results ?? [] });
});

pharmacyGrowthLoopRoutes.post('/api/custom/pharmacy/growth/sources', async (c) => {
  const scope = await accountScope(c);
  if (scope instanceof Response) return scope;
  const denied = await requireCapability(c, scope.accountId, 'account_settings');
  if (denied) return denied;
  const body = await c.req.json<{ displayName?: unknown; classification?: unknown }>().catch(() => ({} as { displayName?: unknown; classification?: unknown }));
  if (typeof body.displayName !== 'string' || (body.classification !== 'primary' && body.classification !== 'other')) {
    return c.json({ success: false, error: 'displayName and classification are required' }, 400);
  }
  try {
    const data = await createMedicalSource(c.env.DB, {
      lineAccountId: scope.accountId,
      displayName: body.displayName,
      classification: body.classification,
      staffId: scope.staff.id,
    });
    return c.json({ success: true, data }, 201);
  } catch (error) {
    return c.json({ success: false, error: error instanceof Error ? error.message : 'source creation failed' }, 400);
  }
});

pharmacyGrowthLoopRoutes.patch('/api/custom/pharmacy/growth/sources/:sourceId', async (c) => {
  const scope = await accountScope(c);
  if (scope instanceof Response) return scope;
  const denied = await requireCapability(c, scope.accountId, 'account_settings');
  if (denied) return denied;
  const body = await c.req.json<{ isActive?: unknown }>().catch(() => ({} as { isActive?: unknown }));
  if (typeof body.isActive !== 'boolean') {
    return c.json({ success: false, error: 'isActive must be boolean' }, 400);
  }
  try {
    await setMedicalSourceActive(c.env.DB, scope.accountId, c.req.param('sourceId'), body.isActive);
    return c.json({ success: true });
  } catch (error) {
    return c.json({ success: false, error: error instanceof Error ? error.message : 'source update failed' }, 404);
  }
});

pharmacyGrowthLoopRoutes.post('/api/custom/pharmacy/growth/submissions/:submissionId/source', async (c) => {
  const scope = await accountScope(c);
  if (scope instanceof Response) return scope;
  const denied = await requireCapability(c, scope.accountId, 'pharmacy_dashboard');
  if (denied) return denied;
  const body = await c.req.json<{ sourceId?: unknown; classification?: unknown }>().catch(() => ({} as { sourceId?: unknown; classification?: unknown }));
  if ((body.sourceId !== null && typeof body.sourceId !== 'string') ||
      !['primary', 'other', 'unknown'].includes(String(body.classification))) {
    return c.json({ success: false, error: 'invalid source classification' }, 400);
  }
  try {
    await classifySubmissionSource(c.env.DB, {
      lineAccountId: scope.accountId,
      submissionId: c.req.param('submissionId'),
      sourceId: body.sourceId as string | null,
      classification: body.classification as 'primary' | 'other' | 'unknown',
      staffId: scope.staff.id,
    });
    return c.json({ success: true });
  } catch (error) {
    return c.json({ success: false, error: error instanceof Error ? error.message : 'source update failed' }, 400);
  }
});

pharmacyGrowthLoopRoutes.put('/api/custom/pharmacy/growth/submissions/:submissionId/validity', async (c) => {
  const scope = await accountScope(c);
  if (scope instanceof Response) return scope;
  const denied = await requireCapability(c, scope.accountId, 'pharmacy_dashboard');
  if (denied) return denied;
  const body = await c.req.json<{
    issuedOn?: unknown;
    validUntil?: unknown;
    validityBasis?: unknown;
    verificationStatus?: unknown;
  }>().catch(() => ({} as { issuedOn?: unknown; validUntil?: unknown; validityBasis?: unknown; verificationStatus?: unknown }));
  if (!['default_4_days', 'prescriber_specified'].includes(String(body.validityBasis)) ||
      !['unverified', 'verified', 'expired_review_required', 'expired_confirmed'].includes(String(body.verificationStatus))) {
    return c.json({ success: false, error: 'invalid validity input' }, 400);
  }
  try {
    await savePrescriptionValidity(c.env.DB, {
      lineAccountId: scope.accountId,
      submissionId: c.req.param('submissionId'),
      issuedOn: typeof body.issuedOn === 'string' ? body.issuedOn : null,
      validUntil: typeof body.validUntil === 'string' ? body.validUntil : null,
      validityBasis: body.validityBasis as 'default_4_days' | 'prescriber_specified',
      verificationStatus: body.verificationStatus as 'unverified' | 'verified' | 'expired_review_required' | 'expired_confirmed',
      staffId: scope.staff.id,
    });
    return c.json({ success: true });
  } catch (error) {
    return c.json({ success: false, error: error instanceof Error ? error.message : 'validity update failed' }, 400);
  }
});
