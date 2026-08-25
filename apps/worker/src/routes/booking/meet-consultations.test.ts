import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../../index.js';

const mocks = vi.hoisted(() => ({
  resolveAccessiblePharmacyTenant: vi.fn(),
  listMeetConsultations: vi.fn(),
  registerMeetConsultation: vi.fn(),
  cancelMeetConsultation: vi.fn(),
}));

vi.mock('../../custom/pharmacy/growth-loop/access.js', () => ({
  resolveAccessiblePharmacyTenant: mocks.resolveAccessiblePharmacyTenant,
}));
vi.mock('../../services/meet-consultation-reminders.js', () => ({
  listMeetConsultations: mocks.listMeetConsultations,
  registerMeetConsultation: mocks.registerMeetConsultation,
  cancelMeetConsultation: mocks.cancelMeetConsultation,
}));

import { meetConsultations } from './meet-consultations.js';

function app() {
  const instance = new Hono<Env>();
  instance.use('*', async (c, next) => {
    c.set('tenantId', 'tenant-a');
    c.set('staff', { id: 'staff-a', name: 'Staff A', role: 'staff' });
    await next();
  });
  instance.route('/', meetConsultations);
  return instance;
}

function env(lineAccountId = 'account-a'): Env['Bindings'] {
  const db = {
    prepare: vi.fn(() => ({
      bind: vi.fn(() => ({ first: vi.fn().mockResolvedValue({ line_account_id: lineAccountId }) })),
    })),
  } as unknown as D1Database;
  return { DB: db } as Env['Bindings'];
}

describe('meet consultation account authorization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveAccessiblePharmacyTenant.mockResolvedValue('tenant-a');
    mocks.listMeetConsultations.mockResolvedValue([]);
    mocks.registerMeetConsultation.mockResolvedValue({ id: 'consultation-a', reminders: [] });
    mocks.cancelMeetConsultation.mockResolvedValue(true);
  });

  it('requires an assigned LINE account and scopes the list to it', async () => {
    const bindings = env();
    const response = await app().request(
      '/api/meet-consultations?line_account_id=account-a&status=confirmed',
      {},
      bindings,
    );

    expect(response.status).toBe(200);
    expect(mocks.resolveAccessiblePharmacyTenant).toHaveBeenCalledWith(
      bindings.DB, expect.objectContaining({ id: 'staff-a' }), 'account-a',
    );
    expect(mocks.listMeetConsultations).toHaveBeenCalledWith(
      bindings.DB, 'tenant-a', 'account-a', 'confirmed',
    );
  });

  it('rejects registration when the friend account is not assigned to the staff member', async () => {
    mocks.resolveAccessiblePharmacyTenant.mockResolvedValue('tenant-b');
    const response = await app().request('/api/meet-consultations', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        externalEventId: 'event-a', friendId: 'friend-a', title: 'Consultation',
        startsAt: '2026-09-01T01:00:00.000Z', endsAt: '2026-09-01T02:00:00.000Z',
        meetUrl: 'https://meet.google.com/abc-defg-hij',
      }),
    }, env());

    expect(response.status).toBe(403);
    expect(mocks.registerMeetConsultation).not.toHaveBeenCalled();
  });

  it('rejects cancellation when the event account is not assigned to the staff member', async () => {
    mocks.resolveAccessiblePharmacyTenant.mockResolvedValue(null);
    const response = await app().request('/api/meet-consultations/event-a', {
      method: 'DELETE',
    }, env());

    expect(response.status).toBe(403);
    expect(mocks.cancelMeetConsultation).not.toHaveBeenCalled();
  });

  it('does not expose storage errors from registration', async () => {
    mocks.registerMeetConsultation.mockRejectedValue(new Error('D1 internal token detail'));
    const response = await app().request('/api/meet-consultations', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        externalEventId: 'event-a', friendId: 'friend-a', title: 'Consultation',
        startsAt: '2026-09-01T01:00:00.000Z', endsAt: '2026-09-01T02:00:00.000Z',
        meetUrl: 'https://meet.google.com/abc-defg-hij',
      }),
    }, env());

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      success: false, error: 'consultation registration failed',
    });
  });
});
