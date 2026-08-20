import { Hono, type Context } from 'hono';
import type { Env } from '../../../index.js';
import { readJsonObject } from '../json.js';
import {
  assessDataSubjectLegalHold,
  createDataSubjectRequest,
  listDataSubjectRequests,
  markDataSubjectIdentityVerified,
  resolveDataSubjectRequest,
  type DataSubjectRequestType,
} from './repository.js';

export const dataSubjectRequestRoutes = new Hono<Env>();

const BASE = '/api/custom/pharmacy/data-subject-requests';
const REQUEST_TYPES: DataSubjectRequestType[] = ['access', 'correction', 'suspension', 'erasure'];

function staffScope(c: Context<Env>): {
  lineAccountId: string;
  tenantId: string;
  staff: Env['Variables']['staff'];
} | Response {
  const lineAccountId = c.get('pharmacyLineAccountId');
  const tenantId = c.get('pharmacyTenantId');
  const staff = c.get('staff');
  if (!lineAccountId || !tenantId || !staff) return c.json({ error: 'Unauthorized' }, 401);
  return { lineAccountId, tenantId, staff };
}

function ownerOrAdmin(role: Env['Variables']['staff']['role']): boolean {
  return role === 'owner' || role === 'admin';
}

function errorResponse(c: Context<Env>, error: unknown): Response {
  const message = error instanceof Error ? error.message : '';
  if (message.includes('legal hold')) {
    return c.json({
      status: 'legal_hold',
      error: '対象データは法定保存期間中のため、消去・利用停止には応じられません。'
        + '応じられない理由を記録したうえで「対応不可として記録」で終了してください。',
    }, 409);
  }
  if (message.includes('not found')) {
    return c.json({ error: '請求を確認できませんでした' }, 404);
  }
  return c.json({ error: '最新の状態を確認してください' }, 409);
}

dataSubjectRequestRoutes.get(BASE, async (c) => {
  const scope = staffScope(c);
  if (scope instanceof Response) return scope;
  return c.json({ requests: await listDataSubjectRequests(c.env.DB, scope.lineAccountId) });
});

dataSubjectRequestRoutes.post(BASE, async (c) => {
  const scope = staffScope(c);
  if (scope instanceof Response) return scope;
  if (!ownerOrAdmin(scope.staff.role)) return c.json({ error: 'Forbidden' }, 403);
  const body = await readJsonObject(c.req);
  if (
    !body || typeof body.patientId !== 'string' || body.patientId.length === 0 ||
    typeof body.requestType !== 'string' ||
    !REQUEST_TYPES.includes(body.requestType as DataSubjectRequestType) ||
    typeof body.reason !== 'string' || body.reason.trim().length === 0 ||
    body.reason.length > 1000
  ) {
    return c.json({ error: '請求内容を確認してください' }, 400);
  }
  try {
    const request = await createDataSubjectRequest(c.env.DB, {
      lineAccountId: scope.lineAccountId,
      tenantId: scope.tenantId,
      patientId: body.patientId,
      requestType: body.requestType as DataSubjectRequestType,
      reason: body.reason,
      staffId: scope.staff.id,
    });
    return c.json({ request }, 201);
  } catch (error) {
    return errorResponse(c, error);
  }
});

function expectedVersion(body: Record<string, unknown> | null): number | null {
  return typeof body?.expectedVersion === 'number' && Number.isInteger(body.expectedVersion)
    ? body.expectedVersion
    : null;
}

dataSubjectRequestRoutes.post(`${BASE}/:id/identity-verification`, async (c) => {
  const scope = staffScope(c);
  if (scope instanceof Response) return scope;
  if (!ownerOrAdmin(scope.staff.role)) return c.json({ error: 'Forbidden' }, 403);
  const version = expectedVersion(await readJsonObject(c.req));
  if (version === null) return c.json({ error: '本人確認の内容を確認してください' }, 400);
  try {
    return c.json({ request: await markDataSubjectIdentityVerified(c.env.DB, {
      lineAccountId: scope.lineAccountId,
      requestId: c.req.param('id'),
      expectedVersion: version,
      staffId: scope.staff.id,
    }) });
  } catch (error) {
    return errorResponse(c, error);
  }
});

dataSubjectRequestRoutes.post(`${BASE}/:id/legal-hold-assessment`, async (c) => {
  const scope = staffScope(c);
  if (scope instanceof Response) return scope;
  if (!ownerOrAdmin(scope.staff.role)) return c.json({ error: 'Forbidden' }, 403);
  const version = expectedVersion(await readJsonObject(c.req));
  if (version === null) return c.json({ error: '判定の内容を確認してください' }, 400);
  try {
    return c.json({ request: await assessDataSubjectLegalHold(c.env.DB, {
      lineAccountId: scope.lineAccountId,
      requestId: c.req.param('id'),
      expectedVersion: version,
      staffId: scope.staff.id,
    }) });
  } catch (error) {
    return errorResponse(c, error);
  }
});

dataSubjectRequestRoutes.post(`${BASE}/:id/resolution`, async (c) => {
  const scope = staffScope(c);
  if (scope instanceof Response) return scope;
  if (!ownerOrAdmin(scope.staff.role)) return c.json({ error: 'Forbidden' }, 403);
  const body = await readJsonObject(c.req);
  const version = expectedVersion(body);
  if (
    version === null || !body ||
    (body.decision !== 'resolved' && body.decision !== 'rejected') ||
    typeof body.outcomeNote !== 'string' || body.outcomeNote.trim().length === 0 ||
    body.outcomeNote.length > 2000
  ) {
    return c.json({ error: '対応結果の内容を確認してください' }, 400);
  }
  try {
    return c.json({ request: await resolveDataSubjectRequest(c.env.DB, {
      lineAccountId: scope.lineAccountId,
      requestId: c.req.param('id'),
      expectedVersion: version,
      decision: body.decision,
      outcomeNote: body.outcomeNote,
      staffId: scope.staff.id,
    }) });
  } catch (error) {
    return errorResponse(c, error);
  }
});
