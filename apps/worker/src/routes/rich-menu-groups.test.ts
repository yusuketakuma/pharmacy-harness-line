import { describe, expect, test, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';

// Mock @line-crm/db so we can drive the route purely from this test file.
const lineAccountLookup = vi.fn();
const dbMocks = {
  getRichMenuGroups: vi.fn(),
  getRichMenuGroupById: vi.fn(),
  getRichMenuGroupWithPages: vi.fn(),
  createRichMenuGroup: vi.fn(),
  updateRichMenuGroupMeta: vi.fn(),
  replaceRichMenuPages: vi.fn(),
  deleteRichMenuGroup: vi.fn(),
  setRichMenuPageImage: vi.fn(),
  pageBelongsToGroup: vi.fn(),
  acquirePublishLock: vi.fn(),
  acquireRichMenuAccountLock: vi.fn(),
  releasePublishLock: vi.fn(),
  markRichMenuGroupPublished: vi.fn(),
  markRichMenuGroupUnpublished: vi.fn(),
  getLineAccountById: lineAccountLookup,
  getLineAccountByIdForTenant: lineAccountLookup,
  getFollowingLineUserIdsByTag: vi.fn(),
};
vi.mock('@line-crm/db', () => dbMocks);

const credentialMocks = vi.hoisted(() => ({
  readLineCredential: vi.fn(),
}));
vi.mock('../custom/pharmacy/provisioning/line-credential-store.js', () => credentialMocks);

// Re-import after mock so the module picks up mocked deps.
const { richMenuGroups } = await import('./rich-menu-groups.js');

type TestEnv = {
  Variables: {
    staff: { id: string; role: 'owner' | 'admin' | 'staff' };
    tenantId: string;
  };
  Bindings: { DB: D1Database; IMAGES: R2Bucket; LINE_CREDENTIAL_KEY_V1?: string };
};

function makeR2Stub(): R2Bucket {
  const store = new Map<string, { body: Uint8Array; contentType?: string }>();
  return {
    async put(key: string, value: ArrayBuffer | Uint8Array, options?: { httpMetadata?: { contentType?: string } }) {
      const bytes = value instanceof Uint8Array ? value : new Uint8Array(value as ArrayBuffer);
      store.set(key, { body: bytes, contentType: options?.httpMetadata?.contentType });
      return {} as any;
    },
    async get(key: string) {
      const item = store.get(key);
      if (!item) return null;
      return {
        body: item.body,
        httpMetadata: { contentType: item.contentType },
      } as any;
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

// Minimal D1 stub for routes that issue ad-hoc SQL outside the @line-crm/db
// helpers (例: GET /api/rich-menu-groups の thumbnail JOIN クエリ)。
// 空 results / null を返すことで route の「サムネなし」分岐を通す。
function makeMinimalDbStub(): D1Database {
  const empty = { results: [] };
  return {
    prepare: vi.fn(() => ({
      bind: vi.fn(() => ({
        all: vi.fn(async () => empty),
        first: vi.fn(async () => null),
        run: vi.fn(async () => ({ meta: { changes: 0 } })),
      })),
    })),
    batch: vi.fn(async () => []),
  } as unknown as D1Database;
}

function setupApp(opts: { r2?: R2Bucket; db?: D1Database; credentialKey?: string | null } = {}) {
  const app = new Hono<TestEnv>();
  app.use('*', async (c, next) => {
    c.set('staff', { id: 'staff-1', role: 'owner' });
    c.set('tenantId', 'tenant-a');
    c.env = {
      DB: opts.db ?? makeMinimalDbStub(),
      IMAGES: opts.r2 ?? makeR2Stub(),
      LINE_CREDENTIAL_KEY_V1: opts.credentialKey === undefined ? 'root-key-v1' : opts.credentialKey ?? undefined,
    };
    await next();
  });
  app.route('/', richMenuGroups);
  return app;
}

beforeEach(() => {
  for (const fn of Object.values(dbMocks)) fn.mockReset();
  credentialMocks.readLineCredential.mockReset();
  credentialMocks.readLineCredential.mockResolvedValue('tenant-token');
  dbMocks.acquirePublishLock.mockResolvedValue('lock-token');
  dbMocks.acquireRichMenuAccountLock.mockResolvedValue({
    groupId: 'account-lock-group', token: 'account-lock-token',
  });
});

// ----- GET /api/rich-menu-groups -----

describe('GET /api/rich-menu-groups', () => {
  test('returns empty list when accountId has no groups', async () => {
    dbMocks.getRichMenuGroups.mockResolvedValue([]);
    const app = setupApp();
    const res = await app.request('/api/rich-menu-groups?accountId=acc-1');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; data: unknown[] };
    expect(body).toEqual({ success: true, data: [] });
    expect(dbMocks.getRichMenuGroups).toHaveBeenCalledWith(expect.anything(), 'acc-1');
  });

  test('400 when accountId missing', async () => {
    const app = setupApp();
    const res = await app.request('/api/rich-menu-groups');
    expect(res.status).toBe(400);
  });

  test('serializes snake_case rows to camelCase', async () => {
    dbMocks.getRichMenuGroups.mockResolvedValue([
      {
        id: 'g1', account_id: 'acc-1', name: 'メイン', chat_bar_text: 'メニュー',
        size: 'large', default_page_id: 'p1', is_default_for_all: 1, selected: 1,
        status: 'published', publishing_at: null,
        created_at: '2026-05-08T00:00:00.000', updated_at: '2026-05-08T01:00:00.000',
      },
    ]);
    const app = setupApp();
    const res = await app.request('/api/rich-menu-groups?accountId=acc-1');
    const body = (await res.json()) as { data: any[] };
    expect(body.data[0]).toMatchObject({
      id: 'g1', accountId: 'acc-1', chatBarText: 'メニュー',
      isDefaultForAll: true, selected: true, status: 'published',
    });
  });
});

// ----- GET /api/rich-menu-groups/:groupId -----

describe('GET /api/rich-menu-groups/:groupId', () => {
  test('404 when group not found', async () => {
    dbMocks.getRichMenuGroupWithPages.mockResolvedValue(null);
    const app = setupApp();
    const res = await app.request('/api/rich-menu-groups/missing');
    expect(res.status).toBe(404);
  });

  test('returns group with pages and areas', async () => {
    dbMocks.getRichMenuGroupWithPages.mockResolvedValue({
      id: 'g1', account_id: 'acc-1', name: 'メイン', chat_bar_text: 'メニュー',
      size: 'large', default_page_id: 'p1', is_default_for_all: 0,
      status: 'draft', publishing_at: null,
      created_at: '2026-05-08T00:00:00.000', updated_at: '2026-05-08T00:00:00.000',
      pages: [{
        id: 'p1', group_id: 'g1', order_index: 0, name: 'ホーム',
        alias_id: 'lhx-g1xxxxxx-0', line_richmenu_id: null,
        image_r2_key: null, image_content_type: null,
        created_at: '2026-05-08T00:00:00.000', updated_at: '2026-05-08T00:00:00.000',
        areas: [{
          id: 'a1', page_id: 'p1',
          bounds_x: 0, bounds_y: 0, bounds_width: 100, bounds_height: 100,
          action_type: 'uri', action_data: '{"uri":"https://x"}',
          actionData: { uri: 'https://x' },
          created_at: '2026-05-08T00:00:00.000', updated_at: '2026-05-08T00:00:00.000',
        }],
      }],
    });
    const app = setupApp();
    const res = await app.request('/api/rich-menu-groups/g1');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: any };
    expect(body.data.pages).toHaveLength(1);
    expect(body.data.pages[0].areas[0]).toMatchObject({
      boundsX: 0, boundsWidth: 100, actionType: 'uri',
      actionData: { uri: 'https://x' },
    });
  });

  test('does not return a group when the requested account scope differs', async () => {
    dbMocks.getRichMenuGroupWithPages.mockResolvedValue({
      id: 'g1', account_id: 'account-a', name: 'A', chat_bar_text: 'メニュー', size: 'compact',
      default_page_id: null, is_default_for_all: 0, selected: 1, status: 'draft',
      publishing_at: null, generator_key: null, generator_version: null,
      created_at: '', updated_at: '', pages: [],
    });
    const res = await setupApp().request('/api/rich-menu-groups/g1?accountId=account-b');
    expect(res.status).toBe(404);
  });

  test('requires account scope for bearer callers', async () => {
    dbMocks.getRichMenuGroupWithPages.mockResolvedValue({
      id: 'g1', account_id: 'account-a', name: 'A', chat_bar_text: 'メニュー', size: 'compact',
      default_page_id: null, is_default_for_all: 0, selected: 1, status: 'draft',
      publishing_at: null, generator_key: null, generator_version: null,
      created_at: '', updated_at: '', pages: [],
    });
    const res = await setupApp().request('/api/rich-menu-groups/g1', {
      headers: { Authorization: 'Bearer api-key' },
    });
    expect(res.status).toBe(404);
  });
});

// ----- POST /api/rich-menu-groups -----

describe('POST /api/rich-menu-groups', () => {
  test('rejects missing accountId', async () => {
    const app = setupApp();
    const res = await app.request('/api/rich-menu-groups', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'x', chatBarText: 'x', size: 'large', pages: [{ name: 'p', orderIndex: 0, areas: [] }] }),
    });
    expect(res.status).toBe(400);
  });

  test('rejects invalid size enum', async () => {
    const app = setupApp();
    const res = await app.request('/api/rich-menu-groups', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accountId: 'a', name: 'x', chatBarText: 'x', size: 'huge', pages: [{ name: 'p', orderIndex: 0, areas: [] }] }),
    });
    expect(res.status).toBe(400);
  });

  test('rejects pages with non-sequential orderIndex', async () => {
    const app = setupApp();
    const res = await app.request('/api/rich-menu-groups', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        accountId: 'a', name: 'x', chatBarText: 'x', size: 'large',
        pages: [
          { name: 'p1', orderIndex: 0, areas: [] },
          { name: 'p2', orderIndex: 5, areas: [] },
        ],
      }),
    });
    expect(res.status).toBe(400);
  });

  test('rejects richmenuswitch action in create payload (Round 3 P2-1)', async () => {
    const app = setupApp();
    const res = await app.request('/api/rich-menu-groups', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        accountId: 'a', name: 'x', chatBarText: 'x', size: 'large',
        pages: [
          { name: 'p1', orderIndex: 0, areas: [
            { boundsX: 0, boundsY: 0, boundsWidth: 1, boundsHeight: 1,
              actionType: 'richmenuswitch', actionData: { targetPageId: 'p2' } },
          ] },
          { name: 'p2', orderIndex: 1, areas: [] },
        ],
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/richmenuswitch/i);
  });

  test('rejects duplicate page.id in payload (Round 3 P3)', async () => {
    const app = setupApp();
    const res = await app.request('/api/rich-menu-groups', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        accountId: 'a', name: 'x', chatBarText: 'x', size: 'large',
        pages: [
          { id: 'dup', name: 'p1', orderIndex: 0, areas: [] },
          { id: 'dup', name: 'p2', orderIndex: 1, areas: [] },
        ],
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/duplicat/i);
  });

  test('rejects more than 20 areas per page', async () => {
    const tooMany = Array.from({ length: 21 }, () => ({
      boundsX: 0, boundsY: 0, boundsWidth: 1, boundsHeight: 1,
      actionType: 'message', actionData: { text: 'x' },
    }));
    const app = setupApp();
    const res = await app.request('/api/rich-menu-groups', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        accountId: 'a', name: 'x', chatBarText: 'x', size: 'large',
        pages: [{ name: 'p1', orderIndex: 0, areas: tooMany }],
      }),
    });
    expect(res.status).toBe(400);
  });

  test('forwards parsed input to createRichMenuGroup', async () => {
    dbMocks.createRichMenuGroup.mockResolvedValue({
      id: 'new-1', account_id: 'a', name: 'x', chat_bar_text: 'x', size: 'large',
      default_page_id: 'p1', is_default_for_all: 0, status: 'draft', publishing_at: null,
      created_at: '2026-05-08T00:00:00.000', updated_at: '2026-05-08T00:00:00.000',
      pages: [{ id: 'p1', group_id: 'new-1', order_index: 0, name: 'p1', alias_id: 'lhx-newxxxxx-0',
        line_richmenu_id: null, image_r2_key: null, image_content_type: null,
        created_at: '2026-05-08T00:00:00.000', updated_at: '2026-05-08T00:00:00.000', areas: [] }],
    });
    const app = setupApp();
    const res = await app.request('/api/rich-menu-groups', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        accountId: 'a', name: 'x', chatBarText: 'バー', size: 'large', selected: true,
        pages: [{ name: 'p1', orderIndex: 0, areas: [] }],
      }),
    });
    expect(res.status).toBe(200);
    expect(dbMocks.createRichMenuGroup).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        accountId: 'a', name: 'x', chatBarText: 'バー', size: 'large', selected: true,
        pages: [expect.objectContaining({ name: 'p1', orderIndex: 0 })],
      }),
    );
  });
});

