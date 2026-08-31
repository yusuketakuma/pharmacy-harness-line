import { describe, expect, test, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../../index.js';

const dbMocks = {
  getAutomations: vi.fn(),
  getAutomationById: vi.fn(),
  createAutomation: vi.fn(),
  updateAutomation: vi.fn(),
  deleteAutomation: vi.fn(),
  getAutomationLogs: vi.fn(),
  getTemplateById: vi.fn(),
};
vi.mock('@line-crm/db', () => dbMocks);

const boundaryMocks = vi.hoisted(() => ({
  accountResourceOwnedByStaff: vi.fn(),
}));
vi.mock('../../middleware/tenant-boundary.js', () => boundaryMocks);

const { automations } = await import('./automations.js');

interface AutomationRow {
  id: string;
  name: string;
  description: string | null;
  event_type: string;
  conditions: string;
  actions: string;
  is_active: number;
  priority: number;
  created_at: string;
  updated_at: string;
  line_account_id: string | null;
}

function setupApp(
  db: D1Database,
  options: { tenantId?: string; staffId?: string } = {},
) {
  const app = new Hono<Env>();
  app.use('*', async (c, next) => {
    c.env = { DB: db } as Env['Bindings'];
    if (options.tenantId !== undefined) c.set('tenantId', options.tenantId);
    if (options.staffId !== undefined) c.set('staff', {
      id: options.staffId,
      name: 'Staff',
      role: 'staff',
    });
    await next();
  });
  app.route('/', automations);
  return app;
}

const rowBase = {
  description: null,
  event_type: 'message_received',
  conditions: '{}',
  actions: '[]',
  is_active: 1,
  priority: 0,
  created_at: '2026-05-20T00:00:00.000',
  updated_at: '2026-05-20T00:00:00.000',
};

beforeEach(() => {
  for (const fn of Object.values(dbMocks)) fn.mockReset();
  boundaryMocks.accountResourceOwnedByStaff.mockReset();
});

describe('GET /api/automations?lineAccountId=X', () => {
  test('lists only automations returned for the selected server-owned account', async () => {
    const rows: AutomationRow[] = [
      { id: 'a-acc1', name: 'acc1', line_account_id: 'acc-1', ...rowBase },
      { id: 'a-acc2', name: 'acc2', line_account_id: 'acc-2', ...rowBase },
    ];
    const db = {} as D1Database;
    dbMocks.getAutomations.mockResolvedValue([rows[0]]);
    boundaryMocks.accountResourceOwnedByStaff.mockResolvedValue(true);

    const res = await setupApp(db, { tenantId: 'tenant-a', staffId: 'staff-a' })
      .request('/api/automations?lineAccountId=acc-1');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      success: boolean;
      data: { id: string; lineAccountId: string | null }[];
    };
    expect(body.success).toBe(true);
    const ids = body.data.map((d) => d.id).sort();
    expect(ids).toEqual(['a-acc1']);
    const byId = new Map(body.data.map((d) => [d.id, d.lineAccountId] as const));
    expect(byId.get('a-acc1')).toBe('acc-1');
    expect(dbMocks.getAutomations).toHaveBeenCalledWith(db, 'tenant-a', 'acc-1');
  });

  test('uses the server tenant when no lineAccountId is provided', async () => {
    const db = {} as D1Database;
    dbMocks.getAutomations.mockResolvedValue([
      { id: 'a-x', name: 'x', line_account_id: 'acc-a', ...rowBase },
    ]);

    const res = await setupApp(db, { tenantId: 'tenant-a', staffId: 'staff-a' })
      .request('/api/automations');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; data: { id: string }[] };
    expect(body.data.map((d) => d.id)).toEqual(['a-x']);
    expect(dbMocks.getAutomations).toHaveBeenCalledWith(db, 'tenant-a', undefined);
  });

  test('returns empty array when filter matches nothing and no globals exist', async () => {
    const db = {} as D1Database;
    dbMocks.getAutomations.mockResolvedValue([]);
    boundaryMocks.accountResourceOwnedByStaff.mockResolvedValue(true);

    const res = await setupApp(db, { tenantId: 'tenant-a', staffId: 'staff-a' })
      .request('/api/automations?lineAccountId=acc-1');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; data: unknown[] };
    expect(body.data).toEqual([]);
  });

  test('rejects a foreign account selector before reading automations', async () => {
    boundaryMocks.accountResourceOwnedByStaff.mockResolvedValue(false);
    const db = {} as D1Database;

    const res = await setupApp(db, { tenantId: 'tenant-a', staffId: 'staff-a' })
      .request('/api/automations?lineAccountId=acc-b');

    expect(res.status).toBe(403);
    expect(dbMocks.getAutomations).not.toHaveBeenCalled();
  });

  test('requires the server-resolved tenant for listing', async () => {
    const db = {} as D1Database;

    const res = await setupApp(db).request('/api/automations');

    expect(res.status).toBe(401);
    expect(dbMocks.getAutomations).not.toHaveBeenCalled();
  });

  test('requires the authenticated staff context as well as the tenant', async () => {
    const db = {} as D1Database;

    const res = await setupApp(db, { tenantId: 'tenant-a' }).request('/api/automations');

    expect(res.status).toBe(401);
    expect(dbMocks.getAutomations).not.toHaveBeenCalled();
  });
});

