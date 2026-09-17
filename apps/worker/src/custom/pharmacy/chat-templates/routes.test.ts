import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const mocks = vi.hoisted(() => ({
  access: vi.fn(), capability: vi.fn(),
  list: vi.fn(), create: vi.fn(), update: vi.fn(),
  approve: vi.fn(), archive: vi.fn(),
}));
vi.mock('../growth-loop/access.js', () => ({
  canAccessPharmacyAccount: mocks.access,
  hasPharmacyCapability: mocks.capability,
}));
vi.mock('./repository.js', () => ({
  listChatTemplates: mocks.list,
  createChatTemplate: mocks.create,
  updateChatTemplate: mocks.update,
  approveChatTemplate: mocks.approve,
  archiveChatTemplate: mocks.archive,
}));

import { chatTemplateRoutes } from './routes.js';

const env = { DB: {} as D1Database };
const template = {
  line_account_id: 'account-a', template_id: 'tpl-1', title: '受付確認',
  body: '処方せんを受け付けました。', status: 'draft', version: 1,
  created_by_staff_id: 'staff-a', approved_by_staff_id: null,
  approved_at: null, created_at: '2026-09-20T00:00:00.000Z',
  updated_at: '2026-09-20T00:00:00.000Z',
};

function app(role: 'owner' | 'admin' | 'staff' = 'staff') {
  const root = new Hono<any>();
  root.use('*', async (c, next) => {
    c.set('staff', { id: 'staff-a', name: 'Staff', role });
    await next();
  });
  root.route('/', chatTemplateRoutes);
  return root;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.access.mockResolvedValue(true);
  mocks.capability.mockResolvedValue(true);
  mocks.list.mockResolvedValue([template]);
  for (const fn of [mocks.create, mocks.update, mocks.approve, mocks.archive]) {
    fn.mockResolvedValue(template);
  }
});

describe('chat template routes', () => {
  it('lists templates filtered to approved for the picker', async () => {
    mocks.list.mockResolvedValue([
      template, { ...template, template_id: 'tpl-2', status: 'approved' },
      { ...template, template_id: 'tpl-3', status: 'archived' },
    ]);
    const res = await app().request(
      'http://x/api/custom/pharmacy/chat-templates?line_account_id=account-a&status=approved',
      {}, env,
    );
    expect(res.status).toBe(200);
    const json = await res.json() as { templates: Array<{ id: string; status: string }> };
    expect(json.templates.map((t) => t.id)).toEqual(['tpl-2']);
  });

  it('hides archived templates from the default list', async () => {
    mocks.list.mockResolvedValue([
      { ...template, status: 'approved' },
      { ...template, template_id: 'tpl-3', status: 'archived' },
    ]);
    const res = await app().request(
      'http://x/api/custom/pharmacy/chat-templates?line_account_id=account-a',
      {}, env,
    );
    const json = await res.json() as { templates: Array<{ status: string }> };
    expect(json.templates.every((t) => t.status !== 'archived')).toBe(true);
  });

  it('rejects cross-account access and missing staff', async () => {
    mocks.access.mockResolvedValue(false);
    const res = await app().request(
      'http://x/api/custom/pharmacy/chat-templates?line_account_id=account-b',
      {}, env,
    );
    expect(res.status).toBe(403);
    const noStaff = new Hono<any>();
    noStaff.route('/', chatTemplateRoutes);
    const unauth = await noStaff.request(
      'http://x/api/custom/pharmacy/chat-templates?line_account_id=account-a',
      {}, env,
    );
    expect(unauth.status).toBe(401);
  });

  it('creates a draft when manual_chat is enabled', async () => {
    const res = await app().request(
      'http://x/api/custom/pharmacy/chat-templates?line_account_id=account-a',
      { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: '受付確認', body: '処方せんを受け付けました。' }) }, env,
    );
    expect(res.status).toBe(201);
    expect(mocks.create).toHaveBeenCalledWith(env.DB, expect.objectContaining({
      lineAccountId: 'account-a', actorStaffId: 'staff-a',
    }));
  });

  it('blocks mutations when manual_chat capability is off', async () => {
    mocks.capability.mockResolvedValue(false);
    const res = await app().request(
      'http://x/api/custom/pharmacy/chat-templates?line_account_id=account-a',
      { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 't', body: 'b' }) }, env,
    );
    expect(res.status).toBe(409);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('requires owner or admin to approve', async () => {
    const denied = await app('staff').request(
      'http://x/api/custom/pharmacy/chat-templates/tpl-1/approve?line_account_id=account-a',
      { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ expectedVersion: 1 }) }, env,
    );
    expect(denied.status).toBe(403);
    const allowed = await app('admin').request(
      'http://x/api/custom/pharmacy/chat-templates/tpl-1/approve?line_account_id=account-a',
      { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ expectedVersion: 1 }) }, env,
    );
    expect(allowed.status).toBe(200);
    expect(mocks.approve).toHaveBeenCalledWith(env.DB, expect.objectContaining({
      templateId: 'tpl-1', expectedVersion: 1,
    }));
  });

  it('maps repository errors to stable responses', async () => {
    mocks.update.mockRejectedValue(new Error('chat template conflict'));
    const res = await app().request(
      'http://x/api/custom/pharmacy/chat-templates/tpl-1?line_account_id=account-a',
      { method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 't', body: 'b', expectedVersion: 1 }) }, env,
    );
    expect(res.status).toBe(409);
    mocks.archive.mockRejectedValue(new Error('chat template schema unavailable'));
    const unavailable = await app().request(
      'http://x/api/custom/pharmacy/chat-templates/tpl-1/archive?line_account_id=account-a',
      { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ expectedVersion: 1 }) }, env,
    );
    expect(unavailable.status).toBe(503);
  });
});