// ----- PATCH /api/rich-menu-groups/:groupId -----

describe('PATCH /api/rich-menu-groups/:groupId', () => {
  test('404 when group missing', async () => {
    dbMocks.getRichMenuGroupById.mockResolvedValue(null);
    const app = setupApp();
    const res = await app.request('/api/rich-menu-groups/missing', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'new' }),
    });
    expect(res.status).toBe(404);
  });

  test('updates meta fields', async () => {
    dbMocks.getRichMenuGroupById.mockResolvedValue({ id: 'g1' });
    dbMocks.getRichMenuGroupWithPages.mockResolvedValue({
      id: 'g1', account_id: 'a', name: 'new', chat_bar_text: 'バー', size: 'large',
      default_page_id: null, is_default_for_all: 1, status: 'draft', publishing_at: null,
      created_at: '', updated_at: '', pages: [],
    });
    const app = setupApp();
    const res = await app.request('/api/rich-menu-groups/g1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'new', selected: true }),
    });
    expect(res.status).toBe(200);
    expect(dbMocks.updateRichMenuGroupMeta).toHaveBeenCalledWith(expect.anything(), 'g1', {
      name: 'new', selected: true,
    });
    expect(dbMocks.replaceRichMenuPages).not.toHaveBeenCalled();
  });

  test('rejects default visibility changes through the generic patch endpoint', async () => {
    dbMocks.getRichMenuGroupById.mockResolvedValue({ id: 'g1', account_id: 'a' });
    const app = setupApp();
    const res = await app.request('/api/rich-menu-groups/g1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ isDefaultForAll: true }),
    });
    expect(res.status).toBe(400);
    expect(dbMocks.updateRichMenuGroupMeta).not.toHaveBeenCalled();
  });

  test('replaces pages when pages key present', async () => {
    dbMocks.getRichMenuGroupById.mockResolvedValue({ id: 'g1' });
    dbMocks.getRichMenuGroupWithPages.mockResolvedValue({
      id: 'g1', account_id: 'a', name: 'x', chat_bar_text: 'x', size: 'large',
      default_page_id: null, is_default_for_all: 0, status: 'draft', publishing_at: null,
      created_at: '', updated_at: '', pages: [],
    });
    const app = setupApp();
    const res = await app.request('/api/rich-menu-groups/g1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pages: [
          { name: 'p1', orderIndex: 0, areas: [] },
          { name: 'p2', orderIndex: 1, areas: [] },
        ],
      }),
    });
    expect(res.status).toBe(200);
    expect(dbMocks.replaceRichMenuPages).toHaveBeenCalledWith(
      expect.anything(),
      'g1',
      expect.arrayContaining([
        expect.objectContaining({ name: 'p1' }),
        expect.objectContaining({ name: 'p2' }),
      ]),
    );
  });
});

