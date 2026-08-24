import { beforeEach, describe, expect, test, vi } from 'vitest';
import { Hono } from 'hono';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const lineAccountLookup = vi.fn();
const dbMocks = {
  createRichMenuGroup: vi.fn(),
  deleteRichMenuGroup: vi.fn(),
  getLineAccountById: lineAccountLookup,
  getLineAccountByIdForTenant: lineAccountLookup,
  getRichMenuGroupByGeneratorKey: vi.fn(),
  getRichMenuGroupWithPages: vi.fn(),
  updateRichMenuGroupMeta: vi.fn(),
  replaceRichMenuPages: vi.fn(),
  setRichMenuPageImage: vi.fn(),
};
vi.mock('@line-crm/db', () => dbMocks);
const accessMock = vi.hoisted(() => ({ canAccessPharmacyAccount: vi.fn(), hasPharmacyCapability: vi.fn() }));
vi.mock('../growth-loop/access.js', () => accessMock);

const access = vi.fn();
vi.mock('../operations-access.js', () => ({ canAccessPharmacyOperationsAccount: access }));

const layoutRepository = vi.hoisted(() => ({
  get: vi.fn(), save: vi.fn(), bind: vi.fn(), deleteVersion: vi.fn(),
  listVersions: vi.fn(), renameVersion: vi.fn(), getLifecycle: vi.fn(), saveLifecycle: vi.fn(),
  getCurrentDefaultEvidence: vi.fn(),
}));
vi.mock('./repository.js', () => ({
  createPharmacyRichMenuDraftBinding: layoutRepository.bind,
  deletePharmacyRichMenuVersion: layoutRepository.deleteVersion,
  getPharmacyRichMenuLayout: layoutRepository.get,
  getPharmacyRichMenuLifecycleControl: layoutRepository.getLifecycle,
  getPharmacyRichMenuCurrentDefaultEvidence: layoutRepository.getCurrentDefaultEvidence,
  listPharmacyRichMenuVersions: layoutRepository.listVersions,
  renamePharmacyRichMenuVersion: layoutRepository.renameVersion,
  savePharmacyRichMenuLayout: layoutRepository.save,
  savePharmacyRichMenuLifecycleControl: layoutRepository.saveLifecycle,
}));
const capabilityRepository = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('../growth-loop/repository.js', () => ({ getPharmacyCapabilityConfig: capabilityRepository.get }));
const catalog = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock('./catalog.js', () => ({
  PHARMACY_RICH_MENU_CATALOG_VERSION: 'v4-2',
  loadPharmacyRichMenuCatalogImage: catalog.load,
}));

const { pharmacyRichMenuRoutes } = await import('./routes.js');

function group(overrides: Record<string, unknown> = {}) {
  return {
    id: 'group-1', account_id: 'account-a', name: '薬局初期メニュー', chat_bar_text: 'メニュー',
    size: 'large', default_page_id: 'page-1', is_default_for_all: 0, selected: 1,
    status: 'draft', generator_key: 'initial-large-3x2-v4', generator_version: '4',
    publishing_at: null, created_at: '', updated_at: '',
    pages: [{
      id: 'page-1', group_id: 'group-1', order_index: 0, name: '初期メニュー',
      alias_id: 'lhx-group-1-0', line_richmenu_id: null, image_r2_key: null,
      image_content_type: null, created_at: '', updated_at: '', areas: [],
    }],
    ...overrides,
  };
}

const JPEG_2500x1686 = new Uint8Array(readFileSync(resolve(
  process.cwd(), 'public/custom/pharmacy/rich-menu/initial-large-3x2-v4.jpg',
)));
const JPEG_2500x843 = new Uint8Array(readFileSync(resolve(
  process.cwd(), 'public/custom/pharmacy/rich-menu/initial-compact-3x1.jpg',
)));

