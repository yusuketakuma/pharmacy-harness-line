import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const mocks = vi.hoisted(() => ({
  access: vi.fn(), capability: vi.fn(), schedule: vi.fn(), transition: vi.fn(),
  listOwner: vi.fn(), getOwner: vi.fn(), respond: vi.fn(), verify: vi.fn(), resolve: vi.fn(),
}));
vi.mock('../growth-loop/access.js', () => ({
  canAccessPharmacyAccount: mocks.access,
  hasPharmacyCapability: mocks.capability,
}));
vi.mock('./repository.js', () => ({
  scheduleMedicationFollowUp: mocks.schedule,
  transitionMedicationFollowUp: mocks.transition,
  listOwnerMedicationFollowUps: mocks.listOwner,
  getOwnerMedicationFollowUp: mocks.getOwner,
  respondToMedicationFollowUp: mocks.respond,
}));
vi.mock('../../../services/liff-auth.js', () => ({ verifyCallerLineIdentity: mocks.verify }));
vi.mock('../prescriptions/patient.js', () => ({ resolvePrescriptionPatient: mocks.resolve }));

import { medicationFollowUpRoutes } from './routes.js';

const env = { DB: {} as D1Database };
function app() {
  const root = new Hono<any>();
  root.use('*', async (c, next) => {
    c.set('staff', { id: 'staff-a', name: 'Staff', role: 'staff' });
    await next();
  });
  root.route('/', medicationFollowUpRoutes);
  return root;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.access.mockResolvedValue(true);
  mocks.capability.mockResolvedValue(true);
  mocks.schedule.mockResolvedValue({
    id: 'followup-a', status: 'scheduled', version: 1,
    line_account_id: 'account-a', owner_friend_id: 'friend-a', patient_id: 'patient-a',
    created_by: 'staff-a',
  });
  mocks.transition.mockResolvedValue({ id: 'followup-a', status: 'assigned', version: 4 });
  mocks.verify.mockResolvedValue({
    lineUserId: 'U-a', loginChannelId: 'login-a', tenantId: 'tenant-a', lineAccountId: 'account-a',
  });
  mocks.resolve.mockResolvedValue({ lineAccountId: 'account-a', friendId: 'friend-a' });
  mocks.listOwner.mockResolvedValue([{
    id: 'followup-a', patient_name: '田中 太郎', status: 'delivered',
    due_at: '2026-08-21T09:00:00.000Z', delivered_at: '2026-08-21T09:00:00.000Z',
    responded_at: null, closed_at: null, version: 3,
  }]);
  mocks.getOwner.mockResolvedValue({
    id: 'followup-a', patient_name: '田中 太郎', status: 'concern',
    due_at: '2026-08-21T09:00:00.000Z', delivered_at: '2026-08-21T09:00:00.000Z',
    responded_at: '2026-08-21T10:00:00.000Z', closed_at: null, version: 4,
  });
  mocks.respond.mockResolvedValue({
    id: 'followup-a', patient_name: '田中 太郎', status: 'concern',
    due_at: '2026-08-21T09:00:00.000Z', delivered_at: '2026-08-21T09:00:00.000Z',
    responded_at: '2026-08-21T10:00:00.000Z', closed_at: null, version: 4,
  });
});

describe('medication follow-up patient routes', () => {
  it('lists only the verified LINE owner records without prescription identifiers', async () => {
    const response = await app().request(
      '/api/liff/pharmacy/medication-followups?liffId=liff-a',
      { headers: { Authorization: 'Bearer id-token-a' } }, env,
    );
    expect(response.status).toBe(200);
    const payload = await response.json() as { followUps: Array<Record<string, unknown>> };
    expect(payload.followUps[0]).toMatchObject({
      id: 'followup-a', patient_name: '田中 太郎', status: 'delivered', version: 3,
    });
    expect(payload.followUps[0]).not.toHaveProperty('source_submission_id');
    expect(mocks.resolve).toHaveBeenCalledWith(env.DB, 'liff-a', expect.objectContaining({
      tenantId: 'tenant-a', lineAccountId: 'account-a',
    }));
    expect(mocks.listOwner).toHaveBeenCalledWith(env.DB, 'account-a', 'friend-a');
  });

  it('records a fixed patient response with owner scope and idempotency', async () => {
    mocks.getOwner.mockResolvedValue({
      id: 'followup-a', patient_name: '田中 太郎', status: 'concern',
      due_at: '2026-08-21T09:00:00.000Z', delivered_at: '2026-08-21T09:00:00.000Z',
      responded_at: '2026-08-21T10:00:00.000Z', closed_at: null, version: 4,
    });
    const response = await app().request(
      '/api/liff/pharmacy/medication-followups/followup-a/respond?liffId=liff-a',
      {
        method: 'POST',
        headers: { Authorization: 'Bearer id-token-a', 'Content-Type': 'application/json' },
        body: JSON.stringify({ response: 'concern', expectedVersion: 3, idempotencyKey: 'response-a' }),
      }, env,
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      followUp: { id: 'followup-a', patient_name: '田中 太郎', status: 'concern', version: 4 },
    });
    expect(mocks.respond).toHaveBeenCalledWith(env.DB, {
      lineAccountId: 'account-a', friendId: 'friend-a', followUpId: 'followup-a',
      response: 'concern', expectedVersion: 3, idempotencyKey: 'response-a',
    });
    expect(mocks.getOwner).toHaveBeenCalledWith(env.DB, 'account-a', 'friend-a', 'followup-a');
    expect(mocks.listOwner).not.toHaveBeenCalled();
  });

  it('returns success when the responded row falls outside the recent-20 listing window', async () => {
    // Regression for the false-409 bug: the respond route must confirm the
    // write with a targeted id lookup, not by re-deriving it from the
    // LIMIT-20 recent-activity listing (which a prolific owner can outgrow).
    mocks.listOwner.mockResolvedValue([]); // simulates the target row being outside the top 20
    mocks.getOwner.mockResolvedValue({
      id: 'followup-old', patient_name: '田中 太郎', status: 'no_issue',
      due_at: '2020-01-01T09:00:00.000Z', delivered_at: '2020-01-01T09:00:00.000Z',
      responded_at: '2026-08-21T10:00:00.000Z', closed_at: null, version: 2,
    });
    mocks.respond.mockResolvedValue({ id: 'followup-old', status: 'no_issue', version: 2 });
    const response = await app().request(
      '/api/liff/pharmacy/medication-followups/followup-old/respond?liffId=liff-a',
      {
        method: 'POST',
        headers: { Authorization: 'Bearer id-token-a', 'Content-Type': 'application/json' },
        body: JSON.stringify({ response: 'no_issue', expectedVersion: 1, idempotencyKey: 'response-old' }),
      }, env,
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      followUp: { id: 'followup-old', patient_name: '田中 太郎', status: 'no_issue', version: 2 },
    });
  });

  it('fails closed before listing when LIFF identity cannot be verified', async () => {
    mocks.verify.mockResolvedValue(null);
    const response = await app().request(
      '/api/liff/pharmacy/medication-followups?liffId=liff-a', {}, env,
    );
    expect(response.status).toBe(401);
    expect(mocks.listOwner).not.toHaveBeenCalled();
  });

  it('keeps existing medication follow-ups readable when the feature is disabled', async () => {
    mocks.capability.mockResolvedValue(false);
    const response = await app().request(
      '/api/liff/pharmacy/medication-followups?liffId=liff-a',
      { headers: { Authorization: 'Bearer id-token-a' } }, env,
    );
    expect(response.status).toBe(200);
    expect(mocks.listOwner).toHaveBeenCalled();
  });
});