// ----- DELETE /api/rich-menu-groups/:groupId -----

describe('DELETE /api/rich-menu-groups/:groupId', () => {
  test('returns 200 on success (draft group)', async () => {
    dbMocks.getRichMenuGroupById.mockResolvedValue({ id: 'g1', status: 'draft' });
    dbMocks.deleteRichMenuGroup.mockResolvedValue(true);
    const app = setupApp();
    const res = await app.request('/api/rich-menu-groups/g1', { method: 'DELETE' });
    expect(res.status).toBe(200);
  });

  test('returns 404 when group missing', async () => {
    dbMocks.getRichMenuGroupById.mockResolvedValue(null);
    const app = setupApp();
    const res = await app.request('/api/rich-menu-groups/missing', { method: 'DELETE' });
    expect(res.status).toBe(404);
  });

  test('returns 409 for published group without force (unpublish first)', async () => {
    dbMocks.getRichMenuGroupById.mockResolvedValue({ id: 'g1', status: 'published' });
    const app = setupApp();
    const res = await app.request('/api/rich-menu-groups/g1', { method: 'DELETE' });
    expect(res.status).toBe(409);
    expect(dbMocks.deleteRichMenuGroup).not.toHaveBeenCalled();
  });

  test('force=true skips published guard', async () => {
    dbMocks.getRichMenuGroupById.mockResolvedValue({ id: 'g1', status: 'published' });
    dbMocks.deleteRichMenuGroup.mockResolvedValue(true);
    const app = setupApp();
    const res = await app.request('/api/rich-menu-groups/g1?force=true', { method: 'DELETE' });
    expect(res.status).toBe(200);
  });
});

