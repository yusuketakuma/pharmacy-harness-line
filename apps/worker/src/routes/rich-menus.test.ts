import { beforeEach, describe, expect, test, vi } from 'vitest';
import { Hono } from 'hono';
import { richMenus } from './rich-menus.js';

const dbMocks = vi.hoisted(() => ({
  getFriendById: vi.fn(),
  getLineAccountById: vi.fn(),
}));
vi.mock('@line-crm/db', () => dbMocks);

const pharmacyAccessMocks = vi.hoisted(() => ({
  isPharmacyModeAccount: vi.fn(),
}));
vi.mock('../custom/pharmacy/growth-loop/access.js', () => pharmacyAccessMocks);

const tenantBoundaryMocks = vi.hoisted(() => ({
  accountResourceOwnedByStaff: vi.fn(),
}));
vi.mock('../middleware/tenant-boundary.js', () => tenantBoundaryMocks);

const credentialMocks = vi.hoisted(() => ({
  readLineCredential: vi.fn(),
}));
vi.mock('../custom/pharmacy/provisioning/line-credential-store.js', () => credentialMocks);

const lineClientMocks = vi.hoisted(() => ({
  constructor: vi.fn(),
  uploadRichMenuImage: vi.fn(),
  linkRichMenuToUser: vi.fn(),
  unlinkRichMenuFromUser: vi.fn(),
  getRichMenuIdOfUser: vi.fn(),
  getDefaultRichMenuId: vi.fn(),
  getRichMenuList: vi.fn(),
}));
vi.mock('@line-crm/line-sdk', () => ({
  LineClient: vi.fn().mockImplementation((token: string) => {
    lineClientMocks.constructor(token);
    return {
      uploadRichMenuImage: lineClientMocks.uploadRichMenuImage,
      linkRichMenuToUser: lineClientMocks.linkRichMenuToUser,
      unlinkRichMenuFromUser: lineClientMocks.unlinkRichMenuFromUser,
      getRichMenuIdOfUser: lineClientMocks.getRichMenuIdOfUser,
      getDefaultRichMenuId: lineClientMocks.getDefaultRichMenuId,
      getRichMenuList: lineClientMocks.getRichMenuList,
    };
  }),
}));

describe('POST /api/rich-menus/:id/image', () => {
  function setupApp() {
    const app = new Hono<{
      Bindings: {
        DB: D1Database;
        LINE_CHANNEL_ACCESS_TOKEN: string;
        LINE_CREDENTIAL_KEY_V1?: string;
      };
    }>();
    app.route('/', richMenus);
    return app;
  }

  beforeEach(() => {
    for (const mock of Object.values(dbMocks)) mock.mockReset();
    for (const mock of Object.values(lineClientMocks)) mock.mockReset();
    pharmacyAccessMocks.isPharmacyModeAccount.mockReset();
    pharmacyAccessMocks.isPharmacyModeAccount.mockResolvedValue(false);
    credentialMocks.readLineCredential.mockReset();
    credentialMocks.readLineCredential.mockResolvedValue('tenant-token');
    lineClientMocks.uploadRichMenuImage.mockResolvedValue(undefined);
    lineClientMocks.linkRichMenuToUser.mockResolvedValue(undefined);
    lineClientMocks.unlinkRichMenuFromUser.mockResolvedValue(undefined);
    lineClientMocks.getRichMenuIdOfUser.mockResolvedValue({ richMenuId: null });
    lineClientMocks.getDefaultRichMenuId.mockResolvedValue(null);
    lineClientMocks.getRichMenuList.mockResolvedValue({ richmenus: [] });
  });

  test('accepts SDK imageData JSON field for base64 uploads', async () => {
    const app = setupApp();
    const res = await app.request('/api/rich-menus/richmenu-1/image', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        imageData: 'aGVsbG8=',
        contentType: 'image/png',
      }),
    }, {
      LINE_CHANNEL_ACCESS_TOKEN: 'token',
      DB: {} as D1Database,
    });

    expect(res.status).toBe(200);
    expect(lineClientMocks.uploadRichMenuImage).toHaveBeenCalledTimes(1);
    const [richMenuId, imageData, contentType] = lineClientMocks.uploadRichMenuImage.mock.calls[0];
    expect(richMenuId).toBe('richmenu-1');
    expect(contentType).toBe('image/png');
    expect(new TextDecoder().decode(imageData as ArrayBuffer)).toBe('hello');
  });

  test('keeps accepting legacy image JSON field', async () => {
    const app = setupApp();
    const res = await app.request('/api/rich-menus/richmenu-2/image', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        image: 'data:image/jpeg;base64,aGVsbG8=',
        contentType: 'image/jpeg',
      }),
    }, {
      LINE_CHANNEL_ACCESS_TOKEN: 'token',
      DB: {} as D1Database,
    });

    expect(res.status).toBe(200);
    expect(lineClientMocks.uploadRichMenuImage).toHaveBeenCalledTimes(1);
    const [richMenuId, imageData, contentType] = lineClientMocks.uploadRichMenuImage.mock.calls[0];
    expect(richMenuId).toBe('richmenu-2');
    expect(contentType).toBe('image/jpeg');
    expect(new TextDecoder().decode(imageData as ArrayBuffer)).toBe('hello');
  });
});

