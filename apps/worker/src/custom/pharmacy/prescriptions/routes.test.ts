import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const mocks = vi.hoisted(() => ({
  verify: vi.fn(),
  resolvePatient: vi.fn(),
  reserveDraft: vi.fn(),
  inspectImage: vi.fn(),
  reserveFile: vi.fn(),
  markFileReady: vi.fn(),
  submit: vi.fn(),
  listHistory: vi.fn(),
  cancel: vi.fn(),
  reserveResubmission: vi.fn(),
  reportArrival: vi.fn(),
  markFileDeleted: vi.fn(),
  listAdmin: vi.fn(),
  adminStats: vi.fn(),
  adminDetail: vi.fn(),
  adminFile: vi.fn(),
  recordFileViewed: vi.fn(),
  adminAction: vi.fn(),
  notify: vi.fn(),
  linkContinuity: vi.fn(),
  completeContinuity: vi.fn(),
  activation: vi.fn(),
  enqueueActivity: vi.fn(),
  access: vi.fn(),
  capability: vi.fn(),
  audit: vi.fn(),
}));

vi.mock('../../../services/liff-auth.js', () => ({
  verifyCallerLineIdentity: mocks.verify,
}));
vi.mock('./patient.js', () => ({
  resolvePrescriptionPatient: mocks.resolvePatient,
}));
vi.mock('./repository.js', () => ({
  reservePrescriptionDraft: mocks.reserveDraft,
  reservePrescriptionFile: mocks.reserveFile,
  markPrescriptionFileReady: mocks.markFileReady,
  submitPrescription: mocks.submit,
  listPrescriptionHistory: mocks.listHistory,
  cancelPrescription: mocks.cancel,
  reservePrescriptionResubmission: mocks.reserveResubmission,
  reportPrescriptionArrival: mocks.reportArrival,
  markPrescriptionFileDeleted: mocks.markFileDeleted,
  listAdminPrescriptionQueue: mocks.listAdmin,
  getAdminPrescriptionStats: mocks.adminStats,
  getAdminPrescriptionDetail: mocks.adminDetail,
  getAdminPrescriptionFile: mocks.adminFile,
  recordPrescriptionFileViewed: mocks.recordFileViewed,
  applyAdminPrescriptionAction: mocks.adminAction,
}));
vi.mock('./image.js', () => ({
  inspectPrescriptionImage: mocks.inspectImage,
}));
vi.mock('./notifications.js', () => ({
  deliverPrescriptionNotification: mocks.notify,
}));
vi.mock('../continuity/repository.js', () => ({
  linkContinuitySubmission: mocks.linkContinuity,
  completeContinuityAfterClose: mocks.completeContinuity,
}));
vi.mock('../growth-loop/onboarding.js', () => ({
  recordAcceptedSubmissionActivation: mocks.activation,
}));
vi.mock('../activity-notifications/repository.js', () => ({
  enqueueActivityForAccount: mocks.enqueueActivity,
}));
vi.mock('../operations-access.js', () => ({
  canAccessPharmacyOperationsAccount: mocks.access,
}));
vi.mock('../growth-loop/access.js', () => ({
  hasPharmacyCapability: mocks.capability,
}));
vi.mock('../../../lib/tenant-audit.js', () => ({
  recordTenantAudit: mocks.audit,
}));

import { prescriptionRoutes } from './routes.js';

const env = { DB: {} as D1Database };

function adminApp() {
  const app = new Hono<{
    Bindings: { DB: D1Database; IMAGES?: R2Bucket };
    Variables: { staff: { id: string; name: string; role: 'admin' } };
  }>();
  app.use('*', async (c, next) => {
    c.set('staff', { id: 'staff-1', name: 'Staff', role: 'admin' });
    await next();
  });
  app.route('/', prescriptionRoutes);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.notify.mockResolvedValue({ status: 'sent' });
  mocks.linkContinuity.mockResolvedValue(null);
  mocks.completeContinuity.mockResolvedValue(null);
  mocks.activation.mockResolvedValue(undefined);
  mocks.enqueueActivity.mockResolvedValue(null);
  mocks.access.mockResolvedValue(true);
  mocks.capability.mockResolvedValue(true);
});