// ----- POST /api/rich-menu-groups/:groupId/pages/:pageId/image -----

const PNG_2500x1686 = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x09, 0xc4, 0x00, 0x00, 0x06, 0x96,
  0x08, 0x06, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
]);

describe('POST /api/rich-menu-groups/:groupId/pages/:pageId/image', () => {
  test('rejects wrong content-type', async () => {
    const app = setupApp();
    const res = await app.request('/api/rich-menu-groups/g1/pages/p1/image', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not an image',
    });
    expect(res.status).toBe(400);
  });

  test('rejects when page does not belong to group', async () => {
    dbMocks.pageBelongsToGroup.mockResolvedValue(false);
    const app = setupApp();
    const res = await app.request('/api/rich-menu-groups/g1/pages/p1/image', {
      method: 'POST',
      headers: { 'Content-Type': 'image/png' },
      body: PNG_2500x1686,
    });
    expect(res.status).toBe(404);
  });

  test('rejects invalid dimensions via image-validator', async () => {
    dbMocks.pageBelongsToGroup.mockResolvedValue(true);
    const odd = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
      0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x00,
      0x08, 0x06, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    ]);
    const app = setupApp();
    const res = await app.request('/api/rich-menu-groups/g1/pages/p1/image', {
      method: 'POST',
      headers: { 'Content-Type': 'image/png' },
      body: odd,
    });
    expect(res.status).toBe(400);
  });

  test('on success uploads to R2 and updates DB image key', async () => {
    dbMocks.pageBelongsToGroup.mockResolvedValue(true);
    dbMocks.getRichMenuGroupById.mockResolvedValue({
      id: 'g1', account_id: 'acc-1', name: 'x', chat_bar_text: 'x', size: 'large',
      default_page_id: null, is_default_for_all: 0, status: 'draft', publishing_at: null,
      created_at: '', updated_at: '',
    });
    const r2 = makeR2Stub();
    const app = setupApp({ r2 });
    const res = await app.request('/api/rich-menu-groups/g1/pages/p1/image', {
      method: 'POST',
      headers: { 'Content-Type': 'image/png' },
      body: PNG_2500x1686,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { imageR2Key: string; size: string } };
    expect(body.data.imageR2Key).toMatch(/^rich-menus\/acc-1\/g1\/p1\//);
    expect(body.data.size).toBe('large');
    // R2 に書き込まれているか
    const stored = await r2.get(body.data.imageR2Key);
    expect(stored).not.toBeNull();
    expect(dbMocks.setRichMenuPageImage).toHaveBeenCalledWith(
      expect.anything(), 'p1', body.data.imageR2Key, 'image/png',
    );
  });
});

describe('GET /api/rich-menu-images/:key', () => {
  test('serves a page-linked image with an encoded key', async () => {
    const r2 = makeR2Stub();
    const key = 'rich-menus/acc-1/group-1/page-1/image.png';
    await r2.put(key, new Uint8Array([1, 2, 3]), { httpMetadata: { contentType: 'image/png' } });
    const db = makeMinimalDbStub();
    const statement = db.prepare('linked');
    vi.mocked(db.prepare).mockImplementation((sql: string) => {
      if (sql.includes('FROM rich_menu_pages')) {
        return {
          bind: vi.fn(() => ({ first: vi.fn(async () => ({ ok: 1 })) })),
        } as unknown as D1PreparedStatement;
      }
      return statement;
    });
    const res = await setupApp({ r2, db }).request(`/api/rich-menu-images/${encodeURIComponent(key)}`);

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
  });

  test('does not serve an orphaned same-account R2 object', async () => {
    const r2 = makeR2Stub();
    const key = 'rich-menus/acc-1/group-1/page-1/image.png';
    await r2.put(key, new Uint8Array([1, 2, 3]), { httpMetadata: { contentType: 'image/png' } });
    const app = setupApp({ r2 });

    const res = await app.request(`/api/rich-menu-images/${encodeURIComponent(key)}`);

    expect(res.status).toBe(404);
  });
});

// ----- POST /api/rich-menu-groups/:groupId/publish -----