function app(opts: {
  images?: R2Bucket;
  platformAdmin?: boolean;
  role?: 'owner' | 'admin' | 'staff';
} = {}) {
  const worker = new Hono<any>();
  worker.use('*', async (c, next) => {
    if (opts.platformAdmin) c.set('platformAdmin', { id: 'platform-admin-1' });
    else c.set('staff', { id: 'staff-1', name: 'Staff', role: opts.role ?? 'admin' });
    c.set('tenantId', 'tenant-a');
    c.env = {
      DB: {} as D1Database,
      IMAGES: opts.images ?? { put: vi.fn() } as unknown as R2Bucket,
      ASSETS: { fetch: vi.fn(async (request: Request) => new Response(
        request.url.includes('initial-large-3x2-v') ? JPEG_2500x1686 : JPEG_2500x843,
      )) } as unknown as Fetcher,
      LINE_CHANNEL_ID: 'channel-1',
    };
    await next();
  });
  worker.route('/', pharmacyRichMenuRoutes);
  return worker;
}

beforeEach(() => {
  for (const fn of Object.values(dbMocks)) fn.mockReset();
  accessMock.canAccessPharmacyAccount.mockResolvedValue(true);
  accessMock.hasPharmacyCapability.mockResolvedValue(true);
  access.mockReset();
  access.mockResolvedValue(true);
  layoutRepository.get.mockReset();
  layoutRepository.save.mockReset();
  layoutRepository.bind.mockReset();
  layoutRepository.deleteVersion.mockReset();
  layoutRepository.listVersions.mockReset();
  layoutRepository.renameVersion.mockReset();
  layoutRepository.getLifecycle.mockReset();
  layoutRepository.getCurrentDefaultEvidence.mockReset();
  layoutRepository.saveLifecycle.mockReset();
  catalog.load.mockReset();
  capabilityRepository.get.mockReset();
  layoutRepository.get.mockResolvedValue({
    lineAccountId: 'account-a',
    preferredOrder: [
      'prescription-send', 'prescription-history', 'medication-followup', 'manual-chat', 'pharmacy-info',
    ],
    revision: 1,
    updatedAt: '2026-08-21T00:00:00Z',
  });
  capabilityRepository.get.mockResolvedValue({
    capabilities: ['manual_chat', 'pharmacy_info', 'pharmacy_rich_menu'],
    revision: 7,
  });
  catalog.load.mockResolvedValue({
    variantKey: 'v4-compact-manual-chat.pharmacy-info',
    orderedActions: ['manual-chat', 'pharmacy-info'],
    objectKey: 'rich-menu-catalog/v4-2/v4-compact-manual-chat.pharmacy-info.jpg',
    imageHash: 'a'.repeat(64),
    width: 2500,
    height: 843,
    size: 'compact',
    contentType: 'image/jpeg',
    bytes: JPEG_2500x843,
  });
  layoutRepository.listVersions.mockResolvedValue([]);
  layoutRepository.getLifecycle.mockResolvedValue({
    lineAccountId: 'account-a', state: 'inactive', revision: 0, updatedAt: null,
  });
  layoutRepository.getCurrentDefaultEvidence.mockResolvedValue(null);
});

describe('pharmacy rich-menu lifecycle control', () => {
  test('is inactive by default without issuing a LINE mutation', async () => {
    const response = await app().request(
      '/api/custom/pharmacy/rich-menus/lifecycle?accountId=account-a',
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ data: { state: 'inactive', revision: 0 } });
    expect(layoutRepository.getLifecycle).toHaveBeenCalledWith(expect.anything(), 'account-a');
  });

  test('uses an account-scoped revision to activate or freeze without LINE calls', async () => {
    layoutRepository.saveLifecycle.mockResolvedValue({
      lineAccountId: 'account-a', state: 'active', revision: 1, updatedAt: '2026-08-21T00:00:00Z',
    });
    const response = await app().request(
      '/api/custom/pharmacy/rich-menus/lifecycle?accountId=account-a', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ state: 'active', expectedRevision: 0 }),
      },
    );

    expect(response.status).toBe(200);
    expect(layoutRepository.saveLifecycle).toHaveBeenCalledWith(
      expect.anything(), 'account-a', 'active', 0,
    );
  });
});

describe('pharmacy rich-menu preparation', () => {
  test('returns Gone without reading account data or creating a full composite menu', async () => {
    const response = await app().request(
      '/api/custom/pharmacy/rich-menus/prepare?accountId=account-a',
      { method: 'POST', body: '{}' },
    );

    expect(response.status).toBe(410);
    expect(await response.json()).toEqual({
      success: false,
      error: 'pharmacy rich-menu prepare was retired; create a saved version instead',
    });
    expect(access).not.toHaveBeenCalled();
    expect(dbMocks.getLineAccountById).not.toHaveBeenCalled();
    expect(dbMocks.createRichMenuGroup).not.toHaveBeenCalled();
  });
});

