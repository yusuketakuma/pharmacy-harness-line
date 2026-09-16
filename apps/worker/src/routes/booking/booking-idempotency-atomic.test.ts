import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { DB_PACKAGE_ROOT, Sqlite, d1FromSqlite } from '../../custom/pharmacy/test-sqlite.js';
import { findIdempotencyResponse, saveIdempotencyResponse } from '../../services/booking-idempotency.js';

const mocks = vi.hoisted(() => ({
  mileage: vi.fn(async () => undefined),
  identity: vi.fn(async () => ({ lineUserId: 'user-a', lineAccountId: 'account-a' })),
  availability: vi.fn(async () => ({ by_staff: [{ slots: [{ date: '2099-01-01', start: '10:00' }] }] })),
}));
vi.mock('./liff-account.js', () => ({
  resolveActiveLineAccountIdByLiffId: async (_db: unknown, liffId: string) =>
    liffId === 'synthetic-b' ? 'account-b' : 'account-a',
}));
vi.mock('../../services/liff-auth.js', () => ({ verifyCallerLineIdentity: mocks.identity }));
vi.mock('../../services/activity-mileage.js', () => ({ awardActivityMileage: mocks.mileage }));
vi.mock('../../services/availability.js', () => ({ getAvailability: mocks.availability }));

import booking from './booking.js';