describe('patient history, cancellation, and resubmission routes', () => {
  const patient = { lineAccountId: 'account-1', friendId: 'friend-1' };
  const deleteObject = vi.fn();
  const request = (path: string, method = 'GET') => prescriptionRoutes.request(
    `${path}?liffId=liff-1`,
    {
      method,
      headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json' },
      body: method === 'GET' ? undefined : JSON.stringify({
        expectedUpdatedAt: '2026-08-17T00:00:00.000Z',
      }),
    },
    { DB: env.DB, IMAGES: { delete: deleteObject } as unknown as R2Bucket },
  );

  beforeEach(() => {
    mocks.verify.mockResolvedValue({ lineUserId: 'U1', loginChannelId: 'login-1' });
    mocks.resolvePatient.mockResolvedValue(patient);
    mocks.listHistory.mockResolvedValue([{ id: 'submission-1', status: 'received' }]);
    mocks.cancel.mockResolvedValue([
      { id: 'file-1', r2_key: 'custom/pharmacy/prescriptions/submission-1/1/file-1' },
    ]);
    mocks.reserveResubmission.mockResolvedValue(undefined);
    mocks.reportArrival.mockResolvedValue({ arrivalReportedAt: '2026-08-19T10:00:00.000Z' });
    mocks.markFileDeleted.mockResolvedValue(undefined);
    deleteObject.mockResolvedValue(undefined);
  });

  it('returns owned history without thumbnails', async () => {
    const response = await request('/api/liff/pharmacy/prescriptions/me');
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      submissions: [{ id: 'submission-1', status: 'received' }],
    });
  });

  it('keeps owned history available when prescription intake is disabled', async () => {
    mocks.capability.mockResolvedValue(false);
    const response = await request('/api/liff/pharmacy/prescriptions/me');
    expect(response.status).toBe(200);
    expect(mocks.listHistory).toHaveBeenCalled();
  });

  it('commits cancellation before deleting and marking each R2 object', async () => {
    const response = await request(
      '/api/liff/pharmacy/prescriptions/submission-1/cancel',
      'POST',
    );
    expect(response.status).toBe(200);
    expect(mocks.cancel).toHaveBeenCalled();
    expect(deleteObject).toHaveBeenCalledWith(
      'custom/pharmacy/prescriptions/submission-1/1/file-1',
    );
    expect(mocks.markFileDeleted).toHaveBeenCalledWith(
      env.DB, patient, 'submission-1', 'file-1',
    );
  });

  it('keeps cancellation valid and reports cleanup pending after R2 failure', async () => {
    deleteObject.mockRejectedValueOnce(new Error('r2 unavailable'));
    const response = await request(
      '/api/liff/pharmacy/prescriptions/submission-1/cancel',
      'POST',
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      status: 'cancelled', cleanupPending: true,
    });
    expect(mocks.markFileDeleted).not.toHaveBeenCalled();
  });

  it('reserves a replacement revision with CAS', async () => {
    const response = await request(
      '/api/liff/pharmacy/prescriptions/submission-1/resubmission',
      'POST',
    );
    expect(response.status).toBe(200);
    expect(mocks.reserveResubmission).toHaveBeenCalledWith(
      env.DB, patient, 'submission-1', '2026-08-17T00:00:00.000Z',
    );
  });

  it('records an authenticated patient arrival with account and owner scope', async () => {
    const response = await request(
      '/api/liff/pharmacy/prescriptions/submission-1/arrival',
      'POST',
    );
    expect(response.status).toBe(200);
    expect(mocks.reportArrival).toHaveBeenCalledWith(
      env.DB, patient, 'submission-1', '2026-08-17T00:00:00.000Z',
    );
  });
});