describe('POST /api/rich-menu-groups/:groupId/publish', () => {
  test('404 when group missing', async () => {
    dbMocks.getRichMenuGroupWithPages.mockResolvedValue(null);
    const app = setupApp();
    const res = await app.request('/api/rich-menu-groups/missing/publish', { method: 'POST' });
    expect(res.status).toBe(404);
  });

  test('409 when the publish lock cannot be acquired', async () => {
    dbMocks.getRichMenuGroupWithPages.mockResolvedValue({
      id: 'g1', publishing_at: '2026-05-08', pages: [],
      account_id: 'a', name: 'x', chat_bar_text: 'x', size: 'large',
      default_page_id: null, is_default_for_all: 0, status: 'draft',
      created_at: '', updated_at: '',
    });
    dbMocks.getLineAccountById.mockResolvedValue({ channel_access_token: 'encrypted:v1' });
    dbMocks.acquireRichMenuAccountLock.mockResolvedValue(null);
    const app = setupApp();
    const res = await app.request('/api/rich-menu-groups/g1/publish', { method: 'POST' });
    expect(res.status).toBe(409);
    expect(dbMocks.acquireRichMenuAccountLock).toHaveBeenCalledWith(expect.anything(), 'a');
  });

  test('500 when LINE fetch throws — releases lock', async () => {
    dbMocks.getRichMenuGroupWithPages.mockResolvedValue({
      id: 'gid12345-aaaa', account_id: 'acc-1',
      name: 'x', chat_bar_text: 'メニュー', size: 'large',
      default_page_id: 'p1', is_default_for_all: 0, status: 'draft', publishing_at: null,
      created_at: '', updated_at: '',
      pages: [{
        id: 'p1', group_id: 'gid12345-aaaa', order_index: 0, name: 'p1',
        alias_id: 'lhx-gid12345-0', line_richmenu_id: null,
        image_r2_key: null, image_content_type: null,
        created_at: '', updated_at: '', areas: [],
      }],
    });
    dbMocks.getLineAccountById.mockResolvedValue({ channel_access_token: 'tk' });

    const app = setupApp();
    const res = await app.request('/api/rich-menu-groups/gid12345-aaaa/publish', { method: 'POST' });
    expect(res.status).toBe(500);
    expect(dbMocks.releasePublishLock).toHaveBeenCalledWith(
      expect.anything(), 'account-lock-group', 'account-lock-token',
    );
  });

  test('keeps the previous LINE menu when the atomic D1 publish commit fails', async () => {
    const r2 = makeR2Stub();
    const imageKey = 'rich-menus/acc-1/gid12345-aaaa/p1/menu.png';
    await r2.put(imageKey, new Uint8Array([1, 2, 3]), {
      httpMetadata: { contentType: 'image/png' },
    });
    dbMocks.getRichMenuGroupWithPages.mockResolvedValue({
      id: 'gid12345-aaaa', account_id: 'acc-1',
      name: 'x', chat_bar_text: 'メニュー', size: 'compact',
      default_page_id: 'p1', is_default_for_all: 0, selected: 1,
      status: 'draft', publishing_at: null, created_at: '', updated_at: '',
      pages: [{
        id: 'p1', group_id: 'gid12345-aaaa', order_index: 0, name: 'p1',
        alias_id: 'lhx-gid12345-0', line_richmenu_id: 'line-menu-old',
        image_r2_key: imageKey, image_content_type: 'image/png',
        created_at: '', updated_at: '', areas: [],
      }],
    });
    dbMocks.getLineAccountById.mockResolvedValue({ channel_access_token: 'legacy-token' });
    dbMocks.markRichMenuGroupPublished.mockRejectedValue(new Error('D1 unavailable'));
    const requests: Array<{ url: string; method: string }> = [];
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      requests.push({ url, method });
      if (url === 'https://api.line.me/v2/bot/richmenu' && method === 'POST') {
        return new Response(JSON.stringify({ richMenuId: 'line-menu-new' }), { status: 200 });
      }
      if (url.includes('/content') && method === 'POST') return new Response(null, { status: 200 });
      if (url.includes('/richmenu/alias/') && method === 'DELETE') return new Response(null, { status: 404 });
      if (url.endsWith('/richmenu/alias') && method === 'POST') return new Response(null, { status: 200 });
      if (url.endsWith('/user/all/richmenu') && method === 'GET') return new Response(null, { status: 404 });
      if (url.endsWith('/richmenu/line-menu-old') && method === 'DELETE') return new Response(null, { status: 200 });
      throw new Error(`unexpected LINE request: ${method} ${url}`);
    });

    const res = await setupApp({ r2 }).request(
      '/api/rich-menu-groups/gid12345-aaaa/publish',
      { method: 'POST' },
    );

    expect(res.status).toBe(500);
    expect(dbMocks.markRichMenuGroupPublished).toHaveBeenCalledWith(
      expect.anything(),
      'gid12345-aaaa',
      'account-lock-group',
      'account-lock-token',
      [expect.objectContaining({
        pageId: 'p1',
        lineRichMenuId: 'line-menu-new',
        aliasId: expect.stringMatching(/^lhx-gid12345-[a-z0-9]+-0$/u),
      })],
    );
    expect(requests).not.toContainEqual({
      url: 'https://api.line.me/v2/bot/richmenu/line-menu-old',
      method: 'DELETE',
    });
    fetchSpy.mockRestore();
  });

  test('resolves the tenant-scoped credential and fails closed before LINE when unavailable', async () => {
    dbMocks.getRichMenuGroupWithPages.mockResolvedValue({
      id: 'gid12345-aaaa', account_id: 'acc-1',
      name: 'x', chat_bar_text: 'メニュー', size: 'large',
      default_page_id: 'p1', is_default_for_all: 0, status: 'draft', publishing_at: null,
      created_at: '', updated_at: '',
      pages: [{
        id: 'p1', group_id: 'gid12345-aaaa', order_index: 0, name: 'p1',
        alias_id: 'lhx-gid12345-0', line_richmenu_id: null,
        image_r2_key: null, image_content_type: null,
        created_at: '', updated_at: '', areas: [],
      }],
    });
    dbMocks.getLineAccountById.mockResolvedValue({ channel_access_token: 'legacy-token' });
    credentialMocks.readLineCredential.mockResolvedValue(null);
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const res = await setupApp().request('/api/rich-menu-groups/gid12345-aaaa/publish', { method: 'POST' });

    expect(res.status).toBe(403);
    expect(credentialMocks.readLineCredential).toHaveBeenCalledWith(
      expect.anything(),
      'root-key-v1',
      { tenantId: 'tenant-a', lineAccountId: 'acc-1', kind: 'channel_access_token' },
    );
    expect(dbMocks.acquireRichMenuAccountLock).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});

describe('LINE credential resolution for external rich-menu reads', () => {
  test('uses the tenant credential instead of the account row token', async () => {
    dbMocks.getLineAccountById.mockResolvedValue({ channel_access_token: 'legacy-token' });
    const db = makeMinimalDbStub();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer tenant-token');
      return new Response(JSON.stringify({ richmenus: [] }), { status: 200 });
    });

    const res = await setupApp({ db }).request('/api/rich-menu-groups/external?accountId=acc-1');

    expect(res.status).toBe(200);
    expect(dbMocks.getLineAccountById).toHaveBeenCalledWith(db, 'tenant-a', 'acc-1');
    expect(credentialMocks.readLineCredential).toHaveBeenCalledWith(
      db,
      'root-key-v1',
      { tenantId: 'tenant-a', lineAccountId: 'acc-1', kind: 'channel_access_token' },
    );
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    fetchSpy.mockRestore();
  });

  test('fails closed without the credential root key before LINE', async () => {
    dbMocks.getLineAccountById.mockResolvedValue({ channel_access_token: 'legacy-token' });
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const res = await setupApp({ credentialKey: null }).request('/api/rich-menu-groups/external?accountId=acc-1');

    expect(res.status).toBe(403);
    expect(credentialMocks.readLineCredential).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});

