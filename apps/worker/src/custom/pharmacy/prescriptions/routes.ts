import { Hono } from 'hono';
import type { Env } from '../../../index.js';
import { getPharmacyAccountId } from '../account.js';
import { lineProxy } from '../../../routes/line-proxy.js';
import { verifyCallerLineIdentity } from '../../../services/liff-auth.js';
import { inspectPrescriptionImage } from './image.js';
import {
  resolvePrescriptionPatient,
  type PrescriptionPatient,
} from './patient.js';
import { deliverPrescriptionNotification } from './notifications.js';
import { recordAcceptedSubmissionActivation } from '../growth-loop/onboarding.js'; // custom:pharmacy-growth-loop
import {
  completeContinuityAfterClose,
  linkContinuitySubmission,
} from '../continuity/repository.js'; // custom:pharmacy-continuity
import {
  applyAdminPrescriptionAction,
  cancelPrescription,
  getAdminPrescriptionDetail,
  getAdminPrescriptionFile,
  getAdminPrescriptionStats,
  listPrescriptionHistory,
  listAdminPrescriptionQueue,
  markPrescriptionFileDeleted,
  markPrescriptionFileReady,
  reservePrescriptionDraft,
  reservePrescriptionFile,
  reservePrescriptionResubmission,
  submitPrescription,
} from './repository.js';
import { enqueueActivityForAccount } from '../activity-notifications/repository.js'; // custom:pharmacy-activity-notifications
import { canAccessPharmacyOperationsAccount } from '../operations-access.js';
import { hasPharmacyCapability } from '../growth-loop/access.js';

type PrescriptionBindings = {
  DB: D1Database;
  IMAGES?: R2Bucket;
  LINE_CHANNEL_ID?: string;
  LINE_LOGIN_CHANNEL_ID?: string;
  LINE_CREDENTIAL_KEY_V1?: string;
  WORKER_PUBLIC_URL?: string;
};

type PrescriptionEnv = {
  Bindings: PrescriptionBindings;
  Variables: {
    staff: { id: string; name: string; role: 'owner' | 'admin' | 'staff' };
    prescriptionPatient: PrescriptionPatient;
    prescriptionLineAccountId: string;
  };
};

export const prescriptionRoutes = new Hono<PrescriptionEnv>();

function notificationOptions(requestUrl: string, env: PrescriptionBindings) {
  return {
    proxyBaseUrl: env.WORKER_PUBLIC_URL ?? new URL(requestUrl).origin,
    proxyDispatch: (request: Request) => Promise.resolve(
      lineProxy.fetch(request, env as Env['Bindings']),
    ),
    lineCredentialKey: env.LINE_CREDENTIAL_KEY_V1,
  };
}

async function readExpectedUpdatedAt(request: { json<T>(): Promise<T> }): Promise<string | null> {
  try {
    const body = await request.json<Record<string, unknown>>();
    return typeof body.expectedUpdatedAt === 'string' &&
      Number.isFinite(Date.parse(body.expectedUpdatedAt))
      ? body.expectedUpdatedAt
      : null;
  } catch {
    return null;
  }
}

prescriptionRoutes.use('/api/liff/pharmacy/prescriptions/*', async (c, next) => {
  const identity = await verifyCallerLineIdentity(c.req.header('Authorization'), c.env);
  if (!identity) return c.json({ error: 'Unauthorized' }, 401);
  const patient = await resolvePrescriptionPatient(
    c.env.DB,
    c.req.query('liffId') ?? '',
    identity,
  );
  if (!patient) return c.json({ error: 'Prescription account not found' }, 404);
  if (!(await hasPharmacyCapability(c.env.DB, patient.lineAccountId, 'prescription_intake'))) {
    return c.json({ error: 'Prescription intake is not enabled' }, 403);
  }
  c.set('prescriptionPatient', patient);
  return next();
});