describe('admin prescription routes', () => {
  const getObject = vi.fn();
  const adminEnv = {
    DB: env.DB,
    IMAGES: { get: getObject } as unknown as R2Bucket,
  };

  beforeEach(() => {
    mocks.listAdmin.mockResolvedValue([{ id: 'submission-1', status: 'received' }]);
    mocks.adminStats.mockResolvedValue({ pending_count: 1, oldest_wait_at: '2026-08-17T00:00:00Z' });
    mocks.adminDetail.mockResolvedValue({ submission: { id: 'submission-1' }, files: [], events: [] });
    mocks.adminFile.mockResolvedValue({ r2_key: 'private-key', content_type: 'image/png' });
    mocks.recordFileViewed.mockResolvedValue(undefined);
    mocks.adminAction.mockResolvedValue({ status: 'accepted', statusEventId: 'event-1' });
    getObject.mockResolvedValue({ arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer });
  });

  it('rejects a staff member outside the requested account before reading the queue', async () => {
    mocks.access.mockResolvedValue(false);
    const response = await adminApp().request(
      '/api/custom/pharmacy/prescriptions?line_account_id=account-b', {}, adminEnv,
    );
    expect(response.status).toBe(403);
    expect(mocks.listAdmin).not.toHaveBeenCalled();
  });

  it('requires line_account_id for every admin collection query', async () => {
    const response = await adminApp().request(
      '/api/custom/pharmacy/prescriptions', {}, adminEnv,
    );
    expect(response.status).toBe(400);
    expect(mocks.listAdmin).not.toHaveBeenCalled();
  });

  it('keeps the existing queue available when new prescription intake is disabled', async () => {
    mocks.capability.mockResolvedValue(false);
    const response = await adminApp().request(
      '/api/custom/pharmacy/prescriptions?line_account_id=account-1', {}, adminEnv,
    );
    expect(response.status).toBe(200);
    expect(mocks.listAdmin).toHaveBeenCalled();
  });

  it('returns an account-scoped queue without thumbnails', async () => {
    const response = await adminApp().request(
      '/api/custom/pharmacy/prescriptions?line_account_id=account-1', {}, adminEnv,
    );
    expect(response.status).toBe(200);
    expect(mocks.listAdmin).toHaveBeenCalledWith(
      env.DB,
      'account-1',
      { status: null, cursor: null, limit: 21 },
    );
    expect(JSON.stringify(await response.json())).not.toContain('thumbnail');
  });

  it('audits a staff prescription detail view with ids only', async () => {
    mocks.audit.mockResolvedValue(undefined);
    const response = await adminApp().request(
      '/api/custom/pharmacy/prescriptions/submission-1?line_account_id=account-1', {}, adminEnv,
    );
    expect(response.status).toBe(200);
    expect(mocks.audit).toHaveBeenCalledWith(env.DB, {
      lineAccountId: 'account-1', actorStaffId: 'staff-1',
      action: 'phi.prescription_detail_viewed',
      resourceType: 'prescription_submission', resourceId: 'submission-1',
    });
  });

  it('does not audit a missing prescription detail', async () => {
    mocks.adminDetail.mockResolvedValue(null);
    const response = await adminApp().request(
      '/api/custom/pharmacy/prescriptions/submission-9?line_account_id=account-1', {}, adminEnv,
    );
    expect(response.status).toBe(404);
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it('denies a private image not owned by the requested account', async () => {
    mocks.adminFile.mockResolvedValueOnce(null);
    const response = await adminApp().request(
      '/api/custom/pharmacy/prescriptions/submission-1/files/file-1?line_account_id=account-2',
      {},
      adminEnv,
    );
    expect(response.status).toBe(404);
    expect(getObject).not.toHaveBeenCalled();
    expect(mocks.recordFileViewed).not.toHaveBeenCalled();
  });

  it('streams an authorized image with no-store headers and records exactly one view event', async () => {
    const response = await adminApp().request(
      '/api/custom/pharmacy/prescriptions/submission-1/files/file-1?line_account_id=account-1',
      {},
      adminEnv,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('Content-Type')).toBe('image/png');
    expect(mocks.recordFileViewed).toHaveBeenCalledTimes(1);
    expect(mocks.recordFileViewed).toHaveBeenCalledWith(
      env.DB, 'account-1', 'submission-1', 'file-1', 'staff-1',
    );
  });

  it('applies a scoped admin CAS action with the authenticated staff id', async () => {
    const response = await adminApp().request(
      '/api/custom/pharmacy/prescriptions/submission-1/actions/accept?line_account_id=account-1',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expectedUpdatedAt: '2026-08-17T00:00:00.000Z', operationId: 'operation-1' }),
      },
      adminEnv,
    );
    expect(response.status).toBe(200);
    expect(mocks.adminAction).toHaveBeenCalledWith(
      env.DB, 'account-1', 'submission-1', 'admin_accept',
      '2026-08-17T00:00:00.000Z', 'staff-1', null, 'operation-1',
    );
    expect(mocks.notify).toHaveBeenCalledWith(
      env.DB,
      'account-1',
      'submission-1',
      expect.objectContaining({ proxyDispatch: expect.any(Function) }),
      'event-1',
    );
    expect(mocks.adminAction.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.notify.mock.invocationCallOrder[0],
    );
    expect(mocks.activation).toHaveBeenCalledWith(env.DB, 'account-1', 'submission-1');
    expect(mocks.enqueueActivity).toHaveBeenCalledWith(
      env.DB,
      'account-1',
      'prescription_status_changed',
      'prescription:status:submission-1:accepted',
    );
  });

  it('keeps a committed action successful when notification delivery fails', async () => {
    mocks.notify.mockResolvedValueOnce({ status: 'failed' });
    const response = await adminApp().request(
      '/api/custom/pharmacy/prescriptions/submission-1/actions/accept?line_account_id=account-1',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expectedUpdatedAt: '2026-08-17T00:00:00.000Z' }),
      },
      adminEnv,
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      status: 'accepted',
      statusEventId: 'event-1',
      notification: { status: 'failed' },
    });
  });

  it('does not turn a committed close into a false failure when continuity repair is needed', async () => {
    mocks.adminAction.mockResolvedValueOnce({ status: 'closed', statusEventId: 'event-close' });
    mocks.notify.mockResolvedValueOnce({ status: 'sent' });
    mocks.completeContinuity.mockRejectedValueOnce(new Error('continuity unavailable'));
    const response = await adminApp().request(
      '/api/custom/pharmacy/prescriptions/submission-1/actions/close?line_account_id=account-1',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expectedUpdatedAt: '2026-08-17T00:00:00.000Z', operationId: 'operation-close' }),
      },
      adminEnv,
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      status: 'closed',
      statusEventId: 'event-close',
      notification: { status: 'sent' },
      continuity: 'retry_pending',
    });
  });

  it('returns a conflict without notifying when prescription validity is not usable', async () => {
    mocks.adminAction.mockRejectedValueOnce(new Error('prescription validity verification required'));
    const response = await adminApp().request(
      '/api/custom/pharmacy/prescriptions/submission-1/actions/accept?line_account_id=account-1',
      {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expectedUpdatedAt: '2026-08-17T00:00:00.000Z' }),
      },
      adminEnv,
    );
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: '処方せんの使用期限を確認してください' });
    expect(mocks.notify).not.toHaveBeenCalled();
  });
});

