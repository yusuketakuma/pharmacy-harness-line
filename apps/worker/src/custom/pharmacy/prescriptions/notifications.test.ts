import { beforeEach, describe, expect, it, vi } from 'vitest';

const readCredential = vi.hoisted(() => vi.fn());
vi.mock('../provisioning/line-credential-store.js', () => ({
  readLineCredential: readCredential,
}));

import {
  deliverPrescriptionNotification,
  prescriptionNotificationText,
  retryFailedPrescriptionNotifications,
} from './notifications.js';

const STATUS_EVENT_ID = '123e4567-e89b-42d3-a456-426614174000';
const CREDENTIAL_KEY = 'synthetic-line-credential-root-key-v1';

function fakeDb(options: {
  recipient?: Record<string, unknown> | null;
  due?: unknown[];
  sent?: boolean;
  notificationAuditError?: boolean;
  notificationInProgress?: boolean;
} = {}) {
  const calls: Array<{ sql: string; values: unknown[]; operation: string }> = [];
  const recipient = options.sent ? null : options.recipient === undefined ? {
    status_event_id: STATUS_EVENT_ID,
    status: 'ready',
    reason_code: null,
    revision: 1,
    line_user_id: 'U-patient',
    tenant_id: 'tenant-a',
    line_account_id: 'account-a',
    friend_id: 'friend-a',
    patient_id: 'patient-a',
    intake_method: 'PAPER',
    liff_id: 'liff-1',
    estimated_ready_at: null,
  } : options.recipient;
  const db = {
    prepare: (sql: string) => ({
      bind: (...values: unknown[]) => ({
        first: async () => {
          calls.push({ sql, values, operation: 'first' });
          if (sql.includes('SELECT patient.relationship')) {
            return {
              relationship: 'self', proxy_expires_at: null, privacy_withdrawn: 0,
              notifications_stopped: 0, control_version: 0,
            };
          }
          if (options.notificationInProgress && sql.includes('SELECT id, outcome')) {
            return { id: 'notification-1', outcome: 'attempted', occurred_at: new Date().toISOString() };
          }
          if (sql.includes('pharmacy_account_capabilities')) {
            return { line_account_id: 'account-a', mode: 'pharmacy', capabilities_json: '["prescription_intake"]', proactive_monthly_limit: 1, unfollow_alert_state: 'alert_only', created_at: '', updated_at: '' };
          }
          if (options.sent) {
            if (sql.includes('SELECT e.to_status')) return { to_status: 'ready', status: 'ready' };
            if (sql.includes('sent.actor_id = ?')) return { sent: 1 };
          }
          return recipient;
        },
        all: async () => {
          calls.push({ sql, values, operation: 'all' });
          return { results: options.due ?? [] };
        },
        run: async () => {
          calls.push({ sql, values, operation: 'run' });
          if (options.notificationInProgress &&
              sql.includes('INSERT OR IGNORE INTO pharmacy_notification_events')) {
            return { success: true, meta: { changes: 0 } };
          }
          if (options.notificationAuditError && sql.includes('pharmacy_prescription_events')) {
            throw new Error('audit unavailable');
          }
          return { success: true, meta: { changes: 1 } };
        },
      }),
    }),
  } as unknown as D1Database;
  return { db, calls };
}

