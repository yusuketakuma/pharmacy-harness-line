import { Hono } from 'hono';
import type { Context } from 'hono';
import type { Env } from '../../../index.js';
import { readJsonObject } from '../json.js';
import {
  PATIENT_PHARMACY_CAPABILITIES,
  hasPharmacyCapability,
  resolveAccessiblePharmacyTenant,
} from './access.js';
import {
  classifySubmissionSource,
  createMedicalSource,
  getGrowthDashboard,
  getPharmacyCapabilityConfig,
  savePharmacyCapabilityConfig,
  savePrescriptionValidity,
  setMedicalSourceActive,
} from './repository.js';
import { getPharmacyReadiness } from '../readiness.js';
import { getPharmacyConfigurationDoctor } from '../configuration-doctor.js';
import { getActivePatientWorkCounts } from './active-work.js';
import { getPharmacyOperationsSummary } from './operations-summary.js';

export const pharmacyGrowthLoopRoutes = new Hono<Env>();

const ISO_INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(?:Z|[+-](\d{2}):(\d{2}))$/;

function canonicalIsoInstant(value: string): { iso: string; time: number } | null {
  const match = ISO_INSTANT.exec(value);
  if (!match) return null;
  const [year, month, day, hour, minute, second, offsetHour, offsetMinute] =
    match.slice(1).map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth[month - 1] ||
      hour > 23 || minute > 59 || second > 59 ||
      (offsetHour !== undefined && (offsetHour > 23 || offsetMinute > 59))) {
    return null;
  }
  const time = Date.parse(value);
  return Number.isFinite(time) ? { iso: new Date(time).toISOString(), time } : null;
}

async function accountScope(c: Context<Env>): Promise<
  { accountId: string; tenantId: string; staff: { id: string; role: 'owner' | 'admin' | 'staff' } } | Response
> {
  const accountId = c.req.query('line_account_id') ?? c.req.query('accountId');
  const staff = c.get('staff');
  if (!accountId) return c.json({ success: false, error: 'line_account_id is required' }, 400);
  const tenantId = staff
    ? await resolveAccessiblePharmacyTenant(c.env.DB, staff, accountId)
    : null;
  if (!tenantId || tenantId !== c.get('tenantId')) {
    return c.json({ success: false, error: 'pharmacy account access denied' }, 403);
  }
  return { accountId, tenantId, staff };
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

pharmacyGrowthLoopRoutes.get('/api/custom/pharmacy/readiness', async (c) => {
  const scope = await accountScope(c);
  if (scope instanceof Response) return scope;
  const readiness = await getPharmacyReadiness(c.env.DB, scope.accountId);
  if (!readiness) return c.json({ success: false, error: 'pharmacy account not found' }, 404);
  const configurationDoctor = await getPharmacyConfigurationDoctor({
    db: c.env.DB,
    tenantId: scope.tenantId,
    accountId: scope.accountId,
    liffPublicUrl: c.env.LIFF_PUBLIC_URL,
    credentialKey: c.env.LINE_CREDENTIAL_KEY_V1,
    readiness,
  });
  return c.json({ success: true, data: { ...readiness, configurationDoctor } });
});

pharmacyGrowthLoopRoutes.get('/api/custom/pharmacy/active-work', async (c) => {
  const scope = await accountScope(c);
  if (scope instanceof Response) return scope;
  return c.json({ success: true, data: await getActivePatientWorkCounts(c.env.DB, scope.accountId) });
});

pharmacyGrowthLoopRoutes.get('/api/custom/pharmacy/operations-summary', async (c) => {
  const scope = await accountScope(c);
  if (scope instanceof Response) return scope;
  return c.json({ success: true, data: await getPharmacyOperationsSummary(c.env.DB, scope.accountId) });
});

pharmacyGrowthLoopRoutes.put('/api/custom/pharmacy/growth/config', async (c) => {
  const scope = await accountScope(c);
  if (scope instanceof Response) return scope;
  if (scope.staff.role !== 'owner') return c.json({ success: false, error: 'owner role required' }, 403);
  const body = await readJsonObject(c.req) ?? {};
  if (!Array.isArray(body.capabilities) || body.capabilities.some((value) => typeof value !== 'string')) {
    return c.json({ success: false, error: 'capabilities must be an array' }, 400);
  }
  if (body.capabilities.some((value) =>
    !(PATIENT_PHARMACY_CAPABILITIES as readonly string[]).includes(value as string))) {
    return c.json({ success: false, error: 'unknown patient capability' }, 400);
  }
  if (typeof body.expectedRevision !== 'number' ||
      !Number.isInteger(body.expectedRevision) || body.expectedRevision < 1) {
    return c.json({ success: false, error: 'expectedRevision is required' }, 400);
  }
  if (body.unfollowAlertState !== undefined && body.unfollowAlertState !== 'alert_only') {
    return c.json({ success: false, error: 'unfollow monitoring is alert-only in Release 1' }, 400);
  }
  const limit = body.proactiveMonthlyLimit === undefined ? 1 : Number(body.proactiveMonthlyLimit);
  try {
    const config = await savePharmacyCapabilityConfig(
      c.env.DB, scope.accountId, body.capabilities, limit, 'alert_only', scope.staff.id,
      body.expectedRevision,
    );
    return c.json({ success: true, data: config });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'invalid config';
    return c.json({ success: false, error: message }, message.includes('stale') ? 409 : 400);
  }
});

pharmacyGrowthLoopRoutes.get('/api/custom/pharmacy/growth/dashboard', async (c) => {
  const scope = await accountScope(c);
  if (scope instanceof Response) return scope;
  const denied = await requireCapability(c, scope.accountId, 'pharmacy_dashboard');
  if (denied) return denied;
  const from = canonicalIsoInstant(
    c.req.query('from') ?? new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
  );
  const to = canonicalIsoInstant(c.req.query('to') ?? new Date().toISOString());
  if (!from || !to || from.time >= to.time ||
      to.time - from.time > 32 * 24 * 60 * 60 * 1000) {
    return c.json({ success: false, error: 'invalid dashboard range' }, 400);
  }
  const data = await getGrowthDashboard(c.env.DB, scope.accountId, from.iso, to.iso);
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
  const body = await readJsonObject(c.req) ?? {};
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
  const body = await readJsonObject(c.req) ?? {};
  if (typeof body.isActive !== 'boolean') {
    return c.json({ success: false, error: 'isActive must be boolean' }, 400);
  }
  try {
    await setMedicalSourceActive(
      c.env.DB, scope.accountId, c.req.param('sourceId'), body.isActive, scope.staff.id,
    );
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
  const body = await readJsonObject(c.req) ?? {};
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
  const body = await readJsonObject(c.req) ?? {};
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
