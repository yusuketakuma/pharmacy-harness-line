import { Hono, type Context } from 'hono';
import {
  getAutomations,
  getAutomationById,
  createAutomation,
  updateAutomation,
  deleteAutomation,
  getAutomationLogs,
  getTemplateById,
} from '@line-crm/db';
import type { Env } from '../../index.js';
import { clampLimitOffset } from '../../lib/pagination.js';
import { accountResourceOwnedByStaff } from '../../middleware/tenant-boundary.js';

const automations = new Hono<Env>();

function resolveAutomationTenant(c: Context<Env>): string | null {
  const tenantId = c.get('tenantId');
  const staffId = c.get('staff')?.id;
  if (!tenantId || !staffId) return null;
  return tenantId;
}

async function getOwnedAutomation(c: Context<Env>, id: string, tenantId: string) {
  const item = await getAutomationById(c.env.DB, id, tenantId);
  if (!item?.line_account_id) return null;
  if (!await accountResourceOwnedByStaff(c, tenantId, item.line_account_id)) return null;
  return item;
}

async function automationTemplatesExist(
  db: D1Database,
  actions: unknown[],
  tenantId: string,
): Promise<boolean> {
  const templateIds = new Set<string>();
  for (const action of actions) {
    if (!action || typeof action !== 'object') continue;
    const candidate = action as { type?: unknown; params?: unknown };
    if (candidate.type !== 'send_message' || !candidate.params || typeof candidate.params !== 'object') {
      continue;
    }
    const templateId = (candidate.params as { template_id?: unknown }).template_id;
    if (typeof templateId === 'string' && templateId) templateIds.add(templateId);
  }
  for (const templateId of templateIds) {
    if (!await getTemplateById(db, templateId, tenantId)) return false;
  }
  return true;
}

function serializeAutomationLog(
  log: Awaited<ReturnType<typeof getAutomationLogs>>[number],
  includeAutomationId: boolean,
) {
  return {
    id: log.id,
    ...(includeAutomationId ? { automationId: log.automation_id } : {}),
    friendId: null,
    // eventData/actionsResult may contain PHI or upstream secrets. The DB
    // helper returns a safe projection and historical raw values are never
    // re-exposed by this API.
    eventData: null,
    actionsResult: null,
    status: log.status,
    createdAt: log.created_at,
  };
}

// ========== 自動化ルールCRUD ==========