describe('POST /api/rich-menu-groups/:groupId/unpublish', () => {
  test('rejects unpublish while another rich-menu operation holds the publish lock', async () => {
    dbMocks.getRichMenuGroupWithPages.mockResolvedValue({
      id: 'g1', account_id: 'acc-1', name: 'メニュー', chat_bar_text: 'メニュー', size: 'compact',
      default_page_id: 'p1', is_default_for_all: 1, selected: 1, status: 'published',
      publishing_at: '2026-05-08T00:00:00.000Z', generator_key: null, generator_version: null,
      created_at: '', updated_at: '', pages: [],
    });
    dbMocks.acquireRichMenuAccountLock.mockResolvedValue(null);
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const res = await setupApp().request('/api/rich-menu-groups/g1/unpublish', { method: 'POST' });

    expect(res.status).toBe(409);
    expect(dbMocks.acquireRichMenuAccountLock).toHaveBeenCalledWith(expect.anything(), 'acc-1');
    expect(dbMocks.getLineAccountById).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  test('keeps D1 publish state when LINE cleanup returns warnings', async () => {
    dbMocks.getRichMenuGroupWithPages.mockResolvedValue({
      id: 'g1', account_id: 'acc-1', name: 'メニュー', chat_bar_text: 'メニュー', size: 'compact',
      default_page_id: 'p1', is_default_for_all: 1, selected: 1, status: 'published',
      publishing_at: null, generator_key: null, generator_version: null, created_at: '', updated_at: '',
      pages: [{
        id: 'p1', group_id: 'g1', order_index: 0, name: '初期', alias_id: 'alias',
        line_richmenu_id: 'line-menu-1', image_r2_key: null, image_content_type: null,
        created_at: '', updated_at: '', areas: [],
      }],
    });
    dbMocks.getLineAccountById.mockResolvedValue({ channel_access_token: 'token' });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.includes('/richmenu/alias')) return new Response('temporary failure', { status: 500 });
      if (url.endsWith('/v2/bot/richmenu/line-menu-1') && init?.method === 'DELETE') return new Response(null, { status: 200 });
      if (url.endsWith('/v2/bot/user/all/richmenu') && init?.method === 'GET') return new Response(null, { status: 404 });
      throw new Error(`unexpected LINE request: ${url}`);
    });
    const app = setupApp();
    const res = await app.request('/api/rich-menu-groups/g1/unpublish', { method: 'POST' });
    expect(res.status).toBe(502);
    expect(await res.text()).not.toContain('temporary failure');
    expect(dbMocks.markRichMenuGroupUnpublished).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});

describe('POST /api/rich-menu-groups/:groupId/apply-to-tag', () => {
  test('requires an explicit dry-run/confirmation phase before mutating LINE', async () => {
    dbMocks.getRichMenuGroupWithPages.mockResolvedValue({
      id: 'g1', account_id: 'acc-1', name: 'メニュー', chat_bar_text: 'メニュー', size: 'compact',
      default_page_id: 'p1', is_default_for_all: 0, selected: 1, status: 'published',
      publishing_at: null, generator_key: null, generator_version: null, created_at: '', updated_at: '',
      pages: [{
        id: 'p1', group_id: 'g1', order_index: 0, name: '初期', alias_id: 'alias',
        line_richmenu_id: 'line-menu-1', image_r2_key: null, image_content_type: null,
        created_at: '', updated_at: '', areas: [],
      }],
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const app = setupApp();
    const res = await app.request('/api/rich-menu-groups/g1/apply-to-tag', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'set-default' }),
    });
    expect(res.status).toBe(428);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  test('dry-run returns a confirmation token without changing LINE state', async () => {
    dbMocks.getRichMenuGroupWithPages.mockResolvedValue({
      id: 'g1', account_id: 'acc-1', name: 'メニュー', chat_bar_text: 'メニュー', size: 'compact',
      default_page_id: 'p1', is_default_for_all: 0, selected: 1, status: 'published',
      publishing_at: null, generator_key: null, generator_version: null, created_at: '', updated_at: '',
      pages: [{
        id: 'p1', group_id: 'g1', order_index: 0, name: '初期', alias_id: 'alias',
        line_richmenu_id: 'line-menu-1', image_r2_key: null, image_content_type: null,
        created_at: '', updated_at: '', areas: [],
      }],
    });
    dbMocks.getLineAccountById.mockResolvedValue({ channel_access_token: 'token' });
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const app = setupApp();
    const res = await app.request('/api/rich-menu-groups/g1/apply-to-tag', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'set-default', dryRun: true }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.data).toMatchObject({ dryRun: true, affected: 0, mode: 'set-default' });
    expect(body.data.confirmationToken).toMatch(/^rmc1\./);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  test('rejects an expired set-default confirmation before calling LINE', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-08-19T00:00:00.000Z'));
      dbMocks.getRichMenuGroupWithPages.mockResolvedValue({
        id: 'g1', account_id: 'acc-1', name: 'メニュー', chat_bar_text: 'メニュー', size: 'compact',
        default_page_id: 'p1', is_default_for_all: 0, selected: 1, status: 'published',
        publishing_at: null, generator_key: null, generator_version: null,
        created_at: '', updated_at: '2026-08-19T00:00:00.000Z',
        pages: [{
          id: 'p1', group_id: 'g1', order_index: 0, name: '初期', alias_id: 'alias',
          line_richmenu_id: 'line-menu-1', image_r2_key: null, image_content_type: null,
          created_at: '', updated_at: '', areas: [],
        }],
      });
      dbMocks.getLineAccountById.mockResolvedValue({ channel_access_token: 'legacy-token' });
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 200 }));
      const app = setupApp();
      const dryRun = await app.request('/api/rich-menu-groups/g1/apply-to-tag', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'set-default', dryRun: true }),
      });
      const token = (await dryRun.json() as any).data.confirmationToken;

      vi.advanceTimersByTime(5 * 60 * 1000 + 1);
      const live = await app.request('/api/rich-menu-groups/g1/apply-to-tag', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'set-default', dryRun: false, confirmationToken: token }),
      });

      expect(live.status).toBe(428);
      expect(fetchSpy).not.toHaveBeenCalled();
      fetchSpy.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });

  test('rejects a tampered confirmation before calling LINE', async () => {
    dbMocks.getRichMenuGroupWithPages.mockResolvedValue({
      id: 'g1', account_id: 'acc-1', name: 'メニュー', chat_bar_text: 'メニュー', size: 'compact',
      default_page_id: 'p1', is_default_for_all: 0, selected: 1, status: 'published',
      publishing_at: null, generator_key: null, generator_version: null,
      created_at: '', updated_at: '2026-08-19T00:00:00.000Z',
      pages: [{
        id: 'p1', group_id: 'g1', order_index: 0, name: '初期', alias_id: 'alias',
        line_richmenu_id: 'line-menu-1', image_r2_key: null, image_content_type: null,
        created_at: '', updated_at: '', areas: [],
      }],
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const app = setupApp();
    const dryRun = await app.request('/api/rich-menu-groups/g1/apply-to-tag', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'set-default', dryRun: true }),
    });
    const token = (await dryRun.json() as any).data.confirmationToken as string;
    const tampered = `${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`;

    const live = await app.request('/api/rich-menu-groups/g1/apply-to-tag', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'set-default', dryRun: false, confirmationToken: tampered }),
    });

    expect(live.status).toBe(428);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  test('rejects bulk-link when the confirmed follower audience changed', async () => {
    dbMocks.getRichMenuGroupWithPages.mockResolvedValue({
      id: 'g1', account_id: 'acc-1', name: 'メニュー', chat_bar_text: 'メニュー', size: 'compact',
      default_page_id: 'p1', is_default_for_all: 0, selected: 1, status: 'published',
      publishing_at: null, generator_key: null, generator_version: null,
      created_at: '', updated_at: '2026-08-19T00:00:00.000Z',
      pages: [{
        id: 'p1', group_id: 'g1', order_index: 0, name: '初期', alias_id: 'alias',
        line_richmenu_id: 'line-menu-1', image_r2_key: null, image_content_type: null,
        created_at: '', updated_at: '', areas: [],
      }],
    });
    dbMocks.getFollowingLineUserIdsByTag
      .mockResolvedValueOnce(['U1'])
      .mockResolvedValueOnce(['U1', 'U2']);
    dbMocks.getLineAccountById.mockResolvedValue({ channel_access_token: 'legacy-token' });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 200 }));
    const app = setupApp();
    const dryRun = await app.request('/api/rich-menu-groups/g1/apply-to-tag', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'bulk-link', tagId: null, dryRun: true }),
    });
    const token = (await dryRun.json() as any).data.confirmationToken;

    const live = await app.request('/api/rich-menu-groups/g1/apply-to-tag', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mode: 'bulk-link', tagId: null, dryRun: false, confirmationToken: token,
      }),
    });

    expect(live.status).toBe(409);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  test('can turn the account-wide initial display off without affecting another group', async () => {
    dbMocks.getRichMenuGroupWithPages.mockResolvedValue({
      id: 'g1', account_id: 'acc-1', name: 'メニュー', chat_bar_text: 'メニュー', size: 'compact',
      default_page_id: 'p1', is_default_for_all: 1, selected: 1, status: 'published',
      publishing_at: null, generator_key: null, generator_version: null, created_at: '', updated_at: '',
      pages: [{
        id: 'p1', group_id: 'g1', order_index: 0, name: '初期', alias_id: 'alias',
        line_richmenu_id: 'line-menu-1', image_r2_key: null, image_content_type: null,
        created_at: '', updated_at: '', areas: [],
      }],
    });
    dbMocks.getLineAccountById.mockResolvedValue({ channel_access_token: 'token' });
    const prepared: Array<{ sql: string; values: unknown[] }> = [];
    const db = {
      prepare: vi.fn((sql: string) => ({
        bind: vi.fn((...values: unknown[]) => ({
          run: vi.fn(async () => {
            prepared.push({ sql, values });
            return { meta: { changes: 1 } };
          }),
          all: vi.fn(async () => ({ results: [] })),
          first: vi.fn(async () => null),
        })),
      })),
      batch: vi.fn(async () => []),
    } as unknown as D1Database;
    let currentDefault: string | null = 'line-menu-1';
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith('/v2/bot/user/all/richmenu') && init?.method === 'GET') {
        return currentDefault
          ? new Response(JSON.stringify({ richMenuId: currentDefault }), { status: 200 })
          : new Response(null, { status: 404 });
      }
      if (url.endsWith('/v2/bot/user/all/richmenu') && init?.method === 'DELETE') {
        currentDefault = null;
        return new Response(null, { status: 200 });
      }
      throw new Error(`unexpected LINE request: ${url}`);
    });
    const app = setupApp({ db });

    const dryRun = await app.request('/api/rich-menu-groups/g1/apply-to-tag', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'set-default', enabled: false, dryRun: true }),
    });
    const dryRunBody = await dryRun.json() as any;
    const live = await app.request('/api/rich-menu-groups/g1/apply-to-tag', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mode: 'set-default',
        enabled: false,
        dryRun: false,
        confirmationToken: dryRunBody.data.confirmationToken,
      }),
    });

    expect(live.status).toBe(200);
    expect((await live.json() as any).data).toMatchObject({ enabled: false });
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(prepared).toHaveLength(1);
    expect(prepared[0].sql).toContain('is_default_for_all = 0');
    expect(prepared[0].sql).toContain('publishing_at = ?');
    expect(prepared[0].values).toContain('account-lock-token');
    expect(dbMocks.acquireRichMenuAccountLock).toHaveBeenCalledWith(db, 'acc-1');
    expect(dbMocks.releasePublishLock).toHaveBeenCalledWith(
      db, 'account-lock-group', 'account-lock-token',
    );
    fetchSpy.mockRestore();
  });

  test('restores the previous LINE default when the D1 default update fails', async () => {
    dbMocks.getRichMenuGroupWithPages.mockResolvedValue({
      id: 'g1', account_id: 'acc-1', name: 'メニュー', chat_bar_text: 'メニュー', size: 'compact',
      default_page_id: 'p1', is_default_for_all: 0, selected: 1, status: 'published',
      publishing_at: null, generator_key: null, generator_version: null,
      created_at: '', updated_at: '2026-08-19T00:00:00.000Z',
      pages: [{
        id: 'p1', group_id: 'g1', order_index: 0, name: '初期', alias_id: 'alias',
        line_richmenu_id: 'line-menu-new', image_r2_key: null, image_content_type: null,
        created_at: '', updated_at: '', areas: [],
      }],
    });
    dbMocks.getLineAccountById.mockResolvedValue({ channel_access_token: 'encrypted:v1' });
    const db = makeMinimalDbStub();
    db.batch = vi.fn(async () => { throw new Error('D1 unavailable'); });
    let currentDefault = 'line-menu-old';
    const setTargets: string[] = [];
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith('/v2/bot/user/all/richmenu') && init?.method === 'GET') {
        return new Response(JSON.stringify({ richMenuId: currentDefault }), { status: 200 });
      }
      const match = url.match(/\/v2\/bot\/user\/all\/richmenu\/(.+)$/u);
      if (match && init?.method === 'POST') {
        currentDefault = match[1];
        setTargets.push(match[1]);
        return new Response(null, { status: 200 });
      }
      throw new Error(`unexpected LINE request: ${url}`);
    });
    const app = setupApp({ db });
    const dryRun = await app.request('/api/rich-menu-groups/g1/apply-to-tag', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'set-default', enabled: true, dryRun: true }),
    });
    const confirmationToken = (await dryRun.json() as any).data.confirmationToken;

    const live = await app.request('/api/rich-menu-groups/g1/apply-to-tag', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'set-default', enabled: true, dryRun: false, confirmationToken }),
    });

    expect(live.status).toBe(500);
    expect(setTargets).toEqual(['line-menu-new', 'line-menu-old']);
    expect(currentDefault).toBe('line-menu-old');
    fetchSpy.mockRestore();
  });

  test('replays the confirmed bulk-link through 500-user LINE chunks', async () => {
    dbMocks.getRichMenuGroupWithPages.mockResolvedValue({
      id: 'g1', account_id: 'acc-1', name: 'メニュー', chat_bar_text: 'メニュー', size: 'compact',
      default_page_id: 'p1', is_default_for_all: 0, selected: 1, status: 'published',
      publishing_at: null, generator_key: null, generator_version: null, created_at: '', updated_at: '',
      pages: [{
        id: 'p1', group_id: 'g1', order_index: 0, name: '初期', alias_id: 'alias',
        line_richmenu_id: 'line-menu-1', image_r2_key: null, image_content_type: null,
        created_at: '', updated_at: '', areas: [],
      }],
    });
    dbMocks.getLineAccountById.mockResolvedValue({ channel_access_token: 'legacy-token' });
    const userIds = Array.from({ length: 501 }, (_, index) => `U${index}`);
    dbMocks.getFollowingLineUserIdsByTag.mockResolvedValue(userIds);
    const chunkSizes: number[] = [];
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      expect(String(input)).toBe('https://api.line.me/v2/bot/richmenu/bulk/link');
      expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer tenant-token');
      const payload = JSON.parse(String(init?.body)) as { richMenuId: string; userIds: string[] };
      expect(payload.richMenuId).toBe('line-menu-1');
      chunkSizes.push(payload.userIds.length);
      return new Response(null, { status: 200 });
    });
    const app = setupApp();

    const dryRun = await app.request('/api/rich-menu-groups/g1/apply-to-tag', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'bulk-link', tagId: 'tag-1', dryRun: true }),
    });
    expect(dryRun.status).toBe(200);
    const dryRunBody = await dryRun.json() as any;
    expect(dryRunBody.data).toMatchObject({ affected: 501, chunks: 2, tagId: 'tag-1' });

    const live = await app.request('/api/rich-menu-groups/g1/apply-to-tag', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mode: 'bulk-link', tagId: 'tag-1', dryRun: false,
        confirmationToken: dryRunBody.data.confirmationToken,
      }),
    });
    expect(live.status).toBe(200);
    expect((await live.json() as any).data).toEqual({ chunks: 2, total: 501 });
    expect(chunkSizes).toEqual([500, 1]);
    fetchSpy.mockRestore();
  });

  test('rejects a live mutation without the token returned by dry-run', async () => {
    dbMocks.getRichMenuGroupWithPages.mockResolvedValue({
      id: 'g1', account_id: 'acc-1', name: 'メニュー', chat_bar_text: 'メニュー', size: 'compact',
      default_page_id: 'p1', is_default_for_all: 0, selected: 1, status: 'published',
      publishing_at: null, generator_key: null, generator_version: null, created_at: '', updated_at: '',
      pages: [{ id: 'p1', group_id: 'g1', order_index: 0, name: '初期', alias_id: 'alias', line_richmenu_id: 'line-menu-1', image_r2_key: null, image_content_type: null, created_at: '', updated_at: '', areas: [] }],
    });
    const res = await setupApp().request('/api/rich-menu-groups/g1/apply-to-tag', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'set-default', dryRun: false }),
    });
    expect(res.status).toBe(428);
  });
});
