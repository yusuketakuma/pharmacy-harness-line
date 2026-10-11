import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DB_PACKAGE_ROOT, Sqlite, d1FromSqlite, type TestSqliteDatabase } from './test-sqlite.js';

const external = vi.hoisted(() => ({ calls: [] as string[], accepted: new Set<string>() }));
vi.mock('../../services/line-proxy-send.js', async (original) => ({
  ...(await original<typeof import('../../services/line-proxy-send.js')>()),
  pushViaHarnessProxy: async (_url: string, _token: string, _to: string, _message: unknown, retryKey: string) => {
    external.calls.push(retryKey);
    // LINE accepts the stable key once; a retry of an accepted key is reconciled.
    external.accepted.add(retryKey);
  },
}));
vi.mock('./provisioning/line-credential-store.js', () => ({ readLineCredential: async () => 'synthetic' }));
import { processExpiredMynaHandoffNotifications, sendMynaHandoffStatusNotification } from './myna/notifications.js';
import { claimStatusNotificationWork, finishStatusNotificationWork } from './status-notification-work.js';

const now = new Date('2026-10-07T00:00:00.000Z');
let sqlite: TestSqliteDatabase;
let db: D1Database;
const options = { proxyBaseUrl: 'https://example.invalid', lineCredentialKey: 'synthetic', now };
const handoff = { id: 'h', line_account_id: 'a', friend_id: 'f', patient_id: null, status: 'EXPIRED' as const };
function work() {
  return sqlite
    .prepare(`SELECT line_account_id,retry_key AS work_retry_key,attempt_count AS work_attempt_count,
    expires_at AS work_expires_at FROM pharmacy_status_notification_work`)
    .get() as Parameters<typeof claimStatusNotificationWork>[1];
}
function queueState() {
  return sqlite.prepare(`SELECT state,claim_token FROM pharmacy_status_notification_work`).get();
}
function noticeState() {
  return sqlite.prepare(`SELECT outcome FROM pharmacy_notification_events`).get();
}
function faultDb(ack: 'before' | 'after' | null = null, finishFailure = false) {
  let failed = false;
  let batches = 0;
  const native = d1FromSqlite(sqlite);
  return {
    prepare: (sql: string) => {
      const prepared = native.prepare(sql);
      return {
        ...prepared,
        bind: (...values: unknown[]) => {
          const bound = prepared.bind(...values);
          return {
            ...bound,
            run: async () => {
              const fail =
                !failed && ack && sql.includes('UPDATE pharmacy_notification_events') && values[0] === 'sent';
              if (fail && ack === 'before') {
                failed = true;
                throw new Error('synthetic ack rejected before commit');
              }
              const result = await bound.run();
              if (fail && ack === 'after') {
                failed = true;
                throw new Error('synthetic ack response lost after commit');
              }
              return result;
            },
          };
        },
      };
    },
    batch: async (statements: D1PreparedStatement[]) => {
      batches++;
      if (finishFailure && batches === 2) throw new Error('synthetic finish batch failure');
      return native.batch(statements);
    },
  } as unknown as D1Database;
}
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(now);
  external.calls.length = 0;
  external.accepted.clear();
  sqlite = new Sqlite(':memory:');
  sqlite.exec(readFileSync(join(DB_PACKAGE_ROOT, 'bootstrap.sql'), 'utf8'));
  sqlite.exec(`PRAGMA foreign_keys=ON;
    INSERT INTO tenants(id,tenant_code,display_name,status) VALUES('t','t','synthetic','active');
    INSERT INTO line_accounts(id,channel_id,name,channel_access_token,channel_secret,is_active)
      VALUES('a','a','synthetic','synthetic','synthetic',1);
    INSERT INTO tenant_line_accounts(tenant_id,line_account_id) VALUES('t','a');
    INSERT INTO friends(id,line_user_id,provider_line_user_id,line_account_id,is_following)
      VALUES('f','synthetic','synthetic','a',1);
    UPDATE pharmacy_account_capabilities SET capabilities_json='["electronic_prescription"]' WHERE line_account_id='a';
    INSERT INTO pharmacy_myna_handoffs
      (id,line_account_id,friend_id,method,status,source,correlation_id,expires_at,created_at,updated_at)
      VALUES('h','a','f','PAPER','EXPIRED','LIFF','h','2026-10-07T00:00:00.000Z','2026-10-07T00:00:00.000Z','2026-10-07T00:00:00.000Z');`);
  db = d1FromSqlite(sqlite);
});
afterEach(() => {
  sqlite.close();
  vi.useRealTimers();
});

