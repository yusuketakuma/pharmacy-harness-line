import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const mocks = vi.hoisted(() => ({
  access: vi.fn(), capability: vi.fn(), schedule: vi.fn(), transition: vi.fn(),
  listOwner: vi.fn(), getOwner: vi.fn(), respond: vi.fn(), verify: vi.fn(), resolve: vi.fn(),
  listContacts: vi.fn(), recordContact: vi.fn(),
  audit: vi.fn(),
  betaParticipant: vi.fn(),
  outlook: vi.fn(),
  getOperations: vi.fn(), saveOperations: vi.fn(),
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
  listMedicationFollowUpContacts: mocks.listContacts,
  recordMedicationFollowUpContact: mocks.recordContact,
  getMedicationFollowUpOperationsOutlook: mocks.outlook,
  getMedicationFollowUpOperations: mocks.getOperations,
  saveMedicationFollowUpOperations: mocks.saveOperations,
}));
vi.mock('../../../services/liff-auth.js', () => ({ verifyCallerLineIdentity: mocks.verify }));
vi.mock('../prescriptions/patient.js', () => ({ resolvePrescriptionPatient: mocks.resolve }));
vi.mock('../beta-membership/repository.js', () => ({
  canUsePharmacyBetaParticipant: mocks.betaParticipant,
}));
vi.mock('../../../lib/tenant-audit.js', () => ({ recordTenantAudit: mocks.audit }));

import { medicationFollowUpRoutes } from './routes.js';

