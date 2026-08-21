import { describe, it, expect, vi, beforeEach } from 'vitest';

// friend_add auto-enroll gating on GET /auth/callback (LIFF/OAuth path).
//
// The friend_scenarios partial UNIQUE only blocks non-completed enrollments
// (WHERE status != 'completed'), so an existing friend with a completed
// enrollment would get re-enrolled — and the welcome sequence re-sent — every
// time they re-run OAuth login (e.g. via a form link). Re-sends on actual
// re-adds (unblock → follow) are the follow webhook's job, so the OAuth path
// must only enroll friends with no enrollment history for the scenario. It
// must NOT gate on "friend row is new": friends whose row was created without
// a follow event (message-first via ensureFriendFromWebhookUser, migrated
// bases, webhook partial failure) still rely on this path as their only
// friend_add entry.
//
// Cases:
//   - new friend → enrolls in active friend_add scenarios
//   - existing friend with a prior (completed) enrollment → does NOT enroll
//   - existing friend with NO enrollment history → enrolls (catch-up)

const dbMocks = {
  // eager module-load deps
  getLineAccounts: vi.fn().mockResolvedValue([]),
  getStaffByApiKey: vi.fn(),
  recoverStalledBroadcasts: vi.fn(),
  recoverStuckDeliveries: vi.fn(),
  // /auth/callback deps
  getFriendByLineUserId: vi.fn(),
  upsertFriend: vi.fn(),
  createUser: vi.fn().mockResolvedValue({ id: 'U-uuid' }),
  getUserByEmail: vi.fn().mockResolvedValue(null),
  linkFriendToUser: vi.fn().mockResolvedValue(undefined),
  getEntryRouteByRefCode: vi.fn().mockResolvedValue(null),
  recordRefTracking: vi.fn().mockResolvedValue(undefined),
  getTrackedLinkById: vi.fn().mockResolvedValue(null),
  getMessageTemplateById: vi.fn().mockResolvedValue(null),
  getAffiliateLinkByRefCode: vi.fn().mockResolvedValue(null),
  getAffiliateOfferById: vi.fn().mockResolvedValue(null),
  getAffiliateById: vi.fn().mockResolvedValue(null),
  addTagToFriend: vi.fn().mockResolvedValue(undefined),
  getLineAccountByChannelId: vi.fn().mockResolvedValue(null),
  getLineAccountById: vi.fn().mockResolvedValue(null),
  getScenariosForAccount: vi.fn().mockResolvedValue([]),
  enrollFriendInScenario: vi.fn().mockResolvedValue(null),
  getScenarioSteps: vi.fn().mockResolvedValue([]),
  computeNextDeliveryAt: vi.fn(),
  resolveStepContent: vi.fn(),
  getTrafficPoolBySlug: vi.fn().mockResolvedValue(null),
  getTrafficPoolById: vi.fn().mockResolvedValue(null),
  getRandomPoolAccount: vi.fn().mockResolvedValue(null),
  getPoolAccounts: vi.fn().mockResolvedValue([]),
  jstNow: () => '2026-07-19 00:00:00',
};
vi.mock('@line-crm/db', () => dbMocks);

const pushImmediateFirstStep = vi.fn().mockResolvedValue(true);
vi.mock('../services/immediate-first-step.js', () => ({ pushImmediateFirstStep }));

const pharmacyAccessMocks = vi.hoisted(() => ({
  isPharmacyModeAccount: vi.fn(
    async (_db: D1Database, _lineAccountId: string | null | undefined) => false,
  ),
  hasPharmacyModeAccount: vi.fn(async (_db: D1Database) => false),
}));
vi.mock('../custom/pharmacy/growth-loop/access.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../custom/pharmacy/growth-loop/access.js')>()),
  ...pharmacyAccessMocks,
}));

const worker = (await import('../index.js')).default;

