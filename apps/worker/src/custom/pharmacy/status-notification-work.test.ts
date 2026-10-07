import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { processExpiredMynaHandoffNotifications } from './myna/notifications.js';
import { processEmergencyIntakeStatusNotifications } from './emergency-contraception/status-notifications.js';
import { DB_PACKAGE_ROOT, Sqlite, d1FromSqlite, type TestSqliteDatabase } from './test-sqlite.js';
import {
  claimStatusNotificationWork,
  claimStatusNotificationWorks,
  expireStatusNotificationWorks,
  finishStatusNotificationWork,
  type StatusNotificationWork,
} from './status-notification-work.js';

const now = new Date('2026-10-07T00:00:00.000Z');
let sqlite: TestSqliteDatabase;
let db: D1Database;
function enqueue(id = 'a', account = 'a', timestamp = now.toISOString()) {
  sqlite
    .prepare(`INSERT INTO pharmacy_myna_handoffs
    (id,line_account_id,friend_id,method,status,source,correlation_id,expires_at,created_at,updated_at)
    VALUES (?, ?, ?, 'PAPER', 'EXPIRED', 'LIFF', ?, ?, ?, ?)`)
    .run(id, `account-${account}`, `friend-${account}`, id, timestamp, timestamp, timestamp);
  return work(id, account);
}
function work(id = 'a', account = 'a'): StatusNotificationWork {
  return sqlite
    .prepare(`SELECT line_account_id, retry_key AS work_retry_key,
    attempt_count AS work_attempt_count, expires_at AS work_expires_at
    FROM pharmacy_status_notification_work WHERE source_id = ? AND line_account_id = ?`)
    .get(id, `account-${account}`) as StatusNotificationWork;
}
function state(id = 'a', account = 'a') {
  return sqlite
    .prepare(`SELECT state,due_at,attempt_count,claim_token FROM pharmacy_status_notification_work
    WHERE source_id = ? AND line_account_id = ?`)
    .get(id, `account-${account}`);
}
beforeEach(() => {
  sqlite = new Sqlite(':memory:');
  sqlite.exec(readFileSync(join(DB_PACKAGE_ROOT, 'bootstrap.sql'), 'utf8'));
  sqlite.exec(`PRAGMA foreign_keys = ON;`);
  for (const id of ['a', 'b']) {
    sqlite
      .prepare(`INSERT INTO line_accounts (id,channel_id,name,channel_access_token,channel_secret)
      VALUES (?, ?, ?, 'synthetic', 'synthetic')`)
      .run(`account-${id}`, id, id);
    sqlite
      .prepare(`INSERT INTO friends(id,line_user_id,line_account_id) VALUES (?, ?, ?)`)
      .run(`friend-${id}`, id, `account-${id}`);
  }
  db = d1FromSqlite(sqlite);
});
afterEach(() => sqlite.close());

