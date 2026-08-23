import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
  getActiveAdPlatforms: vi.fn(),
  getRefTrackingWithClickIds: vi.fn(),
  logAdConversion: vi.fn(),
}));

vi.mock('@line-crm/db', () => db);

import { sendAdConversions } from './ad-conversion.js';

const REF = {
  fbclid: 'fb-click',
  twclid: 'x-click',
  gclid: 'google-click',
  ttclid: 'tiktok-click',
  ip_address: null,
  user_agent: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  db.getRefTrackingWithClickIds.mockResolvedValue(REF);
});

afterEach(() => vi.unstubAllGlobals());

describe('sendAdConversions error privacy', () => {
  it.each([
    ['meta', { pixel_id: 'pixel', access_token: 'token' }, 'Meta CAPI error: 503', 'fb-click'],
    ['x', { pixel_id: 'pixel' }, 'X Conversion API error: 503', 'x-click'],
    ['google', {
      customer_id: 'customer', conversion_action_id: 'action', oauth_token: 'token',
    }, 'Google Ads API error: 503', 'google-click'],
    ['tiktok', { pixel_code: 'pixel', access_token: 'token' }, 'TikTok Events API error: 503', 'tiktok-click'],
  ])('%s failure does not persist the upstream response body', async (name, config, message, clickId) => {
    db.getActiveAdPlatforms.mockResolvedValue([{
      id: `platform-${name}`,
      name,
      config: JSON.stringify(config),
    }]);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response('sensitive-upstream-detail', { status: 503 }),
    ));

    await sendAdConversions({} as D1Database, 'friend-a', 'conversion');

    expect(db.logAdConversion).toHaveBeenCalledOnce();
    const failure = db.logAdConversion.mock.calls[0][1];
    expect(failure).toMatchObject({ status: 'failed', errorMessage: message, clickId });
    expect(failure.errorMessage).not.toContain('sensitive-upstream-detail');
  });

  it('does not persist arbitrary transport error details', async () => {
    db.getActiveAdPlatforms.mockResolvedValue([{
      id: 'platform-meta',
      name: 'meta',
      config: JSON.stringify({ pixel_id: 'pixel', access_token: 'token' }),
    }]);
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(
      new Error('sensitive-transport-detail'),
    ));

    await sendAdConversions({} as D1Database, 'friend-a', 'conversion');

    const failure = db.logAdConversion.mock.calls[0][1];
    expect(failure).toMatchObject({ status: 'failed', errorMessage: 'Ad conversion failed' });
    expect(failure.errorMessage).not.toContain('sensitive-transport-detail');
  });

  it('records a malformed config failure and continues with later platforms', async () => {
    db.getActiveAdPlatforms.mockResolvedValue([
      { id: 'platform-meta', name: 'meta', config: '{' },
      {
        id: 'platform-google',
        name: 'google',
        config: JSON.stringify({
          customer_id: 'customer', conversion_action_id: 'action', oauth_token: 'token',
        }),
      },
    ]);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 200 })));

    await expect(sendAdConversions(
      {} as D1Database, 'friend-a', 'conversion',
    )).resolves.toBeUndefined();

    expect(db.logAdConversion).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      expect.objectContaining({
        platformId: 'platform-meta', status: 'failed', errorMessage: 'Ad conversion failed',
      }),
    );
    expect(db.logAdConversion).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      expect.objectContaining({ platformId: 'platform-google', status: 'sent' }),
    );
  });
});