describe('LIFF booking result durability', () => {
  it('rolls back the booking if its success receipt cannot be written, then retries once', async () => {
    const sqlite = new Sqlite(':memory:');
    mocks.mileage.mockClear();
    mocks.availability.mockClear();
    try {
      sqlite.pragma('foreign_keys = ON');
      sqlite.exec(readFileSync(join(DB_PACKAGE_ROOT, 'bootstrap.sql'), 'utf8'));
      sqlite.prepare(`INSERT INTO line_accounts (id, channel_id, name, channel_access_token, channel_secret)
        VALUES ('account-a','channel-a','Synthetic','synthetic-token','synthetic-secret')`).run();
      sqlite.prepare(`INSERT INTO friends (id, line_user_id, provider_line_user_id, line_account_id)
        VALUES ('friend-a','line-user-a','user-a','account-a')`).run();
      sqlite.prepare(`INSERT INTO staff (id, line_account_id, name, display_name)
        VALUES ('staff-a','account-a','Staff','Staff')`).run();
      sqlite.prepare(`INSERT INTO menus (id, line_account_id, name, duration_minutes, base_price)
        VALUES ('menu-a','account-a','Menu',60,1000)`).run();
      sqlite.prepare(`INSERT INTO staff_menus (staff_id, menu_id) VALUES ('staff-a','menu-a')`).run();

      const base = d1FromSqlite(sqlite);
      let failReceipt = true;
      let hideCacheBeforeAvailability = false;
      const db = {
        ...base,
        prepare(sql: string) {
          // better-sqlite3 binds ?1/?2 differently from D1's positional bind.
          const positions = [...sql.matchAll(/\?(\d+)/g)].map((match) => Number(match[1]) - 1);
          const prepared = base.prepare(positions.length ? sql.replace(/\?\d+/g, '?') : sql);
          return {
            ...prepared,
            bind(...args: unknown[]) {
              const bound = prepared.bind(...(positions.length ? positions.map((index) => args[index]) : args));
              if (sql.includes('SELECT response_status, response_body, expires_at')) {
                return { ...bound, async first() {
                  if (hideCacheBeforeAvailability) return null;
                  return bound.first();
                } };
              }
              if (!sql.includes('INSERT INTO booking_idempotency_scoped')) return bound;
              return { ...bound, async run() {
                if (failReceipt) { failReceipt = false; throw new Error('synthetic receipt failure'); }
                return bound.run();
              } };
            },
          };
        },
        batch(statements: D1PreparedStatement[]) {
          if (failReceipt && statements.some((item) =>
            (item as unknown as { __sql?: string }).__sql?.includes('INSERT INTO booking_idempotency_scoped'))) {
            failReceipt = false;
            const poisoned = statements.map((item) =>
              (item as unknown as { __sql?: string }).__sql?.includes('INSERT INTO booking_idempotency_scoped')
                ? base.prepare('INSERT INTO missing_receipt_table VALUES (1)') : item);
            return base.batch(poisoned);
          }
          return base.batch(statements);
        },
      } as D1Database;
      const app = new Hono();
      app.route('/', booking);
      const pending: Promise<unknown>[] = [];
      const request = (key = 'same-key', staffId = 'staff-a', accountId = 'account-a') => app.fetch(new Request(`https://example.invalid/api/liff/booking/requests?liffId=${accountId === 'account-b' ? 'synthetic-b' : 'synthetic'}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'Idempotency-Key': key, Authorization: 'Bearer synthetic' },
        body: JSON.stringify({ menu_id: accountId === 'account-b' ? 'menu-b' : 'menu-a', staff_id: staffId, starts_at: '2099-01-01T01:00:00.000Z' }),
      }), { DB: db } as never, { waitUntil: (promise: Promise<unknown>) => pending.push(promise) } as never);

      expect((await request()).status).toBe(500);
      expect(sqlite.prepare('SELECT COUNT(*) AS count FROM bookings').get()).toEqual({ count: 0 });
      const retry = await request();
      expect(retry.status).toBe(201);
      const body = await retry.json() as { booking_id: string };
      expect(sqlite.prepare('SELECT id FROM bookings').get()).toEqual({ id: body.booking_id });
      expect(JSON.parse((sqlite.prepare(`SELECT response_body FROM booking_idempotency_keys WHERE key = 'same-key'`)
        .get() as { response_body: string }).response_body)).toEqual(body);
      expect((await request()).status).toBe(201);
      expect(sqlite.prepare('SELECT COUNT(*) AS count FROM bookings').get()).toEqual({ count: 1 });
      hideCacheBeforeAvailability = true;
      mocks.availability.mockImplementationOnce(async () => {
        hideCacheBeforeAvailability = false;
        return { by_staff: [{ slots: [] }] };
      });
      const racedRetry = await request();
      expect(racedRetry.status).toBe(201);
      expect((await racedRetry.json() as { booking_id: string }).booking_id).toBe(body.booking_id);
      expect((await request('other-key')).status).toBe(409);
      expect((await request('other-key')).status).toBe(409);
      sqlite.prepare(`INSERT INTO friends (id, line_user_id, provider_line_user_id, line_account_id)
        VALUES ('friend-b','line-user-b','user-b','account-a')`).run();
      mocks.identity.mockResolvedValueOnce({ lineUserId: 'user-b', lineAccountId: 'account-a' });
      const otherCaller = await request('overlap-key');
      expect(otherCaller.status).toBe(409);
      expect(await otherCaller.json()).toEqual({ error: 'slot_conflict' });
      expect(sqlite.prepare('SELECT COUNT(*) AS count FROM bookings').get()).toEqual({ count: 1 });
      sqlite.prepare(`INSERT INTO staff (id, line_account_id, name, display_name)
        VALUES ('staff-b','account-a','Staff B','Staff B')`).run();
      sqlite.prepare(`INSERT INTO staff_menus (staff_id, menu_id) VALUES ('staff-b','menu-a')`).run();
      failReceipt = true;
      mocks.identity.mockResolvedValueOnce({ lineUserId: 'user-b', lineAccountId: 'account-a' });
      expect((await request('same-key', 'staff-b')).status).toBe(500);
      expect(sqlite.prepare('SELECT COUNT(*) AS count FROM bookings').get()).toEqual({ count: 1 });
      mocks.identity.mockResolvedValueOnce({ lineUserId: 'user-b', lineAccountId: 'account-a' });
      const independent = await request('same-key', 'staff-b');
      expect(independent.status).toBe(201);
      const independentBody = await independent.json() as { booking_id: string };
      expect(independentBody.booking_id).not.toBe(body.booking_id);
      expect(JSON.parse((sqlite.prepare(`SELECT response_body FROM booking_idempotency_scoped
        WHERE key = 'same-key' AND line_account_id = 'account-a' AND friend_id = 'friend-b'`)
        .get() as { response_body: string }).response_body)).toEqual(independentBody);
      mocks.identity.mockResolvedValueOnce({ lineUserId: 'user-b', lineAccountId: 'account-a' });
      expect(await (await request('same-key', 'staff-b')).json()).toEqual(independentBody);
      expect(await (await request()).json()).toEqual(body);
      expect(sqlite.prepare('SELECT COUNT(*) AS count FROM bookings').get()).toEqual({ count: 2 });
      sqlite.prepare(`INSERT INTO line_accounts (id, channel_id, name, channel_access_token, channel_secret)
        VALUES ('account-b','channel-b','Synthetic B','synthetic-token','synthetic-secret')`).run();
      sqlite.prepare(`INSERT INTO friends (id, line_user_id, provider_line_user_id, line_account_id)
        VALUES ('friend-c','line-user-c','user-c','account-b')`).run();
      sqlite.prepare(`INSERT INTO staff (id, line_account_id, name, display_name)
        VALUES ('staff-c','account-b','Staff C','Staff C')`).run();
      sqlite.prepare(`INSERT INTO menus (id, line_account_id, name, duration_minutes, base_price)
        VALUES ('menu-b','account-b','Menu B',60,1000)`).run();
      sqlite.prepare(`INSERT INTO staff_menus (staff_id, menu_id) VALUES ('staff-c','menu-b')`).run();
      mocks.identity.mockResolvedValueOnce({ lineUserId: 'user-c', lineAccountId: 'account-b' });
      const otherAccount = await request('same-key', 'staff-c', 'account-b');
      expect(otherAccount.status).toBe(201);
      const otherAccountBody = await otherAccount.json() as { booking_id: string };
      mocks.identity.mockResolvedValueOnce({ lineUserId: 'user-c', lineAccountId: 'account-b' });
      expect(await (await request('same-key', 'staff-c', 'account-b')).json()).toEqual(otherAccountBody);
      expect(await (await request()).json()).toEqual(body);
      expect(sqlite.prepare('SELECT COUNT(*) AS count FROM bookings').get()).toEqual({ count: 3 });
      await Promise.all(pending);
      expect(mocks.mileage).toHaveBeenCalledTimes(3);

      sqlite.prepare('DELETE FROM bookings').run();
      const concurrent = await Promise.all([request('concurrent-key'), request('concurrent-key')]);
      expect(concurrent.map((response) => response.status)).toEqual([201, 201]);
      const returned = await Promise.all(concurrent.map((response) => response.json() as Promise<{ booking_id: string }>));
      expect(returned[0].booking_id).toBe(returned[1].booking_id);
      expect(sqlite.prepare('SELECT COUNT(*) AS count FROM bookings').get()).toEqual({ count: 1 });
      await Promise.all(pending);
      expect(mocks.mileage).toHaveBeenCalledTimes(4);
      const scopedExpiry = (sqlite.prepare(`SELECT expires_at FROM booking_idempotency_scoped
        WHERE key = 'same-key' AND line_account_id = 'account-a' AND friend_id = 'friend-a'`)
        .get() as { expires_at: string }).expires_at;
      sqlite.prepare(`UPDATE booking_idempotency_keys SET expires_at = '2000-01-01T00:00:00.000Z'
        WHERE key = 'same-key'`).run();
      expect(await findIdempotencyResponse(db, {
        key: 'same-key', lineAccountId: 'account-a', friendId: 'friend-a',
        now: new Date(Date.parse(scopedExpiry) - 1),
      })).toEqual({ status: 201, body });
      expect(await findIdempotencyResponse(db, {
        key: 'same-key', lineAccountId: 'account-a', friendId: 'friend-a',
        now: new Date(scopedExpiry),
      })).toBeNull();
      await saveIdempotencyResponse(db, {
        key: 'previous-worker-key', lineAccountId: 'account-a', friendId: 'friend-a',
        status: 201, body: { booking_id: 'previous-worker-booking' },
        ttlMinutes: 5, now: new Date(),
      });
      expect(await findIdempotencyResponse(db, {
        key: 'previous-worker-key', lineAccountId: 'account-a', friendId: 'friend-a', now: new Date(),
      })).toEqual({ status: 201, body: { booking_id: 'previous-worker-booking' } });
    } finally {
      sqlite.close();
    }
  });

  async function collisionFixture() {
    const sqlite = new Sqlite(':memory:');
    sqlite.pragma('foreign_keys = ON');
    sqlite.exec(readFileSync(join(DB_PACKAGE_ROOT, 'bootstrap.sql'), 'utf8'));
    for (const account of ['a', 'b']) {
      sqlite.prepare(`INSERT INTO line_accounts (id, channel_id, name, channel_access_token, channel_secret)
        VALUES (?, ?, 'Synthetic', 'synthetic-token', 'synthetic-secret')`).run(`account-${account}`, `channel-${account}`);
      sqlite.prepare(`INSERT INTO friends (id, line_user_id, provider_line_user_id, line_account_id)
        VALUES (?, ?, ?, ?)`).run(`friend-${account}`, `line-${account}`, `user-${account}`, `account-${account}`);
      sqlite.prepare(`INSERT INTO menus (id, line_account_id, name, duration_minutes, base_price)
        VALUES (?, ?, 'Menu', 60, 1000)`).run(`menu-${account}`, `account-${account}`);
    }
    for (const [staff, account] of [['a1', 'a'], ['a2', 'a'], ['a3', 'a'], ['b1', 'b']]) {
      sqlite.prepare(`INSERT INTO staff (id, line_account_id, name, display_name)
        VALUES (?, ?, 'Staff', 'Staff')`).run(`staff-${staff}`, `account-${account}`);
      sqlite.prepare(`INSERT INTO staff_menus (staff_id, menu_id) VALUES (?, ?)`)
        .run(`staff-${staff}`, `menu-${account}`);
    }
    const app = new Hono();
    app.route('/', booking);
    const pending: Promise<unknown>[] = [];
    const base = d1FromSqlite(sqlite);
    const db = {
      ...base,
      prepare(sql: string) {
        const positions = [...sql.matchAll(/\?(\d+)/g)].map((match) => Number(match[1]) - 1);
        const prepared = base.prepare(positions.length ? sql.replace(/\?\d+/g, '?') : sql);
        return {
          ...prepared,
          bind(...args: unknown[]) {
            return prepared.bind(...(positions.length ? positions.map((index) => args[index]) : args));
          },
        };
      },
    } as D1Database;
    const request = (key: string, staff: string, account: 'a' | 'b' = 'a') => {
      mocks.identity.mockResolvedValueOnce({ lineUserId: `user-${account}`, lineAccountId: `account-${account}` });
      return app.fetch(new Request(`https://example.invalid/api/liff/booking/requests?liffId=${account === 'a' ? 'synthetic' : 'synthetic-b'}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'Idempotency-Key': key, Authorization: 'Bearer synthetic' },
        body: JSON.stringify({ menu_id: `menu-${account}`, staff_id: `staff-${staff}`, starts_at: '2099-01-01T01:00:00.000Z' }),
      }), { DB: db } as never, { waitUntil: (promise: Promise<unknown>) => pending.push(promise) } as never);
    };
    const oldScopedKey = async (key: string) => {
      const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(['account-a', 'friend-a', key])));
      return `booking:v2:${Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
    };
    return { sqlite, request, pending, oldScopedKey };
  }

  it('keeps a raw key distinct from another request’s former internal key', async () => {
    const { sqlite, request, pending, oldScopedKey } = await collisionFixture();
    try {
      const first = await request('ordinary-key', 'a1');
      expect(first.status).toBe(201);
      const firstBody = await first.json() as { booking_id: string };
      const second = await request(await oldScopedKey('ordinary-key'), 'a2');
      expect(second.status).toBe(201);
      expect((await second.json() as { booking_id: string }).booking_id).not.toBe(firstBody.booking_id);
      expect(sqlite.prepare('SELECT COUNT(*) AS count FROM bookings').get()).toEqual({ count: 2 });
      await Promise.all(pending);
    } finally {
      sqlite.close();
    }
  });

  it('cannot leave a booking without its receipt when another caller owns a colliding raw key', async () => {
    const { sqlite, request, pending, oldScopedKey } = await collisionFixture();
    try {
      const rawCollision = await request(await oldScopedKey('target-key'), 'b1', 'b');
      expect(rawCollision.status).toBe(201);
      const target = await request('target-key', 'a3');
      expect(target.status).toBe(201);
      const targetBody = await target.json() as { booking_id: string };
      expect(await (await request('target-key', 'a3')).json()).toEqual(targetBody);
      expect(sqlite.prepare('SELECT COUNT(*) AS count FROM bookings').get()).toEqual({ count: 2 });
      await Promise.all(pending);
    } finally {
      sqlite.close();
    }
  });
});