describe('real sender with durable SQLite work and synthetic LINE acceptance', () => {
  it('recovers an external success whose ack failed, with the same provider key and one acceptance', async () => {
    expect(await processExpiredMynaHandoffNotifications(faultDb('before'), options)).toEqual({
      sent: 0,
      failed: 1,
      skipped: 0,
    });
    expect(noticeState()).toEqual({ outcome: 'attempted' });
    expect(queueState()).toMatchObject({ state: 'pending' });
    const five = new Date(now.getTime() + 5 * 60_000);
    vi.setSystemTime(five);
    expect(await processExpiredMynaHandoffNotifications(db, { ...options, now: five })).toEqual({
      sent: 0,
      failed: 0,
      skipped: 1,
    });
    expect(external.calls).toHaveLength(1); // Existing sender's 15-minute unknown-outcome guard.
    const recovered = new Date(now.getTime() + 20 * 60_000);
    vi.setSystemTime(recovered);
    expect(await processExpiredMynaHandoffNotifications(db, { ...options, now: recovered })).toEqual({
      sent: 1,
      failed: 0,
      skipped: 0,
    });
    expect(external.calls).toHaveLength(2);
    expect(new Set(external.calls).size).toBe(1);
    expect(external.accepted.size).toBe(1);
    expect(noticeState()).toEqual({ outcome: 'sent' });
    expect(queueState()).toEqual({ state: 'done', claim_token: null });
  });

  it('does not retry after ack committed but its response was lost', async () => {
    expect(await processExpiredMynaHandoffNotifications(faultDb('after'), options)).toEqual({
      sent: 0,
      failed: 1,
      skipped: 0,
    });
    expect(queueState()).toEqual({ state: 'done', claim_token: null });
    expect(await processExpiredMynaHandoffNotifications(db, options)).toEqual({ sent: 0, failed: 0, skipped: 0 });
    expect(external.calls).toHaveLength(1);
  });

  it('keeps done after sent ack succeeded and finish batch failed', async () => {
    await expect(processExpiredMynaHandoffNotifications(faultDb(null, true), options)).rejects.toThrow('finish batch');
    expect(queueState()).toEqual({ state: 'done', claim_token: null });
    expect(await processExpiredMynaHandoffNotifications(db, options)).toEqual({ sent: 0, failed: 0, skipped: 0 });
    expect(external.calls).toHaveLength(1);
  });

  it('honors an old Worker inline send while a new Worker owns the work claim', async () => {
    const row = work();
    const token = await claimStatusNotificationWork(db, row, now);
    expect(await sendMynaHandoffStatusNotification(db, options, handoff)).toBe('sent');
    expect(
      await sendMynaHandoffStatusNotification(
        db,
        { ...options, workClaim: { retryKey: row.work_retry_key, token: token ?? '' } },
        handoff,
      ),
    ).toBe('skipped');
    await finishStatusNotificationWork(db, row, token ?? '', 'failed', now);
    expect(queueState()).toEqual({ state: 'done', claim_token: null });
    expect(external.calls).toHaveLength(1);
  });

  it('rejects an obsolete lease and a cancellation after discovery without dispatch', async () => {
    const row = work();
    const first = await claimStatusNotificationWork(db, row, now);
    const later = new Date(now.getTime() + 5 * 60_000);
    vi.setSystemTime(later);
    await claimStatusNotificationWork(db, work(), later);
    expect(
      await sendMynaHandoffStatusNotification(
        db,
        { ...options, workClaim: { retryKey: row.work_retry_key, token: first ?? '' } },
        handoff,
      ),
    ).toBe('skipped');
    sqlite.exec(`UPDATE pharmacy_myna_handoffs SET status='CLOSED' WHERE id='h'`);
    expect(queueState()).toEqual({ state: 'expired', claim_token: null });
    expect(await sendMynaHandoffStatusNotification(db, options, handoff)).toBe('skipped');
    expect(external.calls).toHaveLength(0);
  });
});
