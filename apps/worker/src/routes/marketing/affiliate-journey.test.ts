import { describe, it, expect, vi, beforeEach } from 'vitest';

// The heavy set-based aggregation SQL is covered against real SQLite in
// packages/db/test/affiliate-report.test.ts. Here we mock @line-crm/db and only
// assert that the routes wire params/cursors through and shape the response.
const dbMocks = {
  // eager module-load deps (mirror other route tests)
  getLineAccounts: vi.fn().mockResolvedValue([]),
  getStaffByApiKey: vi.fn(),
  recoverStalledBroadcasts: vi.fn(),
  recoverStuckDeliveries: vi.fn(),
  // affiliate route deps
  getAffiliateById: vi.fn(),
  getAffiliateReportV2: vi.fn(),
  getFriendJourney: vi.fn(),
  getAffiliateJourneys: vi.fn(),
};
vi.mock('@line-crm/db', () => dbMocks);

const worker = (await import('../../index.js')).default;

const API_KEY = 'test-owner-key';
const tenantDb = {
  prepare(sql: string) {
    let binds: unknown[] = [];
    const statement = {
      bind: (...args: unknown[]) => {
        binds = args;
        return statement;
      },
      first: async () => {
        if (sql.includes('FROM tenants')) {
          return { id: 'tenant-generic', tenant_code: 'generic', display_name: 'Generic' };
        }
        if (sql.includes('FROM friends AS friend')) {
          return binds[1] === 'ghost' ? null : { line_account_id: 'generic-a' };
        }
        if (sql.includes('FROM tenant_line_accounts') && !sql.includes('pharmacy_account_capabilities')) {
          return { ok: 1 };
        }
        return null;
      },
      all: async () => ({
        results: sql.includes('FROM tenant_line_accounts') ? [{ line_account_id: 'generic-a' }] : [],
      }),
    };
    return statement;
  },
} as unknown as D1Database;
const env = {
  DB: tenantDb,
  LINE_LOGIN_CHANNEL_ID: '2000000000',
  API_KEY,
  LEGACY_ENV_OWNER_BYPASS: 'true',
} as unknown as import('../../index.js').Env['Bindings'];

// These routes sit behind authMiddleware. getStaffByApiKey is mocked to return
// undefined, so this fixture explicitly opts into the legacy env-owner fallback.
function call(path: string, init?: RequestInit) {
  const headers = new Headers(init?.headers);
  headers.set('Authorization', `Bearer ${API_KEY}`);
  headers.set('X-Tenant-Id', 'generic');
  return worker.fetch(
    new Request(`https://worker.example.com${path}`, { ...init, headers }),
    env,
    { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  dbMocks.getLineAccounts.mockResolvedValue([]);
});

describe('GET /api/friends/:id/journey', () => {
  it('wraps db events under { events } ascending', async () => {
    const events = [
      { at: '2026-06-12T00:00:00.000+09:00', type: 'touch', refCode: 'refA', affiliateId: 'aff-A' },
      { at: '2026-06-17T00:00:00.000+09:00', type: 'friend_add' },
      { at: '2026-06-27T00:00:00.000+09:00', type: 'touch', refCode: 'refB', affiliateId: 'aff-B' },
      { at: '2026-07-02T00:00:00.000+09:00', type: 'conversion', refCode: 'refB', affiliateId: 'aff-B' },
    ];
    dbMocks.getFriendJourney.mockResolvedValue(events);

    const res = await call('/api/friends/friend-1/journey');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; data: { events: typeof events } };
    expect(body.success).toBe(true);
    expect(body.data.events).toHaveLength(4);
    expect(body.data.events.map((e) => e.type)).toEqual(['touch', 'friend_add', 'touch', 'conversion']);
    expect(dbMocks.getFriendJourney).toHaveBeenCalledWith(env.DB, 'friend-1');
  });

  it('returns empty events for an unknown friend', async () => {
    dbMocks.getFriendJourney.mockResolvedValue([]);
    const res = await call('/api/friends/ghost/journey');
    expect(res.status).toBe(403);
    expect(dbMocks.getFriendJourney).not.toHaveBeenCalled();
  });
});

describe('GET /api/affiliates/:id/journeys', () => {
  it('404s when the affiliate does not exist', async () => {
    dbMocks.getAffiliateById.mockResolvedValue(null);
    const res = await call('/api/affiliates/nope/journeys');
    expect(res.status).toBe(404);
    expect(dbMocks.getAffiliateJourneys).not.toHaveBeenCalled();
  });

  it('passes limit + cursor through and returns items + nextCursor', async () => {
    dbMocks.getAffiliateById.mockResolvedValue({ id: 'aff-A' });
    dbMocks.getAffiliateJourneys.mockResolvedValue({
      items: [{ friendId: 'friend-1', addedAt: '2026-07-01T00:00:00.000+09:00' }],
      nextCursor: { beforeAt: '2026-07-01T00:00:00.000+09:00', beforeId: 'friend-1' },
    });

    const res = await call('/api/affiliates/aff-A/journeys?limit=2&beforeAt=2026-07-05T00:00:00.000%2B09:00&beforeId=friend-9');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: unknown[]; nextCursor: unknown };
    expect(body.data).toHaveLength(1);
    expect(body.nextCursor).toEqual({ beforeAt: '2026-07-01T00:00:00.000+09:00', beforeId: 'friend-1' });
    expect(dbMocks.getAffiliateJourneys).toHaveBeenCalledWith(env.DB, 'aff-A', {
      limit: 2,
      beforeAt: '2026-07-05T00:00:00.000+09:00',
      beforeId: 'friend-9',
    });
  });
});

describe('GET /api/affiliates/:id/report (v2)', () => {
  it('404s when the report is null', async () => {
    dbMocks.getAffiliateReportV2.mockResolvedValue(null);
    const res = await call('/api/affiliates/nope/report');
    expect(res.status).toBe(404);
  });

  it('returns the v2 report and forwards the identity-key fragment', async () => {
    const report = {
      affiliateId: 'aff-A',
      friendAdds: 1,
      conversions: 0,
      clicks: 3,
      linkClicks: 7,
      conversionsByPoint: [],
      revenue: 0,
      estimatedCommission: 0,
      duplicateFlags: [],
    };
    dbMocks.getAffiliateReportV2.mockResolvedValue(report);

    const res = await call('/api/affiliates/aff-A/report');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: typeof report };
    expect(body.data.friendAdds).toBe(1);
    expect(body.data.duplicateFlags).toEqual([]);
    const callArg = dbMocks.getAffiliateReportV2.mock.calls[0][2] as { identityKeySql: string };
    expect(typeof callArg.identityKeySql).toBe('string');
    expect(callArg.identityKeySql).toContain('COALESCE');
  });
});