describe('automation detail, logs, and mutations tenant boundary', () => {
  const owned = { id: 'auto-a', name: 'owned', line_account_id: 'acc-a', ...rowBase };
  const setupScoped = () => setupApp({} as D1Database, { tenantId: 'tenant-a', staffId: 'staff-a' });

  test('does not return a foreign automation detail or read its logs', async () => {
    dbMocks.getAutomationById.mockResolvedValue(null);
    boundaryMocks.accountResourceOwnedByStaff.mockResolvedValue(false);
    const app = setupScoped();

    const res = await app.request('/api/automations/auto-b');

    expect(res.status).toBe(404);
    expect(dbMocks.getAutomationLogs).not.toHaveBeenCalled();
  });

  test('does not return a foreign automation log', async () => {
    dbMocks.getAutomationById.mockResolvedValue(null);
    boundaryMocks.accountResourceOwnedByStaff.mockResolvedValue(false);
    const app = setupScoped();

    const res = await app.request('/api/automations/auto-b/logs');

    expect(res.status).toBe(404);
    expect(dbMocks.getAutomationLogs).not.toHaveBeenCalled();
  });

  test('requires ownership before creating an automation for the selected account', async () => {
    boundaryMocks.accountResourceOwnedByStaff.mockResolvedValue(false);
    const app = setupScoped();

    const res = await app.request('/api/automations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'foreign',
        eventType: 'message_received',
        actions: [],
        lineAccountId: 'acc-b',
        tenantId: 'tenant-b',
      }),
    });

    expect(res.status).toBe(403);
    expect(dbMocks.createAutomation).not.toHaveBeenCalled();
  });

  test('passes only the server tenant to an owned create', async () => {
    boundaryMocks.accountResourceOwnedByStaff.mockResolvedValue(true);
    dbMocks.createAutomation.mockResolvedValue(owned);
    const app = setupScoped();

    const res = await app.request('/api/automations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'owned',
        description: 'description',
        eventType: 'message_received',
        conditions: { matched: true },
        actions: [],
        priority: 3,
        lineAccountId: 'acc-a',
        tenantId: 'tenant-b',
      }),
    });

    expect(res.status).toBe(201);
    expect(dbMocks.createAutomation).toHaveBeenCalledWith(expect.anything(), {
      name: 'owned',
      description: 'description',
      eventType: 'message_received',
      conditions: { matched: true },
      actions: [],
      priority: 3,
      lineAccountId: 'acc-a',
      tenantId: 'tenant-a',
    });
  });

  test('rejects a template reference outside the server tenant on create and update', async () => {
    boundaryMocks.accountResourceOwnedByStaff.mockResolvedValue(true);
    dbMocks.getTemplateById.mockResolvedValue(null);
    dbMocks.getAutomationById.mockResolvedValue(owned);
    const app = setupScoped();
    const actions = [{ type: 'send_message', params: { template_id: 'template-b' } }];

    const create = await app.request('/api/automations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'foreign template',
        eventType: 'message_received',
        actions,
        lineAccountId: 'acc-a',
      }),
    });
    const update = await app.request('/api/automations/auto-a', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ actions }),
    });

    expect([create.status, update.status]).toEqual([400, 400]);
    expect(dbMocks.getTemplateById).toHaveBeenCalledWith(
      expect.anything(),
      'template-b',
      'tenant-a',
    );
    expect(dbMocks.createAutomation).not.toHaveBeenCalled();
    expect(dbMocks.updateAutomation).not.toHaveBeenCalled();
  });

  test('rejects a foreign update and delete before mutation', async () => {
    dbMocks.getAutomationById.mockResolvedValue(null);
    boundaryMocks.accountResourceOwnedByStaff.mockResolvedValue(false);
    const app = setupScoped();

    const update = await app.request('/api/automations/auto-b', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'spoofed', tenantId: 'tenant-b', lineAccountId: 'acc-b' }),
    });
    const remove = await app.request('/api/automations/auto-b', { method: 'DELETE' });

    expect(update.status).toBe(404);
    expect(remove.status).toBe(404);
    expect(dbMocks.updateAutomation).not.toHaveBeenCalled();
    expect(dbMocks.deleteAutomation).not.toHaveBeenCalled();
  });

  test('passes the server tenant to owned update and delete mutations', async () => {
    dbMocks.getAutomationById.mockResolvedValue(owned);
    dbMocks.updateAutomation.mockResolvedValue(true);
    dbMocks.deleteAutomation.mockResolvedValue(true);
    boundaryMocks.accountResourceOwnedByStaff.mockResolvedValue(true);
    const app = setupScoped();

    const update = await app.request('/api/automations/auto-a', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'updated', tenantId: 'tenant-b', lineAccountId: 'acc-b' }),
    });
    const remove = await app.request('/api/automations/auto-a', { method: 'DELETE' });

    expect(update.status).toBe(200);
    expect(remove.status).toBe(200);
    expect(dbMocks.updateAutomation).toHaveBeenCalledWith(
      expect.anything(), 'auto-a', { name: 'updated' }, 'tenant-a',
    );
    expect(dbMocks.deleteAutomation).toHaveBeenCalledWith(
      expect.anything(), 'auto-a', 'tenant-a',
    );
  });

  test('does not expose historical event data or action errors in detail/log responses', async () => {
    dbMocks.getAutomationById.mockResolvedValue(owned);
    dbMocks.getAutomationLogs.mockResolvedValue([{
      id: 'log-a',
      automation_id: 'auto-a',
      friend_id: 'friend-a',
      event_data: JSON.stringify({ text: 'patient-sensitive-text' }),
      actions_result: JSON.stringify([{ action: 'send_webhook', success: false, error: 'secret-upstream-body' }]),
      status: 'failed',
      created_at: '2026-05-20T00:00:00.000',
    }]);
    boundaryMocks.accountResourceOwnedByStaff.mockResolvedValue(true);
    const app = setupScoped();

    const detail = await app.request('/api/automations/auto-a');
    const logs = await app.request('/api/automations/auto-a/logs');
    const detailBody = await detail.text();
    const logsBody = await logs.text();

    expect(detail.status).toBe(200);
    expect(logs.status).toBe(200);
    expect(detailBody).not.toContain('patient-sensitive-text');
    expect(detailBody).not.toContain('secret-upstream-body');
    expect(logsBody).not.toContain('patient-sensitive-text');
    expect(logsBody).not.toContain('secret-upstream-body');
    expect(JSON.parse(detailBody).data.logs[0]).toMatchObject({
      friendId: null,
      eventData: null,
      actionsResult: null,
    });
    expect(JSON.parse(logsBody).data[0]).toMatchObject({
      friendId: null,
      eventData: null,
      actionsResult: null,
    });
  });
});