prescriptionRoutes.use('/api/custom/pharmacy/prescriptions/*', async (c, next) => {
  const staff = c.get('staff');
  const lineAccountId = getPharmacyAccountId(c);
  if (!lineAccountId) return c.json({ error: 'line_account_id is required' }, 400);
  if (!staff) return c.json({ error: 'Unauthorized' }, 401);
  if (!(await canAccessPharmacyOperationsAccount(
    c.env.DB, staff, lineAccountId, c.env.LINE_CHANNEL_ID,
  ))) return c.json({ error: 'Forbidden' }, 403);
  if (!(await hasPharmacyCapability(c.env.DB, lineAccountId, 'prescription_intake'))) {
    return c.json({ error: 'Prescription intake is not enabled' }, 403);
  }
  c.set('prescriptionLineAccountId', lineAccountId);
  return next();
});

prescriptionRoutes.post('/api/liff/pharmacy/prescriptions', async (c) => {
  const patient = c.get('prescriptionPatient');

  let body: Record<string, unknown>;
  try {
    body = await c.req.json<Record<string, unknown>>();
  } catch {
    return c.json({ error: 'Invalid JSON' }, 400);
  }
  const desiredPickupAt = body.desiredPickupAt;
  const patientId = body.patientId;
  const intakeResponseId = body.intakeResponseId;
  if (
    typeof body.idempotencyKey !== 'string' ||
    typeof body.originalPrescriptionConsent !== 'boolean' ||
    typeof body.readinessNoticeConsent !== 'boolean' ||
    !(
      desiredPickupAt === null ||
      (typeof desiredPickupAt === 'string' && Number.isFinite(Date.parse(desiredPickupAt)))
    ) ||
    (patientId !== undefined && typeof patientId !== 'string') ||
    (intakeResponseId !== undefined && typeof intakeResponseId !== 'string') ||
    (patientId !== undefined && intakeResponseId === undefined) ||
    (patientId === undefined && intakeResponseId !== undefined)
  ) {
    return c.json({ error: 'Invalid prescription draft' }, 400);
  }

  const draftInput = {
    idempotencyKey: body.idempotencyKey,
    desiredPickupAt,
    originalPrescriptionConsent: body.originalPrescriptionConsent,
    readinessNoticeConsent: body.readinessNoticeConsent,
    ...(typeof patientId === 'string' && typeof intakeResponseId === 'string'
      ? { patientId, intakeResponseId }
      : {}),
  } as Parameters<typeof reservePrescriptionDraft>[2];

  try {
    const submission = await reservePrescriptionDraft(c.env.DB, patient, draftInput);
    return c.json({ submission }, 201);
  } catch (error) {
    if (error instanceof Error && error.message === 'invalid idempotency key') {
      return c.json({ error: 'Invalid idempotency key' }, 400);
    }
    if (error instanceof Error && error.message === 'prescription patient link conflict') {
      return c.json({ error: 'Prescription patient link changed; retry' }, 409);
    }
    throw error;
  }
});

prescriptionRoutes.post('/api/liff/pharmacy/prescriptions/:id/submit', async (c) => {
  const patient = c.get('prescriptionPatient');

  let body: Record<string, unknown>;
  try {
    body = await c.req.json<Record<string, unknown>>();
  } catch {
    return c.json({ error: 'Invalid JSON' }, 400);
  }
  if (
    typeof body.expectedUpdatedAt !== 'string' ||
    !Number.isFinite(Date.parse(body.expectedUpdatedAt))
  ) {
    return c.json({ error: 'Invalid expectedUpdatedAt' }, 400);
  }
  try {
    const transition = await submitPrescription(
      c.env.DB,
      patient,
      c.req.param('id'),
      body.expectedUpdatedAt,
    );
    try {
      await enqueueActivityForAccount(
        c.env.DB, patient.lineAccountId, 'prescription_received',
        `prescription:received:${c.req.param('id')}`,
      );
    } catch {
      console.error('[pharmacy-prescription] activity notification unavailable');
    }
    try {
      await linkContinuitySubmission(
        c.env.DB, patient.lineAccountId, c.req.param('id'), patient.friendId,
      );
    } catch {
      console.error('[pharmacy-prescription] continuity link unavailable');
    }
    const notification = await deliverPrescriptionNotification(
      c.env.DB,
      patient.lineAccountId,
      c.req.param('id'),
      notificationOptions(c.req.url, c.env),
      transition.statusEventId,
    );
    return c.json({ status: 'received', statusEventId: transition.statusEventId, notification });
  } catch (error) {
    if (error instanceof Error && error.message === 'prescription submit conflict') {
      return c.json({ error: 'Prescription changed or is incomplete' }, 409);
    }
    throw error;
  }
});

