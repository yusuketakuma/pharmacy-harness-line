import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DB_PACKAGE_ROOT, Sqlite, d1FromSqlite } from '../test-sqlite.js';

const mocks = vi.hoisted(() => ({
  readCredential: vi.fn(),
  send: vi.fn(),
}));
vi.mock('../provisioning/line-credential-store.js', () => ({
  readLineCredential: mocks.readCredential,
}));
vi.mock('../growth-loop/sender.js', () => ({ sendPharmacyAutomatedPush: mocks.send }));

import { processEmergencyIntakeStatusNotifications } from './status-notifications.js';

const baseRow = {
  event_id: 'event-a',
  intake_status: 'reviewed',
  tenant_id: 'tenant-a',
  line_account_id: 'account-a',
  friend_id: 'friend-a',
  line_user_id: 'U-a',
  is_following: 1,
  control_state: 'active',
  feature_enabled: 1,
  capability_enabled: 1,
  account_active: 1,
  tenant_status: 'active',
  safe_contact_mode: 'neutral_line',
};

// 08:15 JST — inside the sending window.
const now = new Date('2026-08-20T23:15:00.000Z');

function fakeDb(rows: unknown[], alreadySentEventIds = new Set<string>()) {
  return {
    prepare: vi.fn((sql: string) => ({
      bind: () => ({
        all: async () => ({
          results: alreadySentEventIds.size > 0
            ? sql.includes('NOT EXISTS')
              ? rows.filter((row) => !alreadySentEventIds.has((row as { event_id: string }).event_id))
              : rows.slice(0, 1)
            : rows,
        }),
      }),
    })),
  } as unknown as D1Database;
}

const options = {
  proxyBaseUrl: 'https://worker.test',
  lineCredentialKey: 'key',
  now,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.readCredential.mockResolvedValue('token');
  mocks.send.mockResolvedValue('sent');
});

