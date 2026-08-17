import { beforeEach, describe, expect, test, vi } from 'vitest';
import { Hono } from 'hono';

const dbMocks = {
  createRichMenuGroup: vi.fn(),
  getLineAccountById: vi.fn(),
  getRichMenuGroupByGeneratorKey: vi.fn(),
  getRichMenuGroupWithPages: vi.fn(),
  setRichMenuPageImage: vi.fn(),
};
vi.mock('@line-crm/db', () => dbMocks);
const accessMock = vi.hoisted(() => ({ canAccessPharmacyAccount: vi.fn(), hasPharmacyCapability: vi.fn() }));
vi.mock('../growth-loop/access.js', () => accessMock);

const { pharmacyRichMenuRoutes } = await import('./routes.js');

function group(overrides: Record<string, unknown> = {}) {
  return {
    id: 'group-1', account_id: 'account-a', name: '薬局初期メニュー', chat_bar_text: 'メニュー',
    size: 'compact', default_page_id: 'page-1', is_default_for_all: 0, selected: 1,
    status: 'draft', generator_key: 'initial-compact-3x1', generator_version: '1',
    publishing_at: null, created_at: '', updated_at: '',
    pages: [{
      id: 'page-1', group_id: 'group-1', order_index: 0, name: '初期メニュー',
      alias_id: 'lhx-group-1-0', line_richmenu_id: null, image_r2_key: null,
      image_content_type: null, created_at: '', updated_at: '', areas: [],
    }],
    ...overrides,
  };
}

const PNG_2500x843 = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x09, 0xc4, 0x00, 0x00, 0x03, 0x4b,
  0x08, 0x06, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
]);

function app() {
  const worker = new Hono<any>();
  worker.use('*', async (c, next) => {
    c.env = {
      DB: {} as D1Database,
      IMAGES: { put: vi.fn() } as unknown as R2Bucket,
      ASSETS: { fetch: vi.fn(async () => new Response(PNG_2500x843)) } as unknown as Fetcher,
    };
    c.set('staff', { id: 'staff-1', name: 'Staff', role: 'admin' });
    await next();
  });
  worker.route('/', pharmacyRichMenuRoutes);
  return worker;
}

beforeEach(() => {
  for (const fn of Object.values(dbMocks)) fn.mockReset();
  accessMock.canAccessPharmacyAccount.mockResolvedValue(true);
  accessMock.hasPharmacyCapability.mockResolvedValue(true);
});

describe('pharmacy rich-menu preparation', () => {
  test('requires a configured LIFF id', async () => {
    dbMocks.getLineAccountById.mockResolvedValue({ id: 'account-a', liff_id: null });
    const res = await app().request('/api/custom/pharmacy/rich-menus/prepare?accountId=account-a', {
      method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' },
    });
    expect(res.status).toBe(409);
    expect(dbMocks.createRichMenuGroup).not.toHaveBeenCalled();
  });

  test('creates the initial profile once and attaches the generated image', async () => {
    dbMocks.getLineAccountById.mockResolvedValue({ id: 'account-a', liff_id: '1234567890-AbCd' });
    dbMocks.getRichMenuGroupByGeneratorKey.mockResolvedValueOnce(null);
    dbMocks.createRichMenuGroup.mockResolvedValue(group());
    dbMocks.getRichMenuGroupWithPages.mockResolvedValue(group({
      pages: [{ ...group().pages[0], image_r2_key: 'rich-menus/account-a/group-1/page-1/initial-compact-3x1.jpg', image_content_type: 'image/jpeg' }],
    }));
    const response = await app().request('/api/custom/pharmacy/rich-menus/prepare?accountId=account-a', {
      method: 'POST', body: JSON.stringify({ initial: true }), headers: { 'Content-Type': 'application/json' },
    });
    expect(response.status).toBe(200);
    const body = await response.json() as any;
    expect(body.data.status).toBe('prepared');
    expect(body.data.imageAttached).toBe(true);
    expect(dbMocks.createRichMenuGroup).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      accountId: 'account-a', generatorKey: 'initial-compact-3x1', generatorVersion: '1',
    }));
    expect(dbMocks.setRichMenuPageImage).toHaveBeenCalledWith(
      expect.anything(), 'page-1', expect.stringContaining('/initial-compact-3x1.jpg'), 'image/jpeg',
    );
  });

  test('reuses an existing generator profile without creating another group', async () => {
    dbMocks.getLineAccountById.mockResolvedValue({ id: 'account-a', liff_id: '1234567890-AbCd' });
    dbMocks.getRichMenuGroupByGeneratorKey.mockResolvedValue(group());
    dbMocks.getRichMenuGroupWithPages.mockResolvedValue(group());
    const res = await app().request('/api/custom/pharmacy/rich-menus/prepare?accountId=account-a', { method: 'POST' });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.data.status).toBe('already_prepared');
    expect(body.data.reused).toBe(true);
    expect(dbMocks.createRichMenuGroup).not.toHaveBeenCalled();
  });

  test('prepares the versioned single-action profile with one full-size area and its image', async () => {
    dbMocks.getLineAccountById.mockResolvedValue({ id: 'account-a', liff_id: '1234567890-AbCd' });
    dbMocks.getRichMenuGroupByGeneratorKey.mockResolvedValueOnce(null);
    dbMocks.createRichMenuGroup.mockResolvedValue(group({ generator_key: 'intake-single-action-v1' }));
    dbMocks.getRichMenuGroupWithPages.mockResolvedValue(group({
      generator_key: 'intake-single-action-v1',
      pages: [{ ...group().pages[0], image_r2_key: 'rich-menus/account-a/group-1/page-1/initial-single-action-v1.jpg', image_content_type: 'image/jpeg' }],
    }));
    const response = await app().request('/api/custom/pharmacy/rich-menus/prepare?accountId=account-a', {
      method: 'POST', body: JSON.stringify({ profileKey: 'intake-single-action-v1', initial: false }),
      headers: { 'Content-Type': 'application/json' },
    });
    expect(response.status).toBe(200);
    expect(dbMocks.createRichMenuGroup).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      generatorKey: 'intake-single-action-v1',
      pages: [expect.objectContaining({ areas: [expect.objectContaining({ boundsWidth: 2500 })] })],
    }));
    expect(dbMocks.setRichMenuPageImage).toHaveBeenCalledWith(
      expect.anything(), 'page-1', expect.stringContaining('/initial-single-action-v1.jpg'), 'image/jpeg',
    );
  });

  test('fails closed when the pharmacy rich-menu capability is disabled', async () => {
    accessMock.hasPharmacyCapability.mockResolvedValue(false);
    dbMocks.getLineAccountById.mockResolvedValue({ id: 'account-a', liff_id: '1234567890-AbCd' });
    const response = await app().request('/api/custom/pharmacy/rich-menus/prepare?accountId=account-a', {
      method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' },
    });
    expect(response.status).toBe(403);
    expect(dbMocks.getLineAccountById).not.toHaveBeenCalled();
  });
});
