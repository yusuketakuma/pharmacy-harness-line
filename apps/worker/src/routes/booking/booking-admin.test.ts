import { describe, expect, test, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../../index.js';

const availabilityMocks = {
  computeSlots: vi.fn(() => [] as { start: string; end: string }[]),
  getAvailability: vi.fn(async (_db: unknown, params: { from: string }) => ({
    by_staff: [{
      staff_id: 's1',
      display_name: 'A',
      slots: availabilityMocks.computeSlots().map((slot) => ({ date: params.from, ...slot })),
    }],
  })),
};
vi.mock('../../services/availability.js', () => availabilityMocks);

const notifierMocks = { sendBookingNotification: vi.fn() };
vi.mock('../../services/booking-notifier.js', () => notifierMocks);

const calendarSyncMocks = {
  verifyStaffCalendarConnection: vi.fn(async () => undefined),
};
vi.mock('../../services/booking-calendar-sync.js', async () => {
  const actual = await vi.importActual<typeof import('../../services/booking-calendar-sync.js')>(
    '../../services/booking-calendar-sync.js',
  );
  return { ...actual, verifyStaffCalendarConnection: calendarSyncMocks.verifyStaffCalendarConnection };
});

const liffAuthMocks = vi.hoisted(() => ({
  verifyCallerLineIdentity: vi.fn(),
}));
vi.mock('../../services/liff-auth.js', () => liffAuthMocks);

const { default: booking, verifyCallerLineUserId } = await import('./booking.js');

function makeApp(db: unknown) {
  const app = new Hono();
  app.route('/', booking);
  return { app, env: { DB: db } };
}

function makeTenantApp(db: unknown) {
  const app = new Hono<Env>();
  app.use('*', async (c, next) => {
    c.set('tenantId', 'tenant-a');
    await next();
  });
  app.route('/', booking);
  return { app, env: { DB: db } as Env['Bindings'] };
}

const emptyDb = {
  prepare: () => ({
    bind: () => ({
      first: async () => null,
      all: async () => ({ results: [] }),
      run: async () => ({ meta: { changes: 0 } }),
    }),
  }),
};

describe('LIFF booking identity scope', () => {
  test('accepts only an identity bound to the requested account', async () => {
    const context = {
      req: { header: () => 'Bearer token' },
      env: { DB: emptyDb },
    } as never;
    liffAuthMocks.verifyCallerLineIdentity.mockResolvedValueOnce({
      lineUserId: 'U-a', loginChannelId: 'login-a', lineAccountId: 'account-a', tenantId: 'tenant-a',
    });
    await expect(verifyCallerLineUserId(context, 'account-b')).resolves.toBeNull();

    liffAuthMocks.verifyCallerLineIdentity.mockResolvedValueOnce({
      lineUserId: 'U-a', loginChannelId: 'login-a', lineAccountId: 'account-a', tenantId: 'tenant-a',
    });
    await expect(verifyCallerLineUserId(context, 'account-a')).resolves.toBe('U-a');
  });
});

describe('GET /api/booking/admin/menus/:id/staff', () => {
  test('400 without account_id', async () => {
    const { app, env } = makeApp(emptyDb);
    const res = await app.request('/api/booking/admin/menus/m1/staff', {}, env);
    expect(res.status).toBe(400);
  });

  test('200 with staff list', async () => {
    const db = {
      prepare: () => ({
        bind: () => ({
          all: async () => ({ results: [{ id: 's1', display_name: 'スタッフA' }] }),
        }),
      }),
    };
    const { app, env } = makeApp(db);
    const res = await app.request('/api/booking/admin/menus/m1/staff?account_id=acc1', {}, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { staff: unknown[] };
    expect(body.staff).toHaveLength(1);
  });
});

describe('GET /api/booking/admin/availability', () => {
  test('400 without params', async () => {
    const { app, env } = makeApp(emptyDb);
    const res = await app.request('/api/booking/admin/availability?account_id=acc1', {}, env);
    expect(res.status).toBe(400);
  });

  test('200 delegates to getAvailability with minLeadTimeMinutes 0', async () => {
    const { app, env } = makeApp(emptyDb);
    const res = await app.request(
      '/api/booking/admin/availability?account_id=acc1&menu_id=m1&from=2026-07-08&to=2026-07-14',
      {},
      env,
    );
    expect(res.status).toBe(200);
    expect(availabilityMocks.getAvailability).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ lineAccountId: 'acc1', menuId: 'm1', minLeadTimeMinutes: 0 }),
    );
  });

  test('400 when range wider than 28 days', async () => {
    const { app, env } = makeApp(emptyDb);
    const res = await app.request(
      '/api/booking/admin/availability?account_id=acc1&menu_id=m1&from=2026-07-01&to=2026-08-15',
      {},
      env,
    );
    expect(res.status).toBe(400);
  });
});

