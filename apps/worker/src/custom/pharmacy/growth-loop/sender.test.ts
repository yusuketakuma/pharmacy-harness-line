import { beforeEach, describe, expect, it, vi } from 'vitest';

const push = vi.hoisted(() => vi.fn());
const config = vi.hoisted(() => vi.fn());
const patientAccess = vi.hoisted(() => vi.fn());
const betaEnabled = vi.hoisted(() => vi.fn());
const betaDeliveryState = vi.hoisted(() => vi.fn());
const betaSchemaState = vi.hoisted(() => vi.fn());
vi.mock('../../../services/line-proxy-send.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../services/line-proxy-send.js')>(),
  pushViaHarnessProxy: push,
}));
vi.mock('./repository.js', () => ({ getPharmacyCapabilityConfig: config }));
vi.mock('../intake/repository.js', () => ({ getPatientAccessState: patientAccess }));
vi.mock('../beta-membership/repository.js', () => ({
  getPharmacyBetaEnabled: betaEnabled,
  getPharmacyBetaSchemaState: betaSchemaState,
  getPharmacyBetaMembershipDeliveryState: betaDeliveryState,
}));

import { LineHarnessUnknownOutcomeError } from '../../../services/line-proxy-send.js';
import { sendPharmacyAutomatedPush } from './sender.js';

type Step = { match: string; run?: { changes: number }; first?: unknown; error?: Error };
type FinalScope = {
  destination_line_user_id?: string | null;
  is_following?: number;
  account_active?: number;
  tenant_status?: string;
  outbound_messaging_paused_at?: string | null;
  capability_enabled?: number;
  followup_status?: string | null;
  followup_operations_enabled?: number | null;
} | null;

