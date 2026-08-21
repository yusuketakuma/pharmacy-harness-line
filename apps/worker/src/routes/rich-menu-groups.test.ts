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
const pharmacyPublishGate = vi.hoisted(() => ({
  readiness: vi.fn(), sign: vi.fn(), verify: vi.fn(), signResume: vi.fn(), verifyResume: vi.fn(),
}));
vi.mock('../custom/pharmacy/rich-menu/publish-readiness.js', () => ({
  getPharmacyRichMenuPublishReadiness: pharmacyPublishGate.readiness,
}));
vi.mock('../custom/pharmacy/rich-menu/publish-confirmation.js', () => ({
  PHARMACY_RICH_MENU_PUBLISH_CONFIRMATION_TTL_MS: 300_000,
  signPharmacyRichMenuPublishConfirmation: pharmacyPublishGate.sign,
  verifyPharmacyRichMenuPublishConfirmation: pharmacyPublishGate.verify,
  signPharmacyRichMenuResumeConfirmation: pharmacyPublishGate.signResume,
  verifyPharmacyRichMenuResumeConfirmation: pharmacyPublishGate.verifyResume,
}));
const pharmacyOperationMocks = vi.hoisted(() => ({
  advancePublishPhase: vi.fn(),
  begin: vi.fn(),
  consumeResume: vi.fn(),
  finish: vi.fn(),
  getLifecycle: vi.fn(),
  getOperation: vi.fn(),
  isKnownGood: vi.fn(),
  unresolved: vi.fn(),
  recordExpectedDefault: vi.fn(),
  recordRemoteId: vi.fn(),
}));
vi.mock('../custom/pharmacy/rich-menu/repository.js', () => ({
  advancePharmacyRichMenuPublishPhase: pharmacyOperationMocks.advancePublishPhase,
  beginPharmacyRichMenuOperation: pharmacyOperationMocks.begin,
  consumePharmacyRichMenuResumeConfirmation: pharmacyOperationMocks.consumeResume,
  finishPharmacyRichMenuOperation: pharmacyOperationMocks.finish,
  getPharmacyRichMenuLifecycleControl: pharmacyOperationMocks.getLifecycle,
  getPharmacyRichMenuOperation: pharmacyOperationMocks.getOperation,
  getUnresolvedPharmacyRichMenuOperation: pharmacyOperationMocks.unresolved,
  isPharmacyRichMenuKnownGood: pharmacyOperationMocks.isKnownGood,
  recordPharmacyRichMenuExpectedDefault: pharmacyOperationMocks.recordExpectedDefault,
  recordPharmacyRichMenuRemoteId: pharmacyOperationMocks.recordRemoteId,
}));

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

function makeBoundVersionDb(): D1Database {
  return Object.assign({
    prepare: vi.fn((sql: string) => ({
      bind: vi.fn(() => ({
        all: vi.fn(async () => ({ results: [] })),
        first: vi.fn(async () => sql.includes('pharmacy_rich_menu_draft_bindings') ? { ok: 1 } : null),
        run: vi.fn(async () => ({ meta: { changes: 0 } })),
      })),
    })),
    batch: vi.fn(async () => []),
  } as unknown as D1Database, { __boundPharmacyVersion: true });
}