// ----------------------------------------------------------------
// POST /api/booking/admin/bookings

type Handler = {
  first?: unknown;
  all?: { results: unknown[] };
  run?: { meta: { changes: number } };
};

// SQL 断片マッチで応答を返す scripted D1。マッチしない SQL は空応答。
function scriptedDb(handlers: [string, Handler][]) {
  const calls: { sql: string; params: unknown[] }[] = [];
  return {
    calls,
    prepare(sql: string) {
      return {
        bind(...params: unknown[]) {
          calls.push({ sql, params });
          const h = handlers.find(([frag]) => sql.includes(frag))?.[1] ?? {};
          return {
            first: async () => h.first ?? null,
            all: async () => h.all ?? { results: [] },
            run: async () => h.run ?? { meta: { changes: 0 } },
          };
        },
      };
    },
    async batch(stmts: unknown[]) {
      return stmts;
    },
  };
}

const execCtx = {
  waitUntil: () => undefined,
  passThroughOnException: () => undefined,
} as unknown as ExecutionContext;

describe('POST /api/booking/admin/bookings', () => {
  // Always 7 days in the future at 02:00Z (= JST 11:00, inside the mocked
  // 10:00-19:00 shift). A fixed date here becomes a time bomb: the route
  // rejects past slots with 422 once the calendar catches up.
  const futureStartsAt = (() => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + 7);
    d.setUTCHours(2, 0, 0, 0);
    return d.toISOString();
  })();
  const validBody = {
    friend_id: 'f1',
    menu_id: 'm1',
    staff_id: 's1',
    starts_at: futureStartsAt, // JST 11:00
  };

  function happyDb(insertChanges = 1) {
    return scriptedDb([
      ['FROM friends', { first: { id: 'f1', is_following: 1 } }],
      ['FROM staff WHERE', { first: { ok: 1 } }],
      [
        'FROM menus m',
        {
          first: {
            duration_minutes: 60,
            buffer_after_minutes: 10,
            dur: 60,
            price: 8000,
            is_offered: 1,
          },
        },
      ],
      ['FROM staff_shifts', { first: { start_time: '10:00', end_time: '19:00' } }],
      ['SELECT starts_at, block_ends_at FROM bookings', { all: { results: [] } }],
      ['INSERT INTO bookings', { run: { meta: { changes: insertChanges } } }],
    ]);
  }

  test('400 without account_id', async () => {
    const { app, env } = makeApp(emptyDb);
    const res = await app.request(
      '/api/booking/admin/bookings',
      {
        method: 'POST',
        body: JSON.stringify(validBody),
        headers: { 'Content-Type': 'application/json' },
      },
      env,
      execCtx,
    );
    expect(res.status).toBe(400);
  });

  test('404 when friend not found', async () => {
    const db = scriptedDb([['FROM friends', { first: null }]]);
    const { app, env } = makeApp(db);
    const res = await app.request(
      '/api/booking/admin/bookings?account_id=acc1',
      {
        method: 'POST',
        body: JSON.stringify(validBody),
        headers: { 'Content-Type': 'application/json' },
      },
      env,
      execCtx,
    );
    expect(res.status).toBe(404);
  });

  test('201 creates confirmed booking and inserts reminders', async () => {
    availabilityMocks.computeSlots.mockReturnValue([{ start: '11:00', end: '12:00' }]);
    const db = happyDb();
    const { app, env } = makeApp(db);
    const res = await app.request(
      '/api/booking/admin/bookings?account_id=acc1',
      {
        method: 'POST',
        body: JSON.stringify(validBody),
        headers: { 'Content-Type': 'application/json' },
      },
      env,
      execCtx,
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { booking_id: string; status: string };
    expect(body.status).toBe('confirmed');
    const insert = db.calls.find((c) => c.sql.includes('INSERT INTO bookings'));
    expect(insert?.params).toContain('confirmed');
    // booking_reminders INSERT が走っている(未来の予約なので day_before + hours_before)
    const reminders = db.calls.filter((c) => c.sql.includes('INSERT INTO booking_reminders'));
    expect(reminders.length).toBeGreaterThan(0);
  });

  test('resolves notification scope from the persisted booking before sending', async () => {
    availabilityMocks.computeSlots.mockReturnValue([{ start: '11:00', end: '12:00' }]);
    notifierMocks.sendBookingNotification.mockResolvedValue(undefined);
    const notification = {
      starts_at: futureStartsAt,
      line_account_id: 'acc1',
      friend_id: 'f1',
      tenant_id: 'tenant-a',
      menu_name: 'カット',
      staff_name: 'スタッフA',
      channel_access_token: 'token',
      line_user_id: 'U1',
    };
    const db = scriptedDb([
      ['FROM friends', { first: { id: 'f1', is_following: 1 } }],
      ['FROM staff WHERE', { first: { ok: 1 } }],
      ['FROM menus m', { first: {
        duration_minutes: 60,
        buffer_after_minutes: 10,
        dur: 60,
        price: 8000,
        is_offered: 1,
      } }],
      ['FROM staff_shifts', { first: { start_time: '10:00', end_time: '19:00' } }],
      ['SELECT starts_at, block_ends_at FROM bookings', { all: { results: [] } }],
      ['INSERT INTO bookings', { run: { meta: { changes: 1 } } }],
      ['SELECT b.starts_at', { first: notification }],
    ]);
    const pending: Promise<unknown>[] = [];
    const notificationCtx = {
      waitUntil(promise: Promise<unknown>) { pending.push(promise); },
      passThroughOnException() {},
    } as unknown as ExecutionContext;
    const { app, env } = makeApp(db);

    const res = await app.request(
      '/api/booking/admin/bookings?account_id=acc1',
      {
        method: 'POST',
        body: JSON.stringify(validBody),
        headers: { 'Content-Type': 'application/json' },
      },
      env,
      notificationCtx,
    );
    await Promise.all(pending);

    expect(res.status).toBe(201);
    expect(notifierMocks.sendBookingNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        db,
        tenantId: 'tenant-a',
        lineAccountId: 'acc1',
        friendId: 'f1',
      }),
    );
    const scopeQuery = db.calls.find((call) => call.sql.includes('SELECT b.starts_at'))?.sql ?? '';
    expect(scopeQuery).toContain('tenant_line_accounts');
    expect(scopeQuery).toContain("tenant.status = 'active'");
    expect(scopeQuery).toContain('m.line_account_id = b.line_account_id');
    expect(scopeQuery).toContain('s.line_account_id = b.line_account_id');
    expect(scopeQuery).toContain('f.line_account_id = b.line_account_id');
  });

  test('409 on slot conflict (atomic insert 0 rows)', async () => {
    availabilityMocks.computeSlots.mockReturnValue([{ start: '11:00', end: '12:00' }]);
    const db = happyDb(0);
    const { app, env } = makeApp(db);
    const res = await app.request(
      '/api/booking/admin/bookings?account_id=acc1',
      {
        method: 'POST',
        body: JSON.stringify(validBody),
        headers: { 'Content-Type': 'application/json' },
      },
      env,
      execCtx,
    );
    expect(res.status).toBe(409);
  });

  test('422 when slot not in availability', async () => {
    availabilityMocks.computeSlots.mockReturnValue([{ start: '14:00', end: '15:00' }]);
    const db = happyDb();
    const { app, env } = makeApp(db);
    const res = await app.request(
      '/api/booking/admin/bookings?account_id=acc1',
      {
        method: 'POST',
        body: JSON.stringify(validBody),
        headers: { 'Content-Type': 'application/json' },
      },
      env,
      execCtx,
    );
    expect(res.status).toBe(422);
  });

  test('404 when staff belongs to another account', async () => {
    availabilityMocks.computeSlots.mockReturnValue([{ start: '11:00', end: '12:00' }]);
    // friend exists, but the staff-in-account assertion returns no row.
    const db = scriptedDb([
      ['FROM friends', { first: { id: 'f1', is_following: 1 } }],
      ['FROM staff WHERE', { first: null }],
    ]);
    const { app, env } = makeApp(db);
    const res = await app.request(
      '/api/booking/admin/bookings?account_id=acc1',
      {
        method: 'POST',
        body: JSON.stringify(validBody),
        headers: { 'Content-Type': 'application/json' },
      },
      env,
      execCtx,
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('staff_not_found');
  });

  test('server-side availability recheck receives the correct September JST date', async () => {
    availabilityMocks.computeSlots.mockReturnValue([{ start: '11:00', end: '12:00' }]);
    const db = happyDb();
    const { app, env } = makeApp(db);
    // September exercises the old `.replace('-09', ...)` mangling bug, but the
    // year must stay in the future (past slots are rejected with 422 before the
    // window query runs) — pick this year's Sep 10 or next year's once passed.
    const now = new Date();
    const sepYear =
      now.getTime() < Date.UTC(now.getUTCFullYear(), 8, 1) // before Sep 1
        ? now.getUTCFullYear()
        : now.getUTCFullYear() + 1;
    const res = await app.request(
      '/api/booking/admin/bookings?account_id=acc1',
      {
        method: 'POST',
        body: JSON.stringify({ ...validBody, starts_at: `${sepYear}-09-10T02:00:00.000Z` }),
        headers: { 'Content-Type': 'application/json' },
      },
      env,
      execCtx,
    );
    expect(res.status).toBe(201);
    expect(availabilityMocks.getAvailability).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ from: `${sepYear}-09-10`, to: `${sepYear}-09-10` }),
    );
  });
});