describe('pharmacy rich-menu layout', () => {
  test('returns the account layout and server-derived catalog variant', async () => {
    const response = await app().request('/api/custom/pharmacy/rich-menus/layout?accountId=account-a');

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      success: true,
      data: {
        preferredOrder: [
          'prescription-send', 'prescription-history', 'medication-followup', 'manual-chat', 'pharmacy-info',
        ],
        effectiveOrder: ['manual-chat', 'pharmacy-info'],
        variantKey: 'v4-compact-manual-chat.pharmacy-info',
        revision: 1,
        capabilityRevision: 7,
      },
    });
  });

  test('saves only the account layout and makes zero LINE preparation calls', async () => {
    const preferredOrder = [
      'pharmacy-info', 'manual-chat', 'medication-followup', 'prescription-history', 'prescription-send',
    ];
    layoutRepository.save.mockResolvedValue({
      lineAccountId: 'account-a', preferredOrder, revision: 2, updatedAt: '2026-08-21T00:01:00Z',
    });

    const response = await app().request('/api/custom/pharmacy/rich-menus/layout?accountId=account-a', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ preferredOrder, expectedRevision: 1 }),
    });

    expect(response.status).toBe(200);
    expect(layoutRepository.save).toHaveBeenCalledWith(expect.anything(), 'account-a', preferredOrder, 1);
    expect(dbMocks.createRichMenuGroup).not.toHaveBeenCalled();
    expect(dbMocks.setRichMenuPageImage).not.toHaveBeenCalled();
  });

  test('allows assigned staff to read but not mutate the pharmacy rich-menu layout', async () => {
    const staff = app({ role: 'staff' });
    const read = await staff.request('/api/custom/pharmacy/rich-menus/layout?accountId=account-a');
    const write = await staff.request('/api/custom/pharmacy/rich-menus/layout?accountId=account-a', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        preferredOrder: [
          'prescription-send', 'prescription-history', 'medication-followup', 'manual-chat', 'pharmacy-info',
        ],
        expectedRevision: 1,
      }),
    });

    expect(read.status).toBe(200);
    expect(write.status).toBe(403);
    expect(layoutRepository.save).not.toHaveBeenCalled();
  });

  test('rejects invalid or stale layout writes without touching another account', async () => {
    const invalid = await app().request('/api/custom/pharmacy/rich-menus/layout?accountId=account-a', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        preferredOrder: [
          'prescription-send', 'prescription-send', 'medication-followup', 'manual-chat', 'pharmacy-info',
        ],
        expectedRevision: 1,
      }),
    });
    expect(invalid.status).toBe(400);
    expect(layoutRepository.save).not.toHaveBeenCalled();

    layoutRepository.save.mockRejectedValueOnce(new Error('stale pharmacy rich-menu layout revision'));
    const stale = await app().request('/api/custom/pharmacy/rich-menus/layout?accountId=account-a', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        preferredOrder: [
          'prescription-send', 'prescription-history', 'medication-followup', 'manual-chat', 'pharmacy-info',
        ],
        expectedRevision: 1,
      }),
    });
    expect(stale.status).toBe(409);

    access.mockResolvedValueOnce(false);
    const denied = await app().request('/api/custom/pharmacy/rich-menus/layout?accountId=account-b');
    expect(denied.status).toBe(403);
    expect(layoutRepository.get).not.toHaveBeenCalledWith(expect.anything(), 'account-b');
  });
});

