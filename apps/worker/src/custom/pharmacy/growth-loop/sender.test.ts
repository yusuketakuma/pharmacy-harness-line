import { beforeEach, describe, expect, it, vi } from 'vitest';

const push = vi.hoisted(() => vi.fn());
const config = vi.hoisted(() => vi.fn());
vi.mock('../../../services/line-proxy-send.js', () => ({ pushViaHarnessProxy: push }));
vi.mock('./repository.js', () => ({ getPharmacyCapabilityConfig: config }));

import { sendPharmacyAutomatedPush } from './sender.js';

type Step = { match: string; run?: { changes: number }; first?: unknown };

function scriptedDb(steps: Step[], seen: string[] = []): D1Database {
  return {
    prepare(sql: string) {
      seen.push(sql);
      const step = steps.shift();
      if (!step || !sql.includes(step.match)) throw new Error(`unexpected SQL: ${sql}`);
      return {
        bind() {
          return {
            run: async () => ({ meta: step.run ?? { changes: 0 } }),
            first: async () => step.first ?? null,
          };
        },
      };
    },
  } as unknown as D1Database;
}

const base = {
  proxyBaseUrl: 'https://worker.example', accessToken: 'token', to: 'U1',
  lineAccountId: 'account-a', friendId: 'friend-a', messageId: 'prescription_status_v1' as const,
  category: 'transactional_care' as const, retryKey: 'prescription:submission-1:received',
};

beforeEach(() => {
  vi.clearAllMocks();
  config.mockResolvedValue({ capabilities: ['prescription_intake'], proactive_monthly_limit: 1 });
  push.mockResolvedValue(undefined);
});

describe('pharmacy automated sender', () => {
  it('does not reach LINE when the rendered payload fails policy validation', async () => {
    await expect(sendPharmacyAutomatedPush({
      ...base,
      db: {} as D1Database,
      messageId: 'prescription_validity_reminder_v1',
      vars: { genericDate: 'さくら病院' } as never,
    })).rejects.toThrow(/variable rejected/);
    expect(config).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
  });

  it('fails closed when the account does not allow the message capability', async () => {
    config.mockResolvedValue({ capabilities: ['continuity'], proactive_monthly_limit: 1 });
    await expect(sendPharmacyAutomatedPush({
      ...base, db: {} as D1Database,
    })).rejects.toThrow(/capability/);
    expect(push).not.toHaveBeenCalled();
  });

  it('requires account, friend, and database context at runtime', async () => {
    await expect(sendPharmacyAutomatedPush({
      ...base, db: undefined, lineAccountId: undefined, friendId: undefined,
    } as unknown as Parameters<typeof sendPharmacyAutomatedPush>[0])).rejects.toThrow(/account context/);
    expect(push).not.toHaveBeenCalled();
  });

  it('does not push again after the same idempotency key was sent', async () => {
    const db = scriptedDb([
      { match: 'INSERT OR IGNORE INTO pharmacy_notification_events', run: { changes: 1 } },
      { match: 'UPDATE pharmacy_notification_events', run: { changes: 1 } },
      { match: 'INSERT OR IGNORE INTO pharmacy_notification_events', run: { changes: 0 } },
      { match: 'SELECT id, outcome', first: { id: 'event-1', outcome: 'sent', occurred_at: '2026-08-18T00:00:00.000Z' } },
    ]);

    await sendPharmacyAutomatedPush({ ...base, db });
    await sendPharmacyAutomatedPush({ ...base, db });

    expect(push).toHaveBeenCalledTimes(1);
    expect(push.mock.calls[0][4]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(push.mock.calls[0][6]).toEqual({
      pharmacyNotificationEventId: expect.any(String),
      lineAccountId: 'account-a',
    });
  });

  it('does not push while another invocation owns a recent attempt', async () => {
    const db = scriptedDb([
      { match: 'INSERT OR IGNORE INTO pharmacy_notification_events', run: { changes: 0 } },
      { match: 'SELECT id, outcome', first: { id: 'event-1', outcome: 'attempted', occurred_at: '2026-08-18T00:00:00.000Z' } },
    ]);

    await expect(sendPharmacyAutomatedPush({
      ...base,
      db,
      now: new Date('2026-08-18T00:05:00.000Z'),
    })).resolves.toBe('in_progress');
    expect(push).not.toHaveBeenCalled();
  });

  it('reclaims a stale attempt using the same LINE retry key', async () => {
    const db = scriptedDb([
      { match: 'INSERT OR IGNORE INTO pharmacy_notification_events', run: { changes: 0 } },
      { match: 'SELECT id, outcome', first: { id: 'event-1', outcome: 'attempted', occurred_at: '2026-08-17T23:00:00.000Z' } },
      { match: "outcome = 'attempted' AND occurred_at < ?", run: { changes: 1 } },
      { match: 'UPDATE pharmacy_notification_events', run: { changes: 1 } },
    ]);

    await expect(sendPharmacyAutomatedPush({
      ...base,
      db,
      now: new Date('2026-08-18T00:05:00.000Z'),
    })).resolves.toBe('sent');
    expect(push).toHaveBeenCalledTimes(1);
  });

  it('retries a failed attempt with the same LINE retry key', async () => {
    const db = scriptedDb([
      { match: 'INSERT OR IGNORE INTO pharmacy_notification_events', run: { changes: 1 } },
      { match: 'UPDATE pharmacy_notification_events', run: { changes: 1 } },
      { match: 'INSERT OR IGNORE INTO pharmacy_notification_events', run: { changes: 0 } },
      { match: 'SELECT id, outcome', first: { id: 'event-1', outcome: 'failed', occurred_at: '2026-08-18T00:00:00.000Z' } },
      { match: "SET outcome = 'attempted'", run: { changes: 1 } },
      { match: 'UPDATE pharmacy_notification_events', run: { changes: 1 } },
    ]);
    push.mockRejectedValueOnce(new Error('temporary LINE failure')).mockResolvedValueOnce(undefined);

    await expect(sendPharmacyAutomatedPush({ ...base, db })).rejects.toThrow(/temporary/);
    await expect(sendPharmacyAutomatedPush({ ...base, db })).resolves.toBe('sent');
    expect(push).toHaveBeenCalledTimes(2);
    expect(push.mock.calls[0][4]).toBe(push.mock.calls[1][4]);
  });

  it('applies the proactive monthly cap per friend with an atomic claim', async () => {
    const seen: string[] = [];
    const db = scriptedDb([
      { match: 'INSERT OR IGNORE INTO pharmacy_notification_events', run: { changes: 0 } },
      { match: 'SELECT id, outcome', first: null },
      { match: "VALUES (?, ?, ?, ?, ?, 'blocked'", run: { changes: 1 } },
    ], seen);

    await expect(sendPharmacyAutomatedPush({
      ...base, db, category: 'proactive_noncare', now: new Date('2026-08-31T15:30:00.000Z'),
    })).rejects.toThrow(/frequency cap/);
    expect(seen[0]).toContain('friend_id = ?');
    expect(seen[0]).toContain("outcome IN ('attempted','sent')");
    expect(push).not.toHaveBeenCalled();
  });
});
