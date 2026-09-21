import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

const calls = vi.hoisted(() => ({
  refresh: vi.fn(), meet: vi.fn(), medication: vi.fn(), generic: vi.fn(),
}));
vi.mock('@line-crm/db', async (original) => ({
  ...await original<typeof import('@line-crm/db')>(),
  getActiveTenantLineAccounts: vi.fn().mockResolvedValue([{ id: 'pharmacy-a', is_active: 1 }]),
}));
vi.mock('./custom/pharmacy/cron-access.js', () => ({ shouldRunGenericCron: vi.fn().mockResolvedValue(false) }));
vi.mock('./services/token-refresh.js', () => ({ refreshLineAccessTokens: calls.refresh }));
vi.mock('./services/meet-consultation-reminders.js', async (original) => ({
  ...await original<typeof import('./services/meet-consultation-reminders.js')>(),
  processDueMeetConsultationReminders: calls.meet,
}));
vi.mock('./services/booking-reminders.js', () => ({ processDueReminders: calls.generic }));
vi.mock('./custom/pharmacy/medication-followup/notifications.js', async (original) => ({
  ...await original<typeof import('./custom/pharmacy/medication-followup/notifications.js')>(),
  processDueMedicationFollowUps: calls.medication,
}));
import worker, { type Env } from './index.js';

// Other minute jobs see an empty synthetic database. No credentials, patient
// data, or outgoing provider calls are available in this entrypoint test.
const db = {
  prepare: () => {
    const statement = {
      bind: () => statement,
      first: async () => null,
      all: async () => ({ results: [] }),
      run: async () => ({ meta: { changes: 0 } }),
    };
    return statement;
  },
  batch: async () => [],
} as unknown as D1Database;
const env = {
  DB: db, LINE_CHANNEL_ACCESS_TOKEN: 'synthetic', LINE_CREDENTIAL_KEY_V1: 'synthetic-key',
  WORKER_PUBLIC_URL: 'https://worker.example.test',
} as Env['Bindings'];
const tick = { cron: '* * * * *', scheduledTime: Date.UTC(2026, 8, 22, 0, 1) } as ScheduledEvent;
const ctx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext;

beforeEach(() => {
  vi.clearAllMocks();
  calls.refresh.mockResolvedValue(undefined);
  calls.meet.mockResolvedValue({ sent: 0, failed: 0 });
  calls.medication.mockResolvedValue({ sent: 0, failed: 0, skipped: 0 });
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('External fetch forbidden')));
});
afterEach(() => vi.unstubAllGlobals());

describe('pharmacy scheduled Meet reminders', () => {
  it('runs the reminder processor after credential refresh while generic jobs stay disabled', async () => {
    await worker.scheduled(tick, env, ctx);
    expect(calls.meet).toHaveBeenCalledExactlyOnceWith(db, expect.objectContaining({
      now: expect.any(Date), proxyBaseUrl: env.WORKER_PUBLIC_URL,
      lineCredentialKey: env.LINE_CREDENTIAL_KEY_V1, proxyDispatch: expect.any(Function),
    }));
    expect(calls.refresh.mock.invocationCallOrder[0]).toBeLessThan(calls.meet.mock.invocationCallOrder[0]);
    expect(calls.generic).not.toHaveBeenCalled();
    expect(calls.medication).toHaveBeenCalledOnce();
    expect(fetch).not.toHaveBeenCalled();
  });
  it('continues pharmacy jobs when Meet processing fails', async () => {
    calls.meet.mockRejectedValueOnce(new Error('synthetic processor failure'));
    await worker.scheduled(tick, env, ctx);
    expect(calls.meet).toHaveBeenCalledOnce();
    expect(calls.medication).toHaveBeenCalledOnce();
    expect(calls.generic).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
});