const env = { DB: {} as D1Database };
function app() {
  const root = new Hono<any>();
  root.use('*', async (c, next) => {
    c.set('staff', { id: 'staff-a', name: 'Staff', role: 'owner' });
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
  mocks.betaParticipant.mockResolvedValue(true);
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
  mocks.outlook.mockResolvedValue({
    serviceHoursText: '9:00-18:00', responseEstimateMinutes: 30,
    afterHoursMessageCode: 'contact_pharmacy_during_hours',
    emergencyMessageCode: 'seek_urgent_care',
  });
  mocks.listContacts.mockResolvedValue([]);
  mocks.recordContact.mockResolvedValue({
    id: 'contact-a', channel: 'phone', outcome_code: 'answered',
    next_contact_at: null, occurred_at: '2026-08-21T10:00:00.000Z',
  });
  mocks.audit.mockResolvedValue(undefined);
  mocks.getOperations.mockResolvedValue({
    line_account_id: 'account-a', service_hours_text: '9:00-18:00',
    response_sla_json: '{"typical_minutes":30,"concern_minutes":60}',
    primary_staff_id: 'staff-a', backup_staff_id: null,
    after_hours_message_code: 'contact_pharmacy_during_hours',
    emergency_message_code: 'seek_urgent_care',
    enabled: 1, version: 2,
    created_at: '2026-08-20T09:00:00.000Z', updated_at: '2026-08-21T09:00:00.000Z',
  });
  mocks.saveOperations.mockResolvedValue({
    line_account_id: 'account-a', service_hours_text: '9:00-18:00',
    response_sla_json: '{"typical_minutes":30,"concern_minutes":60}',
    primary_staff_id: 'staff-a', backup_staff_id: 'staff-b',
    after_hours_message_code: 'contact_pharmacy_during_hours',
    emergency_message_code: 'seek_urgent_care',
    enabled: 1, version: 3,
    created_at: '2026-08-20T09:00:00.000Z', updated_at: '2026-08-21T10:00:00.000Z',
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

  it('returns the whitelisted operations outlook for the owner account', async () => {
    const response = await app().request(
      '/api/liff/pharmacy/medication-followups/outlook?liffId=liff-a',
      { headers: { Authorization: 'Bearer id-token-a' } }, env,
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      outlook: {
        serviceHoursText: '9:00-18:00', responseEstimateMinutes: 30,
        afterHoursMessageCode: 'contact_pharmacy_during_hours',
        emergencyMessageCode: 'seek_urgent_care',
      },
    });
    expect(mocks.outlook).toHaveBeenCalledWith(env.DB, 'account-a');
  });

  it('rejects a non-participant before listing follow-ups', async () => {
    mocks.betaParticipant.mockResolvedValue(false);
    const response = await app().request(
      '/api/liff/pharmacy/medication-followups?liffId=liff-a',
      { headers: { Authorization: 'Bearer id-token-a' } }, env,
    );
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: 'Pharmacy beta participation required' });
    expect(mocks.betaParticipant).toHaveBeenCalledWith(env.DB, 'account-a', 'friend-a');
    expect(mocks.listOwner).not.toHaveBeenCalled();
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

  it('passes a fixed contact record atomically with the responded transition', async () => {
    const response = await app().request(
      '/api/custom/pharmacy/medication-followups/followup-a/transitions?line_account_id=account-a',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        status: 'responded', expectedVersion: 3,
        contact: { channel: 'phone', outcomeCode: 'answered', idempotencyKey: 'contact-a' },
      }) }, env,
    );

    expect(response.status).toBe(200);
    expect(mocks.transition).toHaveBeenCalledWith(env.DB, {
      lineAccountId: 'account-a', followUpId: 'followup-a',
      toStatus: 'responded', expectedVersion: 3,
      actorType: 'staff', actorId: 'staff-a',
      contact: { channel: 'phone', outcomeCode: 'answered', idempotencyKey: 'contact-a' },
    });
  });

  it('records a staff contact with the account scope and expected version', async () => {
    const response = await app().request(
      '/api/custom/pharmacy/medication-followups/followup-a/contacts?line_account_id=account-a',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        channel: 'phone', outcomeCode: 'follow_up_required',
        nextContactAt: '2026-08-22T01:00:00.000Z', idempotencyKey: 'contact-follow-up',
        expectedVersion: 3,
      }) }, env,
    );

    expect(response.status).toBe(200);
    expect(mocks.recordContact).toHaveBeenCalledWith(env.DB, {
      lineAccountId: 'account-a', followUpId: 'followup-a', channel: 'phone',
      outcomeCode: 'follow_up_required', nextContactAt: '2026-08-22T01:00:00.000Z',
      actorStaffId: 'staff-a', idempotencyKey: 'contact-follow-up', expectedVersion: 3,
    });
  });

  it('audits and disables caching for contact history reads', async () => {
    const response = await app().request(
      '/api/custom/pharmacy/medication-followups/followup-a/contacts?line_account_id=account-a',
      {}, env,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(mocks.audit).toHaveBeenCalledWith(env.DB, {
      lineAccountId: 'account-a', actorStaffId: 'staff-a',
      action: 'phi.medication_followup_contacts_viewed',
      resourceType: 'medication_followup', resourceId: 'followup-a',
    });
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

  it('reports additive follow-up features as unavailable on an old schema', async () => {
    mocks.schedule.mockRejectedValue(new Error('follow-up closure unavailable'));
    const response = await app().request(
      '/api/custom/pharmacy/medication-followups?line_account_id=account-a',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        submissionId: 'submission-a', dueAt: '2026-08-21T09:00:00.000Z',
        responseDeadlineAt: '2026-08-22T09:00:00.000Z', idempotencyKey: 'request-a',
      }) }, env,
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: '服薬後フォローの追加対応記録は準備中です。',
    });
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

describe('medication follow-up operations routes', () => {
  const operationsBody = {
    serviceHoursText: '9:00-18:00',
    responseSla: { typical_minutes: 30, concern_minutes: 60 },
    primaryStaffId: 'staff-a', backupStaffId: 'staff-b',
    afterHoursMessageCode: 'contact_pharmacy_during_hours',
    emergencyMessageCode: 'seek_urgent_care',
    enabled: true, expectedVersion: 2,
  };

  it('returns the scoped account operations config', async () => {
    const response = await app().request(
      '/api/custom/pharmacy/medication-followups/operations?line_account_id=account-a',
      {}, env,
    );

    expect(response.status).toBe(200);
    const payload = await response.json() as { operations: Record<string, unknown> };
    expect(payload.operations).toMatchObject({
      service_hours_text: '9:00-18:00',
      response_sla: { typical_minutes: 30, concern_minutes: 60 },
      primary_staff_id: 'staff-a', backup_staff_id: null,
      enabled: true, version: 2,
    });
    expect(mocks.getOperations).toHaveBeenCalledWith(env.DB, 'account-a');
  });

  it('returns null operations when the account is not configured yet', async () => {
    mocks.getOperations.mockResolvedValue(null);
    const response = await app().request(
      '/api/custom/pharmacy/medication-followups/operations?line_account_id=account-a',
      {}, env,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ operations: null });
  });

  it('rejects cross-account operations reads and writes before the repository', async () => {
    mocks.access.mockResolvedValue(false);
    const read = await app().request(
      '/api/custom/pharmacy/medication-followups/operations?line_account_id=account-b',
      {}, env,
    );
    const write = await app().request(
      '/api/custom/pharmacy/medication-followups/operations?line_account_id=account-b',
      { method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(operationsBody) }, env,
    );

    expect(read.status).toBe(403);
    expect(write.status).toBe(403);
    expect(mocks.getOperations).not.toHaveBeenCalled();
    expect(mocks.saveOperations).not.toHaveBeenCalled();
  });

  it('rejects operations writes from non-owner staff before the repository', async () => {
    const root = new Hono<any>();
    root.use('*', async (c, next) => {
      c.set('staff', { id: 'staff-a', name: 'Staff', role: 'staff' });
      await next();
    });
    root.route('/', medicationFollowUpRoutes);
    const response = await root.request(
      '/api/custom/pharmacy/medication-followups/operations?line_account_id=account-a',
      { method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(operationsBody) }, env,
    );

    expect(response.status).toBe(403);
    expect(mocks.saveOperations).not.toHaveBeenCalled();
  });

  it('saves operations with the staff-derived account scope', async () => {
    const response = await app().request(
      '/api/custom/pharmacy/medication-followups/operations?line_account_id=account-a',
      { method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(operationsBody) }, env,
    );

    expect(response.status).toBe(200);
    const payload = await response.json() as { operations: Record<string, unknown> };
    expect(payload.operations).toMatchObject({ enabled: true, version: 3 });
    expect(mocks.saveOperations).toHaveBeenCalledWith(env.DB, {
      lineAccountId: 'account-a',
      serviceHoursText: '9:00-18:00',
      responseSla: { typical_minutes: 30, concern_minutes: 60 },
      primaryStaffId: 'staff-a', backupStaffId: 'staff-b',
      afterHoursMessageCode: 'contact_pharmacy_during_hours',
      emergencyMessageCode: 'seek_urgent_care',
      enabled: true, expectedVersion: 2,
      actorStaffId: 'staff-a',
    });
  });

  it('rejects malformed operations payloads without touching the repository', async () => {
    for (const body of [
      { ...operationsBody, primaryStaffId: 7 },
      { ...operationsBody, enabled: 'yes' },
      { ...operationsBody, expectedVersion: 'two' },
      { ...operationsBody, responseSla: ['typical_minutes'] },
      { ...operationsBody, afterHoursMessageCode: 12 },
    ]) {
      const response = await app().request(
        '/api/custom/pharmacy/medication-followups/operations?line_account_id=account-a',
        { method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body) }, env,
      );
      expect(response.status).toBe(400);
    }
    expect(mocks.saveOperations).not.toHaveBeenCalled();
  });

  it('requires the medication_followup capability for saves but not reads', async () => {
    mocks.capability.mockResolvedValue(false);
    const write = await app().request(
      '/api/custom/pharmacy/medication-followups/operations?line_account_id=account-a',
      { method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(operationsBody) }, env,
    );
    const read = await app().request(
      '/api/custom/pharmacy/medication-followups/operations?line_account_id=account-a',
      {}, env,
    );

    expect(write.status).toBe(409);
    expect(read.status).toBe(200);
    expect(mocks.saveOperations).not.toHaveBeenCalled();
    expect(mocks.getOperations).toHaveBeenCalledWith(env.DB, 'account-a');
  });

  it('maps version conflicts, invalid staff and missing schema to stable statuses', async () => {
    mocks.saveOperations.mockRejectedValue(new Error('follow-up operations conflict'));
    let response = await app().request(
      '/api/custom/pharmacy/medication-followups/operations?line_account_id=account-a',
      { method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(operationsBody) }, env,
    );
    expect(response.status).toBe(409);

    mocks.saveOperations.mockRejectedValue(new Error('invalid follow-up operations staff'));
    response = await app().request(
      '/api/custom/pharmacy/medication-followups/operations?line_account_id=account-a',
      { method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(operationsBody) }, env,
    );
    expect(response.status).toBe(400);

    mocks.saveOperations.mockRejectedValue(new Error('follow-up operations schema unavailable'));
    response = await app().request(
      '/api/custom/pharmacy/medication-followups/operations?line_account_id=account-a',
      { method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(operationsBody) }, env,
    );
    expect(response.status).toBe(503);

    mocks.getOperations.mockRejectedValue(new Error('follow-up operations schema unavailable'));
    response = await app().request(
      '/api/custom/pharmacy/medication-followups/operations?line_account_id=account-a',
      {}, env,
    );
    expect(response.status).toBe(503);
  });
});