// Prepared-statement stub. Raw statements are no-ops except the
// friend_scenarios existence probe, which answers from `priorEnrollment` so
// tests can simulate a friend with/without enrollment history.
let priorEnrollment: { id: string } | null = null;
const DB = {
  prepare: (sql: string) => ({
    bind: () => ({
      run: async () => ({ meta: { changes: 0 } }),
      first: async () => (sql.includes('FROM friend_scenarios') ? priorEnrollment : null),
      all: async () => ({ results: [] }),
    }),
    run: async () => ({ meta: { changes: 0 } }),
    first: async () => null,
    all: async () => ({ results: [] }),
  }),
} as unknown as D1Database;

const env = {
  DB,
  LIFF_URL: 'https://liff.line.me/1000000000-DefaultAA',
  WORKER_URL: 'https://worker.example.com',
  LINE_LOGIN_CHANNEL_ID: '2000000000',
  LINE_LOGIN_CHANNEL_SECRET: 'secret',
  LINE_CHANNEL_ACCESS_TOKEN: 'env-token',
} as unknown as import('../index.js').Env['Bindings'];

function installFetchMock() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url === 'https://api.line.me/oauth2/v2.1/token') {
        return new Response(
          JSON.stringify({ access_token: 'at', id_token: 'idt', token_type: 'Bearer' }),
          { status: 200 },
        );
      }
      if (url === 'https://api.line.me/oauth2/v2.1/verify') {
        return new Response(JSON.stringify({ sub: 'U-login', name: 'Tester' }), {
          status: 200,
        });
      }
      if (url === 'https://api.line.me/v2/profile') {
        return new Response(JSON.stringify({ userId: 'U-login', displayName: 'Tester' }), {
          status: 200,
        });
      }
      // bot/info, push, etc → 404 so the handler falls through
      return new Response('not found', { status: 404 });
    }),
  );
}

