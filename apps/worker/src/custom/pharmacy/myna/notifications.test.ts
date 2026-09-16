import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DB_PACKAGE_ROOT, Sqlite, d1FromSqlite } from '../test-sqlite.js';

const mocks = vi.hoisted(() => ({
  readCredential: vi.fn(),
  send: vi.fn(),
  betaBinding: vi.fn(),
}));
vi.mock('../provisioning/line-credential-store.js', () => ({
  readLineCredential: mocks.readCredential,
}));
vi.mock('../growth-loop/sender.js', () => ({ sendPharmacyAutomatedPush: mocks.send }));
vi.mock('../beta-membership/repository.js', () => ({
  getPharmacyBetaNotificationBinding: mocks.betaBinding,
}));

import {
  processExpiredMynaHandoffNotifications,
  sendMynaHandoffStatusNotification,
} from './notifications.js';

const baseHandoff = {
  id: 'handoff-a',
  line_account_id: 'account-a',
  friend_id: 'friend-a',
  patient_id: 'patient-a',
  status: 'EXPIRED',
} as const;

// 08:15 JST — inside the sending window.
const now = new Date('2026-08-20T23:15:00.000Z');

function fakeDb(
  handoffs: unknown[],
  recipient: unknown = { line_user_id: 'U-a', tenant_id: 'tenant-a' },
  alreadySentIds = new Set<string>(),
) {
  return {
    prepare: vi.fn((sql: string) => ({
      bind: () => ({
        all: async () => ({
          results: alreadySentIds.size > 0
            ? sql.includes('NOT EXISTS')
              ? handoffs.filter((row) => !alreadySentIds.has((row as { id: string }).id))
              : handoffs.slice(0, 1)
            : handoffs,
        }),
        first: async () => recipient,
      }),
    })),
  } as unknown as D1Database;
}

const options = {
  proxyBaseUrl: 'https://worker.test',
  lineCredentialKey: 'key',
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.readCredential.mockResolvedValue('token');
  mocks.send.mockResolvedValue('sent');
  mocks.betaBinding.mockResolvedValue('membership-a');
});