function setupApp(opts: {
  r2?: R2Bucket;
  db?: D1Database;
  credentialKey?: string | null;
  lifecycleState?: 'inactive' | 'active' | 'frozen';
} = {}) {
  const db = opts.db ?? makeMinimalDbStub();
  const bound = Boolean((db as D1Database & { __boundPharmacyVersion?: boolean }).__boundPharmacyVersion);
  Object.assign(db, { __lifecycleState: opts.lifecycleState ?? (bound ? 'active' : 'inactive') });
  const app = new Hono<TestEnv>();
  app.use('*', async (c, next) => {
    c.set('staff', { id: 'staff-1', role: 'owner' });
    c.set('tenantId', 'tenant-a');
    c.env = {
      DB: db,
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
  lineAccountLookup.mockImplementation(async (_db, _tenantId, accountId) => ({ id: accountId }));
  credentialMocks.readLineCredential.mockReset();
  credentialMocks.readLineCredential.mockResolvedValue('tenant-token');
  pharmacyPublishGate.readiness.mockReset();
  pharmacyPublishGate.sign.mockReset();
  pharmacyPublishGate.verify.mockReset();
  pharmacyPublishGate.signResume.mockReset();
  pharmacyPublishGate.verifyResume.mockReset();
  for (const fn of Object.values(pharmacyOperationMocks)) fn.mockReset();
  pharmacyPublishGate.readiness.mockResolvedValue({
    status: 'READY', reasonCodes: [], evidenceDigest: 'a'.repeat(64),
  });
  pharmacyPublishGate.sign.mockResolvedValue('prmp1.confirmation.signature');
  pharmacyPublishGate.verify.mockResolvedValue(null);
  pharmacyPublishGate.signResume.mockResolvedValue('prmr1.confirmation.signature');
  pharmacyPublishGate.verifyResume.mockResolvedValue(null);
  pharmacyOperationMocks.begin.mockResolvedValue({ id: 'operation-1', status: 'running' });
  pharmacyOperationMocks.advancePublishPhase.mockResolvedValue(undefined);
  pharmacyOperationMocks.consumeResume.mockResolvedValue(undefined);
  pharmacyOperationMocks.finish.mockResolvedValue(undefined);
  pharmacyOperationMocks.getLifecycle.mockImplementation(async (db: D1Database, lineAccountId: string) => {
    const state = (db as D1Database & {
      __lifecycleState?: 'inactive' | 'active' | 'frozen';
    }).__lifecycleState ?? 'inactive';
    return { lineAccountId, state, revision: state === 'inactive' ? 0 : 1, updatedAt: null };
  });
  pharmacyOperationMocks.getOperation.mockResolvedValue(null);
  pharmacyOperationMocks.isKnownGood.mockResolvedValue(false);
  pharmacyOperationMocks.unresolved.mockResolvedValue(null);
  pharmacyOperationMocks.recordExpectedDefault.mockResolvedValue(undefined);
  pharmacyOperationMocks.recordRemoteId.mockResolvedValue(undefined);
  dbMocks.acquirePublishLock.mockResolvedValue('lock-token');
  dbMocks.acquireRichMenuAccountLock.mockResolvedValue({
    groupId: 'account-lock-group', token: 'account-lock-token',
  });
});

// ----- GET /api/rich-menu-groups -----

describe('GET /api/rich-menu-groups', () => {
  test('does not list another tenant account rich menus', async () => {
    lineAccountLookup.mockResolvedValue(null);

    const res = await setupApp().request('/api/rich-menu-groups?accountId=account-other');

    expect(res.status).toBe(404);
    expect(dbMocks.getRichMenuGroups).not.toHaveBeenCalled();
  });

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

  test('does not trust a browser request that omits another tenant account scope', async () => {
    dbMocks.getRichMenuGroupWithPages.mockResolvedValue({
      id: 'g1', account_id: 'account-other', name: 'A', chat_bar_text: 'メニュー', size: 'compact',
      default_page_id: null, is_default_for_all: 0, selected: 1, status: 'draft',
      publishing_at: null, generator_key: null, generator_version: null,
      created_at: '', updated_at: '', pages: [],
    });
    lineAccountLookup.mockResolvedValue(null);

    const res = await setupApp().request('/api/rich-menu-groups/g1');

    expect(res.status).toBe(404);
    expect(lineAccountLookup).toHaveBeenCalledWith(expect.anything(), 'tenant-a', 'account-other');
  });
});

// ----- POST /api/rich-menu-groups -----

describe('POST /api/rich-menu-groups', () => {
  test('does not create a rich menu for another tenant account', async () => {
    lineAccountLookup.mockResolvedValue(null);

    const res = await setupApp().request('/api/rich-menu-groups', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        accountId: 'account-other', name: 'x', chatBarText: 'x', size: 'large',
        pages: [{ name: 'p', orderIndex: 0, areas: [] }],
      }),
    });

    expect(res.status).toBe(404);
    expect(dbMocks.createRichMenuGroup).not.toHaveBeenCalled();
  });

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
  test('does not allow a generic editor to mutate an immutable pharmacy version', async () => {
    dbMocks.getRichMenuGroupById.mockResolvedValue({
      id: 'g1', account_id: 'acc-1', status: 'draft',
    });

    const res = await setupApp({ db: makeBoundVersionDb() }).request('/api/rich-menu-groups/g1', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'changed' }),
    });

    expect(res.status).toBe(409);
    expect(dbMocks.updateRichMenuGroupMeta).not.toHaveBeenCalled();
    expect(dbMocks.replaceRichMenuPages).not.toHaveBeenCalled();
  });

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

  test('force cannot bypass saved pharmacy version deletion protections', async () => {
    dbMocks.getRichMenuGroupById.mockResolvedValue({
      id: 'g1', account_id: 'acc-1', status: 'draft',
    });
    const res = await setupApp({ db: makeBoundVersionDb() }).request(
      '/api/rich-menu-groups/g1?force=true', { method: 'DELETE' },
    );
    expect(res.status).toBe(409);
    expect(dbMocks.deleteRichMenuGroup).not.toHaveBeenCalled();
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
  test('does not allow image replacement on an immutable pharmacy version', async () => {
    dbMocks.pageBelongsToGroup.mockResolvedValue(true);
    dbMocks.getRichMenuGroupById.mockResolvedValue({
      id: 'g1', account_id: 'acc-1', size: 'large', status: 'draft',
    });
    const r2 = makeR2Stub();

    const res = await setupApp({ db: makeBoundVersionDb(), r2 }).request(
      '/api/rich-menu-groups/g1/pages/p1/image',
      { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: PNG_2500x1686 },
    );

    expect(res.status).toBe(409);
    expect(dbMocks.setRichMenuPageImage).not.toHaveBeenCalled();
  });

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
    lineAccountLookup.mockResolvedValue({ id: 'acc-1' });
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

  test('does not serve a linked image outside the authenticated tenant', async () => {
    lineAccountLookup.mockResolvedValue(null);
    const r2 = makeR2Stub();
    const key = 'rich-menus/acc-other/group-1/page-1/image.png';
    await r2.put(key, new Uint8Array([1, 2, 3]), { httpMetadata: { contentType: 'image/png' } });
    const db = makeMinimalDbStub();
    vi.mocked(db.prepare).mockImplementation(() => ({
      bind: vi.fn(() => ({ first: vi.fn(async () => ({ ok: 1 })) })),
    }) as unknown as D1PreparedStatement);

    const res = await setupApp({ r2, db }).request(`/api/rich-menu-images/${encodeURIComponent(key)}`);

    expect(res.status).toBe(404);
  });

  test('does not serve an orphaned same-account R2 object', async () => {
    lineAccountLookup.mockResolvedValue({ id: 'acc-1' });
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
  test('blocks both a frozen v0.30 version and an active legacy bypass before LINE', async () => {
    const group = {
      id: 'g1', account_id: 'acc-1', name: 'Menu', chat_bar_text: 'Menu', size: 'compact',
      default_page_id: 'p1', is_default_for_all: 0, selected: 1, status: 'draft',
      publishing_at: null, generator_key: null, generator_version: null,
      created_at: '', updated_at: '', pages: [],
    };
    dbMocks.getRichMenuGroupWithPages.mockResolvedValue(group);
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const frozen = await setupApp({ db: makeBoundVersionDb(), lifecycleState: 'frozen' }).request(
      '/api/rich-menu-groups/g1/publish?accountId=acc-1', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dryRun: true }),
      },
    );
    expect(frozen.status).toBe(409);

    const legacy = await setupApp({ lifecycleState: 'active' }).request(
      '/api/rich-menu-groups/g1/publish?accountId=acc-1', { method: 'POST' },
    );
    expect(legacy.status).toBe(409);
    expect(dbMocks.acquireRichMenuAccountLock).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  test('requires a pharmacy dry-run confirmation for an immutable version before LINE', async () => {
    dbMocks.getRichMenuGroupWithPages.mockResolvedValue({
      id: 'g1', account_id: 'acc-1', name: 'x', chat_bar_text: 'メニュー', size: 'large',
      default_page_id: 'p1', is_default_for_all: 0, status: 'draft', publishing_at: null,
      created_at: '', updated_at: '', pages: [],
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const res = await setupApp({ db: makeBoundVersionDb() }).request(
      '/api/rich-menu-groups/g1/publish', { method: 'POST' },
    );

    expect(res.status).toBe(428);
    expect(dbMocks.acquireRichMenuAccountLock).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  test('returns a bounded confirmation for a READY immutable version without LINE calls', async () => {
    const version = {
      id: 'g1', account_id: 'acc-1', name: 'x', chat_bar_text: 'メニュー', size: 'large',
      default_page_id: 'p1', is_default_for_all: 0, status: 'draft', publishing_at: null,
      created_at: '', updated_at: '', pages: [],
    };
    dbMocks.getRichMenuGroupWithPages.mockResolvedValue(version);
    dbMocks.getLineAccountById.mockResolvedValue({ id: 'acc-1', liff_id: '1234567890-AbCd' });
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const res = await setupApp({ db: makeBoundVersionDb() }).request(
      '/api/rich-menu-groups/g1/publish?accountId=acc-1', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dryRun: true }),
      },
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      success: true, data: { dryRun: true, confirmationToken: 'prmp1.confirmation.signature' },
    });
    expect(pharmacyPublishGate.readiness).toHaveBeenCalledWith(expect.objectContaining({
      accountId: 'acc-1', liffId: '1234567890-AbCd', group: version,
    }));
    expect(pharmacyPublishGate.sign).toHaveBeenCalledOnce();
    expect(credentialMocks.readLineCredential).not.toHaveBeenCalled();
    expect(dbMocks.acquireRichMenuAccountLock).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  test('returns tap diagnostics before signing or calling LINE', async () => {
    dbMocks.getRichMenuGroupWithPages.mockResolvedValue({
      id: 'g1', account_id: 'acc-1', name: 'x', chat_bar_text: 'メニュー', size: 'compact',
      default_page_id: 'p1', is_default_for_all: 0, status: 'draft', publishing_at: null,
      created_at: '', updated_at: '', pages: [],
    });
    dbMocks.getLineAccountById.mockResolvedValue({ id: 'acc-1', liff_id: '1234567890-AbCd' });
    pharmacyPublishGate.readiness.mockResolvedValue({
      status: 'BLOCKED', reasonCodes: ['ACTION_URI_INVALID'], evidenceDigest: null,
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const res = await setupApp({ db: makeBoundVersionDb() }).request(
      '/api/rich-menu-groups/g1/publish?accountId=acc-1', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dryRun: true }),
      },
    );

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      data: { status: 'BLOCKED', reasonCodes: ['ACTION_URI_INVALID'] },
    });
    expect(pharmacyPublishGate.sign).not.toHaveBeenCalled();
    expect(credentialMocks.readLineCredential).not.toHaveBeenCalled();
    expect(dbMocks.acquireRichMenuAccountLock).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  test('accepts only a matching immutable-version confirmation before entering publish', async () => {
    dbMocks.getRichMenuGroupWithPages.mockResolvedValue({
      id: 'g1', account_id: 'acc-1', name: 'x', chat_bar_text: 'メニュー', size: 'compact',
      default_page_id: 'p1', is_default_for_all: 0, status: 'draft', publishing_at: null,
      created_at: '', updated_at: '', pages: [],
    });
    dbMocks.getLineAccountById.mockResolvedValue({ id: 'acc-1', liff_id: '1234567890-AbCd' });
    pharmacyPublishGate.verify.mockResolvedValue({
      tenantId: 'tenant-a', accountId: 'acc-1', groupId: 'g1',
      confirmationId: 'confirmation-publish-1',
      evidenceDigest: 'a'.repeat(64), expiresAt: Date.now() + 60_000,
    });
    dbMocks.acquireRichMenuAccountLock.mockResolvedValue(null);

    const res = await setupApp({ db: makeBoundVersionDb() }).request(
      '/api/rich-menu-groups/g1/publish?accountId=acc-1', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dryRun: false, confirmationToken: 'prmp1.confirmation.signature' }),
      },
    );

    expect(res.status).toBe(409);
    expect(dbMocks.acquireRichMenuAccountLock).toHaveBeenCalledWith(expect.anything(), 'acc-1');
  });

  test('records immutable publish intent and remote id before the next LINE call', async () => {
    const events: string[] = [];
    const r2 = makeR2Stub();
    const imageKey = 'rich-menus/acc-1/gid12345-aaaa/p1/menu.jpg';
    await r2.put(imageKey, new Uint8Array([1, 2, 3]), {
      httpMetadata: { contentType: 'image/jpeg' },
    });
    dbMocks.getRichMenuGroupWithPages.mockResolvedValue({
      id: 'gid12345-aaaa', account_id: 'acc-1', name: 'x', chat_bar_text: 'メニュー', size: 'compact',
      default_page_id: 'p1', is_default_for_all: 0, selected: 1, status: 'draft', publishing_at: null,
      created_at: '', updated_at: '', pages: [{
        id: 'p1', group_id: 'gid12345-aaaa', order_index: 0, name: 'p1', alias_id: null,
        line_richmenu_id: null, image_r2_key: imageKey, image_content_type: 'image/jpeg',
        created_at: '', updated_at: '', areas: [],
      }],
    });
    dbMocks.getLineAccountById.mockResolvedValue({ id: 'acc-1', liff_id: '1234567890-AbCd' });
    pharmacyPublishGate.verify.mockResolvedValue({
      tenantId: 'tenant-a', accountId: 'acc-1', groupId: 'gid12345-aaaa',
      confirmationId: 'confirmation-publish-2',
      evidenceDigest: 'a'.repeat(64), expiresAt: Date.now() + 60_000,
    });
    pharmacyOperationMocks.begin.mockImplementation(async () => {
      events.push('intent');
      return { id: 'operation-1', status: 'running' };
    });
    pharmacyOperationMocks.advancePublishPhase.mockImplementation(async (_db, input) => {
      events.push(input.phase);
    });
    pharmacyOperationMocks.finish.mockImplementation(async () => { events.push('succeeded'); });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === 'https://api.line.me/v2/bot/richmenu' && init?.method === 'POST') {
        events.push('create');
        return new Response(JSON.stringify({ richMenuId: 'line-menu-new' }), { status: 200 });
      }
      if (url.endsWith('/richmenu/line-menu-new/content') && init?.method === 'POST') {
        events.push('upload');
        return new Response(null, { status: 200 });
      }
      if (url.endsWith('/richmenu/alias') && init?.method === 'POST') {
        events.push('alias');
        return new Response(null, { status: 200 });
      }
      throw new Error(`unexpected LINE request: ${init?.method} ${url}`);
    });

    const res = await setupApp({ db: makeBoundVersionDb(), r2 }).request(
      '/api/rich-menu-groups/gid12345-aaaa/publish?accountId=acc-1', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dryRun: false, confirmationToken: 'prmp1.confirmation.signature' }),
      },
    );

    expect(res.status).toBe(200);
    expect(events).toEqual([
      'intent', 'create', 'remote_created', 'upload', 'image_uploaded',
      'alias', 'alias_created', 'committed', 'succeeded',
    ]);
    expect(pharmacyOperationMocks.begin).toHaveBeenCalledWith(expect.anything(), {
      lineAccountId: 'acc-1', groupId: 'gid12345-aaaa', kind: 'publish',
      confirmationId: 'confirmation-publish-2',
      evidenceDigest: 'a'.repeat(64), expectedDefaultMenuId: null,
      publishAliasId: 'lhx-gid12345-confirmation-0',
      publishMenuName: 'pharmacy:gid12345:confirmation',
    });
    expect(pharmacyOperationMocks.finish).toHaveBeenCalledWith(expect.anything(), {
      lineAccountId: 'acc-1', operationId: 'operation-1',
      expectedStatus: 'running', status: 'succeeded',
    });
    fetchSpy.mockRestore();
  });

  test('rejects a consumed immutable publish confirmation before LINE', async () => {
    dbMocks.getRichMenuGroupWithPages.mockResolvedValue({
      id: 'g1', account_id: 'acc-1', name: 'x', chat_bar_text: 'メニュー', size: 'compact',
      default_page_id: 'p1', is_default_for_all: 0, selected: 1, status: 'draft', publishing_at: null,
      created_at: '', updated_at: '', pages: [{
        id: 'p1', group_id: 'g1', order_index: 0, name: 'p1', alias_id: null,
        line_richmenu_id: null, image_r2_key: 'key', image_content_type: 'image/jpeg',
        created_at: '', updated_at: '', areas: [],
      }],
    });
    dbMocks.getLineAccountById.mockResolvedValue({ id: 'acc-1', liff_id: '1234567890-AbCd' });
    pharmacyPublishGate.verify.mockResolvedValue({
      tenantId: 'tenant-a', accountId: 'acc-1', groupId: 'g1',
      confirmationId: 'confirmation-replayed',
      evidenceDigest: 'a'.repeat(64), expiresAt: Date.now() + 60_000,
    });
    pharmacyOperationMocks.begin.mockRejectedValue(
      new Error('pharmacy rich-menu confirmation already used'),
    );
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const res = await setupApp({ db: makeBoundVersionDb() }).request(
      '/api/rich-menu-groups/g1/publish?accountId=acc-1', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dryRun: false, confirmationToken: 'prmp1.confirmation.signature' }),
      },
    );

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'pharmacy rich-menu confirmation already used' });
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  test('blocks an unresolved immutable publish before another LINE call', async () => {
    dbMocks.getRichMenuGroupWithPages.mockResolvedValue({
      id: 'g1', account_id: 'acc-1', name: 'x', chat_bar_text: 'メニュー', size: 'compact',
      default_page_id: 'p1', is_default_for_all: 0, selected: 1, status: 'draft', publishing_at: null,
      created_at: '', updated_at: '', pages: [],
    });
    dbMocks.getLineAccountById.mockResolvedValue({ id: 'acc-1', liff_id: '1234567890-AbCd' });
    pharmacyPublishGate.verify.mockResolvedValue({
      tenantId: 'tenant-a', accountId: 'acc-1', groupId: 'g1',
      confirmationId: 'confirmation-publish-3',
      evidenceDigest: 'a'.repeat(64), expiresAt: Date.now() + 60_000,
    });
    pharmacyOperationMocks.unresolved.mockResolvedValue({ id: 'old-operation', status: 'unknown' });
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const res = await setupApp({ db: makeBoundVersionDb() }).request(
      '/api/rich-menu-groups/g1/publish?accountId=acc-1', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dryRun: false, confirmationToken: 'prmp1.confirmation.signature' }),
      },
    );

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      success: false, data: { operationId: 'old-operation', status: 'unknown' },
    });
    expect(pharmacyOperationMocks.begin).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  test('marks an immutable publish unknown when the LINE result cannot be proven', async () => {
    const r2 = makeR2Stub();
    const imageKey = 'rich-menus/acc-1/gid12345-aaaa/p1/menu.jpg';
    await r2.put(imageKey, new Uint8Array([1, 2, 3]), {
      httpMetadata: { contentType: 'image/jpeg' },
    });
    dbMocks.getRichMenuGroupWithPages.mockResolvedValue({
      id: 'gid12345-aaaa', account_id: 'acc-1', name: 'x', chat_bar_text: 'メニュー', size: 'compact',
      default_page_id: 'p1', is_default_for_all: 0, selected: 1, status: 'draft', publishing_at: null,
      created_at: '', updated_at: '', pages: [{
        id: 'p1', group_id: 'gid12345-aaaa', order_index: 0, name: 'p1', alias_id: null,
        line_richmenu_id: null, image_r2_key: imageKey, image_content_type: 'image/jpeg',
        created_at: '', updated_at: '', areas: [],
      }],
    });
    dbMocks.getLineAccountById.mockResolvedValue({ id: 'acc-1', liff_id: '1234567890-AbCd' });
    pharmacyPublishGate.verify.mockResolvedValue({
      tenantId: 'tenant-a', accountId: 'acc-1', groupId: 'gid12345-aaaa',
      confirmationId: 'confirmation-publish-4',
      evidenceDigest: 'a'.repeat(64), expiresAt: Date.now() + 60_000,
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === 'https://api.line.me/v2/bot/richmenu' && init?.method === 'POST') {
        return new Response(JSON.stringify({ richMenuId: 'line-menu-new' }), { status: 200 });
      }
      if (url.endsWith('/richmenu/line-menu-new/content') && init?.method === 'POST') {
        throw new Error('network result unknown');
      }
      if (url.endsWith('/richmenu/line-menu-new') && init?.method === 'DELETE') {
        return new Response(null, { status: 200 });
      }
      throw new Error(`unexpected LINE request: ${init?.method} ${url}`);
    });

    const res = await setupApp({ db: makeBoundVersionDb(), r2 }).request(
      '/api/rich-menu-groups/gid12345-aaaa/publish?accountId=acc-1', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dryRun: false, confirmationToken: 'prmp1.confirmation.signature' }),
      },
    );

    expect(res.status).toBe(500);
    expect(pharmacyOperationMocks.finish).toHaveBeenCalledWith(expect.anything(), {
      lineAccountId: 'acc-1', operationId: 'operation-1', expectedStatus: 'running',
      status: 'unknown', reasonCode: 'LINE_RESULT_UNKNOWN',
    });
    fetchSpy.mockRestore();
  });

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
  test('blocks orphan deletion after the v0.30 lifecycle is activated', async () => {
    dbMocks.getLineAccountById.mockResolvedValue({ id: 'acc-1' });
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const response = await setupApp({ lifecycleState: 'active' }).request(
      '/api/rich-menu-groups/external/orphan-menu?accountId=acc-1', { method: 'DELETE' },
    );

    expect(response.status).toBe(409);
    expect(credentialMocks.readLineCredential).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

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

describe('POST /api/rich-menu-groups/operations/:operationId/reconcile', () => {
  const publishedGroup = {
    id: 'g1', account_id: 'acc-1', name: 'メニュー', chat_bar_text: 'メニュー', size: 'compact',
    default_page_id: 'p1', is_default_for_all: 0, selected: 1, status: 'published',
    publishing_at: null, generator_key: null, generator_version: null, created_at: '', updated_at: '',
    pages: [{
      id: 'p1', group_id: 'g1', order_index: 0, name: '初期', alias_id: 'alias',
      line_richmenu_id: 'line-menu-new', image_r2_key: 'key', image_content_type: 'image/jpeg',
      created_at: '', updated_at: '', areas: [],
    }],
  };

  test('reconciles an unknown default operation to succeeded after fresh read-back', async () => {
    pharmacyOperationMocks.getOperation.mockResolvedValue({
      id: 'operation-1', groupId: 'g1', lineAccountId: 'acc-1', kind: 'set_default',
      status: 'unknown', expectedDefaultMenuId: 'line-menu-old', defaultReadAt: '2026-08-21T00:00:00Z',
      remoteRichMenuId: 'line-menu-new',
    });
    dbMocks.getRichMenuGroupWithPages.mockResolvedValue(publishedGroup);
    dbMocks.getLineAccountById.mockResolvedValue({ id: 'acc-1' });
    const db = makeMinimalDbStub();
    db.batch = vi.fn(async () => [
      { meta: { changes: 1 } }, { meta: { changes: 1 } },
    ] as unknown as D1Result<unknown>[]) as D1Database['batch'];
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      expect(String(input)).toBe('https://api.line.me/v2/bot/user/all/richmenu');
      expect(init?.method).toBe('GET');
      return new Response(JSON.stringify({ richMenuId: 'line-menu-new' }), { status: 200 });
    });

    const response = await setupApp({ db }).request(
      '/api/rich-menu-groups/operations/operation-1/reconcile?accountId=acc-1',
      { method: 'POST' },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ data: { status: 'succeeded' } });
    expect(pharmacyOperationMocks.finish).toHaveBeenCalledWith(db, {
      lineAccountId: 'acc-1', operationId: 'operation-1', expectedStatus: 'unknown',
      status: 'succeeded', verifiedDefaultMenuId: 'line-menu-new',
    });
    expect(fetchSpy).toHaveBeenCalledOnce();
    fetchSpy.mockRestore();
  });

  test('reconciles a definitely unchanged remote default to failed without mutation', async () => {
    pharmacyOperationMocks.getOperation.mockResolvedValue({
      id: 'operation-1', groupId: 'g1', lineAccountId: 'acc-1', kind: 'rollback',
      status: 'unknown', expectedDefaultMenuId: 'line-menu-new', defaultReadAt: '2026-08-21T00:00:00Z',
      remoteRichMenuId: 'line-menu-old',
    });
    dbMocks.getRichMenuGroupWithPages.mockResolvedValue(publishedGroup);
    dbMocks.getLineAccountById.mockResolvedValue({ id: 'acc-1' });
    const db = makeMinimalDbStub();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ richMenuId: 'line-menu-new' }), { status: 200 }),
    );

    const response = await setupApp({ db }).request(
      '/api/rich-menu-groups/operations/operation-1/reconcile?accountId=acc-1',
      { method: 'POST' },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ data: { status: 'failed' } });
    expect(pharmacyOperationMocks.finish).toHaveBeenCalledWith(db, {
      lineAccountId: 'acc-1', operationId: 'operation-1', expectedStatus: 'unknown',
      status: 'failed', reasonCode: 'REMOTE_DEFAULT_UNCHANGED',
    });
    expect(db.batch).not.toHaveBeenCalled();
    expect(fetchSpy).toHaveBeenCalledOnce();
    fetchSpy.mockRestore();
  });

  test('keeps a divergent remote default unknown and hides cross-account operations', async () => {
    pharmacyOperationMocks.getOperation.mockResolvedValueOnce(null).mockResolvedValueOnce({
      id: 'operation-1', groupId: 'g1', lineAccountId: 'acc-1', kind: 'set_default',
      status: 'unknown', expectedDefaultMenuId: 'line-menu-old', defaultReadAt: '2026-08-21T00:00:00Z',
      remoteRichMenuId: 'line-menu-new',
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const hidden = await setupApp().request(
      '/api/rich-menu-groups/operations/operation-1/reconcile?accountId=acc-2',
      { method: 'POST' },
    );
    expect(hidden.status).toBe(404);
    expect(fetchSpy).not.toHaveBeenCalled();

    dbMocks.getRichMenuGroupWithPages.mockResolvedValue(publishedGroup);
    dbMocks.getLineAccountById.mockResolvedValue({ id: 'acc-1' });
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ richMenuId: 'line-menu-third' }), { status: 200 }),
    );
    const divergent = await setupApp().request(
      '/api/rich-menu-groups/operations/operation-1/reconcile?accountId=acc-1',
      { method: 'POST' },
    );
    expect(divergent.status).toBe(409);
    expect(await divergent.json()).toMatchObject({ data: { status: 'unknown' } });
    expect(pharmacyOperationMocks.finish).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  test('reconciles publish stages with GET only and reports a safely resumable missing image', async () => {
    pharmacyOperationMocks.getOperation.mockResolvedValue({
      id: 'operation-1', groupId: 'g1', lineAccountId: 'acc-1', kind: 'publish',
      status: 'unknown', evidenceDigest: 'a'.repeat(64), publishPhase: 'remote_created',
      publishAliasId: 'lhx-g1-confirmation-0', publishMenuName: 'pharmacy:g1:confirmation',
      expectedDefaultMenuId: null, remoteRichMenuId: 'line-menu-new',
    });
    const draftGroup = {
      ...publishedGroup, status: 'draft',
      pages: [{ ...publishedGroup.pages[0], alias_id: 'draft-alias', line_richmenu_id: null }],
    };
    dbMocks.getRichMenuGroupWithPages.mockResolvedValue(draftGroup);
    dbMocks.getLineAccountById.mockResolvedValue({ id: 'acc-1', liff_id: '1234567890-AbCd' });
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ richmenus: [{
        richMenuId: 'line-menu-new', size: { width: 2500, height: 843 }, selected: true,
        name: 'pharmacy:g1:confirmation', chatBarText: 'メニュー', areas: [],
      }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 404 }));
    const response = await setupApp({ db: makeMinimalDbStub() }).request(
      '/api/rich-menu-groups/operations/operation-1/reconcile?accountId=acc-1',
      { method: 'POST' },
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      data: {
        status: 'unknown', reasonCode: 'PUBLISH_IMAGE_MISSING',
        publishPhase: 'remote_created', resumableStage: 'image_upload',
      },
    });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(fetchSpy.mock.calls.every(([, init]) => init?.method === 'GET')).toBe(true);
    expect(pharmacyOperationMocks.advancePublishPhase).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  test('commits a publish after remote menu, exact image, and alias are all read back', async () => {
    pharmacyOperationMocks.getOperation.mockResolvedValue({
      id: 'operation-1', groupId: 'g1', lineAccountId: 'acc-1', kind: 'publish',
      status: 'unknown', evidenceDigest: 'a'.repeat(64), publishPhase: 'remote_created',
      publishAliasId: 'lhx-g1-confirmation-0', publishMenuName: 'pharmacy:g1:confirmation',
      expectedDefaultMenuId: null, remoteRichMenuId: 'line-menu-new',
    });
    const draftGroup = {
      ...publishedGroup, status: 'draft',
      pages: [{ ...publishedGroup.pages[0], alias_id: 'draft-alias', line_richmenu_id: null }],
    };
    dbMocks.getRichMenuGroupWithPages.mockResolvedValue(draftGroup);
    dbMocks.getLineAccountById.mockResolvedValue({ id: 'acc-1', liff_id: '1234567890-AbCd' });
    const r2 = makeR2Stub();
    await r2.put('key', new Uint8Array([1, 2, 3]), {
      httpMetadata: { contentType: 'image/jpeg' },
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ richmenus: [{
        richMenuId: 'line-menu-new', size: { width: 2500, height: 843 }, selected: true,
        name: 'pharmacy:g1:confirmation', chatBarText: 'メニュー', areas: [],
      }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3]), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ richMenuId: 'line-menu-new' }), { status: 200 }));
    const db = makeMinimalDbStub();
    const response = await setupApp({ db, r2 }).request(
      '/api/rich-menu-groups/operations/operation-1/reconcile?accountId=acc-1',
      { method: 'POST' },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      data: { status: 'succeeded', publishPhase: 'committed' },
    });
    expect(pharmacyOperationMocks.advancePublishPhase.mock.calls.map(([, input]) => input.phase))
      .toEqual(['image_uploaded', 'alias_created', 'committed']);
    expect(dbMocks.markRichMenuGroupPublished).toHaveBeenCalledWith(
      db, 'g1', 'account-lock-group', 'account-lock-token', [{
        pageId: 'p1', aliasId: 'lhx-g1-confirmation-0', lineRichMenuId: 'line-menu-new',
      }],
    );
    expect(pharmacyOperationMocks.finish).toHaveBeenCalledWith(db, {
      lineAccountId: 'acc-1', operationId: 'operation-1', expectedStatus: 'unknown',
      status: 'succeeded',
    });
    expect(fetchSpy.mock.calls.every(([, init]) => init?.method === 'GET')).toBe(true);
    fetchSpy.mockRestore();
  });
});