prescriptionRoutes.put('/api/liff/pharmacy/prescriptions/:id/files/:position', async (c) => {
  const patient = c.get('prescriptionPatient');
  if (!c.env.IMAGES) return c.json({ error: 'Image storage unavailable' }, 503);

  const position = Number(c.req.param('position'));
  if (!Number.isInteger(position) || position < 1 || position > 4) {
    return c.json({ error: 'Invalid image position' }, 400);
  }
  const declaredLength = c.req.header('Content-Length');
  if (declaredLength) {
    const length = Number(declaredLength);
    if (!Number.isSafeInteger(length) || length < 0) {
      return c.json({ error: 'Invalid Content-Length' }, 400);
    }
    if (length > 10 * 1024 * 1024) {
      return c.json({ error: 'Image exceeds 10 MiB' }, 413);
    }
  }

  const contentType = (c.req.header('Content-Type') ?? '').split(';', 1)[0].trim().toLowerCase();
  const bytes = new Uint8Array(await c.req.arrayBuffer());
  let inspected: { byteSize: number; sha256: string };
  try {
    inspected = await inspectPrescriptionImage(contentType, bytes);
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : 'Invalid image' }, 400);
  }

  let file;
  try {
    file = await reservePrescriptionFile(
      c.env.DB,
      patient,
      c.req.param('id'),
      position,
      { contentType, ...inspected },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (message === 'prescription file position conflict') {
      return c.json({ error: 'Image position already contains another file' }, 409);
    }
    if (message === 'prescription submission not found') {
      return c.json({ error: 'Prescription submission not found' }, 404);
    }
    throw error;
  }

  if (file.state !== 'ready') {
    try {
      await c.env.IMAGES.put(file.r2_key, bytes, {
        httpMetadata: { contentType },
      });
    } catch {
      return c.json({ error: 'Image storage temporarily unavailable' }, 503);
    }
    try {
      await markPrescriptionFileReady(
        c.env.DB,
        patient,
        c.req.param('id'),
        file.id,
        file.sha256,
      );
    } catch (error) {
      if (error instanceof Error && error.message === 'prescription file ready conflict') {
        return c.json({ error: 'Prescription upload changed; retry' }, 409);
      }
      throw error;
    }
  }

  return c.json({
    file: {
      id: file.id,
      revision: file.revision,
      position: file.position,
      state: 'ready',
    },
  });
});

prescriptionRoutes.get('/api/liff/pharmacy/prescriptions/me', async (c) => {
  const patient = c.get('prescriptionPatient');
  return c.json({ submissions: await listPrescriptionHistory(c.env.DB, patient) });
});

prescriptionRoutes.post('/api/liff/pharmacy/prescriptions/:id/cancel', async (c) => {
  const patient = c.get('prescriptionPatient');
  const expectedUpdatedAt = await readExpectedUpdatedAt(c.req);
  if (!expectedUpdatedAt) return c.json({ error: 'Invalid expectedUpdatedAt' }, 400);

  let files;
  try {
    files = await cancelPrescription(
      c.env.DB, patient, c.req.param('id'), expectedUpdatedAt,
    );
  } catch (error) {
    if (error instanceof Error && error.message === 'prescription cancel conflict') {
      return c.json({ error: 'Prescription changed or cannot be cancelled' }, 409);
    }
    throw error;
  }

  let cleanupPending = !c.env.IMAGES;
  if (c.env.IMAGES) {
    for (const file of files) {
      try {
        await c.env.IMAGES.delete(file.r2_key);
        await markPrescriptionFileDeleted(c.env.DB, patient, c.req.param('id'), file.id);
      } catch {
        cleanupPending = true;
      }
    }
  }
  return c.json({ status: 'cancelled', cleanupPending });
});