describe('jstDayWindowUtc', () => {
  test('July date: bounds cover the full JST calendar day', async () => {
    const { jstDayWindowUtc } = await import('./booking.js');
    const w = jstDayWindowUtc('2026-07-10');
    expect(w.startUtc).toBe('2026-07-09T15:00:00.000Z');
    expect(w.endUtc).toBe('2026-07-10T15:00:00Z');
  });

  test('September/November dates are not corrupted', async () => {
    const { jstDayWindowUtc } = await import('./booking.js');
    expect(jstDayWindowUtc('2026-09-10').startUtc).toBe('2026-09-09T15:00:00.000Z');
    expect(jstDayWindowUtc('2026-11-09').startUtc).toBe('2026-11-08T15:00:00.000Z');
  });
});

describe('legacy Google Calendar admin tenant scope', () => {
  test('tenant A cannot read/update/delete tenant B and new connections store tenant A', async () => {
    const calls: { sql: string; params: unknown[] }[] = [];
    const connections = new Map([
      ['connection-b', {
        id: 'connection-b',
        tenant_id: 'tenant-b',
        line_account_id: 'account-b',
        staff_id: 'staff-b',
        auth_type: 'service_account',
        access_token: null,
        refresh_token: null,
      }],
    ]);
    const db = {
      calls,
      prepare(sql: string) {
        let params: unknown[] = [];
        const statement = {
          bind(...bound: unknown[]) {
            params = bound;
            calls.push({ sql, params });
            return statement;
          },
          async first() {
            const tenantId = params.find((value) => String(value).startsWith('tenant-'));
            const accountId = params.find((value) => String(value).startsWith('account-'));
            const staffId = params.find((value) => String(value).startsWith('staff-'));
            if (sql.includes('FROM staff')) {
              if (tenantId) {
                return tenantId === 'tenant-a' && accountId === 'account-a' && staffId === 'staff-a'
                  ? { ok: 1 }
                  : null;
              }
              return accountId === 'account-a' && staffId === 'staff-a' ||
                accountId === 'account-b' && staffId === 'staff-b'
                ? { ok: 1 }
                : null;
            }
            if (sql.includes('FROM tenant_line_accounts')) {
              return tenantId === 'tenant-a' && accountId === 'account-a' ? { ok: 1 } : null;
            }
            if (sql.includes('FROM google_calendar_connections')) {
              const connection = [...connections.values()].find((candidate) =>
                candidate.line_account_id === accountId && candidate.staff_id === staffId &&
                (!tenantId || candidate.tenant_id === tenantId));
              return connection ?? null;
            }
            return null;
          },
          async all() { return { results: [] }; },
          async run() { return { meta: { changes: 1 } }; },
        };
        return statement;
      },
    };
    const { app, env } = makeTenantApp(db);

    const foreignGet = await app.request(
      '/api/booking/admin/staff/staff-b/google-calendar?account_id=account-b', {}, env,
    );
    const foreignPut = await app.request(
      '/api/booking/admin/staff/staff-b/google-calendar?account_id=account-b', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ calendar_id: 'calendar-b' }),
      }, env);
    const foreignDelete = await app.request(
      '/api/booking/admin/staff/staff-b/google-calendar?account_id=account-b', {
        method: 'DELETE',
      }, env);

    expect(foreignGet.status).toBe(404);
    expect(foreignPut.status).toBe(404);
    expect(foreignDelete.status).toBe(404);
    expect(calls.filter(({ sql, params }) =>
      sql.includes('google_calendar_connections') && params.includes('account-b'))).toHaveLength(0);

    const ownPut = await app.request(
      '/api/booking/admin/staff/staff-a/google-calendar?account_id=account-a', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ calendar_id: 'calendar-a' }),
      }, env);

    expect(ownPut.status).toBe(200);
    const insert = calls.find(({ sql }) => sql.includes('INSERT INTO google_calendar_connections'));
    expect(insert?.sql).toContain('tenant_id');
    expect(insert?.params).toEqual(expect.arrayContaining(['tenant-a', 'account-a', 'staff-a']));
  });
});