describe('POST /api/liff/pharmacy/prescriptions/:id/submit', () => {
  const request = (body: Record<string, unknown> = {}) => prescriptionRoutes.request(
    '/api/liff/pharmacy/prescriptions/submission-1/submit?liffId=liff-1',
    {
      method: 'POST',
      headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        expectedUpdatedAt: '2026-08-17T00:00:00.000Z',
        desiredPickupAt: '2026-08-19T09:00:00.000Z',
        desiredFulfillmentMethod: null,
        originalPrescriptionConsent: true,
        readinessNoticeConsent: true,
        ...body,
      }),
    },
    env,
  );

  beforeEach(() => {
    mocks.verify.mockResolvedValue({ lineUserId: 'U1', loginChannelId: 'login-1' });
    mocks.resolvePatient.mockResolvedValue({ lineAccountId: 'account-1', friendId: 'friend-1' });
    mocks.submit.mockResolvedValue({ statusEventId: 'event-1' });
  });

  it('submits with the caller-owned tenant and expected version', async () => {
    expect((await request()).status).toBe(200);
    expect(mocks.submit).toHaveBeenCalledWith(
      env.DB,
      { lineAccountId: 'account-1', friendId: 'friend-1' },
      'submission-1',
      {
        expectedUpdatedAt: '2026-08-17T00:00:00.000Z',
        desiredPickupAt: '2026-08-19T09:00:00.000Z',
        desiredFulfillmentMethod: null,
        originalPrescriptionConsent: true,
        readinessNoticeConsent: true,
      },
    );
    expect(mocks.notify).toHaveBeenCalledWith(
      env.DB,
      'account-1',
      'submission-1',
      expect.objectContaining({ proxyDispatch: expect.any(Function) }),
      'event-1',
    );
  });

  it('rejects submit when the current consent confirmation is missing', async () => {
    expect((await request({ originalPrescriptionConsent: false })).status).toBe(400);
    expect(mocks.submit).not.toHaveBeenCalled();
  });

  it('keeps a committed submission successful when continuity linking needs repair', async () => {
    mocks.linkContinuity.mockRejectedValueOnce(new Error('continuity unavailable'));
    const response = await request();
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      status: 'received',
      statusEventId: 'event-1',
      notification: { status: 'sent' },
    });
    expect(mocks.notify).toHaveBeenCalledWith(
      env.DB,
      'account-1',
      'submission-1',
      expect.objectContaining({ proxyDispatch: expect.any(Function) }),
      'event-1',
    );
  });

  it('returns 409 for stale state or incomplete consent/files', async () => {
    mocks.submit.mockRejectedValueOnce(new Error('prescription submit conflict'));
    expect((await request()).status).toBe(409);
  });
});