describe('friend rich-menu credential resolution', () => {
  const friend = {
    id: 'friend-a',
    line_user_id: 'Ufriend-a',
    line_account_id: 'account-a',
  };

  function setupFriendApp(opts: { tenantId?: string } = {}) {
    const app = new Hono<{
      Bindings: {
        DB: D1Database;
        LINE_CHANNEL_ACCESS_TOKEN: string;
        LINE_CREDENTIAL_KEY_V1?: string;
      };
      Variables: { tenantId: string };
    }>();
    app.use('*', async (c, next) => {
      if (opts.tenantId) c.set('tenantId', opts.tenantId);
      await next();
    });
    app.route('/', richMenus);
    return app;
  }

  const requestOptions = {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ richMenuId: 'richmenu-1' }),
  } as const;

  beforeEach(() => {
    for (const mock of Object.values(dbMocks)) mock.mockReset();
    for (const mock of Object.values(lineClientMocks)) mock.mockReset();
    credentialMocks.readLineCredential.mockReset();
    credentialMocks.readLineCredential.mockResolvedValue('tenant-token');
    lineClientMocks.linkRichMenuToUser.mockResolvedValue(undefined);
    lineClientMocks.unlinkRichMenuFromUser.mockResolvedValue(undefined);
    lineClientMocks.getRichMenuIdOfUser.mockResolvedValue({ richMenuId: null });
    lineClientMocks.getDefaultRichMenuId.mockResolvedValue(null);
    lineClientMocks.getRichMenuList.mockResolvedValue({ richmenus: [] });
    dbMocks.getFriendById.mockResolvedValue(friend);
    pharmacyAccessMocks.isPharmacyModeAccount.mockResolvedValue(true);
  });

  test('uses the tenant/account credential instead of plaintext or env fallback', async () => {
    credentialMocks.readLineCredential.mockResolvedValue('tenant-token');
    const res = await setupFriendApp({ tenantId: 'tenant-a' }).request(
      '/api/friends/friend-a/rich-menu',
      requestOptions,
      {
        DB: {} as D1Database,
        LINE_CHANNEL_ACCESS_TOKEN: 'env-token',
        LINE_CREDENTIAL_KEY_V1: 'root-key-v1',
      },
    );

    expect(res.status).toBe(200);
    expect(credentialMocks.readLineCredential).toHaveBeenCalledWith(
      expect.anything(),
      'root-key-v1',
      { tenantId: 'tenant-a', lineAccountId: 'account-a', kind: 'channel_access_token' },
    );
    expect(dbMocks.getLineAccountById).not.toHaveBeenCalled();
    expect(lineClientMocks.constructor).toHaveBeenCalledWith('tenant-token');
    expect(lineClientMocks.linkRichMenuToUser).toHaveBeenCalledWith('Ufriend-a', 'richmenu-1');
  });

  test('keeps the legacy account credential path for a non-pharmacy account', async () => {
    pharmacyAccessMocks.isPharmacyModeAccount.mockResolvedValue(false);
    dbMocks.getLineAccountById.mockResolvedValue({ channel_access_token: 'legacy-token' });
    const res = await setupFriendApp({ tenantId: 'tenant-a' }).request(
      '/api/friends/friend-a/rich-menu',
      requestOptions,
      {
        DB: {} as D1Database,
        LINE_CHANNEL_ACCESS_TOKEN: 'env-token',
      },
    );

    expect(res.status).toBe(200);
    expect(credentialMocks.readLineCredential).not.toHaveBeenCalled();
    expect(lineClientMocks.constructor).toHaveBeenCalledWith('legacy-token');
  });

  test('denies an account credential outside the authenticated tenant before LINE mutation', async () => {
    dbMocks.getFriendById.mockResolvedValue({ ...friend, line_account_id: 'account-b' });
    credentialMocks.readLineCredential.mockResolvedValue(null);
    const res = await setupFriendApp({ tenantId: 'tenant-a' }).request(
      '/api/friends/friend-a/rich-menu',
      requestOptions,
      {
        DB: {} as D1Database,
        LINE_CHANNEL_ACCESS_TOKEN: 'env-token',
        LINE_CREDENTIAL_KEY_V1: 'root-key-v1',
      },
    );

    expect(res.status).toBe(403);
    expect(credentialMocks.readLineCredential).toHaveBeenCalledWith(
      expect.anything(),
      'root-key-v1',
      { tenantId: 'tenant-a', lineAccountId: 'account-b', kind: 'channel_access_token' },
    );
    expect(lineClientMocks.constructor).not.toHaveBeenCalled();
    expect(lineClientMocks.linkRichMenuToUser).not.toHaveBeenCalled();
  });

  test('fails closed when the credential root key is missing or the credential is corrupt', async () => {
    credentialMocks.readLineCredential.mockResolvedValue(null);
    const missingKey = await setupFriendApp({ tenantId: 'tenant-a' }).request(
      '/api/friends/friend-a/rich-menu',
      requestOptions,
      {
        DB: {} as D1Database,
        LINE_CHANNEL_ACCESS_TOKEN: 'env-token',
      },
    );
    expect(missingKey.status).toBe(403);
    expect(credentialMocks.readLineCredential).not.toHaveBeenCalled();
    expect(lineClientMocks.constructor).not.toHaveBeenCalled();

    const corruptCredential = await setupFriendApp({ tenantId: 'tenant-a' }).request(
      '/api/friends/friend-a/rich-menu',
      requestOptions,
      {
        DB: {} as D1Database,
        LINE_CHANNEL_ACCESS_TOKEN: 'env-token',
        LINE_CREDENTIAL_KEY_V1: 'root-key-v1',
      },
    );
    expect(corruptCredential.status).toBe(403);
    expect(lineClientMocks.constructor).not.toHaveBeenCalled();
    expect(lineClientMocks.linkRichMenuToUser).not.toHaveBeenCalled();
  });
});