describe('sendMynaHandoffStatusNotification', () => {
  it('sends the approved status push with a deterministic retry key', async () => {
    const result = await sendMynaHandoffStatusNotification(
      fakeDb([]), options, baseHandoff,
    );
    expect(result).toBe('sent');
    expect(mocks.send).toHaveBeenCalledWith(expect.objectContaining({
      messageId: 'myna_handoff_status_v1',
      vars: { handoffStatus: 'EXPIRED' },
      retryKey: 'myna-status:handoff-a:EXPIRED',
      to: 'U-a',
      betaMembershipId: 'membership-a',
    }));
  });

  it('skips statuses that are not notified', async () => {
    const result = await sendMynaHandoffStatusNotification(
      fakeDb([]), options, { ...baseHandoff, status: 'WAITING' as never },
    );
    expect(result).toBe('skipped');
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it('skips when the friend has no LINE user id or the credential is missing', async () => {
    mocks.readCredential.mockResolvedValue(null);
    const noUser = await sendMynaHandoffStatusNotification(
      fakeDb([], { line_user_id: null, tenant_id: 'tenant-a' }), options, baseHandoff,
    );
    const noToken = await sendMynaHandoffStatusNotification(
      fakeDb([]), options, baseHandoff,
    );
    expect(noUser).toBe('skipped');
    expect(noToken).toBe('skipped');
    expect(mocks.send).not.toHaveBeenCalled();
  });
});

describe('processExpiredMynaHandoffNotifications', () => {
  it('runs the candidate SQL against the ledger before LIMIT across ticks and accounts', async () => {
    const sqlite = new Sqlite(':memory:');
    try {
      sqlite.pragma('foreign_keys = ON');
      sqlite.exec(readFileSync(join(DB_PACKAGE_ROOT, 'bootstrap.sql'), 'utf8'));
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
      for (const id of ['a', 'b', 'c']) {
        sqlite.prepare(`INSERT INTO pharmacy_myna_handoffs
          (id, line_account_id, friend_id, method, status, source, correlation_id,
           expires_at, created_at, updated_at)
          VALUES (?, 'account-a', 'friend-a', 'PAPER', 'EXPIRED', 'LIFF', ?,
                  '2026-08-20T22:00:00.000Z', '2026-08-20T22:00:00.000Z', '2026-08-20T22:00:00.000Z')`)
          .run(`handoff-${id}`, `correlation-${id}`);
      }
      const recordOutcome = (
        id: string,
        outcome: 'attempted' | 'sent' | 'blocked' | 'failed',
        account = 'a',
      ) => sqlite.prepare(`INSERT INTO pharmacy_notification_events
        (id, line_account_id, friend_id, message_id, category, outcome,
         occurred_at, idempotency_key, created_at)
        VALUES (?, ?, ?, 'myna_handoff_status_v1', 'transactional_care', ?,
                '2026-08-20T23:00:00.000Z', ?, '2026-08-20T23:00:00.000Z')
        ON CONFLICT (line_account_id, idempotency_key)
        DO UPDATE SET outcome = excluded.outcome`)
        .run(`notice-${account}-${outcome}-${id}`, `account-${account}`, `friend-${account}`,
          outcome, `myna-status:handoff-${id}:EXPIRED`);
      recordOutcome('a', 'sent');
      recordOutcome('b', 'failed'); // A failed/attempted row must not suppress the handoff.
      recordOutcome('c', 'sent', 'b'); // Another account's same retry key cannot suppress account-a.
      mocks.send.mockImplementation(async ({ retryKey }: { retryKey: string }) => {
        recordOutcome(retryKey.split(':')[1].slice(-1), 'sent');
        return 'sent';
      });
      const db = d1FromSqlite(sqlite);
      const tick = () => processExpiredMynaHandoffNotifications(db, { ...options, now, limit: 1 });
      expect(await tick()).toEqual({ sent: 1, failed: 0, skipped: 0 });
      expect(await tick()).toEqual({ sent: 1, failed: 0, skipped: 0 });
      expect(await tick()).toEqual({ sent: 0, failed: 0, skipped: 0 });
      expect(mocks.send.mock.calls.map(([call]) => call.retryKey)).toEqual([
        'myna-status:handoff-b:EXPIRED', 'myna-status:handoff-c:EXPIRED',
      ]);
    } finally {
      sqlite.close();
    }
  });

  it('sends one push per expired handoff inside the sending window', async () => {
    const result = await processExpiredMynaHandoffNotifications(
      fakeDb([baseHandoff, { ...baseHandoff, id: 'handoff-b' }]),
      { ...options, now },
    );
    expect(result).toEqual({ sent: 2, failed: 0, skipped: 0 });
    expect(mocks.send).toHaveBeenCalledTimes(2);
  });

  it('defers everything during JST quiet hours', async () => {
    const result = await processExpiredMynaHandoffNotifications(
      fakeDb([baseHandoff]),
      { ...options, now: new Date('2026-08-20T14:00:00.000Z') }, // 23:00 JST
    );
    expect(result).toEqual({ sent: 0, failed: 0, skipped: 0 });
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it('counts send failures without PHI in the result', async () => {
    mocks.send.mockRejectedValue(new Error('provider down'));
    const result = await processExpiredMynaHandoffNotifications(
      fakeDb([baseHandoff]), { ...options, now },
    );
    expect(result).toEqual({ sent: 0, failed: 1, skipped: 0 });
  });

  it('excludes already-sent rows before LIMIT so a later handoff is reached', async () => {
    mocks.send.mockImplementation(async ({ retryKey }: { retryKey: string }) =>
      retryKey.includes('handoff-a') ? 'already_sent' : 'sent');
    const result = await processExpiredMynaHandoffNotifications(
      fakeDb(
        [baseHandoff, { ...baseHandoff, id: 'handoff-b' }],
        undefined,
        new Set(['handoff-a']),
      ),
      { ...options, now, limit: 1 },
    );
    expect(result).toEqual({ sent: 1, failed: 0, skipped: 0 });
    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(mocks.send).toHaveBeenCalledWith(expect.objectContaining({
      retryKey: 'myna-status:handoff-b:EXPIRED',
    }));
  });
});
