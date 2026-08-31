import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../../index.js';

const dbMocks = vi.hoisted(() => ({
  getTemplatesWithUsageCount: vi.fn(),
  getTemplateById: vi.fn(),
  getTemplateUsage: vi.fn(),
  createTemplate: vi.fn(),
  updateTemplate: vi.fn(),
  deleteTemplate: vi.fn(),
}));
vi.mock('@line-crm/db', () => dbMocks);

const { templates } = await import('./templates.js');

const row = {
  id: 'template-a',
  tenant_id: 'tenant-a',
  name: 'Template A',
  category: 'general',
  message_type: 'text',
  message_content: 'hello',
  usage_count: 0,
  created_at: '2026-08-31T00:00:00.000+09:00',
  updated_at: '2026-08-31T00:00:00.000+09:00',
};

function app(tenantId = 'tenant-a') {
  const root = new Hono<Env>();
  root.use('*', async (c, next) => {
    c.set('tenantId', tenantId);
    await next();
  });
  root.route('/', templates);
  return { root, env: { DB: {} as D1Database } as Env['Bindings'] };
}

beforeEach(() => {
  for (const mock of Object.values(dbMocks)) mock.mockReset();
});

describe('template tenant boundary', () => {
  it('lists and reads only through the server tenant scope', async () => {
    dbMocks.getTemplatesWithUsageCount.mockResolvedValue([row]);
    dbMocks.getTemplateById.mockResolvedValue(row);
    dbMocks.getTemplateUsage.mockResolvedValue({ autoReplies: [], automations: [], scenarioSteps: [] });
    const { root, env } = app();

    const list = await root.request('/api/templates?category=general', {}, env);
    const detail = await root.request('/api/templates/template-a', {}, env);

    expect(list.status).toBe(200);
    expect(detail.status).toBe(200);
    expect(dbMocks.getTemplatesWithUsageCount).toHaveBeenCalledWith(env.DB, 'general', 'tenant-a');
    expect(dbMocks.getTemplateById).toHaveBeenCalledWith(env.DB, 'template-a', 'tenant-a');
    expect(dbMocks.getTemplateUsage).toHaveBeenCalledWith(env.DB, 'template-a', 'tenant-a');
  });

  it('does not expose a foreign template or its usages', async () => {
    dbMocks.getTemplateById.mockResolvedValue(null);
    const { root, env } = app();

    const detail = await root.request('/api/templates/template-b', {}, env);
    const usages = await root.request('/api/templates/template-b/usages', {}, env);

    expect(detail.status).toBe(404);
    expect(usages.status).toBe(404);
    expect(dbMocks.getTemplateUsage).not.toHaveBeenCalled();
  });

  it('uses the server tenant for create, update, and delete', async () => {
    dbMocks.createTemplate.mockResolvedValue(row);
    dbMocks.updateTemplate.mockResolvedValue(true);
    dbMocks.getTemplateById.mockResolvedValue(row);
    dbMocks.deleteTemplate.mockResolvedValue(true);
    dbMocks.getTemplateUsage.mockResolvedValue({ autoReplies: [], automations: [], scenarioSteps: [] });
    const { root, env } = app();

    const create = await root.request('/api/templates', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Template A',
        category: 'general',
        messageType: 'text',
        messageContent: 'hello',
        tenantId: 'tenant-b',
      }),
    }, env);
    const update = await root.request('/api/templates/template-a', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Updated', tenantId: 'tenant-b' }),
    }, env);
    const remove = await root.request('/api/templates/template-a', { method: 'DELETE' }, env);

    expect([create.status, update.status, remove.status]).toEqual([201, 200, 200]);
    expect(dbMocks.createTemplate).toHaveBeenCalledWith(env.DB, expect.objectContaining({
      name: 'Template A',
      tenantId: 'tenant-a',
    }));
    expect(dbMocks.updateTemplate).toHaveBeenCalledWith(
      env.DB,
      'template-a',
      { name: 'Updated' },
      'tenant-a',
    );
    expect(dbMocks.deleteTemplate).toHaveBeenCalledWith(env.DB, 'template-a', 'tenant-a');
  });
});