describe('medication follow-up staff routes', () => {
  it('rejects cross-account scheduling before touching the workflow', async () => {
    mocks.access.mockResolvedValue(false);
    const response = await app().request(
      '/api/custom/pharmacy/medication-followups?line_account_id=account-b',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        submissionId: 'submission-a', dueAt: '2026-08-21T09:00:00.000Z',
        idempotencyKey: 'request-a',
      }) },
      env,
    );
    expect(response.status).toBe(403);
    expect(mocks.schedule).not.toHaveBeenCalled();
  });

  it('requires the account capability and derives patient scope from the submission', async () => {
    mocks.capability.mockResolvedValue(false);
    let response = await app().request(
      '/api/custom/pharmacy/medication-followups?line_account_id=account-a',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        submissionId: 'submission-a', dueAt: '2026-08-21T09:00:00.000Z',
        idempotencyKey: 'request-a', patientId: 'patient-b',
      }) }, env,
    );
    expect(response.status).toBe(409);
    mocks.capability.mockResolvedValue(true);
    response = await app().request(
      '/api/custom/pharmacy/medication-followups?line_account_id=account-a',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        submissionId: 'submission-a', dueAt: '2026-08-21T09:00:00.000Z',
        idempotencyKey: 'request-a', patientId: 'patient-b',
      }) }, env,
    );
    expect(response.status).toBe(201);
    const payload = await response.json() as { followUp: Record<string, unknown> };
    expect(payload.followUp).not.toHaveProperty('line_account_id');
    expect(payload.followUp).not.toHaveProperty('owner_friend_id');
    expect(payload.followUp).not.toHaveProperty('patient_id');
    expect(payload.followUp).not.toHaveProperty('created_by');
    expect(mocks.schedule).toHaveBeenCalledWith(env.DB, {
      lineAccountId: 'account-a', submissionId: 'submission-a',
      dueAt: '2026-08-21T09:00:00.000Z', staffId: 'staff-a',
      idempotencyKey: 'request-a',
    });
  });

  it('allows only staff workflow actions with optimistic versioning', async () => {
    let response = await app().request(
      '/api/custom/pharmacy/medication-followups/followup-a/transitions?line_account_id=account-a',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        status: 'assigned', expectedVersion: 3,
      }) }, env,
    );
    expect(response.status).toBe(200);
    expect(mocks.transition).toHaveBeenCalledWith(env.DB, {
      lineAccountId: 'account-a', followUpId: 'followup-a',
      toStatus: 'assigned', expectedVersion: 3,
      actorType: 'staff', actorId: 'staff-a',
    });

    response = await app().request(
      '/api/custom/pharmacy/medication-followups/followup-a/transitions?line_account_id=account-a',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        status: 'delivered', expectedVersion: 3,
      }) }, env,
    );
    expect(response.status).toBe(400);
  });

  it('does not expose internal scheduling errors', async () => {
    mocks.schedule.mockRejectedValue(new Error('SQLITE_CONSTRAINT patient-123'));
    const response = await app().request(
      '/api/custom/pharmacy/medication-followups?line_account_id=account-a',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        submissionId: 'submission-a', dueAt: '2026-08-21T09:00:00.000Z',
        idempotencyKey: 'request-a',
      }) }, env,
    );

    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain('SQLITE_CONSTRAINT patient-123');
  });

  it('keeps transition conflicts distinct without returning repository text', async () => {
    mocks.transition.mockRejectedValue(new Error('medication follow-up transition conflict'));
    const response = await app().request(
      '/api/custom/pharmacy/medication-followups/followup-a/transitions?line_account_id=account-a',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        status: 'assigned', expectedVersion: 3,
      }) }, env,
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: '服薬後フォローは更新されています。再読み込みしてください。',
    });
  });
});
