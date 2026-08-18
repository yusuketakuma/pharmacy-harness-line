import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const mocks = vi.hoisted(() => ({
  access: vi.fn(), capability: vi.fn(), schedule: vi.fn(), transition: vi.fn(),
}));
vi.mock('../growth-loop/access.js', () => ({
  canAccessPharmacyAccount: mocks.access,
  hasPharmacyCapability: mocks.capability,
}));
vi.mock('./repository.js', () => ({
  scheduleMedicationFollowUp: mocks.schedule,
  transitionMedicationFollowUp: mocks.transition,
}));

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
    expect(response.status).toBe(403);
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
});
