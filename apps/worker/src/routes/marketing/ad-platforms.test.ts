import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const db = vi.hoisted(() => ({
  getAdPlatforms: vi.fn(),
  getAdPlatformById: vi.fn(),
  createAdPlatform: vi.fn(),
  updateAdPlatform: vi.fn(),
  deleteAdPlatform: vi.fn(),
  getAdConversionLogs: vi.fn(),
  getAdPlatformByName: vi.fn(),
}));

vi.mock('@line-crm/db', () => db);
vi.mock('../../services/ad-conversion.js', () => ({ sendAdConversions: vi.fn() }));

import type { Env } from '../../index.js';
import { adPlatforms } from './ad-platforms.js';

const CONFIG = {
  pixel_id: 'pixel-public',
  customer_id: 'customer-public',
  conversion_action_id: 'action-public',
  pixel_code: 'tiktok-public',
  access_token: 'access-secret-value',
  api_key: 'tiny',
  api_secret: 'api-secret-value',
  oauth_token: 'oauth-secret-value',
  developer_token: 'developer-secret-value',
  test_event_code: 'test-secret-value',
  future_credential: { token: 'nested-secret-value' },
};

const ROW = {
  id: 'platform-1',
  name: 'meta',
  display_name: 'Meta',
  config: JSON.stringify(CONFIG),
  is_active: 1,
  created_at: '2026-08-23T00:00:00.000Z',
  updated_at: '2026-08-23T00:00:00.000Z',
};

function app() {
  const instance = new Hono<Env>();
  instance.route('/', adPlatforms);
  return instance;
}

beforeEach(() => {
  vi.clearAllMocks();
  db.getAdPlatforms.mockResolvedValue([ROW]);
  db.getAdPlatformById.mockResolvedValue(ROW);
  db.createAdPlatform.mockResolvedValue(ROW);
  db.updateAdPlatform.mockResolvedValue(ROW);
});

describe('ad platform config projection', () => {
  it.each([
    ['GET', '/api/ad-platforms', undefined],
    ['POST', '/api/ad-platforms', { name: 'meta', config: CONFIG }],
    ['PUT', '/api/ad-platforms/platform-1', { config: CONFIG }],
  ])('%s returns public identifiers but no credential material', async (method, path, body) => {
    const response = await app().request(path, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    }, { DB: {} as D1Database } as Env['Bindings']);

    expect(response.status).toBe(method === 'POST' ? 201 : 200);
    const json = await response.json() as {
      data: { config: Record<string, unknown> } | Array<{ config: Record<string, unknown> }>;
    };
    const config = Array.isArray(json.data) ? json.data[0].config : json.data.config;
    expect(config).toMatchObject({
      pixel_id: CONFIG.pixel_id,
      customer_id: CONFIG.customer_id,
      conversion_action_id: CONFIG.conversion_action_id,
      pixel_code: CONFIG.pixel_code,
    });
    for (const key of [
      'access_token', 'api_key', 'api_secret', 'oauth_token', 'developer_token',
      'test_event_code', 'future_credential',
    ]) {
      expect(config[key]).toBe('********');
    }
    expect(JSON.stringify(config)).not.toContain('secret-value');
    expect(JSON.stringify(config)).not.toContain('tiny');
  });

  it('preserves stored credentials when a masked config is saved', async () => {
    await app().request('/api/ad-platforms/platform-1', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        config: {
          pixel_id: 'pixel-updated',
          access_token: '********',
          oauth_token: '********',
        },
      }),
    }, { DB: {} as D1Database } as Env['Bindings']);

    expect(db.updateAdPlatform).toHaveBeenCalledWith(
      expect.anything(),
      'platform-1',
      { config: { ...CONFIG, pixel_id: 'pixel-updated' } },
    );
  });
});