describe('pharmacy rich-menu capability candidate', () => {
  test('derives an account candidate from current capabilities without LINE or draft writes', async () => {
    dbMocks.getLineAccountById.mockResolvedValue({ id: 'account-a', liff_id: '1234567890-AbCd' });
    const response = await app().request(
      '/api/custom/pharmacy/rich-menus/candidate?accountId=account-a',
    );

    expect(response.status).toBe(200);
    const body = await response.json() as Record<string, unknown>;
    expect(body).toMatchObject({
      success: true,
      data: {
        syncStatus: 'UNVERIFIED', reasonCode: 'CURRENT_DEFAULT_EVIDENCE_STALE',
        accountId: 'account-a', layoutRevision: 1, capabilityRevision: 7,
        variantKey: 'v4-compact-manual-chat.pharmacy-info', menuSize: 'compact',
        imageHash: 'a'.repeat(64), effectiveOrder: ['manual-chat', 'pharmacy-info'],
        slots: [
          { actionKey: 'manual-chat', label: '薬局へ相談', actionType: 'message' },
          { actionKey: 'pharmacy-info', label: '薬局情報', actionType: 'uri' },
          { actionKey: 'all-functions', label: 'すべての機能', actionType: 'uri' },
        ],
      },
    });
    expect(JSON.stringify(body)).not.toMatch(/actionData|liff\.line\.me|patient|friend|credential/i);
    expect(catalog.load).toHaveBeenCalledWith(expect.anything(), ['manual-chat', 'pharmacy-info']);
    expect(dbMocks.createRichMenuGroup).not.toHaveBeenCalled();
    expect(dbMocks.setRichMenuPageImage).not.toHaveBeenCalled();
  });

  test('serves only the exact revision- and hash-bound candidate JPEG', async () => {
    dbMocks.getLineAccountById.mockResolvedValue({ id: 'account-a', liff_id: '1234567890-AbCd' });
    const images = {} as R2Bucket;
    const response = await app({ images }).request(
      `/api/custom/pharmacy/rich-menus/candidate/image?accountId=account-a&layoutRevision=1&capabilityRevision=7&imageHash=${'a'.repeat(64)}`,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('image/jpeg');
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(JPEG_2500x843);

    catalog.load.mockClear();
    const stale = await app({ images }).request(
      `/api/custom/pharmacy/rich-menus/candidate/image?accountId=account-a&layoutRevision=1&capabilityRevision=6&imageHash=${'a'.repeat(64)}`,
    );
    expect(stale.status).toBe(409);
    expect(catalog.load).not.toHaveBeenCalled();

    access.mockResolvedValueOnce(false);
    const denied = await app({ images }).request(
      `/api/custom/pharmacy/rich-menus/candidate/image?accountId=account-b&layoutRevision=1&capabilityRevision=7&imageHash=${'a'.repeat(64)}`,
    );
    expect(denied.status).toBe(403);
  });

  test('keeps the fixed all-functions compact candidate when every direct feature is off', async () => {
    dbMocks.getLineAccountById.mockResolvedValue({ id: 'account-a', liff_id: '1234567890-AbCd' });
    capabilityRepository.get.mockResolvedValue({ capabilities: ['pharmacy_rich_menu'], revision: 8 });
    catalog.load.mockResolvedValue({
      variantKey: 'v4-compact-empty', orderedActions: [],
      objectKey: 'rich-menu-catalog/v4-2/v4-compact-empty.jpg', imageHash: 'b'.repeat(64),
      width: 2500, height: 843, size: 'compact', contentType: 'image/jpeg', bytes: JPEG_2500x843,
    });
    const response = await app().request(
      '/api/custom/pharmacy/rich-menus/candidate?accountId=account-a',
    );
    expect(await response.json()).toMatchObject({
      success: true,
      data: {
        capabilityRevision: 8, effectiveOrder: [], variantKey: 'v4-compact-empty',
        slots: [{ actionKey: 'all-functions', label: 'すべての機能' }],
      },
    });
    expect(catalog.load).toHaveBeenCalledWith(expect.anything(), []);
  });

  test('fails closed when the catalog image is missing or its hash is invalid', async () => {
    dbMocks.getLineAccountById.mockResolvedValue({ id: 'account-a', liff_id: '1234567890-AbCd' });
    for (const message of ['catalog image is missing', 'catalog image hash does not match manifest']) {
      catalog.load.mockRejectedValueOnce(new Error(message));
      const response = await app().request(
        '/api/custom/pharmacy/rich-menus/candidate?accountId=account-a',
      );
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        success: false,
        data: { reasonCodes: ['RICH_MENU_CATALOG_UNVERIFIED'] },
      });
    }
    expect(dbMocks.createRichMenuGroup).not.toHaveBeenCalled();
    expect(dbMocks.setRichMenuPageImage).not.toHaveBeenCalled();
  });

  test('becomes CURRENT only after fresh read-back matches the candidate image and actions', async () => {
    dbMocks.getLineAccountById.mockResolvedValue({ id: 'account-a', liff_id: '1234567890-AbCd' });
    layoutRepository.getCurrentDefaultEvidence.mockResolvedValue({
      groupId: 'current', verifiedAt: '2026-08-21T10:00:00Z',
    });
    const currentVersion = {
      groupId: 'current', lineAccountId: 'account-a', imageHash: 'a'.repeat(64),
      layoutRevision: 1, capabilityRevision: 7, manifestHash: 'c'.repeat(64),
    };
    layoutRepository.listVersions.mockResolvedValue([currentVersion]);
    const uri = (page: string) => ({
      uri: `https://liff.line.me/1234567890-AbCd/?page=${page}&liffId=1234567890-AbCd`,
    });
    const area = (id: string, x: number, actionType: 'message' | 'uri', actionData: Record<string, unknown>) => ({
      id, page_id: 'current-page', bounds_x: x, bounds_y: 0,
      bounds_width: x === 833 ? 834 : 833, bounds_height: 843,
      action_type: actionType, action_data: JSON.stringify(actionData), actionData,
      created_at: '', updated_at: '',
    });
    dbMocks.getRichMenuGroupWithPages.mockResolvedValue(group({
      id: 'current', account_id: 'account-a', default_page_id: 'current-page',
      pages: [{
        id: 'current-page', group_id: 'current', order_index: 0, name: 'Menu', alias_id: null,
        line_richmenu_id: 'richmenu-current', image_r2_key: 'rich-menus/account-a/current/menu.jpg',
        image_content_type: 'image/jpeg', created_at: '', updated_at: '', areas: [
          area('a', 0, 'message', { text: '薬局へ相談' }),
          area('b', 833, 'uri', uri('pharmacy-info')),
          area('c', 1667, 'uri', uri('pharmacy-menu')),
        ],
      }],
    }));

    const current = await app().request(
      '/api/custom/pharmacy/rich-menus/candidate?accountId=account-a',
    );
    expect(await current.json()).toMatchObject({
      success: true, data: { syncStatus: 'CURRENT', imageChanged: false },
    });

    layoutRepository.listVersions.mockResolvedValueOnce([
      { ...currentVersion, imageHash: 'b'.repeat(64) },
    ]);
    const stale = await app().request(
      '/api/custom/pharmacy/rich-menus/candidate?accountId=account-a',
    );
    expect(await stale.json()).toMatchObject({
      success: true, data: { syncStatus: 'STALE', imageChanged: true },
    });
  });
});