function scriptedDb(
  steps: Step[],
  seen: string[] = [],
  pausedAt: string | null = null,
  finalScope: FinalScope = {},
  initialOperationsEnabled?: number,
): D1Database {
  return {
    prepare(sql: string) {
      seen.push(sql);
      // The outbound-pause lookup runs before every send and is not part of
      // the notification-event script each test below spells out.
      if (sql.includes('outbound_messaging_paused_at')) {
        if (sql.includes('final pharmacy dispatch scope')) {
          return {
            bind: () => ({
              first: async () => finalScope === null ? null : {
                destination_line_user_id: 'U1',
                is_following: 1,
                account_active: 1,
                tenant_status: 'active',
                outbound_messaging_paused_at: null,
                capability_enabled: 1,
                followup_status: 'due',
                followup_operations_enabled: 1,
                ...finalScope,
              },
              run: async () => ({ meta: { changes: 0 } }),
            }),
          };
        }
        return {
          bind: () => ({
            first: async () => ({ outbound_messaging_paused_at: pausedAt }),
            run: async () => ({ meta: { changes: 0 } }),
          }),
        };
      }
      if (sql.includes('pharmacy_medication_followup_operations')) {
        return {
          bind: () => ({
            first: async () => finalScope === null ? null : {
              enabled: initialOperationsEnabled ?? finalScope?.followup_operations_enabled ?? 1,
            },
            run: async () => ({ meta: { changes: 0 } }),
          }),
        };
      }
      const step = steps.shift();
      if (!step || !sql.includes(step.match)) throw new Error(`unexpected SQL: ${sql}`);
      return {
        bind() {
          return {
            run: async () => {
              if (step.error) throw step.error;
              return { meta: step.run ?? { changes: 0 } };
            },
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
  patientAccess.mockResolvedValue({ privacy: 'active', notifications: 'enabled' });
  betaEnabled.mockResolvedValue(false);
  betaDeliveryState.mockResolvedValue('active');
  betaSchemaState.mockResolvedValue('ready');
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

  it('requires the medication follow-up capability for follow-up pushes', async () => {
    const followUp = {
      ...base,
      messageId: 'medication_followup_v1' as const,
      category: 'followup_care' as const,
      vars: { followUpId: '123e4567-e89b-42d3-a456-426614174000' },
    };
    await expect(sendPharmacyAutomatedPush({ ...followUp, db: {} as D1Database }))
      .rejects.toThrow(/capability/);
    config.mockResolvedValue({ capabilities: ['medication_followup'], proactive_monthly_limit: 1 });
    const seen: string[] = [];
    const db = scriptedDb([
      { match: 'INSERT OR IGNORE INTO pharmacy_notification_events', run: { changes: 1 } },
      { match: 'UPDATE pharmacy_notification_events', run: { changes: 1 } },
    ], seen);
    await expect(sendPharmacyAutomatedPush({ ...followUp, db })).resolves.toBe('sent');
    expect(push).toHaveBeenCalledOnce();
  });

  it('does not claim a follow-up when operations staffing is not configured', async () => {
    const followUp = {
      ...base,
      messageId: 'medication_followup_v1' as const,
      category: 'followup_care' as const,
      vars: { followUpId: '123e4567-e89b-42d3-a456-426614174000' },
    };
    config.mockResolvedValue({ capabilities: ['medication_followup'], proactive_monthly_limit: 1 });
    const db = scriptedDb([], [], null, { followup_operations_enabled: 0 });

    await expect(sendPharmacyAutomatedPush({ ...followUp, db }))
      .resolves.toBe('operations_blocked');
    expect(push).not.toHaveBeenCalled();
  });

  it('keeps a claimed follow-up retryable when operations become unavailable', async () => {
    const followUp = {
      ...base,
      messageId: 'medication_followup_v1' as const,
      category: 'followup_care' as const,
      vars: { followUpId: '123e4567-e89b-42d3-a456-426614174000' },
    };
    config.mockResolvedValue({ capabilities: ['medication_followup'], proactive_monthly_limit: 1 });
    const db = scriptedDb([
      { match: 'INSERT OR IGNORE INTO pharmacy_notification_events', run: { changes: 1 } },
      { match: 'UPDATE pharmacy_notification_events', run: { changes: 1 } },
    ], [], null, { followup_operations_enabled: 0 }, 1);

    await expect(sendPharmacyAutomatedPush({ ...followUp, db }))
      .resolves.toBe('operations_blocked');
    expect(push).not.toHaveBeenCalled();
  });

  it('requires emergency contraception activation for the neutral appointment reminder', async () => {
    const reminder = {
      ...base,
      messageId: 'appointment_reminder_v1' as const,
      retryKey: 'a'.repeat(64),
    };
    await expect(sendPharmacyAutomatedPush({ ...reminder, db: {} as D1Database }))
      .rejects.toThrow(/capability/u);
    config.mockResolvedValue({ capabilities: ['emergency_contraception'], proactive_monthly_limit: 1 });
    const db = scriptedDb([
      { match: 'INSERT OR IGNORE INTO pharmacy_notification_events', run: { changes: 1 } },
      { match: 'UPDATE pharmacy_notification_events', run: { changes: 1 } },
    ]);
    await expect(sendPharmacyAutomatedPush({ ...reminder, db })).resolves.toBe('sent');
    expect(push).toHaveBeenCalledOnce();
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

  it('does not rewrite an accepted send as failed when sent finalization fails', async () => {
    const seen: string[] = [];
    const db = scriptedDb([
      { match: 'INSERT OR IGNORE INTO pharmacy_notification_events', run: { changes: 1 } },
      { match: 'UPDATE pharmacy_notification_events', error: new Error('D1 sent finalization failed') },
      { match: 'UPDATE pharmacy_notification_events', run: { changes: 1 } },
    ], seen);

    await expect(sendPharmacyAutomatedPush({ ...base, db }))
      .rejects.toThrow('D1 sent finalization failed');

    expect(push).toHaveBeenCalledOnce();
    expect(seen.filter((sql) => sql.includes('UPDATE pharmacy_notification_events')))
      .toHaveLength(1);
  });

  it('leaves an unknown LINE result attempted, then reclaims it with the same retry key', async () => {
    const seen: string[] = [];
    const db = scriptedDb([
      { match: 'INSERT OR IGNORE INTO pharmacy_notification_events', run: { changes: 1 } },
      { match: 'INSERT OR IGNORE INTO pharmacy_notification_events', run: { changes: 0 } },
      { match: 'SELECT id, outcome', first: { id: 'event-1', outcome: 'attempted', occurred_at: '2026-08-18T00:00:00.000Z' } },
      { match: "outcome = 'attempted' AND occurred_at < ?", run: { changes: 1 } },
      { match: 'UPDATE pharmacy_notification_events', run: { changes: 1 } },
    ], seen);
    push.mockRejectedValueOnce(new LineHarnessUnknownOutcomeError('LINE push result is unknown'));

    await expect(sendPharmacyAutomatedPush({
      ...base,
      db,
      now: new Date('2026-08-18T00:00:00.000Z'),
    }))
      .rejects.toThrow('LINE push result is unknown');
    expect(seen.filter((sql) => sql.includes('UPDATE pharmacy_notification_events')))
      .toHaveLength(0);

    await expect(sendPharmacyAutomatedPush({
      ...base,
      db,
      now: new Date('2026-08-18T00:16:00.000Z'),
    })).resolves.toBe('sent');

    expect(push).toHaveBeenCalledTimes(2);
    expect(push.mock.calls[0][4]).toBe(push.mock.calls[1][4]);
  });

  it('never retries an unknown outcome after the LINE retry-key horizon', async () => {
    const seen: string[] = [];
    const db = scriptedDb([
      { match: 'INSERT OR IGNORE INTO pharmacy_notification_events', run: { changes: 0 } },
      { match: 'SELECT id, outcome', first: {
        id: 'event-1', outcome: 'attempted',
        occurred_at: '2026-08-16T23:00:00.000Z', created_at: '2026-08-16T23:00:00.000Z',
      } },
    ], seen);

    await expect(sendPharmacyAutomatedPush({
      ...base,
      db,
      now: new Date('2026-08-18T00:05:00.000Z'),
    })).resolves.toBe('reconciliation_required');
    expect(push).not.toHaveBeenCalled();
    expect(seen.some((sql) => sql.includes("SET occurred_at ="))).toBe(false);
  });

  it('does not send while the tenant has outbound messaging paused', async () => {
    // No notification-event steps at all: the pause is checked before the
    // idempotency claim, so a paused send burns neither the retry key nor the
    // proactive monthly cap and can still go out once the tenant resumes.
    const seen: string[] = [];
    const db = scriptedDb([], seen, '2026-08-19T00:00:00.000Z');
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await expect(sendPharmacyAutomatedPush({ ...base, db })).resolves.toBe('paused');
    expect(push).not.toHaveBeenCalled();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain('FROM tenant_line_accounts');
    expect(log.mock.calls.flat().join(' ')).not.toContain(base.retryKey);
    expect(log.mock.calls.flat().join(' ')).not.toContain('retry_key');
    log.mockRestore();
  });

  it('sends normally when the tenant is not paused', async () => {
    const db = scriptedDb([
      { match: 'INSERT OR IGNORE INTO pharmacy_notification_events', run: { changes: 1 } },
      { match: 'UPDATE pharmacy_notification_events', run: { changes: 1 } },
    ], [], null);

    await expect(sendPharmacyAutomatedPush({ ...base, db })).resolves.toBe('sent');
    expect(push).toHaveBeenCalledOnce();
  });

  it('rechecks the final destination and blocks an unfollowed or rebound recipient', async () => {
    const db = scriptedDb([
      { match: 'INSERT OR IGNORE INTO pharmacy_notification_events', run: { changes: 1 } },
      { match: 'UPDATE pharmacy_notification_events', run: { changes: 1 } },
    ], [], null, { is_following: 0 });

    await expect(sendPharmacyAutomatedPush({ ...base, db })).resolves.toBe('patient_blocked');
    expect(push).not.toHaveBeenCalled();
  });

  it('keeps a claim retryable when outbound messaging pauses after the claim', async () => {
    const db = scriptedDb([
      { match: 'INSERT OR IGNORE INTO pharmacy_notification_events', run: { changes: 1 } },
      { match: 'UPDATE pharmacy_notification_events', run: { changes: 1 } },
    ], [], null, { outbound_messaging_paused_at: '2026-09-14T00:00:00.000+09:00' });

    await expect(sendPharmacyAutomatedPush({ ...base, db })).resolves.toBe('paused');
    expect(push).not.toHaveBeenCalled();
  });

  it.each([null, { privacy: 'active', notifications: 'stopped' }])(
    'records a patient-bound notification as blocked when patient delivery is unavailable: %j',
    async (access) => {
      patientAccess.mockResolvedValue(access);
      const db = scriptedDb([
        { match: "VALUES (?, ?, ?, ?, ?, 'blocked'", run: { changes: 1 } },
        { match: "outcome IN ('attempted','failed')", run: { changes: 0 } },
      ]);

      await expect(sendPharmacyAutomatedPush({
        ...base, db, patientId: 'patient-a',
      })).resolves.toBe('patient_blocked');
      expect(patientAccess).toHaveBeenCalledWith(db, {
        lineAccountId: 'account-a', friendId: 'friend-a',
      }, 'patient-a');
      expect(push).not.toHaveBeenCalled();
    },
  );

  it('turns a previously failed attempt into a permanent block instead of replaying it after resume', async () => {
    patientAccess.mockResolvedValue({ notifications: 'stopped' });
    const db = scriptedDb([
      { match: "VALUES (?, ?, ?, ?, ?, 'blocked'", run: { changes: 0 } },
      { match: "outcome IN ('attempted','failed')", run: { changes: 1 } },
    ]);

    await expect(sendPharmacyAutomatedPush({
      ...base, db, patientId: 'patient-a',
    })).resolves.toBe('patient_blocked');
    expect(push).not.toHaveBeenCalled();
  });

  it('rechecks patient notification authority immediately before LINE dispatch', async () => {
    patientAccess
      .mockResolvedValueOnce({ privacy: 'active', notifications: 'enabled' })
      .mockResolvedValueOnce({ privacy: 'active', notifications: 'stopped' });
    const db = scriptedDb([
      { match: 'INSERT OR IGNORE INTO pharmacy_notification_events', run: { changes: 1 } },
      { match: 'UPDATE pharmacy_notification_events', run: { changes: 1 } },
    ]);

    await expect(sendPharmacyAutomatedPush({
      ...base, db, patientId: 'patient-a',
    })).resolves.toBe('patient_blocked');
    expect(patientAccess).toHaveBeenCalledTimes(2);
    expect(push).not.toHaveBeenCalled();
  });

  it('blocks a withdrawn patient immediately before LINE dispatch', async () => {
    patientAccess
      .mockResolvedValueOnce({ privacy: 'active', notifications: 'enabled' })
      .mockResolvedValueOnce({ privacy: 'withdrawn', notifications: 'enabled' });
    const db = scriptedDb([
      { match: 'INSERT OR IGNORE INTO pharmacy_notification_events', run: { changes: 1 } },
      { match: 'UPDATE pharmacy_notification_events', run: { changes: 1 } },
    ]);

    await expect(sendPharmacyAutomatedPush({ ...base, db, patientId: 'patient-a' }))
      .resolves.toBe('patient_blocked');
    expect(push).not.toHaveBeenCalled();
  });

  it('blocks a patient notification when the beta membership is no longer active', async () => {
    betaEnabled.mockResolvedValue(true);
    betaDeliveryState.mockResolvedValue('blocked');
    const db = scriptedDb([
      { match: "VALUES (?, ?, ?, ?, ?, 'blocked'", run: { changes: 1 } },
      { match: "outcome IN ('attempted','failed')", run: { changes: 0 } },
    ]);

    await expect(sendPharmacyAutomatedPush({
      ...base, db, patientId: 'patient-a', betaMembershipId: 'membership-a',
      now: new Date('2026-09-14T00:00:00.000Z'),
    })).resolves.toBe('patient_blocked');
    expect(betaDeliveryState).toHaveBeenCalledWith(expect.anything(), {
      lineAccountId: 'account-a', participantFriendId: 'friend-a',
      subjectPatientId: 'patient-a', membershipId: 'membership-a',
      now: new Date('2026-09-14T00:00:00.000Z'),
    });
    expect(push).not.toHaveBeenCalled();
  });

  it('keeps a suspended beta membership retryable instead of permanently blocked', async () => {
    betaEnabled.mockResolvedValue(true);
    betaDeliveryState.mockResolvedValue('suspended');
    const db = scriptedDb([]);

    await expect(sendPharmacyAutomatedPush({
      ...base, db, patientId: 'patient-a', betaMembershipId: 'membership-a',
      now: new Date('2026-09-14T00:00:00.000Z'),
    })).resolves.toBe('patient_blocked');
    expect(push).not.toHaveBeenCalled();
    expect(db).toBeDefined();
  });

  it('preserves a stale result-unknown attempt when membership becomes suspended', async () => {
    betaEnabled.mockResolvedValue(true);
    betaDeliveryState
      .mockResolvedValueOnce('active')
      .mockResolvedValueOnce('suspended');
    const seen: string[] = [];
    const db = scriptedDb([
      { match: 'INSERT OR IGNORE INTO pharmacy_notification_events', run: { changes: 0 } },
      { match: 'SELECT id, outcome', first: {
        id: 'notification-1',
        outcome: 'attempted',
        occurred_at: '2026-09-13T23:00:00.000Z',
        created_at: '2026-09-13T23:00:00.000Z',
      } },
      { match: 'UPDATE pharmacy_notification_events', run: { changes: 1 } },
    ], seen);

    await expect(sendPharmacyAutomatedPush({
      ...base, db, patientId: 'patient-a', betaMembershipId: 'membership-a',
      now: new Date('2026-09-14T00:00:00.000Z'),
    })).resolves.toBe('patient_blocked');
    expect(push).not.toHaveBeenCalled();
    expect(seen.some((sql) => sql.includes("SET outcome = 'failed'"))).toBe(false);
    expect(db).toBeDefined();
  });

  it('applies the proactive monthly cap per friend with an atomic claim', async () => {
    const seen: string[] = [];
    const db = scriptedDb([
      { match: 'INSERT OR IGNORE INTO pharmacy_notification_events', run: { changes: 0 } },
      { match: 'SELECT id, outcome', first: null },
      { match: "VALUES (?, ?, ?, ?, ?, 'blocked'", run: { changes: 1 } },
      { match: "outcome IN ('attempted','failed')", run: { changes: 0 } },
    ], seen);

    await expect(sendPharmacyAutomatedPush({
      ...base, db, category: 'proactive_noncare', now: new Date('2026-08-31T15:30:00.000Z'),
    })).rejects.toThrow(/frequency cap/);
    const claim = seen.find((sql) => sql.includes('INSERT OR IGNORE')) ?? '';
    expect(claim).toContain('friend_id = ?');
    expect(claim).toContain("outcome IN ('attempted','sent')");
    expect(push).not.toHaveBeenCalled();
  });
});