prescriptionRoutes.post('/api/liff/pharmacy/prescriptions/:id/resubmission', async (c) => {
  const patient = c.get('prescriptionPatient');
  const expectedUpdatedAt = await readExpectedUpdatedAt(c.req);
  if (!expectedUpdatedAt) return c.json({ error: 'Invalid expectedUpdatedAt' }, 400);
  try {
    await reservePrescriptionResubmission(
      c.env.DB, patient, c.req.param('id'), expectedUpdatedAt,
    );
    return c.json({ status: 'needs_resubmission' });
  } catch (error) {
    if (error instanceof Error && error.message === 'prescription resubmission conflict') {
      return c.json({ error: 'Prescription changed or cannot be resubmitted' }, 409);
    }
    throw error;
  }
});

const PRESCRIPTION_STATUSES = new Set([
  'draft', 'received', 'needs_resubmission', 'accepted', 'ready',
  'closed', 'cancelled',
]);

function decodeAdminCursor(value: string): { requestedAt: string; id: string } | null {
  try {
    const parsed = JSON.parse(atob(value)) as Record<string, unknown>;
    return typeof parsed.requestedAt === 'string' && typeof parsed.id === 'string'
      ? { requestedAt: parsed.requestedAt, id: parsed.id }
      : null;
  } catch {
    return null;
  }
}

prescriptionRoutes.get('/api/custom/pharmacy/prescriptions', async (c) => {
  const lineAccountId = c.get('prescriptionLineAccountId');
  const statusValue = c.req.query('status') ?? null;
  if (statusValue && !PRESCRIPTION_STATUSES.has(statusValue)) {
    return c.json({ error: 'Invalid status' }, 400);
  }
  const cursorValue = c.req.query('cursor');
  const cursor = cursorValue ? decodeAdminCursor(cursorValue) : null;
  if (cursorValue && !cursor) return c.json({ error: 'Invalid cursor' }, 400);
  const requestedLimit = Number(c.req.query('limit') ?? 20);
  if (!Number.isInteger(requestedLimit) || requestedLimit < 1) {
    return c.json({ error: 'Invalid limit' }, 400);
  }
  const limit = Math.min(50, requestedLimit);
  const rows = await listAdminPrescriptionQueue(c.env.DB, lineAccountId, {
    status: statusValue as Parameters<typeof listAdminPrescriptionQueue>[2]['status'],
    cursor,
    limit: limit + 1,
  });
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items.at(-1);
  const nextCursor = hasMore && last
    ? btoa(JSON.stringify({
      requestedAt: last.requested_at ?? last.created_at,
      id: last.id,
    }))
    : null;
  return c.json({ items, nextCursor });
});

prescriptionRoutes.get('/api/custom/pharmacy/prescriptions/stats', async (c) => {
  const lineAccountId = c.get('prescriptionLineAccountId');
  return c.json({ stats: await getAdminPrescriptionStats(c.env.DB, lineAccountId) });
});