describe('pharmacy saved rich-menu versions', () => {
  test('compares a saved version only with fresh server-owned current-default evidence', async () => {
    const version = (groupId: string, imageHash: string) => ({
      groupId, lineAccountId: 'account-a', name: groupId, status: 'published',
      currentDefault: groupId === 'current', knownGood: true, unverified: false,
      unresolvedOperationId: null, unresolvedOperationKind: null,
      lineRichMenuId: `richmenu-${groupId}`, imageR2Key: `rich-menus/account-a/${groupId}/menu.jpg`,
      imageContentType: 'image/jpeg', menuSize: 'compact', layoutRevision: 2,
      capabilityRevision: 3, catalogVersion: 'v4-2', catalogVariantKey: groupId,
      manifestHash: groupId.repeat(64).slice(0, 64), imageHash,
      createdAt: '2026-08-21T00:00:00Z', updatedAt: '2026-08-21T00:00:00Z',
    });
    const area = (id: string, x: number, text: string) => ({
      id, page_id: 'page', bounds_x: x, bounds_y: 0, bounds_width: 1250,
      bounds_height: 843, action_type: 'message' as const, action_data: JSON.stringify({ text }),
      actionData: { text }, created_at: '', updated_at: '',
    });
    layoutRepository.listVersions.mockResolvedValue([
      version('draft', 'b'.repeat(64)), version('current', 'a'.repeat(64)),
    ]);
    layoutRepository.getCurrentDefaultEvidence.mockResolvedValue({
      groupId: 'current', verifiedAt: '2026-08-21T10:00:00Z',
    });
    dbMocks.getRichMenuGroupWithPages.mockImplementation(async (_db, groupId: string) => group({
      id: groupId, account_id: 'account-a', default_page_id: `${groupId}-page`,
      pages: [{
        id: `${groupId}-page`, group_id: groupId, order_index: 0, name: 'Menu',
        alias_id: null, line_richmenu_id: `richmenu-${groupId}`,
        image_r2_key: `rich-menus/account-a/${groupId}/menu.jpg`, image_content_type: 'image/jpeg',
        created_at: '', updated_at: '', areas: groupId === 'current'
          ? [area('current-a', 0, 'A'), area('current-b', 1250, 'B')]
          : [area('draft-b', 0, 'B'), area('draft-a', 1250, 'A')],
      }],
    }));

    const response = await app().request(
      '/api/custom/pharmacy/rich-menus/versions/draft/diff?accountId=account-a',
    );
    expect(response.status).toBe(200);
    const body = await response.json() as Record<string, unknown>;
    expect(body).toMatchObject({
      success: true,
      data: {
        status: 'VERIFIED', accountId: 'account-a', verifiedAt: '2026-08-21T10:00:00Z',
        current: { groupId: 'current', imageHash: 'a'.repeat(64) },
        draft: { groupId: 'draft', imageHash: 'b'.repeat(64) },
        imageChanged: true,
        slots: [
          { kind: 'moved', currentIndex: 1, draftIndex: 0 },
          { kind: 'moved', currentIndex: 0, draftIndex: 1 },
        ],
      },
    });
    expect(JSON.stringify(body)).not.toMatch(/patient|friend|credential|actionData|liff\.line\.me/i);

    layoutRepository.getCurrentDefaultEvidence.mockResolvedValueOnce(null);
    const stale = await app().request(
      '/api/custom/pharmacy/rich-menus/versions/draft/diff?accountId=account-a',
    );
    expect(await stale.json()).toMatchObject({
      success: true,
      data: { status: 'UNVERIFIED', reasonCode: 'CURRENT_DEFAULT_EVIDENCE_STALE' },
    });

    access.mockResolvedValueOnce(false);
    const denied = await app().request(
      '/api/custom/pharmacy/rich-menus/versions/draft/diff?accountId=account-b',
    );
    expect(denied.status).toBe(403);
  });

  test('creates a new immutable draft from current server-owned state and catalog bytes', async () => {
    dbMocks.getLineAccountById.mockResolvedValue({ id: 'account-a', liff_id: '1234567890-AbCd' });
    dbMocks.createRichMenuGroup.mockResolvedValue(group({
      name: '夜間向けメニュー', generator_key: null, generator_version: 'v4-2', size: 'compact',
    }));
    const images = { put: vi.fn(), delete: vi.fn() } as unknown as R2Bucket;

    const response = await app({ images }).request(
      '/api/custom/pharmacy/rich-menus/versions?accountId=account-a',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: '夜間向けメニュー', expectedLayoutRevision: 1, expectedCapabilityRevision: 7,
        }),
      },
    );

    expect(response.status).toBe(201);
    expect(catalog.load).toHaveBeenCalledWith(images, ['manual-chat', 'pharmacy-info']);
    expect(dbMocks.createRichMenuGroup).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      accountId: 'account-a', name: '夜間向けメニュー', generatorKey: null,
      pages: [expect.objectContaining({ areas: expect.arrayContaining([
        expect.objectContaining({ boundsX: 0, actionType: 'message' }),
        expect.objectContaining({ boundsX: 833, actionType: 'uri' }),
        expect.objectContaining({ boundsX: 1667, boundsY: 0, actionType: 'uri' }),
      ]) })],
    }));
    expect(layoutRepository.bind).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      groupId: 'group-1', lineAccountId: 'account-a', layoutRevision: 1,
      capabilityRevision: 7, menuSize: 'compact',
      catalogVariantKey: 'v4-compact-manual-chat.pharmacy-info',
      catalogObjectKey: 'rich-menu-catalog/v4-2/v4-compact-manual-chat.pharmacy-info.jpg',
      liffIdHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      manifestHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      imageHash: 'a'.repeat(64),
    }));
    expect(images.put).toHaveBeenCalledOnce();
  });

  test('rejects stale revisions before catalog or rich-menu writes', async () => {
    const response = await app().request(
      '/api/custom/pharmacy/rich-menus/versions?accountId=account-a',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'stale', expectedLayoutRevision: 2, expectedCapabilityRevision: 6,
        }),
      },
    );

    expect(response.status).toBe(409);
    expect(catalog.load).not.toHaveBeenCalled();
    expect(dbMocks.createRichMenuGroup).not.toHaveBeenCalled();
  });

  test('lists only versions returned by the account-scoped repository', async () => {
    layoutRepository.listVersions.mockResolvedValue([{ groupId: 'group-a', lineAccountId: 'account-a' }]);
    const response = await app().request(
      '/api/custom/pharmacy/rich-menus/versions?accountId=account-a',
    );

    expect(response.status).toBe(200);
    expect(layoutRepository.listVersions).toHaveBeenCalledWith(expect.anything(), 'account-a');
    expect(await response.json()).toMatchObject({ success: true, data: [{ groupId: 'group-a' }] });
  });

  test('renames one saved version with metadata CAS and account scope', async () => {
    layoutRepository.renameVersion.mockResolvedValue({
      groupId: 'group-a', name: '営業時間変更版', updatedAt: '2026-08-21T01:00:00Z',
    });
    const response = await app().request(
      '/api/custom/pharmacy/rich-menus/versions/group-a?accountId=account-a',
      {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: '営業時間変更版', expectedUpdatedAt: '2026-08-21T00:00:00Z' }),
      },
    );

    expect(response.status).toBe(200);
    expect(layoutRepository.renameVersion).toHaveBeenCalledWith(
      expect.anything(), 'account-a', 'group-a', '営業時間変更版', '2026-08-21T00:00:00Z',
    );
    expect(await response.json()).toMatchObject({
      success: true, data: { groupId: 'group-a', name: '営業時間変更版' },
    });

    access.mockResolvedValueOnce(false);
    const denied = await app().request(
      '/api/custom/pharmacy/rich-menus/versions/group-a?accountId=account-b',
      {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: '越境', expectedUpdatedAt: '2026-08-21T00:00:00Z' }),
      },
    );
    expect(denied.status).toBe(403);
    expect(layoutRepository.renameVersion).toHaveBeenCalledTimes(1);
  });

  test('rejects stale or invalid saved-version renames', async () => {
    layoutRepository.renameVersion.mockRejectedValueOnce(
      new Error('stale pharmacy rich-menu version metadata'),
    );
    const stale = await app().request(
      '/api/custom/pharmacy/rich-menus/versions/group-a?accountId=account-a',
      {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'stale', expectedUpdatedAt: '2026-08-21T00:00:00Z' }),
      },
    );
    expect(stale.status).toBe(409);

    const invalid = await app().request(
      '/api/custom/pharmacy/rich-menus/versions/group-a?accountId=account-a',
      {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: ' ', expectedUpdatedAt: '' }),
      },
    );
    expect(invalid.status).toBe(400);
    expect(layoutRepository.renameVersion).toHaveBeenCalledOnce();
  });

  test('deletes only a protected-check-passing draft and then removes its catalog copy', async () => {
    layoutRepository.deleteVersion.mockResolvedValue({
      imageR2Key: 'rich-menus/account-a/group-a/page-a/version.jpg',
    });
    const images = { delete: vi.fn() } as unknown as R2Bucket;
    const response = await app({ images }).request(
      '/api/custom/pharmacy/rich-menus/versions/group-a?accountId=account-a&expectedUpdatedAt=2026-08-21T00%3A00%3A00Z',
      { method: 'DELETE' },
    );

    expect(response.status).toBe(200);
    expect(layoutRepository.deleteVersion).toHaveBeenCalledWith(
      expect.anything(), 'account-a', 'group-a', '2026-08-21T00:00:00Z',
    );
    expect(images.delete).toHaveBeenCalledWith(
      'rich-menus/account-a/group-a/page-a/version.jpg',
    );
  });

  test('rejects known-good or unverified version deletion without touching R2', async () => {
    layoutRepository.deleteVersion.mockRejectedValue(
      new Error('protected pharmacy rich-menu version'),
    );
    const images = { delete: vi.fn() } as unknown as R2Bucket;
    const response = await app({ images }).request(
      '/api/custom/pharmacy/rich-menus/versions/group-a?accountId=account-a&expectedUpdatedAt=2026-08-21T00%3A00%3A00Z',
      { method: 'DELETE' },
    );

    expect(response.status).toBe(409);
    expect(images.delete).not.toHaveBeenCalled();
  });
});
