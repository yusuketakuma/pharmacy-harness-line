import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../../index.js';

const mocks = vi.hoisted(() => ({
  resolveAccessiblePharmacyTenant: vi.fn(),
  hasPharmacyCapability: vi.fn(),
  readLineCredential: vi.fn(),
  sendPush: vi.fn(),
  listMeetConsultations: vi.fn(),
  registerMeetConsultation: vi.fn(),
  cancelMeetConsultation: vi.fn(),
}));

vi.mock('../../custom/pharmacy/growth-loop/access.js', () => ({
  resolveAccessiblePharmacyTenant: mocks.resolveAccessiblePharmacyTenant,
  hasPharmacyCapability: mocks.hasPharmacyCapability,
}));
vi.mock('../../custom/pharmacy/provisioning/line-credential-store.js', () => ({
  readLineCredential: mocks.readLineCredential,
}));
vi.mock('../../custom/pharmacy/growth-loop/sender.js', () => ({
  sendPharmacyAutomatedPush: mocks.sendPush,
}));
vi.mock('../integrations/line-proxy.js', () => ({
  lineProxy: { fetch: vi.fn(async () => new Response('{}')) },
}));
vi.mock('../../services/meet-consultation-reminders.js', () => ({
  listMeetConsultations: mocks.listMeetConsultations,
  registerMeetConsultation: mocks.registerMeetConsultation,
  cancelMeetConsultation: mocks.cancelMeetConsultation,
  meetJstDateTime: () => ({ genericDate: '2026-09-01', genericTime: '10:00' }),
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

function env(lineAccountId = 'account-a', lineUserId: string | null = 'U-friend-a'): Env['Bindings'] {
  const db = {
    prepare: vi.fn((sql: string) => ({
      bind: vi.fn(() => ({
        first: vi.fn().mockResolvedValue(
          sql.includes('provider_line_user_id')
            ? { line_user_id: lineUserId }
            : { line_account_id: lineAccountId },
        ),
      })),
    })),
  } as unknown as D1Database;
  return {
    DB: db,
    LINE_CREDENTIAL_KEY_V1: 'root-key',
    WORKER_PUBLIC_URL: 'https://worker.test',
  } as Env['Bindings'];
}

describe('meet consultation account authorization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveAccessiblePharmacyTenant.mockResolvedValue('tenant-a');
    mocks.hasPharmacyCapability.mockResolvedValue(false);
    mocks.readLineCredential.mockResolvedValue('pharmacy-channel-token');
    mocks.sendPush.mockResolvedValue('sent');
    mocks.listMeetConsultations.mockResolvedValue([]);
    mocks.registerMeetConsultation.mockResolvedValue({
      id: 'consultation-a',
      startsAt: '2026-09-01T01:00:00.000Z',
      reminders: [],
    });
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

  it('sends the approved confirmation push when the account has meet_consultation', async () => {
    mocks.hasPharmacyCapability.mockResolvedValue(true);
    const response = await app().request('/api/meet-consultations', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        externalEventId: 'event-a', friendId: 'friend-a', title: 'Consultation',
        startsAt: '2026-09-01T01:00:00.000Z', endsAt: '2026-09-01T02:00:00.000Z',
        meetUrl: 'https://meet.google.com/abc-defg-hij',
      }),
    }, env());

    expect(response.status).toBe(201);
    expect(mocks.hasPharmacyCapability).toHaveBeenCalledWith(
      expect.anything(), 'account-a', 'meet_consultation',
    );
    expect(mocks.readLineCredential).toHaveBeenCalledWith(
      expect.anything(), 'root-key', {
        tenantId: 'tenant-a', lineAccountId: 'account-a', kind: 'channel_access_token',
      },
    );
    expect(mocks.sendPush).toHaveBeenCalledWith(expect.objectContaining({
      messageId: 'meet_consultation_v1',
      category: 'transactional_care',
      to: 'U-friend-a',
      lineAccountId: 'account-a',
      friendId: 'friend-a',
      vars: {
        meetStatus: 'scheduled',
        genericDate: '2026-09-01',
        genericTime: '10:00',
        meetUrl: 'https://meet.google.com/abc-defg-hij',
      },
      retryKey: 'meet-confirmation:consultation-a:2026-09-01T01:00:00.000Z',
    }));
    const body = await response.json() as { data: { confirmationSent: boolean } };
    expect(body.data.confirmationSent).toBe(true);
  });

  it('skips the confirmation push without the meet_consultation capability', async () => {
    const response = await app().request('/api/meet-consultations', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        externalEventId: 'event-a', friendId: 'friend-a', title: 'Consultation',
        startsAt: '2026-09-01T01:00:00.000Z', endsAt: '2026-09-01T02:00:00.000Z',
        meetUrl: 'https://meet.google.com/abc-defg-hij',
      }),
    }, env());

    expect(response.status).toBe(201);
    expect(mocks.sendPush).not.toHaveBeenCalled();
    const body = await response.json() as { data: { confirmationSent: boolean } };
    expect(body.data.confirmationSent).toBe(false);
  });

  it('still returns 201 when the confirmation push fails', async () => {
    mocks.hasPharmacyCapability.mockResolvedValue(true);
    mocks.sendPush.mockRejectedValue(new Error('provider down'));
    const response = await app().request('/api/meet-consultations', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        externalEventId: 'event-a', friendId: 'friend-a', title: 'Consultation',
        startsAt: '2026-09-01T01:00:00.000Z', endsAt: '2026-09-01T02:00:00.000Z',
        meetUrl: 'https://meet.google.com/abc-defg-hij',
      }),
    }, env());

    expect(response.status).toBe(201);
    const body = await response.json() as { data: { confirmationSent: boolean } };
    expect(body.data.confirmationSent).toBe(false);
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