prescriptionRoutes.get('/api/custom/pharmacy/prescriptions/:id/files/:fileId', async (c) => {
  const lineAccountId = c.get('prescriptionLineAccountId');
  if (!c.env.IMAGES) return c.json({ error: 'Image storage unavailable' }, 503);
  const file = await getAdminPrescriptionFile(
    c.env.DB, lineAccountId, c.req.param('id'), c.req.param('fileId'),
  );
  if (!file) return c.json({ error: 'Prescription image not found' }, 404);
  const object = await c.env.IMAGES.get(file.r2_key);
  if (!object) return c.json({ error: 'Prescription image not found' }, 404);
  return new Response(await object.arrayBuffer(), {
    headers: {
      'Content-Type': file.content_type,
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
});

prescriptionRoutes.get('/api/custom/pharmacy/prescriptions/:id', async (c) => {
  const lineAccountId = c.get('prescriptionLineAccountId');
  const detail = await getAdminPrescriptionDetail(
    c.env.DB, lineAccountId, c.req.param('id'),
  );
  return detail
    ? c.json(detail)
    : c.json({ error: 'Prescription submission not found' }, 404);
});

const ADMIN_ACTIONS = {
  accept: 'admin_accept',
  request_resubmission: 'admin_request_resubmission',
  ready: 'admin_ready',
  close: 'admin_close',
  cancel: 'admin_cancel',
} as const;

prescriptionRoutes.post('/api/custom/pharmacy/prescriptions/:id/actions/:action', async (c) => {
  const lineAccountId = c.get('prescriptionLineAccountId');
  const staff = c.get('staff');
  if (!staff) return c.json({ error: 'Unauthorized' }, 401);
  const action = ADMIN_ACTIONS[c.req.param('action') as keyof typeof ADMIN_ACTIONS];
  if (!action) return c.json({ error: 'Invalid action' }, 400);
  let body: Record<string, unknown>;
  try {
    body = await c.req.json<Record<string, unknown>>();
  } catch {
    return c.json({ error: 'Invalid JSON' }, 400);
  }
  if (
    typeof body.expectedUpdatedAt !== 'string' ||
    !Number.isFinite(Date.parse(body.expectedUpdatedAt)) ||
    !(body.reasonCode === undefined || body.reasonCode === null || typeof body.reasonCode === 'string') ||
    !(body.operationId === undefined || body.operationId === null ||
      (typeof body.operationId === 'string' && /^[A-Za-z0-9._:-]{8,128}$/.test(body.operationId)))
  ) {
    return c.json({ error: 'Invalid action input' }, 400);
  }
  try {
    const transition = await applyAdminPrescriptionAction(
      c.env.DB,
      lineAccountId,
      c.req.param('id'),
      action,
      body.expectedUpdatedAt,
      staff.id,
      typeof body.reasonCode === 'string' ? body.reasonCode : null,
      typeof body.operationId === 'string' ? body.operationId : null,
    );
    if (action === 'admin_accept') {
      try {
        await recordAcceptedSubmissionActivation(c.env.DB, lineAccountId, c.req.param('id'));
      } catch (error) {
        // Metrics are observability only; never turn a committed pharmacist action into a 500.
        console.error('[pharmacy-growth] activation metric failed', error);
      }
    }
    try {
      await enqueueActivityForAccount(
        c.env.DB, lineAccountId, 'prescription_status_changed',
        `prescription:status:${c.req.param('id')}:${transition.status}`,
      );
    } catch {
      console.error('[pharmacy-prescription] status activity unavailable');
    }
    const notification = await deliverPrescriptionNotification(
      c.env.DB,
      lineAccountId,
      c.req.param('id'),
      notificationOptions(c.req.url, c.env),
      transition.statusEventId,
    );
    let continuity: 'completed' | 'retry_pending' | undefined;
    if (action === 'admin_close') {
      try {
        await completeContinuityAfterClose(c.env.DB, lineAccountId, c.req.param('id'), staff.id);
        continuity = 'completed';
      } catch {
        continuity = 'retry_pending';
        console.error('[pharmacy-prescription] continuity completion unavailable');
      }
    }
    return c.json({
      status: transition.status,
      statusEventId: transition.statusEventId,
      notification,
      ...(continuity ? { continuity } : {}),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (message.includes('conflict') || message.includes('transition')) {
      return c.json({ error: 'Prescription changed or action is invalid' }, 409);
    }
    if (message === 'fulfillment quote required' ||
        message === 'fulfillment quote not acceptable' ||
        message === 'fulfillment quote invalid') {
      return c.json({ error: '受付内容の確認が完了していません' }, 409);
    }
    if (message === 'prescription validity verification required' ||
        message === 'prescription validity expired') {
      return c.json({ error: '処方せんの使用期限を確認してください' }, 409);
    }
    if (message === 'invalid resubmission reason') {
      return c.json({ error: 'Invalid resubmission reason' }, 400);
    }
    throw error;
  }
});