describe('GET /api/rich-menus accountId tenant backstop', () => {
  function setupApp(opts: { tenantId?: string } = {}) {
    const app = new Hono<{
      Bindings: { DB: D1Database; LINE_CHANNEL_ACCESS_TOKEN: string };
      Variables: { tenantId: string };
    }>();
    app.use('*', async (c, next) => {
      if (opts.tenantId) c.set('tenantId', opts.tenantId);
      await next();
    });
    app.route('/', richMenus);
    return app;
  }

  beforeEach(() => {
    for (const mock of Object.values(dbMocks)) mock.mockReset();
    for (const mock of Object.values(lineClientMocks)) mock.mockReset();
    tenantBoundaryMocks.accountResourceOwnedByStaff.mockReset();
    lineClientMocks.getRichMenuList.mockResolvedValue({ richmenus: [] });
  });

  test('falls back to the default LINE client when the caller tenant does not own accountId, even with upstream guards bypassed', async () => {
    // Calling the richMenus router directly (not through the top-level app)
    // already bypasses pharmacyTenantApiAllowlistGuard/pharmacyGenericFeatureGuard,
    // so this proves resolveLineClient itself rejects the cross-tenant account.
    dbMocks.getLineAccountById.mockResolvedValue({ channel_access_token: 'foreign-token' });
    tenantBoundaryMocks.accountResourceOwnedByStaff.mockResolvedValue(false);

    const res = await setupApp({ tenantId: 'tenant-a' }).request(
      '/api/rich-menus?accountId=account-b',
      {},
      { DB: {} as D1Database, LINE_CHANNEL_ACCESS_TOKEN: 'env-token' },
    );

    expect(res.status).toBe(200);
    expect(tenantBoundaryMocks.accountResourceOwnedByStaff)
      .toHaveBeenCalledWith(expect.anything(), 'tenant-a', 'account-b');
    expect(lineClientMocks.constructor).toHaveBeenCalledWith('env-token');
    expect(lineClientMocks.constructor).not.toHaveBeenCalledWith('foreign-token');
  });

  test('uses the resolved account token when the tenant owns the accountId', async () => {
    dbMocks.getLineAccountById.mockResolvedValue({ channel_access_token: 'owned-token' });
    tenantBoundaryMocks.accountResourceOwnedByStaff.mockResolvedValue(true);

    const res = await setupApp({ tenantId: 'tenant-a' }).request(
      '/api/rich-menus?accountId=account-a',
      {},
      { DB: {} as D1Database, LINE_CHANNEL_ACCESS_TOKEN: 'env-token' },
    );

    expect(res.status).toBe(200);
    expect(lineClientMocks.constructor).toHaveBeenCalledWith('owned-token');
  });
});