describe('prescription status notifications', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    readCredential.mockResolvedValue('account-token');
  });

  it('shows a future preparation time without promising a past time', () => {
    const details = {
      intake_method: 'E_PRESCRIPTION' as const,
      liff_id: 'liff-1',
      estimated_ready_at: '2099-08-17T06:30:00.000Z',
      submissionId: 'submission-1',
    };
    expect(prescriptionNotificationText('accepted', null, details)).toContain('準備予定:');
    expect(prescriptionNotificationText('accepted', null, {
      ...details,
      estimated_ready_at: '2000-08-17T06:30:00.000Z',
    })).not.toContain('準備予定:');
  });

  it('uses the submission account token and omits the manual attribution header', async () => {
    const { db, calls } = fakeDb();
    let request: Request | null = null;
    const dispatch = vi.fn(async (next: Request) => {
      request = next;
      return new Response('{}', { status: 200 });
    });

    await expect(deliverPrescriptionNotification(db, 'account-1', 'submission-1', {
      proxyBaseUrl: 'https://worker.example',
      proxyDispatch: dispatch,
      lineCredentialKey: CREDENTIAL_KEY,
    })).resolves.toEqual({ status: 'sent' });

    expect(request!.headers.get('Authorization')).toBe('Bearer account-token');
    expect(request!.headers.get('X-Line-Harness-Source')).toBeNull();
    expect(request!.headers.get('X-Line-Retry-Key')).toBe(STATUS_EVENT_ID);
    await expect(request!.json()).resolves.toEqual({
      to: 'U-patient',
      messages: [{ type: 'text', text: expect.stringContaining('準備ができました') }],
    });
    expect(calls.some((call) => call.values.includes('notification_sent'))).toBe(true);
    expect(calls[0].sql).toContain('s.line_account_id = ?');
    expect(calls[0].sql).toContain('f.provider_line_user_id AS line_user_id');
    expect(calls[0].values).toContain('account-1');
  });

  it('keeps the committed status and records a PHI-free retry event after send failure', async () => {
    const { db, calls } = fakeDb();
    const dispatch = vi.fn().mockResolvedValue(new Response('unavailable', { status: 503 }));

    await expect(deliverPrescriptionNotification(db, 'account-1', 'submission-1', {
      proxyBaseUrl: 'https://worker.example',
      proxyDispatch: dispatch,
      lineCredentialKey: CREDENTIAL_KEY,
    })).resolves.toEqual({ status: 'failed' });

    const failure = calls.find((call) => call.values.includes('notification_failed'));
    expect(failure?.values).toContain(STATUS_EVENT_ID);
    expect(JSON.stringify(failure)).not.toContain('unavailable');
  });

  it('does not turn a notification audit outage into an unhandled request failure', async () => {
    const { db } = fakeDb({ notificationAuditError: true });
    const dispatch = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));

    await expect(deliverPrescriptionNotification(db, 'account-1', 'submission-1', {
      proxyBaseUrl: 'https://worker.example',
      proxyDispatch: dispatch,
      lineCredentialKey: CREDENTIAL_KEY,
    })).resolves.toEqual({ status: 'failed' });
  });

  it('does not ask electronic prescription patients to bring the paper original', async () => {
    const { db } = fakeDb({
      recipient: {
        status_event_id: STATUS_EVENT_ID,
        status: 'ready',
        reason_code: null,
        revision: 1,
        line_user_id: 'U-patient',
        tenant_id: 'tenant-a',
        line_account_id: 'account-1',
        friend_id: 'friend-a',
        intake_method: 'E_PRESCRIPTION',
        liff_id: 'liff-1',
        estimated_ready_at: null,
      },
    });
    const dispatch = vi.fn(async (request: Request) => {
      const body = await request.json() as { messages: Array<{ text: string }> };
      expect(body.messages[0].text).not.toContain('原本');
      return new Response('{}', { status: 200 });
    });

    await expect(deliverPrescriptionNotification(db, 'account-1', 'submission-1', {
      proxyBaseUrl: 'https://worker.example',
      proxyDispatch: dispatch,
      lineCredentialKey: CREDENTIAL_KEY,
    })).resolves.toEqual({ status: 'sent' });
  });

  it('adds a direct existing intake link for resubmission without patient identity', async () => {
    const { db } = fakeDb({
      recipient: {
        status_event_id: STATUS_EVENT_ID,
        status: 'needs_resubmission',
        reason_code: 'blurred',
        revision: 2,
        line_user_id: 'U-patient',
        tenant_id: 'tenant-a',
        line_account_id: 'account-1',
        friend_id: 'friend-a',
        intake_method: 'PAPER',
        liff_id: 'liff-1',
        estimated_ready_at: null,
      },
    });
    const dispatch = vi.fn(async (request: Request) => {
      const body = await request.json() as { messages: Array<{ text: string }> };
      expect(body.messages[0].text).toContain('https://liff.line.me/liff-1/');
      expect(body.messages[0].text).toContain('submission-1');
      expect(body.messages[0].text).toContain('liffId=liff-1');
      expect(body.messages[0].text).not.toContain('患者');
      return new Response('{}', { status: 200 });
    });

    await expect(deliverPrescriptionNotification(db, 'account-1', 'submission-1', {
      proxyBaseUrl: 'https://worker.example',
      proxyDispatch: dispatch,
      lineCredentialKey: CREDENTIAL_KEY,
    })).resolves.toEqual({ status: 'sent' });
  });

  it('does not send when readiness notice consent is absent', async () => {
    const { db, calls } = fakeDb({ recipient: null });
    const dispatch = vi.fn();

    await expect(deliverPrescriptionNotification(db, 'account-1', 'submission-1', {
      proxyBaseUrl: 'https://worker.example',
      proxyDispatch: dispatch,
      lineCredentialKey: CREDENTIAL_KEY,
    })).resolves.toEqual({ status: 'skipped' });
    expect(dispatch).not.toHaveBeenCalled();
    expect(calls[0].sql).toContain('s.readiness_notice_consent_at IS NOT NULL');
  });

  it('reports an already delivered notification without sending it again', async () => {
    const { db } = fakeDb({ sent: true });
    const dispatch = vi.fn();

    const result = await deliverPrescriptionNotification(db, 'account-1', 'submission-1', {
      proxyBaseUrl: 'https://worker.example',
      proxyDispatch: dispatch,
      lineCredentialKey: CREDENTIAL_KEY,
    }, STATUS_EVENT_ID);
    expect(result).toEqual({ status: 'already_sent' });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('does not record sent while the same delivery key is still in progress', async () => {
    const { db, calls } = fakeDb({ notificationInProgress: true });
    const dispatch = vi.fn();

    await expect(deliverPrescriptionNotification(db, 'account-1', 'submission-1', {
      proxyBaseUrl: 'https://worker.example',
      proxyDispatch: dispatch,
      lineCredentialKey: CREDENTIAL_KEY,
    })).resolves.toEqual({ status: 'skipped' });

    expect(dispatch).not.toHaveBeenCalled();
    expect(calls.some((call) => call.values.includes('notification_sent'))).toBe(false);
  });

  it('retries unresolved failures in a bounded batch', async () => {
    const { db, calls } = fakeDb({
      due: [{ line_account_id: 'account-1', submission_id: 'submission-1', status_event_id: STATUS_EVENT_ID }],
    });
    const dispatch = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));

    await expect(retryFailedPrescriptionNotifications(db, {
      proxyBaseUrl: 'https://worker.example',
      proxyDispatch: dispatch,
      lineCredentialKey: CREDENTIAL_KEY,
    }, 10)).resolves.toEqual({ sent: 1, failed: 0, skipped: 0 });

    expect(calls[0].sql).toContain("failed.event_type = 'notification_failed'");
    expect(calls[0].sql).toContain('FROM pharmacy_notification_events delivery');
    expect(calls[0].sql).toContain('delivery.line_account_id = s.line_account_id');
    expect(calls[0].sql).toContain("delivery.outcome = 'attempted'");
    expect(calls[0].sql).toContain('LIMIT ?');
    expect(calls[0].values).toEqual([expect.any(String), 10]);
  });

  it('does not send when the tenant-scoped credential is missing or corrupt', async () => {
    const { db } = fakeDb();
    const dispatch = vi.fn();
    readCredential.mockResolvedValue(null);

    await expect(deliverPrescriptionNotification(db, 'account-1', 'submission-1', {
      proxyBaseUrl: 'https://worker.example',
      proxyDispatch: dispatch,
      lineCredentialKey: CREDENTIAL_KEY,
    })).resolves.toEqual({ status: 'skipped' });

    expect(readCredential).toHaveBeenCalledWith(db, CREDENTIAL_KEY, {
      tenantId: 'tenant-a',
      lineAccountId: 'account-a',
      kind: 'channel_access_token',
    });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('does not send when the credential store rejects the recipient tenant', async () => {
    const { db } = fakeDb({ recipient: {
      status_event_id: STATUS_EVENT_ID,
      status: 'ready',
      reason_code: null,
      revision: 1,
      line_user_id: 'U-patient',
      tenant_id: 'tenant-b',
      line_account_id: 'account-a',
      friend_id: 'friend-a',
      intake_method: 'PAPER',
      liff_id: 'liff-1',
      estimated_ready_at: null,
    } });
    const dispatch = vi.fn();
    readCredential.mockResolvedValue(null);

    await expect(deliverPrescriptionNotification(db, 'account-1', 'submission-1', {
      proxyBaseUrl: 'https://worker.example',
      proxyDispatch: dispatch,
      lineCredentialKey: CREDENTIAL_KEY,
    })).resolves.toEqual({ status: 'skipped' });

    expect(readCredential).toHaveBeenCalledWith(db, CREDENTIAL_KEY, expect.objectContaining({
      tenantId: 'tenant-b',
      lineAccountId: 'account-a',
    }));
    expect(dispatch).not.toHaveBeenCalled();
  });
});