automations.get('/api/automations', async (c) => {
  try {
    const tenantId = resolveAutomationTenant(c);
    if (!tenantId) return c.json({ success: false, error: 'Tenant context required' }, 401);
    const lineAccountId = c.req.query('lineAccountId')?.trim() || undefined;
    if (lineAccountId && !await accountResourceOwnedByStaff(c, tenantId, lineAccountId)) {
      return c.json({ success: false, error: 'Forbidden' }, 403);
    }
    const items = await getAutomations(c.env.DB, tenantId, lineAccountId);
    return c.json({
      success: true,
      data: items.map((a) => ({
        id: a.id,
        name: a.name,
        description: a.description,
        eventType: a.event_type,
        conditions: JSON.parse(a.conditions),
        actions: JSON.parse(a.actions),
        isActive: Boolean(a.is_active),
        priority: a.priority,
        // The tenant-scoped query excludes unowned legacy NULL rows. Keep the
        // field for response compatibility with existing clients.
        lineAccountId: a.line_account_id ?? null,
        createdAt: a.created_at,
        updatedAt: a.updated_at,
      })),
    });
  } catch (err) {
    console.error('GET /api/automations error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

automations.get('/api/automations/:id', async (c) => {
  try {
    const tenantId = resolveAutomationTenant(c);
    if (!tenantId) return c.json({ success: false, error: 'Tenant context required' }, 401);
    const item = await getOwnedAutomation(c, c.req.param('id'), tenantId);
    if (!item) return c.json({ success: false, error: 'Automation not found' }, 404);

    // ログも取得
    const logs = await getAutomationLogs(c.env.DB, item.id, tenantId, 50);

    return c.json({
      success: true,
      data: {
        id: item.id,
        name: item.name,
        description: item.description,
        eventType: item.event_type,
        conditions: JSON.parse(item.conditions),
        actions: JSON.parse(item.actions),
        isActive: Boolean(item.is_active),
        priority: item.priority,
        lineAccountId: item.line_account_id ?? null,
        createdAt: item.created_at,
        updatedAt: item.updated_at,
        logs: logs.map((log) => serializeAutomationLog(log, false)),
      },
    });
  } catch (err) {
    console.error('GET /api/automations/:id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

automations.post('/api/automations', async (c) => {
  try {
    const tenantId = resolveAutomationTenant(c);
    if (!tenantId) return c.json({ success: false, error: 'Tenant context required' }, 401);
    const body = await c.req.json<{
      name: string;
      description?: string | null;
      eventType: string;
      conditions?: Record<string, unknown>;
      actions: unknown[];
      priority?: number;
      lineAccountId?: string | null;
    }>();
    const lineAccountId = typeof body.lineAccountId === 'string' ? body.lineAccountId.trim() : '';
    if (!body.name || !body.eventType || !Array.isArray(body.actions) || !lineAccountId) {
      return c.json({ success: false, error: 'name, eventType, actions are required' }, 400);
    }
    if (!await accountResourceOwnedByStaff(c, tenantId, lineAccountId)) {
      return c.json({ success: false, error: 'Forbidden' }, 403);
    }
    if (!await automationTemplatesExist(c.env.DB, body.actions, tenantId)) {
      return c.json({ success: false, error: 'templateId not found' }, 400);
    }
    const item = await createAutomation(c.env.DB, {
      name: body.name,
      description: body.description,
      eventType: body.eventType,
      conditions: body.conditions,
      actions: body.actions,
      priority: body.priority,
      lineAccountId,
      tenantId,
    });
    if (!item) return c.json({ success: false, error: 'Automation not found' }, 404);
    return c.json({
      success: true,
      data: {
        id: item.id,
        name: item.name,
        eventType: item.event_type,
        actions: JSON.parse(item.actions),
        isActive: Boolean(item.is_active),
        priority: item.priority,
        lineAccountId: item.line_account_id ?? null,
        createdAt: item.created_at,
      },
    }, 201);
  } catch (err) {
    console.error('POST /api/automations error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

automations.put('/api/automations/:id', async (c) => {
  try {
    const tenantId = resolveAutomationTenant(c);
    if (!tenantId) return c.json({ success: false, error: 'Tenant context required' }, 401);
    const id = c.req.param('id');
    const item = await getOwnedAutomation(c, id, tenantId);
    if (!item) return c.json({ success: false, error: 'Not found' }, 404);
    const body = await c.req.json<Partial<{
      name: string;
      description: string | null;
      eventType: string;
      conditions: Record<string, unknown>;
      actions: unknown[];
      isActive: boolean;
      priority: number;
    }>>();
    const updates = {
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.description !== undefined ? { description: body.description } : {}),
      ...(body.eventType !== undefined ? { eventType: body.eventType } : {}),
      ...(body.conditions !== undefined ? { conditions: body.conditions } : {}),
      ...(body.actions !== undefined ? { actions: body.actions } : {}),
      ...(body.isActive !== undefined ? { isActive: body.isActive } : {}),
      ...(body.priority !== undefined ? { priority: body.priority } : {}),
    };
    if (body.actions && !await automationTemplatesExist(c.env.DB, body.actions, tenantId)) {
      return c.json({ success: false, error: 'templateId not found' }, 400);
    }
    if (!await updateAutomation(c.env.DB, id, updates, tenantId)) {
      return c.json({ success: false, error: 'Not found' }, 404);
    }
    const updated = await getAutomationById(c.env.DB, id, tenantId);
    if (!updated) return c.json({ success: false, error: 'Not found' }, 404);
    return c.json({
      success: true,
      data: {
        id: updated.id,
        name: updated.name,
        eventType: updated.event_type,
        conditions: JSON.parse(updated.conditions),
        actions: JSON.parse(updated.actions),
        isActive: Boolean(updated.is_active),
        priority: updated.priority,
        lineAccountId: updated.line_account_id ?? null,
      },
    });
  } catch (err) {
    console.error('PUT /api/automations/:id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

automations.delete('/api/automations/:id', async (c) => {
  try {
    const tenantId = resolveAutomationTenant(c);
    if (!tenantId) return c.json({ success: false, error: 'Tenant context required' }, 401);
    const id = c.req.param('id');
    const item = await getOwnedAutomation(c, id, tenantId);
    if (!item || !await deleteAutomation(c.env.DB, id, tenantId)) {
      return c.json({ success: false, error: 'Not found' }, 404);
    }
    return c.json({ success: true, data: null });
  } catch (err) {
    console.error('DELETE /api/automations/:id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// ========== 自動化ログ ==========

automations.get('/api/automations/:id/logs', async (c) => {
  try {
    const tenantId = resolveAutomationTenant(c);
    if (!tenantId) return c.json({ success: false, error: 'Tenant context required' }, 401);
    const automationId = c.req.param('id');
    const page = clampLimitOffset(c.req.query('limit'), undefined, 100);
    if (!page) return c.json({ success: false, error: 'limit が不正です' }, 400);
    if (!await getOwnedAutomation(c, automationId, tenantId)) {
      return c.json({ success: false, error: 'Automation not found' }, 404);
    }
    const logs = await getAutomationLogs(c.env.DB, automationId, tenantId, page.limit);
    return c.json({
      success: true,
      data: logs.map((log) => serializeAutomationLog(log, true)),
    });
  } catch (err) {
    console.error('GET /api/automations/:id/logs error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

export { automations };
