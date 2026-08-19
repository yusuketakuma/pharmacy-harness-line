import { describe, expect, it, vi } from 'vitest';

const push = vi.hoisted(() => vi.fn());
const markReminded = vi.hoisted(() => vi.fn());
const readCredential = vi.hoisted(() => vi.fn());
vi.mock('../../../services/line-proxy-send.js', () => ({ pushViaHarnessProxy: push }));
vi.mock('./next-intake.js', () => ({ markNextIntakeExpectationReminded: markReminded }));
vi.mock('../provisioning/line-credential-store.js', () => ({ readLineCredential: readCredential }));

import { continuityReminderText, deliverContinuityReminder } from './notifications.js';

const CREDENTIAL_KEY = 'synthetic-line-credential-root-key-v1';

describe('continuity reminder notifications', () => {
  it('uses a PHI-free fixed message and reports delivery status', async () => {
    push.mockResolvedValue(undefined);
    markReminded.mockResolvedValue({ status: 'reminded' });
    readCredential.mockResolvedValue('token');
    const db = {
      prepare: (sql: string) => ({
        bind: () => ({
          first: async () => sql.includes('pharmacy_account_capabilities')
            ? { line_account_id: 'account-1', mode: 'pharmacy', capabilities_json: '["continuity"]', proactive_monthly_limit: 1, unfollow_alert_state: 'alert_only', created_at: '', updated_at: '' }
            : null,
          run: async () => ({ meta: { changes: 1 } }),
        }),
      }),
    } as unknown as D1Database;
    const result = await deliverContinuityReminder({
      id: 'expectation-1', obligation_id: 'obligation-1', line_account_id: 'account-1',
      owner_friend_id: 'friend-1', patient_id: 'patient-1', status: 'active',
      timing_source: 'manual_window', supply_days: null,
      expected_from: '2026-09-01', expected_to: '2026-10-31',
      reminder_at: '2026-09-01T00:00:00Z', reminded_at: null, version: 2,
      created_by: 'staff-1', created_at: '2026-08-17T00:00:00Z',
      updated_at: '2026-08-17T00:00:00Z', line_user_id: 'U1', tenant_id: 'tenant-a',
    }, { db, proxyBaseUrl: 'https://worker.example', lineCredentialKey: CREDENTIAL_KEY });
    expect(result).toBe('sent');
    expect(continuityReminderText()).not.toMatch(/患者|氏名|薬名/);
    expect(push).toHaveBeenCalledWith(
      'https://worker.example', 'token', 'U1',
      [{ type: 'text', text: continuityReminderText() }],
      expect.stringMatching(/^[0-9a-f-]{36}$/), undefined,
      {
        pharmacyNotificationEventId: expect.any(String),
        lineAccountId: 'account-1',
      },
    );
    expect(markReminded).toHaveBeenCalledWith(db, {
      lineAccountId: 'account-1', expectationId: 'expectation-1', expectedVersion: 2,
    });
    expect(readCredential).toHaveBeenCalledWith(db, CREDENTIAL_KEY, {
      tenantId: 'tenant-a', lineAccountId: 'account-1', kind: 'channel_access_token',
    });
  });

  it('skips without sending when a tenant credential is missing or cross-tenant', async () => {
    vi.clearAllMocks();
    readCredential.mockResolvedValue(null);
    const pushDispatch = vi.fn();
    const db = {} as D1Database;

    await expect(deliverContinuityReminder({
      id: 'expectation-1', obligation_id: 'obligation-1', line_account_id: 'account-1',
      owner_friend_id: 'friend-1', patient_id: 'patient-1', status: 'active',
      timing_source: 'manual_window', supply_days: null,
      expected_from: '2026-09-01', expected_to: '2026-10-31',
      reminder_at: '2026-09-01T00:00:00Z', reminded_at: null, version: 2,
      created_by: 'staff-1', created_at: '2026-08-17T00:00:00Z',
      updated_at: '2026-08-17T00:00:00Z', line_user_id: 'U1', tenant_id: 'tenant-b',
    }, {
      db,
      proxyBaseUrl: 'https://worker.example',
      proxyDispatch: pushDispatch,
      lineCredentialKey: CREDENTIAL_KEY,
    })).resolves.toBe('skipped');
    expect(pushDispatch).not.toHaveBeenCalled();
    expect(markReminded).not.toHaveBeenCalled();
  });
});