describe('processEmergencyIntakeStatusNotifications', () => {
  it('executes the candidate SQL before LIMIT across ticks and accounts', async () => {
    const sqlite = new Sqlite(':memory:');
    try {
      sqlite.pragma('foreign_keys = ON');
      sqlite.exec(readFileSync(join(DB_PACKAGE_ROOT, 'bootstrap.sql'), 'utf8'));
      const ts = '2026-08-20T23:00:00.000Z';
      for (const account of ['a', 'b']) {
        sqlite.prepare(`INSERT INTO tenants (id, tenant_code, display_name) VALUES (?, ?, 'Synthetic')`)
          .run(`tenant-${account}`, `tenant-${account}`);
        sqlite.prepare(`INSERT INTO line_accounts (id, channel_id, name, channel_access_token, channel_secret)
          VALUES (?, ?, 'Synthetic', 'synthetic-token', 'synthetic-secret')`)
          .run(`account-${account}`, `channel-${account}`);
        sqlite.prepare(`INSERT INTO tenant_line_accounts (tenant_id, line_account_id) VALUES (?, ?)`)
          .run(`tenant-${account}`, `account-${account}`);
        sqlite.prepare(`INSERT INTO friends (id, line_user_id, provider_line_user_id, line_account_id)
          VALUES (?, ?, ?, ?)`).run(`friend-${account}`, `line-${account}`, `U-${account}`, `account-${account}`);
      }
      sqlite.prepare(`INSERT INTO staff_members (id, name, role, api_key) VALUES ('staff-a', 'Synthetic', 'staff', 'synthetic-key')`).run();
      sqlite.prepare(`INSERT INTO tenant_staff_memberships (tenant_id, staff_id, role)
        VALUES ('tenant-a', 'staff-a', 'staff')`).run();
      sqlite.prepare(`INSERT INTO pharmacy_staff_accounts (line_account_id, staff_id, created_at, updated_at)
        VALUES ('account-a', 'staff-a', ?, ?)`).run(ts, ts);
      sqlite.prepare(`INSERT INTO pharmacy_emergency_pharmacists
        (line_account_id, staff_id, training_registration_number, created_at, updated_at)
        VALUES ('account-a', 'staff-a', 'synthetic-registration', ?, ?)`).run(ts, ts);
      sqlite.prepare(`INSERT INTO pharmacy_emergency_slots
        (id, line_account_id, pharmacist_staff_id, starts_at, ends_at, created_by, created_at, updated_at)
        VALUES ('slot-a', 'account-a', 'staff-a', '2099-01-01T01:00:00.000Z',
                '2099-01-01T02:00:00.000Z', 'staff-a', ?, ?)`).run(ts, ts);
      sqlite.prepare(`INSERT INTO pharmacy_emergency_reminder_controls
        (line_account_id, state, revision, updated_by, created_at, updated_at)
        VALUES ('account-a', 'active', 1, 'staff-a', ?, ?)`).run(ts, ts);
      sqlite.prepare(`INSERT INTO pharmacy_emergency_settings
        (line_account_id, is_enabled, pharmacy_registration_number, product_code,
         manufacturer_check_url, privacy_policy_url, privacy_contact, purpose_text,
         consent_version, retention_days, consultation_minutes, reservation_ttl_minutes,
         privacy_space_ready, drinking_water_ready,
         partner_clinic_url, support_center_url, updated_by, created_at, updated_at)
        VALUES ('account-a', 1, 'synthetic-registration', 'synthetic-product',
                'https://example.invalid/manufacturer', 'https://example.invalid/privacy',
                'synthetic-contact', 'synthetic-purpose', 'v1', 30, 30, 30, 1, 1,
                'https://example.invalid/clinic', 'https://example.invalid/support',
                'staff-a', ?, ?)`).run(ts, ts);
      sqlite.prepare(`UPDATE pharmacy_account_capabilities
        SET capabilities_json = '["emergency_contraception"]'
        WHERE line_account_id = 'account-a'`).run();
      sqlite.prepare(`INSERT INTO pharmacy_emergency_inventory
        (line_account_id, product_code, on_hand, updated_by, created_at, updated_at)
        VALUES ('account-a', 'synthetic-product', 10, 'staff-a', ?, ?)`).run(ts, ts);
      for (const id of ['a', 'b', 'c']) {
        sqlite.prepare(`INSERT INTO pharmacy_emergency_intakes
          (id, reference_code, tenant_id, line_account_id, owner_friend_id, slot_id,
           status, encrypted_payload, age_band, safe_contact_mode, consent_version,
           product_code, idempotency_key, expires_at, created_at, updated_at)
          VALUES (?, ?, 'tenant-a', 'account-a', 'friend-a', 'slot-a', 'reviewed',
                  'synthetic-ciphertext', 'adult', 'neutral_line', 'v1', 'synthetic-product', ?, ?, ?, ?)`)
          .run(`intake-${id}`, `synthetic-ref-${id}`, `intake-key-${id}`, ts, ts, ts);
        sqlite.prepare(`INSERT INTO pharmacy_emergency_intake_events
          (id, intake_id, line_account_id, event_type, actor_type, actor_id,
           idempotency_key, occurred_at)
          VALUES (?, ?, 'account-a', 'reviewed', 'staff', 'staff-a', ?, ?)`)
          .run(`event-${id}`, `intake-${id}`, `event-key-${id}`, ts);
      }
      const recordOutcome = (
        id: string,
        outcome: 'attempted' | 'sent' | 'blocked' | 'failed',
        account = 'a',
      ) => sqlite.prepare(`INSERT INTO pharmacy_notification_events
        (id, line_account_id, friend_id, message_id, category, outcome,
         occurred_at, idempotency_key, created_at)
        VALUES (?, ?, ?, 'emergency_intake_status_v1', 'transactional_care', ?, ?, ?, ?)
        ON CONFLICT (line_account_id, idempotency_key)
        DO UPDATE SET outcome = excluded.outcome`)
        .run(`notice-${account}-${outcome}-${id}`, `account-${account}`, `friend-${account}`,
          outcome, ts, `emergency-intake-status:event-${id}`, ts);
      recordOutcome('a', 'sent');
      recordOutcome('b', 'failed'); // A failed/attempted row must not suppress the event.
      recordOutcome('c', 'sent', 'b');
      mocks.send.mockImplementation(async ({ retryKey }: { retryKey: string }) => {
        recordOutcome(retryKey.slice(-1), 'sent');
        return 'sent';
      });
      const db = d1FromSqlite(sqlite);
      const tick = () => processEmergencyIntakeStatusNotifications(db, { ...options, limit: 1 });
      expect(await tick()).toEqual({ sent: 1, failed: 0, skipped: 0 });
      expect(await tick()).toEqual({ sent: 1, failed: 0, skipped: 0 });
      expect(await tick()).toEqual({ sent: 0, failed: 0, skipped: 0 });
      expect(mocks.send.mock.calls.map(([call]) => call.retryKey)).toEqual([
        'emergency-intake-status:event-b', 'emergency-intake-status:event-c',
      ]);
    } finally {
      sqlite.close();
    }
  });

  it('sends a neutral push for a notified transition event', async () => {
    const result = await processEmergencyIntakeStatusNotifications(
      fakeDb([baseRow]), options,
    );
    expect(result).toEqual({ sent: 1, failed: 0, skipped: 0 });
    expect(mocks.send).toHaveBeenCalledWith(expect.objectContaining({
      messageId: 'emergency_intake_status_v1',
      vars: { intakeStatus: 'reviewed' },
      retryKey: 'emergency-intake-status:event-a',
      to: 'U-a',
    }));
  });

  it('skips intakes that did not consent to LINE contact', async () => {
    const result = await processEmergencyIntakeStatusNotifications(
      fakeDb([{ ...baseRow, safe_contact_mode: 'no_notification' }]), options,
    );
    expect(result).toEqual({ sent: 0, failed: 0, skipped: 1 });
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it('skips when reminder controls or the feature are disabled', async () => {
    const result = await processEmergencyIntakeStatusNotifications(
      fakeDb([
        { ...baseRow, event_id: 'e1', control_state: 'frozen' },
        { ...baseRow, event_id: 'e2', feature_enabled: 0 },
        { ...baseRow, event_id: 'e3', capability_enabled: 0 },
      ]), options,
    );
    expect(result).toEqual({ sent: 0, failed: 0, skipped: 3 });
  });

  it('defers everything during JST quiet hours', async () => {
    const result = await processEmergencyIntakeStatusNotifications(
      fakeDb([baseRow]),
      { ...options, now: new Date('2026-08-20T14:00:00.000Z') }, // 23:00 JST
    );
    expect(result).toEqual({ sent: 0, failed: 0, skipped: 0 });
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it('skips when the friend unfollowed or the credential is missing', async () => {
    mocks.readCredential.mockResolvedValue(null);
    const result = await processEmergencyIntakeStatusNotifications(
      fakeDb([{ ...baseRow, is_following: 0 }, baseRow]), options,
    );
    expect(result).toEqual({ sent: 0, failed: 0, skipped: 2 });
  });

  it('excludes already-sent rows before LIMIT so a later event is reached', async () => {
    mocks.send.mockImplementation(async ({ retryKey }: { retryKey: string }) =>
      retryKey.includes('event-a') ? 'already_sent' : 'sent');
    const result = await processEmergencyIntakeStatusNotifications(
      fakeDb(
        [baseRow, { ...baseRow, event_id: 'event-b' }],
        new Set(['event-a']),
      ),
      { ...options, limit: 1 },
    );
    expect(result).toEqual({ sent: 1, failed: 0, skipped: 0 });
    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(mocks.send).toHaveBeenCalledWith(expect.objectContaining({
      retryKey: 'emergency-intake-status:event-b',
    }));
  });
});