describe('POST /api/rich-menu-groups/operations/:operationId/resume', () => {
  const draftGroup = {
    id: 'g1', account_id: 'acc-1', name: 'メニュー', chat_bar_text: 'メニュー', size: 'compact',
    default_page_id: 'p1', is_default_for_all: 0, selected: 1, status: 'draft',
    publishing_at: null, generator_key: null, generator_version: null, created_at: '', updated_at: '',
    pages: [{
      id: 'p1', group_id: 'g1', order_index: 0, name: '初期', alias_id: 'draft-alias',
      line_richmenu_id: null, image_r2_key: 'key', image_content_type: 'image/jpeg',
      created_at: '', updated_at: '', areas: [],
    }],
  };
  const operation = {
    id: 'operation-1', groupId: 'g1', lineAccountId: 'acc-1', kind: 'publish',
    status: 'unknown', evidenceDigest: 'a'.repeat(64), publishPhase: 'remote_created',
    publishAliasId: 'lhx-g1-confirmation-0', publishMenuName: 'pharmacy:g1:confirmation',
    expectedDefaultMenuId: null, remoteRichMenuId: 'line-menu-new',
  };

  test('blocks resume while code rollback freeze is active', async () => {
    pharmacyOperationMocks.getOperation.mockResolvedValue(operation);
    dbMocks.getRichMenuGroupWithPages.mockResolvedValue(draftGroup);
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const response = await setupApp({ lifecycleState: 'frozen' }).request(
      '/api/rich-menu-groups/operations/operation-1/resume?accountId=acc-1', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dryRun: true }),
      },
    );

    expect(response.status).toBe(409);
    expect(pharmacyPublishGate.readiness).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  test('issues a phase-bound resume confirmation without LINE calls', async () => {
    pharmacyOperationMocks.getOperation.mockResolvedValue(operation);
    dbMocks.getRichMenuGroupWithPages.mockResolvedValue(draftGroup);
    dbMocks.getLineAccountById.mockResolvedValue({ id: 'acc-1', liff_id: '1234567890-AbCd' });
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const response = await setupApp({ lifecycleState: 'active' }).request(
      '/api/rich-menu-groups/operations/operation-1/resume?accountId=acc-1',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dryRun: true }) },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      data: {
        dryRun: true, confirmationToken: 'prmr1.confirmation.signature',
        publishPhase: 'remote_created', nextStage: 'image_upload',
      },
    });
    expect(pharmacyPublishGate.signResume).toHaveBeenCalledWith('root-key-v1', expect.objectContaining({
      tenantId: 'tenant-a', accountId: 'acc-1', groupId: 'g1', operationId: 'operation-1',
      publishPhase: 'remote_created', evidenceDigest: 'a'.repeat(64),
    }));
    expect(pharmacyOperationMocks.consumeResume).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  test('consumes confirmation before resuming only the missing image stage and verifies read-back', async () => {
    const events: string[] = [];
    pharmacyOperationMocks.getOperation.mockResolvedValue(operation);
    dbMocks.getRichMenuGroupWithPages.mockResolvedValue(draftGroup);
    dbMocks.getLineAccountById.mockResolvedValue({ id: 'acc-1', liff_id: '1234567890-AbCd' });
    pharmacyPublishGate.verifyResume.mockResolvedValue({
      tenantId: 'tenant-a', accountId: 'acc-1', groupId: 'g1', operationId: 'operation-1',
      confirmationId: 'resume-confirmation-1', publishPhase: 'remote_created',
      evidenceDigest: 'a'.repeat(64), expiresAt: Date.now() + 60_000,
    });
    pharmacyOperationMocks.consumeResume.mockImplementation(async () => { events.push('consume'); });
    pharmacyOperationMocks.advancePublishPhase.mockImplementation(async (_db, input) => {
      events.push(`phase:${input.phase}`);
    });
    const r2 = makeR2Stub();
    await r2.put('key', new Uint8Array([1, 2, 3]), {
      httpMetadata: { contentType: 'image/jpeg' },
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      events.push(`${init?.method}:${url.includes('/content') ? 'content' : 'list'}`);
      if (url.endsWith('/richmenu/list')) return new Response(JSON.stringify({ richmenus: [{
        richMenuId: 'line-menu-new', size: { width: 2500, height: 843 }, selected: true,
        name: 'pharmacy:g1:confirmation', chatBarText: 'メニュー', areas: [],
      }] }), { status: 200 });
      if (url.endsWith('/content') && init?.method === 'GET' &&
          events.filter((event) => event === 'GET:content').length === 1) {
        return new Response(null, { status: 404 });
      }
      if (url.endsWith('/content') && init?.method === 'POST') return new Response(null, { status: 200 });
      if (url.endsWith('/content') && init?.method === 'GET') {
        return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
      }
      throw new Error(`unexpected LINE request: ${init?.method} ${url}`);
    });

    const response = await setupApp({ r2, lifecycleState: 'active' }).request(
      '/api/rich-menu-groups/operations/operation-1/resume?accountId=acc-1',
      {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dryRun: false, confirmationToken: 'prmr1.confirmation.signature' }),
      },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      data: { status: 'unknown', publishPhase: 'image_uploaded' },
    });
    expect(events).toEqual([
      'consume', 'GET:list', 'GET:content', 'POST:content', 'GET:content',
      'phase:image_uploaded',
    ]);
    expect(pharmacyOperationMocks.consumeResume).toHaveBeenCalledWith(expect.anything(), {
      lineAccountId: 'acc-1', operationId: 'operation-1',
      confirmationId: 'resume-confirmation-1', publishPhase: 'remote_created',
      evidenceDigest: 'a'.repeat(64),
    });
    fetchSpy.mockRestore();
  });

  test('creates a missing uniquely named candidate only after consuming the intent confirmation', async () => {
    const intentOperation = {
      ...operation, publishPhase: 'intent_recorded', remoteRichMenuId: null,
    };
    pharmacyOperationMocks.getOperation.mockResolvedValue(intentOperation);
    dbMocks.getRichMenuGroupWithPages.mockResolvedValue(draftGroup);
    dbMocks.getLineAccountById.mockResolvedValue({ id: 'acc-1', liff_id: '1234567890-AbCd' });
    pharmacyPublishGate.verifyResume.mockResolvedValue({
      tenantId: 'tenant-a', accountId: 'acc-1', groupId: 'g1', operationId: 'operation-1',
      confirmationId: 'resume-create-1', publishPhase: 'intent_recorded',
      evidenceDigest: 'a'.repeat(64), expiresAt: Date.now() + 60_000,
    });
    const events: string[] = [];
    pharmacyOperationMocks.consumeResume.mockImplementation(async () => { events.push('consume'); });
    pharmacyOperationMocks.advancePublishPhase.mockImplementation(async () => { events.push('phase'); });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      events.push(`${init?.method}:${String(input).endsWith('/list') ? 'list' : 'create'}`);
      return String(input).endsWith('/list')
        ? new Response(JSON.stringify({ richmenus: [] }), { status: 200 })
        : new Response(JSON.stringify({ richMenuId: 'line-menu-created' }), { status: 200 });
    });

    const response = await setupApp({ lifecycleState: 'active' }).request(
      '/api/rich-menu-groups/operations/operation-1/resume?accountId=acc-1',
      {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dryRun: false, confirmationToken: 'prmr1.confirmation.signature' }),
      },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ data: { publishPhase: 'remote_created' } });
    expect(events).toEqual(['consume', 'GET:list', 'POST:create', 'phase']);
    expect(pharmacyOperationMocks.advancePublishPhase).toHaveBeenCalledWith(expect.anything(), {
      lineAccountId: 'acc-1', operationId: 'operation-1', expectedPhase: 'intent_recorded',
      phase: 'remote_created', remoteRichMenuId: 'line-menu-created',
    });
    fetchSpy.mockRestore();
  });

  test('creates only the missing alias and verifies its target', async () => {
    const aliasOperation = { ...operation, publishPhase: 'image_uploaded' };
    pharmacyOperationMocks.getOperation.mockResolvedValue(aliasOperation);
    dbMocks.getRichMenuGroupWithPages.mockResolvedValue(draftGroup);
    dbMocks.getLineAccountById.mockResolvedValue({ id: 'acc-1', liff_id: '1234567890-AbCd' });
    pharmacyPublishGate.verifyResume.mockResolvedValue({
      tenantId: 'tenant-a', accountId: 'acc-1', groupId: 'g1', operationId: 'operation-1',
      confirmationId: 'resume-alias-1', publishPhase: 'image_uploaded',
      evidenceDigest: 'a'.repeat(64), expiresAt: Date.now() + 60_000,
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ richmenus: [{
        richMenuId: 'line-menu-new', size: { width: 2500, height: 843 }, selected: true,
        name: 'pharmacy:g1:confirmation', chatBarText: 'メニュー', areas: [],
      }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ richMenuId: 'line-menu-new' }), { status: 200 }));

    const response = await setupApp({ lifecycleState: 'active' }).request(
      '/api/rich-menu-groups/operations/operation-1/resume?accountId=acc-1',
      {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dryRun: false, confirmationToken: 'prmr1.confirmation.signature' }),
      },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ data: { publishPhase: 'alias_created' } });
    expect(fetchSpy.mock.calls.map(([, init]) => init?.method)).toEqual(['GET', 'GET', 'POST', 'GET']);
    expect(pharmacyOperationMocks.advancePublishPhase).toHaveBeenCalledWith(expect.anything(), {
      lineAccountId: 'acc-1', operationId: 'operation-1', expectedPhase: 'image_uploaded',
      phase: 'alias_created',
    });
    fetchSpy.mockRestore();
  });
});