function callback(stateValue: Record<string, string> = {}) {
  const state = btoa(JSON.stringify(stateValue));
  return worker.fetch(
    new Request(
      `https://worker.example.com/auth/callback?code=abc&state=${encodeURIComponent(state)}`,
    ),
    env,
    { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext,
  );
}

const friendAddScenario = {
  id: 'SC-1',
  trigger_type: 'friend_add',
  is_active: 1,
  line_account_id: null,
  delivery_mode: 'relative',
};

beforeEach(() => {
  vi.clearAllMocks();
  installFetchMock();
  priorEnrollment = null;
  dbMocks.createUser.mockResolvedValue({ id: 'U-uuid' });
  dbMocks.upsertFriend.mockResolvedValue({
    id: 'F-1',
    line_user_id: 'U-login',
    line_account_id: null,
    user_id: null,
  });
  dbMocks.getScenariosForAccount.mockResolvedValue([friendAddScenario]);
  dbMocks.enrollFriendInScenario.mockResolvedValue({ id: 'FS-1' });
  dbMocks.getScenarioSteps.mockResolvedValue([]);
  dbMocks.getLineAccountByChannelId.mockResolvedValue(null);
  pharmacyAccessMocks.isPharmacyModeAccount.mockResolvedValue(false);
  pharmacyAccessMocks.hasPharmacyModeAccount.mockResolvedValue(false);
});

describe('GET /auth/callback — friend_add scenario auto-enroll gating', () => {
  it('enrolls a brand-new friend in active friend_add scenarios', async () => {
    dbMocks.getFriendByLineUserId.mockResolvedValue(null); // brand-new friend

    await callback();

    expect(dbMocks.enrollFriendInScenario).toHaveBeenCalledWith(
      expect.anything(),
      'F-1',
      'SC-1',
    );
  });

  it('does NOT enroll an existing friend with a prior enrollment on OAuth re-login', async () => {
    // A completed enrollment doesn't block the partial UNIQUE, so without the
    // existence guard this re-login would re-create the enrollment and
    // re-send the whole welcome sequence.
    dbMocks.getFriendByLineUserId.mockResolvedValue({
      id: 'F-1',
      line_user_id: 'U-login',
      line_account_id: null,
      user_id: 'U-uuid',
    });
    priorEnrollment = { id: 'FS-done' };

    await callback();

    expect(dbMocks.enrollFriendInScenario).not.toHaveBeenCalled();
  });

  it('enrolls an existing friend with NO enrollment history (catch-up)', async () => {
    // Friend row was created without a follow event (message-first friend,
    // migrated base, or a follow webhook that died before enrolling). The
    // OAuth path is their only friend_add entry — it must still enroll them.
    dbMocks.getFriendByLineUserId.mockResolvedValue({
      id: 'F-1',
      line_user_id: 'U-login',
      line_account_id: null,
      user_id: 'U-uuid',
    });
    priorEnrollment = null;

    await callback();

    expect(dbMocks.enrollFriendInScenario).toHaveBeenCalledWith(
      expect.anything(),
      'F-1',
      'SC-1',
    );
  });

  it('does not send a generic form link for a pharmacy account', async () => {
    dbMocks.getLineAccountByChannelId.mockResolvedValue({
      id: 'pharmacy-a',
      login_channel_id: '2000000001',
      login_channel_secret: 'pharmacy-secret',
      channel_access_token: 'pharmacy-token',
      liff_id: '1000000001-Pharmacy',
    });
    pharmacyAccessMocks.isPharmacyModeAccount.mockImplementation(
      async (_db, lineAccountId) => lineAccountId === 'pharmacy-a',
    );

    await callback({ form: 'form-1', account: 'CH-pharmacy' });

    expect(
      vi.mocked(fetch).mock.calls.some(
        ([input]) => String(input) === 'https://api.line.me/v2/bot/message/push',
      ),
    ).toBe(false);
  });

  it('does not send a generic form link for an unowned friend in a pharmacy install', async () => {
    dbMocks.getLineAccountByChannelId.mockResolvedValue({
      id: 'generic-a',
      login_channel_id: '2000000002',
      login_channel_secret: 'generic-secret',
      channel_access_token: 'generic-token',
      liff_id: '1000000002-Generic',
    });
    dbMocks.getScenariosForAccount.mockResolvedValue([]);
    pharmacyAccessMocks.hasPharmacyModeAccount.mockResolvedValue(true);

    await callback({ form: 'form-1', account: 'CH-generic' });

    expect(
      vi.mocked(fetch).mock.calls.some(
        ([input]) => String(input) === 'https://api.line.me/v2/bot/message/push',
      ),
    ).toBe(false);
  });
});

describe('GET /auth/callback — redirect + logging hardening', () => {
  it('logs only status on token exchange failure, never the upstream body', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":"invalid_grant","secret":"UPSTREAM-BODY"}', { status: 400 })));

    await callback();

    const logged = errorSpy.mock.calls.map((call) => call.map(String).join(' ')).join('\n');
    expect(logged).not.toContain('UPSTREAM-BODY');
    expect(logged).toContain('400');
    errorSpy.mockRestore();
  });

  it('pharmacy mode: only allowlisted origins are honoured for ?redirect=', async () => {
    dbMocks.upsertFriend.mockResolvedValue({ id: 'F-1', line_user_id: 'U-login', line_account_id: 'pharmacy-a', user_id: null });
    pharmacyAccessMocks.isPharmacyModeAccount.mockImplementation(async (_db, id) => id === 'pharmacy-a');

    const evil = await callback({ redirect: 'https://evil.example.net/phish' });
    expect(evil.headers.get('location') ?? '').not.toContain('evil.example.net');

    const ok = await callback({ redirect: 'https://worker.example.com/thanks' });
    expect(ok.status).toBe(302);
    expect(ok.headers.get('location')).toBe('https://worker.example.com/thanks');
  });

  it('non-pharmacy mode keeps external marketing redirects', async () => {
    const res = await callback({ redirect: 'https://lp.example.net/thanks' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('https://lp.example.net/thanks');
  });
});