describe('POST /api/liff/pharmacy/prescriptions', () => {
  const request = (body: unknown) => prescriptionRoutes.request(
    '/api/liff/pharmacy/prescriptions?liffId=liff-1',
    {
      method: 'POST',
      headers: {
        Authorization: 'Bearer token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    },
    env,
  );

  it('rejects an unverified LINE caller', async () => {
    mocks.verify.mockResolvedValue(null);
    expect((await request({})).status).toBe(401);
  });

  it('fails closed when LIFF and verified account do not resolve a friend', async () => {
    mocks.verify.mockResolvedValue({ lineUserId: 'U1', loginChannelId: 'login-1' });
    mocks.resolvePatient.mockResolvedValue(null);
    expect((await request({})).status).toBe(404);
  });

  it('reserves a tenant-scoped idempotent draft', async () => {
    const patient = { lineAccountId: 'account-1', friendId: 'friend-1' };
    const draft = { id: 'submission-1', status: 'draft', upload_revision: 1 };
    mocks.verify.mockResolvedValue({ lineUserId: 'U1', loginChannelId: 'login-1' });
    mocks.resolvePatient.mockResolvedValue(patient);
    mocks.reserveDraft.mockResolvedValue(draft);

    const response = await request({
      idempotencyKey: 'request-123',
      desiredPickupAt: null,
      desiredFulfillmentMethod: 'PICKUP',
      originalPrescriptionConsent: true,
      readinessNoticeConsent: true,
    });

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({ submission: draft });
    expect(mocks.resolvePatient).toHaveBeenCalledWith(
      env.DB,
      'liff-1',
      { lineUserId: 'U1', loginChannelId: 'login-1' },
    );
    expect(mocks.reserveDraft).toHaveBeenCalledWith(env.DB, patient, {
      idempotencyKey: 'request-123',
      desiredPickupAt: null,
      desiredFulfillmentMethod: 'PICKUP',
      originalPrescriptionConsent: true,
      readinessNoticeConsent: true,
    });
  });

  it('rejects only a new draft with FEATURE_DISABLED', async () => {
    const patient = { lineAccountId: 'account-1', friendId: 'friend-1' };
    mocks.verify.mockResolvedValue({ lineUserId: 'U1', loginChannelId: 'login-1' });
    mocks.resolvePatient.mockResolvedValue(patient);
    mocks.reserveDraft.mockRejectedValue(new Error('FEATURE_DISABLED'));

    const response = await request({
      idempotencyKey: 'request-123', desiredPickupAt: null,
      originalPrescriptionConsent: true, readinessNoticeConsent: true,
    });
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ code: 'FEATURE_DISABLED' });
    expect(mocks.reserveDraft).toHaveBeenCalled();
  });

  it('rejects an unsupported patient fulfillment preference', async () => {
    const response = await request({
      idempotencyKey: 'request-123', desiredPickupAt: null,
      desiredFulfillmentMethod: 'DRONE',
      originalPrescriptionConsent: true, readinessNoticeConsent: true,
    });
    expect(response.status).toBe(400);
    expect(mocks.reserveDraft).not.toHaveBeenCalled();
  });

  it('passes the explicit patient and intake revision to the draft reservation', async () => {
    const patient = { lineAccountId: 'account-1', friendId: 'friend-1' };
    mocks.verify.mockResolvedValue({ lineUserId: 'U1', loginChannelId: 'login-1' });
    mocks.resolvePatient.mockResolvedValue(patient);
    mocks.reserveDraft.mockResolvedValue({ id: 'submission-1', status: 'draft' });
    const response = await request({
      idempotencyKey: 'request-123', desiredPickupAt: null,
      originalPrescriptionConsent: true, readinessNoticeConsent: true,
      patientId: 'patient-1', intakeResponseId: 'response-1',
    });
    expect(response.status).toBe(201);
    expect(mocks.reserveDraft).toHaveBeenCalledWith(env.DB, patient, {
      idempotencyKey: 'request-123', desiredPickupAt: null,
      originalPrescriptionConsent: true, readinessNoticeConsent: true,
      patientId: 'patient-1', intakeResponseId: 'response-1',
    });
  });

  it('rejects a draft that names only one side of the patient link', async () => {
    const response = await request({
      idempotencyKey: 'request-123', desiredPickupAt: null,
      originalPrescriptionConsent: true, readinessNoticeConsent: true,
      patientId: 'patient-1',
    });
    expect(response.status).toBe(400);
    expect(mocks.reserveDraft).not.toHaveBeenCalled();
  });

  it('rejects malformed consent input', async () => {
    mocks.verify.mockResolvedValue({ lineUserId: 'U1', loginChannelId: 'login-1' });
    mocks.resolvePatient.mockResolvedValue({ lineAccountId: 'account-1', friendId: 'friend-1' });
    expect((await request({ idempotencyKey: 'request-123' })).status).toBe(400);
    expect(mocks.reserveDraft).not.toHaveBeenCalled();
  });
});