describe('POST /api/rich-menu-groups/:groupId/unpublish', () => {
  test('does not let the legacy cleanup path delete an immutable pharmacy version', async () => {
    dbMocks.getRichMenuGroupWithPages.mockResolvedValue({
      id: 'g1', account_id: 'acc-1', name: 'Menu', chat_bar_text: 'Menu', size: 'compact',
      default_page_id: 'p1', is_default_for_all: 1, selected: 1, status: 'published',
      publishing_at: null, generator_key: null, generator_version: null,
      created_at: '', updated_at: '', pages: [],
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const response = await setupApp({
      db: makeBoundVersionDb(), lifecycleState: 'active',
    }).request('/api/rich-menu-groups/g1/unpublish', { method: 'POST' });

    expect(response.status).toBe(409);
    expect(dbMocks.acquireRichMenuAccountLock).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

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
    expect(lineAccountLookup).toHaveBeenCalledWith(expect.anything(), 'tenant-a', 'acc-1');
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
  test('rejects per-user bulk and default-clear bypasses for immutable versions', async () => {
    dbMocks.getRichMenuGroupWithPages.mockResolvedValue({
      id: 'g1', account_id: 'acc-1', name: 'Menu', chat_bar_text: 'Menu', size: 'compact',
      default_page_id: 'p1', is_default_for_all: 1, selected: 1, status: 'published',
      publishing_at: null, generator_key: null, generator_version: null,
      created_at: '', updated_at: '2026-08-21T00:00:00Z', pages: [{
        id: 'p1', group_id: 'g1', order_index: 0, name: 'Main', alias_id: 'alias',
        line_richmenu_id: 'line-menu-1', image_r2_key: 'image.jpg', image_content_type: 'image/jpeg',
        created_at: '', updated_at: '', areas: [],
      }],
    });
    const app = setupApp({ db: makeBoundVersionDb(), lifecycleState: 'active' });
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const bulk = await app.request('/api/rich-menu-groups/g1/apply-to-tag?accountId=acc-1', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'bulk-link', tagId: null, dryRun: true }),
    });
    const clear = await app.request('/api/rich-menu-groups/g1/apply-to-tag?accountId=acc-1', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'set-default', enabled: false, dryRun: true }),
    });

    expect(bulk.status).toBe(409);
    expect(clear.status).toBe(409);
    expect(dbMocks.getFollowingLineUserIdsByTag).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  test('blocks set-default while the account lifecycle is frozen', async () => {
    dbMocks.getRichMenuGroupWithPages.mockResolvedValue({
      id: 'g1', account_id: 'acc-1', name: 'Menu', chat_bar_text: 'Menu', size: 'compact',
      default_page_id: 'p1', is_default_for_all: 0, selected: 1, status: 'published',
      publishing_at: null, generator_key: null, generator_version: null,
      created_at: '', updated_at: '2026-08-21T00:00:00Z', pages: [{
        id: 'p1', group_id: 'g1', order_index: 0, name: 'Main', alias_id: 'alias',
        line_richmenu_id: 'line-menu-1', image_r2_key: 'image.jpg', image_content_type: 'image/jpeg',
        created_at: '', updated_at: '', areas: [],
      }],
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const response = await setupApp({
      db: makeBoundVersionDb(), lifecycleState: 'frozen',
    }).request('/api/rich-menu-groups/g1/apply-to-tag?accountId=acc-1', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'set-default', enabled: true, dryRun: true }),
    });

    expect(response.status).toBe(409);
    expect(pharmacyPublishGate.readiness).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  test('blocks a stale saved version before issuing a set-default confirmation', async () => {
    dbMocks.getRichMenuGroupWithPages.mockResolvedValue({
      id: 'g1', account_id: 'acc-1', name: 'メニュー', chat_bar_text: 'メニュー', size: 'compact',
      default_page_id: 'p1', is_default_for_all: 0, selected: 1, status: 'published',
      publishing_at: null, created_at: '', updated_at: '2026-08-21T00:00:00Z',
      pages: [{ id: 'p1', group_id: 'g1', order_index: 0, name: 'p1', alias_id: 'a1',
        line_richmenu_id: 'line-menu-1', image_r2_key: 'key', image_content_type: 'image/jpeg',
        created_at: '', updated_at: '', areas: [] }],
    });
    dbMocks.getLineAccountById.mockResolvedValue({ id: 'acc-1', liff_id: '1234567890-AbCd' });
    pharmacyPublishGate.readiness.mockResolvedValue({
      status: 'BLOCKED', reasonCodes: ['CAPABILITY_REVISION_STALE'], evidenceDigest: null,
    });

    const res = await setupApp({ db: makeBoundVersionDb() }).request(
      '/api/rich-menu-groups/g1/apply-to-tag?accountId=acc-1', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'set-default', enabled: true, dryRun: true }),
      },
    );

    expect(res.status).toBe(409);
    expect(pharmacyPublishGate.readiness).toHaveBeenCalledWith(expect.objectContaining({
      accountId: 'acc-1', requiredStatus: 'published',
    }));
    expect(dbMocks.acquireRichMenuAccountLock).not.toHaveBeenCalled();
  });
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

  test('records fresh default evidence and read-back before marking an immutable version known-good', async () => {
    const events: string[] = [];
    dbMocks.getRichMenuGroupWithPages.mockResolvedValue({
      id: 'g1', account_id: 'acc-1', name: 'メニュー', chat_bar_text: 'メニュー', size: 'compact',
      default_page_id: 'p1', is_default_for_all: 0, selected: 1, status: 'published',
      publishing_at: null, generator_key: null, generator_version: null,
      created_at: '', updated_at: '2026-08-21T00:00:00Z', pages: [{
        id: 'p1', group_id: 'g1', order_index: 0, name: '初期', alias_id: 'alias',
        line_richmenu_id: 'line-menu-new', image_r2_key: 'key', image_content_type: 'image/jpeg',
        created_at: '', updated_at: '', areas: [],
      }],
    });
    dbMocks.getLineAccountById.mockResolvedValue({ id: 'acc-1', liff_id: '1234567890-AbCd' });
    pharmacyOperationMocks.begin.mockImplementation(async () => {
      events.push('intent');
      return { id: 'operation-1', status: 'running' };
    });
    pharmacyOperationMocks.recordRemoteId.mockImplementation(async () => { events.push('target'); });
    pharmacyOperationMocks.recordExpectedDefault.mockImplementation(async () => { events.push('expected'); });
    pharmacyOperationMocks.finish.mockImplementation(async () => { events.push('succeeded'); });
    const db = makeBoundVersionDb();
    db.batch = vi.fn(async () => [
      { meta: { changes: 1 } }, { meta: { changes: 1 } },
    ] as unknown as D1Result<unknown>[]) as D1Database['batch'];
    let currentDefault = 'line-menu-old';
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith('/v2/bot/user/all/richmenu') && init?.method === 'GET') {
        events.push(currentDefault === 'line-menu-old' ? 'get' : 'readback');
        return new Response(JSON.stringify({ richMenuId: currentDefault }), { status: 200 });
      }
      if (url.endsWith('/v2/bot/user/all/richmenu/line-menu-new') && init?.method === 'POST') {
        events.push('set');
        currentDefault = 'line-menu-new';
        return new Response(null, { status: 200 });
      }
      throw new Error(`unexpected LINE request: ${init?.method} ${url}`);
    });
    const app = setupApp({ db });
    const dryRun = await app.request('/api/rich-menu-groups/g1/apply-to-tag?accountId=acc-1', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'set-default', dryRun: true }),
    });
    const confirmationToken = (await dryRun.json() as any).data.confirmationToken;

    const live = await app.request('/api/rich-menu-groups/g1/apply-to-tag?accountId=acc-1', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'set-default', dryRun: false, confirmationToken }),
    });

    expect(live.status).toBe(200);
    expect(events).toEqual(['intent', 'target', 'get', 'expected', 'set', 'readback', 'succeeded']);
    expect(pharmacyOperationMocks.begin).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      lineAccountId: 'acc-1', groupId: 'g1', kind: 'set_default',
      confirmationId: expect.any(String),
    }));
    expect(pharmacyOperationMocks.finish).toHaveBeenCalledWith(expect.anything(), {
      lineAccountId: 'acc-1', operationId: 'operation-1', expectedStatus: 'running',
      status: 'succeeded', verifiedDefaultMenuId: 'line-menu-new',
    });
    fetchSpy.mockRestore();
  });

  test('leaves an immutable set-default unknown without automatic rollback after an uncertain result', async () => {
    dbMocks.getRichMenuGroupWithPages.mockResolvedValue({
      id: 'g1', account_id: 'acc-1', name: 'メニュー', chat_bar_text: 'メニュー', size: 'compact',
      default_page_id: 'p1', is_default_for_all: 0, selected: 1, status: 'published',
      publishing_at: null, generator_key: null, generator_version: null,
      created_at: '', updated_at: '2026-08-21T00:00:00Z', pages: [{
        id: 'p1', group_id: 'g1', order_index: 0, name: '初期', alias_id: 'alias',
        line_richmenu_id: 'line-menu-new', image_r2_key: 'key', image_content_type: 'image/jpeg',
        created_at: '', updated_at: '', areas: [],
      }],
    });
    dbMocks.getLineAccountById.mockResolvedValue({ id: 'acc-1', liff_id: '1234567890-AbCd' });
    const db = makeBoundVersionDb();
    let currentDefault = 'line-menu-old';
    const setTargets: string[] = [];
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith('/v2/bot/user/all/richmenu') && init?.method === 'GET') {
        if (currentDefault === 'line-menu-new') throw new Error('read-back result unknown');
        return new Response(JSON.stringify({ richMenuId: currentDefault }), { status: 200 });
      }
      const match = url.match(/\/v2\/bot\/user\/all\/richmenu\/(.+)$/u);
      if (match && init?.method === 'POST') {
        setTargets.push(match[1]);
        currentDefault = match[1];
        return new Response(null, { status: 200 });
      }
      throw new Error(`unexpected LINE request: ${init?.method} ${url}`);
    });
    const app = setupApp({ db });
    const dryRun = await app.request('/api/rich-menu-groups/g1/apply-to-tag?accountId=acc-1', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'set-default', dryRun: true }),
    });
    const confirmationToken = (await dryRun.json() as any).data.confirmationToken;

    const live = await app.request('/api/rich-menu-groups/g1/apply-to-tag?accountId=acc-1', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'set-default', dryRun: false, confirmationToken }),
    });

    expect(live.status).toBe(500);
    expect(setTargets).toEqual(['line-menu-new']);
    expect(pharmacyOperationMocks.finish).toHaveBeenCalledWith(expect.anything(), {
      lineAccountId: 'acc-1', operationId: 'operation-1', expectedStatus: 'running',
      status: 'unknown', reasonCode: 'LINE_RESULT_UNKNOWN',
    });
    fetchSpy.mockRestore();
  });

  test('rejects rollback to a version without same-account known-good evidence', async () => {
    dbMocks.getRichMenuGroupWithPages.mockResolvedValue({
      id: 'g1', account_id: 'acc-1', name: '旧メニュー', chat_bar_text: 'メニュー', size: 'compact',
      default_page_id: 'p1', is_default_for_all: 0, selected: 1, status: 'published',
      publishing_at: null, generator_key: null, generator_version: null,
      created_at: '', updated_at: '2026-08-21T00:00:00Z', pages: [{
        id: 'p1', group_id: 'g1', order_index: 0, name: '初期', alias_id: 'alias',
        line_richmenu_id: 'line-menu-old', image_r2_key: 'key', image_content_type: 'image/jpeg',
        created_at: '', updated_at: '', areas: [],
      }],
    });
    dbMocks.getLineAccountById.mockResolvedValue({ id: 'acc-1', liff_id: '1234567890-AbCd' });
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const response = await setupApp({ db: makeBoundVersionDb() }).request(
      '/api/rich-menu-groups/g1/apply-to-tag?accountId=acc-1', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'set-default', intent: 'rollback', dryRun: true }),
      },
    );

    expect(response.status).toBe(409);
    expect(pharmacyOperationMocks.isKnownGood).toHaveBeenCalledWith(
      expect.anything(), 'acc-1', 'g1', 'line-menu-old',
    );
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  test('runs explicit rollback as a separate confirmed operation', async () => {
    dbMocks.getRichMenuGroupWithPages.mockResolvedValue({
      id: 'g1', account_id: 'acc-1', name: '旧メニュー', chat_bar_text: 'メニュー', size: 'compact',
      default_page_id: 'p1', is_default_for_all: 0, selected: 1, status: 'published',
      publishing_at: null, generator_key: null, generator_version: null,
      created_at: '', updated_at: '2026-08-21T00:00:00Z', pages: [{
        id: 'p1', group_id: 'g1', order_index: 0, name: '初期', alias_id: 'alias',
        line_richmenu_id: 'line-menu-old', image_r2_key: 'key', image_content_type: 'image/jpeg',
        created_at: '', updated_at: '', areas: [],
      }],
    });
    dbMocks.getLineAccountById.mockResolvedValue({ id: 'acc-1', liff_id: '1234567890-AbCd' });
    pharmacyOperationMocks.isKnownGood.mockResolvedValue(true);
    const db = makeBoundVersionDb();
    db.batch = vi.fn(async () => [
      { meta: { changes: 1 } }, { meta: { changes: 1 } },
    ] as unknown as D1Result<unknown>[]) as D1Database['batch'];
    let currentDefault = 'line-menu-new';
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith('/v2/bot/user/all/richmenu') && init?.method === 'GET') {
        return new Response(JSON.stringify({ richMenuId: currentDefault }), { status: 200 });
      }
      if (url.endsWith('/v2/bot/user/all/richmenu/line-menu-old') && init?.method === 'POST') {
        currentDefault = 'line-menu-old';
        return new Response(null, { status: 200 });
      }
      throw new Error(`unexpected LINE request: ${init?.method} ${url}`);
    });
    const app = setupApp({ db });
    const dryRun = await app.request('/api/rich-menu-groups/g1/apply-to-tag?accountId=acc-1', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'set-default', intent: 'rollback', dryRun: true }),
    });
    const confirmationToken = (await dryRun.json() as any).data.confirmationToken;

    const live = await app.request('/api/rich-menu-groups/g1/apply-to-tag?accountId=acc-1', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mode: 'set-default', intent: 'rollback', dryRun: false, confirmationToken,
      }),
    });

    expect(live.status).toBe(200);
    expect(pharmacyOperationMocks.begin).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      lineAccountId: 'acc-1', groupId: 'g1', kind: 'rollback',
    }));
    expect(pharmacyOperationMocks.finish).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      status: 'succeeded', verifiedDefaultMenuId: 'line-menu-old',
    }));
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
