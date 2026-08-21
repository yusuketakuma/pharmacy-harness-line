import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  claim: vi.fn(),
  generate: vi.fn(),
  readCredential: vi.fn(),
  send: vi.fn(),
}));
vi.mock('./reminders.js', () => ({
  claimDueEmergencyAppointmentReminders: mocks.claim,
  generateEmergencyAppointmentReminders: mocks.generate,
}));
vi.mock('../provisioning/line-credential-store.js', () => ({
  readLineCredential: mocks.readCredential,
}));
vi.mock('../growth-loop/sender.js', () => ({ sendPharmacyAutomatedPush: mocks.send }));

import { processEmergencyAppointmentReminders } from './notifications.js';

const now = new Date('2026-08-21T00:15:00.000Z');
const reminder = {
  id: 'reminder-a', line_account_id: 'account-a', intake_id: 'intake-a',
  anchor_at: '2026-08-21T01:00:00.000Z', due_at: '2026-08-21T00:00:00.000Z',
  deadline_at: '2026-08-21T01:00:00.000Z', occurrence_hash: 'a'.repeat(64),
  claim_token: 'claim-a',
};
const context = {
  tenant_id: 'tenant-a', line_account_id: 'account-a', friend_id: 'friend-a',
  line_user_id: 'U-a', is_following: 1, control_state: 'active', feature_enabled: 1,
  capability_enabled: 1, account_active: 1, tenant_status: 'active',
  intake_status: 'provisional', safe_contact_mode: 'neutral_line',
  expires_at: '2026-08-21T02:00:00.000Z', slot_starts_at: reminder.anchor_at,
};

function fakeDb(row: typeof context | Error) {
  const writes: string[] = [];
  return {
    writes,
    db: {
      prepare: vi.fn((sql: string) => ({
        bind: (...values: unknown[]) => ({
          first: async () => {
            if (!sql.includes('SELECT intake.tenant_id')) return null
            if (row instanceof Error) throw row
            return row
          },
          run: async () => {
            writes.push(`${sql}:${values.join(',')}`);
            return { meta: { changes: 1 } };
          },
        }),
      })),
    } as unknown as D1Database,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.generate.mockResolvedValue({ generated: 1, suppressed: 0, failed: 0 });
  mocks.claim.mockResolvedValue([reminder]);
  mocks.readCredential.mockResolvedValue('token-a');
  mocks.send.mockResolvedValue('sent');
});

describe('emergency appointment reminder delivery', () => {
  it('rechecks the account and intake, then sends only the neutral approved template', async () => {
    const { db, writes } = fakeDb(context);
    await expect(processEmergencyAppointmentReminders(db, {
      proxyBaseUrl: 'https://worker.example', lineCredentialKey: 'synthetic-root', now,
    })).resolves.toEqual({ generated: 1, sent: 1, failed: 0, skipped: 0, suppressed: 0 });
    expect(mocks.send).toHaveBeenCalledWith(expect.objectContaining({
      db, lineAccountId: 'account-a', friendId: 'friend-a', to: 'U-a',
      messageId: 'appointment_reminder_v1', category: 'transactional_care',
      retryKey: 'a'.repeat(64), now,
    }));
    expect(mocks.send.mock.calls[0][0]).not.toHaveProperty('vars');
    expect(writes.join('\n')).toContain("status = 'sent'");
  });

  it('suppresses a claimed reminder if the feature was disabled before dispatch', async () => {
    const { db, writes } = fakeDb({ ...context, feature_enabled: 0 });
    await expect(processEmergencyAppointmentReminders(db, {
      proxyBaseUrl: 'https://worker.example', lineCredentialKey: 'synthetic-root', now,
    })).resolves.toEqual({ generated: 1, sent: 0, failed: 0, skipped: 0, suppressed: 1 });
    expect(mocks.send).not.toHaveBeenCalled();
    expect(writes.join('\n')).toContain('FEATURE_DISABLED');
  });

  it.each([
    ['frozen rollback control', { control_state: 'frozen' }, 'ACTIVATION_DISABLED'],
    ['cancelled intake', { intake_status: 'cancelled' }, 'INTAKE_INACTIVE'],
    ['changed appointment anchor', { slot_starts_at: '2026-08-21T03:00:00.000Z' }, 'ANCHOR_CHANGED'],
  ])('suppresses %s before LINE dispatch', async (_label, change, reasonCode) => {
    const { db, writes } = fakeDb({ ...context, ...change });
    await expect(processEmergencyAppointmentReminders(db, {
      proxyBaseUrl: 'https://worker.example', lineCredentialKey: 'synthetic-root', now,
    })).resolves.toMatchObject({ sent: 0, suppressed: 1 });
    expect(mocks.send).not.toHaveBeenCalled();
    expect(writes.join('\n')).toContain(reasonCode);
  });

  it('does not burn the occurrence while outbound sending is paused', async () => {
    mocks.send.mockResolvedValue('paused');
    const { db, writes } = fakeDb(context);
    await expect(processEmergencyAppointmentReminders(db, {
      proxyBaseUrl: 'https://worker.example', lineCredentialKey: 'synthetic-root', now,
    })).resolves.toMatchObject({ sent: 0, skipped: 1 });
    expect(writes.join('\n')).toContain("status = 'pending'");
    expect(writes.join('\n')).not.toContain("status = 'sent'");
  });

  it('keeps a claimed occurrence retryable when the final safety recheck is unavailable', async () => {
    const { db, writes } = fakeDb(new Error('D1 unavailable'));
    await expect(processEmergencyAppointmentReminders(db, {
      proxyBaseUrl: 'https://worker.example', lineCredentialKey: 'synthetic-root', now,
    })).resolves.toMatchObject({ sent: 0, skipped: 1, suppressed: 0 });
    expect(mocks.send).not.toHaveBeenCalled();
    expect(writes.join('\n')).toContain("status = 'pending'");
  });

  it('continues another account after one account credential fails without changing clinical records', async () => {
    const reminderB = {
      ...reminder, id: 'reminder-b', line_account_id: 'account-b', intake_id: 'intake-b',
      occurrence_hash: 'b'.repeat(64), claim_token: 'claim-b',
    };
    const contextB = {
      ...context, tenant_id: 'tenant-b', line_account_id: 'account-b',
      friend_id: 'friend-b', line_user_id: 'U-b',
    };
    mocks.claim.mockResolvedValue([reminder, reminderB]);
    mocks.readCredential.mockResolvedValueOnce(null).mockResolvedValueOnce('token-b');
    const writes: string[] = [];
    const db = {
      prepare: vi.fn((sql: string) => ({
        bind: (...values: unknown[]) => ({
          first: async () => values.includes('account-b') ? contextB : context,
          run: async () => {
            writes.push(sql);
            return { meta: { changes: 1 } };
          },
        }),
      })),
    } as unknown as D1Database;

    await expect(processEmergencyAppointmentReminders(db, {
      proxyBaseUrl: 'https://worker.example', lineCredentialKey: 'synthetic-root', now,
    })).resolves.toEqual({ generated: 1, sent: 1, failed: 1, skipped: 0, suppressed: 0 });
    expect(mocks.send).toHaveBeenCalledOnce();
    expect(mocks.send).toHaveBeenCalledWith(expect.objectContaining({
      lineAccountId: 'account-b', friendId: 'friend-b', retryKey: 'b'.repeat(64),
    }));
    expect(writes.every((sql) => sql.includes('pharmacy_emergency_reminders'))).toBe(true);
    expect(writes.join('\n')).not.toMatch(/UPDATE\s+pharmacy_emergency_(?:intakes|slots|inventory)/iu);
  });
});
