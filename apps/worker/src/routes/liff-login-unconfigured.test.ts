import { beforeEach, describe, expect, it, vi } from 'vitest';

const dbMocks = {
  getLineAccounts: vi.fn().mockResolvedValue([]),
  getStaffByApiKey: vi.fn(),
  recoverStalledBroadcasts: vi.fn(),
  recoverStuckDeliveries: vi.fn(),
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
  getTrafficPoolBySlug: vi.fn().mockResolvedValue(null),
  getTrafficPoolById: vi.fn().mockResolvedValue(null),
  getRandomPoolAccount: vi.fn().mockResolvedValue(null),
  getPoolAccounts: vi.fn().mockResolvedValue([]),
  incrementAffiliateLinkClick: vi.fn().mockResolvedValue(undefined),
  jstNow: () => '2026-08-20 00:00:00',
};
vi.mock('@line-crm/db', () => dbMocks);

vi.mock('../services/immediate-first-step.js', () => ({
  pushImmediateFirstStep: vi.fn().mockResolvedValue(true),
}));

const worker = (await import('../index.js')).default;

const DB = {
  prepare: () => ({
    bind: () => ({
      run: async () => ({ meta: { changes: 0 } }),
      first: async () => null,
      all: async () => ({ results: [] }),
    }),
  }),
} as unknown as D1Database;

const unconfiguredEnv = {
  DB,
  WORKER_URL: 'https://worker.example.com',
  LINE_CHANNEL_ACCESS_TOKEN: 'env-token',
} as unknown as import('../index.js').Env['Bindings'];

function get(path: string) {
  return worker.fetch(
    new Request(`https://worker.example.com${path}`),
    unconfiguredEnv,
    { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext,
  );
}

async function expectSetupGuidance(response: Response) {
  expect(response.status).toBe(503);
  const body = await response.text();
  expect(body).toContain('LINE ログインが未設定です');
  expect(body).toContain('<meta name="robots" content="noindex">');
  expect(body).not.toContain('LINE_LOGIN_CHANNEL_SECRET');
}

beforeEach(() => {
  vi.clearAllMocks();
  dbMocks.getLineAccounts.mockResolvedValue([]);
  dbMocks.getLineAccountByChannelId.mockResolvedValue(null);
  dbMocks.getEntryRouteByRefCode.mockResolvedValue(null);
  dbMocks.getAffiliateLinkByRefCode.mockResolvedValue(null);
  dbMocks.getTrafficPoolBySlug.mockResolvedValue(null);
  vi.stubGlobal('fetch', vi.fn(async () => new Response('unexpected external fetch', { status: 500 })));
});

describe('LINE Login/LIFF unconfigured guard', () => {
  it('returns guidance from /auth/line', async () => {
    await expectSetupGuidance(await get('/auth/line'));
  });

  it('returns guidance from /auth/oauth', async () => {
    await expectSetupGuidance(await get('/auth/oauth'));
  });

  it('returns guidance before /auth/callback exchanges a token', async () => {
    const state = btoa(JSON.stringify({ ref: '' }));
    await expectSetupGuidance(
      await get(`/auth/callback?code=abc&state=${encodeURIComponent(state)}`),
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it('returns guidance from /r instead of calling match on an absent LIFF URL', async () => {
    await expectSetupGuidance(await get('/r/somecode'));
  });
});
