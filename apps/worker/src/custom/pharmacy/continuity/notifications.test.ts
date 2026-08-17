import { describe, expect, it, vi } from 'vitest';

const push = vi.hoisted(() => vi.fn());
vi.mock('../../../services/line-proxy-send.js', () => ({ pushViaHarnessProxy: push }));

import { continuityReminderText, deliverContinuityReminder } from './notifications.js';

describe('continuity reminder notifications', () => {
  it('uses a PHI-free fixed message and reports delivery status', async () => {
    push.mockResolvedValue(undefined);
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
      id: 'obligation-1', line_account_id: 'account-1', owner_friend_id: 'friend-1',
      patient_id: 'patient-1', source_submission_id: 'submission-1', candidate_submission_id: null,
      status: 'active', expected_next_from: '2026-09-01', expected_next_to: '2026-10-31',
      next_contact_at: '2026-09-01T00:00:00Z', consent_at: '2026-08-17T00:00:00Z',
      last_reminded_at: null, reminder_count: 1, created_at: '2026-08-17T00:00:00Z',
      updated_at: '2026-08-17T00:00:00Z', line_user_id: 'U1', channel_access_token: 'token',
    }, { db, proxyBaseUrl: 'https://worker.example' });
    expect(result).toBe('sent');
    expect(continuityReminderText()).not.toMatch(/患者|氏名|薬名/);
    expect(push).toHaveBeenCalledWith(
      'https://worker.example', 'token', 'U1',
      [{ type: 'text', text: continuityReminderText() }],
      expect.stringMatching(/^[0-9a-f-]{36}$/), undefined,
    );
  });
});