describe('durable status notification work', () => {
  it('uses one expiry range UPDATE and one indexed SELECT per idle processor with zero idle row changes', async () => {
    const prepare = vi.spyOn(db, 'prepare');
    const batch = vi.spyOn(db, 'batch');
    const options = { now, proxyBaseUrl: 'https://example.invalid' };
    const changes = sqlite.prepare('SELECT total_changes() AS count').get() as { count: number };
    expect(await processExpiredMynaHandoffNotifications(db, options)).toEqual({ sent: 0, failed: 0, skipped: 0 });
    expect(await processEmergencyIntakeStatusNotifications(db, options)).toEqual({ sent: 0, failed: 0, skipped: 0 });
    expect(prepare).toHaveBeenCalledTimes(4);
    expect(batch).not.toHaveBeenCalled();
    expect(prepare.mock.calls.filter(([sql]) => sql.trim().startsWith('SELECT'))).toHaveLength(2);
    expect(sqlite.prepare('SELECT total_changes() AS count').get()).toEqual(changes);
  });

  it('removes expired backlog before LIMIT so a still-live boundary job is reached on the same tick', async () => {
    const old = new Date(now.getTime() - 73 * 3600_000).toISOString();
    for (let i = 0; i < 101; i++) enqueue(`stale-${i}`, 'a', old);
    enqueue('live', 'b', new Date(now.getTime() - 72 * 3600_000).toISOString());
    expect(
      await processExpiredMynaHandoffNotifications(db, { now, limit: 1, proxyBaseUrl: 'https://example.invalid' }),
    ).toEqual({ sent: 0, failed: 0, skipped: 1 });
    expect(state('live', 'b')).toMatchObject({ state: 'pending', attempt_count: 1 });
    expect(
      sqlite.prepare("SELECT COUNT(*) AS count FROM pharmacy_status_notification_work WHERE state='expired'").get(),
    ).toEqual({ count: 101 });
  });

  it.each(['myna', 'emergency'] as const)(
    'expires %s work without invalidating a live lease or changing the other kind',
    async (kind) => {
      const old = new Date(now.getTime() - 73 * 3600_000).toISOString();
      const row = enqueue('lease', 'a', new Date(now.getTime() - 72 * 3600_000).toISOString());
      enqueue('stale', 'b', old);
      sqlite.prepare('UPDATE pharmacy_status_notification_work SET kind=?').run(kind);
      enqueue('other', 'a', old);
      if (kind === 'myna')
        sqlite.prepare("UPDATE pharmacy_status_notification_work SET kind='emergency' WHERE source_id='other'").run();
      const token = await claimStatusNotificationWork(db, row, now);
      await expireStatusNotificationWorks(db, kind, new Date(now.getTime() + 1));
      expect(state('lease')).toMatchObject({ state: 'pending', claim_token: token });
      expect(state('stale', 'b')).toMatchObject({ state: 'expired' });
      expect(state('other')).toMatchObject({ state: 'pending' });
      await expireStatusNotificationWorks(db, kind, new Date(now.getTime() + 300_000));
      expect(state('lease')).toMatchObject({ state: 'expired', claim_token: null });
      await finishStatusNotificationWork(db, row, token ?? '', 'failed', now);
      expect(state('lease')).toMatchObject({ state: 'expired' });
    },
  );

  it('enqueues within the source transaction, rolls back together, and catches old Worker transitions', () => {
    sqlite.exec('BEGIN');
    enqueue('rollback');
    expect(work('rollback')).toBeDefined();
    sqlite.exec('ROLLBACK');
    expect(work('rollback')).toBeUndefined();
    enqueue();
    expect(state()).toMatchObject({ state: 'pending', attempt_count: 0 });
    sqlite
      .prepare(`INSERT INTO pharmacy_myna_handoffs
      (id,line_account_id,friend_id,method,status,source,correlation_id,expires_at,created_at,updated_at)
      VALUES ('transition','account-a','friend-a','PAPER','CREATED','LIFF','transition',?,?,?)`)
      .run(now.toISOString(), now.toISOString(), now.toISOString());
    sqlite
      .prepare(`UPDATE pharmacy_myna_handoffs SET status='EXPIRED',updated_at=? WHERE id='transition'`)
      .run(now.toISOString());
    expect(work('transition').work_expires_at).toBe('2026-10-10T00:00:00.000Z');
  });

  it('claims once across simultaneous ticks and isolates accounts', async () => {
    const row = enqueue();
    const tokens = await Promise.all([
      claimStatusNotificationWork(db, row, now),
      claimStatusNotificationWork(db, row, now),
    ]);
    expect(tokens.filter(Boolean)).toHaveLength(1);
    expect(await claimStatusNotificationWork(db, { ...row, line_account_id: 'account-b' }, now)).toBeNull();
    expect(state()).toMatchObject({ attempt_count: 1 });
  });

  it('refreshes the legacy updated_at window for still-EXPIRED handoffs without resetting live claims or resending done work', async () => {
    const old = new Date(now.getTime() - 73 * 3600_000).toISOString();
    const stale = enqueue('refresh', 'a', old);
    await expireStatusNotificationWorks(db, 'myna', now);
    expect(state('refresh')).toMatchObject({ state: 'expired' });
    sqlite
      .prepare("UPDATE pharmacy_myna_handoffs SET status='EXPIRED',updated_at=? WHERE id='refresh'")
      .run(now.toISOString());
    expect(work('refresh').work_expires_at).toBe('2026-10-10T00:00:00.000Z');
    expect(state('refresh')).toMatchObject({ state: 'pending' });
    expect(await claimStatusNotificationWork(db, stale, now)).toBeNull();
    const row = work('refresh');
    const token = await claimStatusNotificationWork(db, row, now);
    const renewed = new Date(now.getTime() + 1);
    sqlite.prepare("UPDATE pharmacy_myna_handoffs SET updated_at=? WHERE id='refresh'").run(renewed.toISOString());
    expect(state('refresh')).toMatchObject({
      claim_token: token,
      attempt_count: 1,
      due_at: new Date(now.getTime() + 300_000).toISOString(),
    });
    await finishStatusNotificationWork(db, row, token ?? '', 'sent', now);
    sqlite
      .prepare("UPDATE pharmacy_myna_handoffs SET updated_at=? WHERE id='refresh'")
      .run(new Date(now.getTime() + 2).toISOString());
    expect(state('refresh')).toMatchObject({ state: 'done' });
  });

  it('batches claims and moves a failed head behind later due work', async () => {
    const first = enqueue('first');
    const second = enqueue('second');
    const claims = await claimStatusNotificationWorks(db, [first, second], now);
    expect(claims.every(Boolean)).toBe(true);
    expect(await claimStatusNotificationWorks(db, [first, second], now)).toEqual([null, null]);
    await finishStatusNotificationWork(db, first, claims[0] ?? '', 'failed', now);
    // A third due job is reached without waiting for the failed head.
    enqueue('third');
    expect(
      sqlite
        .prepare(`SELECT source_id FROM pharmacy_status_notification_work
      WHERE kind='myna' AND state='pending' AND due_at <= ? ORDER BY due_at,source_id LIMIT 1`)
        .get(now.toISOString()),
    ).toEqual({ source_id: 'third' });
  });

  it('recovers at the lease boundary and ignores the previous owner completion', async () => {
    const row = enqueue();
    const token = (await claimStatusNotificationWork(db, row, now)) ?? '';
    expect(await claimStatusNotificationWork(db, work(), new Date(now.getTime() + 299_999))).toBeNull();
    const replacement = await claimStatusNotificationWork(db, work(), new Date(now.getTime() + 300_000));
    expect(replacement).toBeTruthy();
    await finishStatusNotificationWork(db, row, token, 'sent', now);
    expect(state()).toMatchObject({ state: 'pending', claim_token: replacement });
    await finishStatusNotificationWork(db, work(), replacement ?? '', 'sent', now);
    expect(state()).toMatchObject({ state: 'done', claim_token: null });
  });

  it('retries failures and lifted suppression on the existing five-minute tick', async () => {
    enqueue();
    let at = now;
    for (const minutes of [5, 5, 5, 5, 5, 5]) {
      const row = work();
      const token = (await claimStatusNotificationWork(db, row, at)) ?? '';
      await finishStatusNotificationWork(db, row, token, 'failed', at);
      at = new Date(at.getTime() + minutes * 60_000);
      expect(state()).toMatchObject({ due_at: at.toISOString(), state: 'pending' });
    }
    const row = work();
    const token = (await claimStatusNotificationWork(db, row, at)) ?? '';
    await finishStatusNotificationWork(db, row, token, 'skipped', at);
    expect(state()).toMatchObject({ due_at: new Date(at.getTime() + 300_000).toISOString() });
  });

  it('includes the exact 72-hour boundary and expires older work without dispatch', async () => {
    const row = enqueue('boundary', 'a', new Date(now.getTime() - 72 * 3600_000).toISOString());
    expect(await claimStatusNotificationWork(db, row, now)).toBeTruthy();
    const stale = enqueue('stale', 'a', new Date(now.getTime() - 72 * 3600_000 - 1).toISOString());
    expect(await claimStatusNotificationWork(db, stale, now)).toBeNull();
    expect(state('stale')).toMatchObject({ state: 'expired' });
  });

  it('settles sent records from either Worker but keeps failed records retryable and account scoped', () => {
    enqueue();
    enqueue('b');
    const insert = sqlite.prepare(`INSERT INTO pharmacy_notification_events
      (id,line_account_id,friend_id,message_id,category,outcome,occurred_at,idempotency_key,created_at)
      VALUES (?, ?, ?, 'myna_handoff_status_v1','transactional_care',?,?,?,?)`);
    insert.run('other', 'account-b', 'friend-b', 'sent', now.toISOString(), 'myna-status:a:EXPIRED', now.toISOString());
    expect(state()).toMatchObject({ state: 'pending' });
    insert.run(
      'failed',
      'account-a',
      'friend-a',
      'failed',
      now.toISOString(),
      'myna-status:a:EXPIRED',
      now.toISOString(),
    );
    expect(state()).toMatchObject({ state: 'pending' });
    sqlite.exec(`UPDATE pharmacy_notification_events SET outcome='sent' WHERE id='failed'`);
    expect(state()).toMatchObject({ state: 'done' });
    insert.run('sent', 'account-a', 'friend-a', 'sent', now.toISOString(), 'myna-status:b:EXPIRED', now.toISOString());
    expect(state('b')).toMatchObject({ state: 'done' });
  });
});
