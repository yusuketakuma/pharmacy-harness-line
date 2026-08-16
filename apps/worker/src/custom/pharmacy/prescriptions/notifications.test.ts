import { describe, expect, it, vi } from 'vitest';
import {
  deliverPrescriptionNotification,
  retryFailedPrescriptionNotifications,
} from './notifications.js';

const STATUS_EVENT_ID = '123e4567-e89b-42d3-a456-426614174000';

function fakeDb(options: { recipient?: Record<string, unknown> | null; due?: unknown[] } = {}) {
  const calls: Array<{ sql: string; values: unknown[]; operation: string }> = [];
  const recipient = options.recipient === undefined ? {
    status_event_id: STATUS_EVENT_ID,
    status: 'ready',
    reason_code: null,
    revision: 1,
    line_user_id: 'U-patient',
    channel_access_token: 'account-token',
  } : options.recipient;
  const db = {
    prepare: (sql: string) => ({
      bind: (...values: unknown[]) => ({
        first: async () => {
          calls.push({ sql, values, operation: 'first' });
          return recipient;
        },
        all: async () => {
          calls.push({ sql, values, operation: 'all' });
          return { results: options.due ?? [] };
        },
        run: async () => {
          calls.push({ sql, values, operation: 'run' });
          return { success: true, meta: { changes: 1 } };
        },
      }),
    }),
  } as unknown as D1Database;
  return { db, calls };
}

describe('prescription status notifications', () => {
  it('uses the submission account token and omits the manual attribution header', async () => {
    const { db, calls } = fakeDb();
    let request: Request | null = null;
    const dispatch = vi.fn(async (next: Request) => {
      request = next;
      return new Response('{}', { status: 200 });
    });

    await expect(deliverPrescriptionNotification(db, 'submission-1', {
      proxyBaseUrl: 'https://worker.example',
      proxyDispatch: dispatch,
    })).resolves.toEqual({ status: 'sent' });

    expect(request!.headers.get('Authorization')).toBe('Bearer account-token');
    expect(request!.headers.get('X-Line-Harness-Source')).toBeNull();
    expect(request!.headers.get('X-Line-Retry-Key')).toBe(STATUS_EVENT_ID);
    await expect(request!.json()).resolves.toEqual({
      to: 'U-patient',
      messages: [{ type: 'text', text: expect.stringContaining('準備ができました') }],
    });
    expect(calls.some((call) => call.sql.includes("'notification_sent'"))).toBe(true);
  });

  it('keeps the committed status and records a PHI-free retry event after send failure', async () => {
    const { db, calls } = fakeDb();
    const dispatch = vi.fn().mockResolvedValue(new Response('unavailable', { status: 503 }));

    await expect(deliverPrescriptionNotification(db, 'submission-1', {
      proxyBaseUrl: 'https://worker.example',
      proxyDispatch: dispatch,
    })).resolves.toEqual({ status: 'failed' });

    const failure = calls.find((call) => call.sql.includes("'notification_failed'"));
    expect(failure?.values).toContain(STATUS_EVENT_ID);
    expect(JSON.stringify(failure)).not.toContain('unavailable');
  });

  it('retries unresolved failures in a bounded batch', async () => {
    const { db, calls } = fakeDb({
      due: [{ submission_id: 'submission-1', status_event_id: STATUS_EVENT_ID }],
    });
    const dispatch = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));

    await expect(retryFailedPrescriptionNotifications(db, {
      proxyBaseUrl: 'https://worker.example',
      proxyDispatch: dispatch,
    }, 10)).resolves.toEqual({ sent: 1, failed: 0, skipped: 0 });

    expect(calls[0].sql).toContain("failed.event_type = 'notification_failed'");
    expect(calls[0].sql).toContain('LIMIT ?');
    expect(calls[0].values).toEqual([10]);
  });
});