describe('PUT /api/liff/pharmacy/prescriptions/:id/files/:position', () => {
  const patient = { lineAccountId: 'account-1', friendId: 'friend-1' };
  const put = vi.fn();
  const upload = (headers: Record<string, string> = {}) => prescriptionRoutes.request(
    '/api/liff/pharmacy/prescriptions/submission-1/files/1?liffId=liff-1',
    {
      method: 'PUT',
      headers: {
        Authorization: 'Bearer token',
        'Content-Type': 'image/png',
        ...headers,
      },
      body: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
    },
    { DB: env.DB, IMAGES: { put } as unknown as R2Bucket },
  );

  beforeEach(() => {
    mocks.verify.mockResolvedValue({ lineUserId: 'U1', loginChannelId: 'login-1' });
    mocks.resolvePatient.mockResolvedValue(patient);
    mocks.inspectImage.mockResolvedValue({ byteSize: 4, sha256: 'a'.repeat(64) });
    mocks.reserveFile.mockResolvedValue({
      id: 'file-1',
      r2_key: 'custom/pharmacy/prescriptions/submission-1/1/file-1',
      content_type: 'image/png',
      byte_size: 4,
      sha256: 'a'.repeat(64),
      state: 'pending',
      revision: 1,
      position: 1,
    });
    put.mockResolvedValue(undefined);
  });

  it('rejects an oversized declared body before reading it', async () => {
    const response = await upload({ 'Content-Length': String(10 * 1024 * 1024 + 1) });
    expect(response.status).toBe(413);
    expect(mocks.inspectImage).not.toHaveBeenCalled();
  });

  it('persists pending, writes R2, and only then marks ready', async () => {
    const response = await upload({ 'Content-Length': '4' });
    expect(response.status).toBe(200);
    expect(mocks.reserveFile).toHaveBeenCalledWith(
      env.DB, patient, 'submission-1', 1,
      { contentType: 'image/png', byteSize: 4, sha256: 'a'.repeat(64) },
    );
    expect(put).toHaveBeenCalledWith(
      'custom/pharmacy/prescriptions/submission-1/1/file-1',
      expect.any(Uint8Array),
      { httpMetadata: { contentType: 'image/png' } },
    );
    expect(mocks.markFileReady).toHaveBeenCalledWith(
      env.DB, patient, 'submission-1', 'file-1', 'a'.repeat(64),
    );
  });

  it('does not rewrite R2 for an identical ready retry', async () => {
    mocks.reserveFile.mockResolvedValueOnce({
      id: 'file-1',
      r2_key: 'custom/pharmacy/prescriptions/submission-1/1/file-1',
      content_type: 'image/png',
      byte_size: 4,
      sha256: 'a'.repeat(64),
      state: 'ready',
      revision: 1,
      position: 1,
    });
    expect((await upload()).status).toBe(200);
    expect(put).not.toHaveBeenCalled();
    expect(mocks.markFileReady).not.toHaveBeenCalled();
  });

  it('leaves the D1 row pending when R2 fails', async () => {
    put.mockRejectedValueOnce(new Error('r2 unavailable'));
    expect((await upload()).status).toBe(503);
    expect(mocks.markFileReady).not.toHaveBeenCalled();
  });
});
