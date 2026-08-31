import { Hono } from 'hono';
import {
  getTemplatesWithUsageCount,
  getTemplateById,
  getTemplateUsage,
  createTemplate,
  updateTemplate,
  deleteTemplate,
} from '@line-crm/db';
import type { Env } from '../../index.js';

const templates = new Hono<Env>();

templates.get('/api/templates', async (c) => {
  try {
    const category = c.req.query('category') ?? undefined;
    const items = await getTemplatesWithUsageCount(c.env.DB, category, c.get('tenantId') || undefined);
    return c.json({
      success: true,
      data: items.map((t) => ({
        id: t.id,
        name: t.name,
        category: t.category,
        messageType: t.message_type,
        messageContent: t.message_content,
        usageCount: t.usage_count,
        createdAt: t.created_at,
        updatedAt: t.updated_at,
      })),
    });
  } catch (err) {
    console.error('GET /api/templates error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

templates.get('/api/templates/:id', async (c) => {
  try {
    const id = c.req.param('id');
    const tenantId = c.get('tenantId') || undefined;
    const item = await getTemplateById(c.env.DB, id, tenantId);
    if (!item) return c.json({ success: false, error: 'Template not found' }, 404);
    const usedBy = await getTemplateUsage(c.env.DB, id, tenantId);
    return c.json({
      success: true,
      data: {
        id: item.id,
        name: item.name,
        category: item.category,
        messageType: item.message_type,
        messageContent: item.message_content,
        usedBy,
        createdAt: item.created_at,
        updatedAt: item.updated_at,
      },
    });
  } catch (err) {
    console.error('GET /api/templates/:id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// GET /api/templates/:id/usages — auto_replies + scenario_steps での使用箇所
templates.get('/api/templates/:id/usages', async (c) => {
  try {
    const templateId = c.req.param('id');
    const tenantId = c.get('tenantId') || undefined;
    if (!await getTemplateById(c.env.DB, templateId, tenantId)) {
      return c.json({ success: false, error: 'Template not found' }, 404);
    }
    const usage = await getTemplateUsage(c.env.DB, templateId, tenantId);

    return c.json({
      success: true,
      data: {
        autoReplies: usage.autoReplies.map(({ id, keyword, lineAccountId }) => ({
          id,
          keyword,
          lineAccountId,
        })),
        scenarioSteps: usage.scenarioSteps,
      },
    });
  } catch (err) {
    console.error('GET /api/templates/:id/usages error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

templates.post('/api/templates', async (c) => {
  try {
    const body = await c.req.json<{ name: string; category?: string; messageType: string; messageContent: string }>();
    if (!body.name || !body.messageType || !body.messageContent) {
      return c.json({ success: false, error: 'name, messageType, messageContent are required' }, 400);
    }
    const item = await createTemplate(c.env.DB, {
      name: body.name,
      category: body.category,
      messageType: body.messageType,
      messageContent: body.messageContent,
      tenantId: c.get('tenantId') ?? null,
    });
    return c.json({ success: true, data: { id: item.id, name: item.name, category: item.category, messageType: item.message_type, createdAt: item.created_at } }, 201);
  } catch (err) {
    console.error('POST /api/templates error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

templates.put('/api/templates/:id', async (c) => {
  try {
    const id = c.req.param('id');
    const tenantId = c.get('tenantId') || undefined;
    const body = await c.req.json<Partial<{
      name: string;
      category: string;
      messageType: string;
      messageContent: string;
    }>>();
    const updates = {
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.category !== undefined ? { category: body.category } : {}),
      ...(body.messageType !== undefined ? { messageType: body.messageType } : {}),
      ...(body.messageContent !== undefined ? { messageContent: body.messageContent } : {}),
    };
    if (!await updateTemplate(c.env.DB, id, updates, tenantId)) {
      return c.json({ success: false, error: 'Not found' }, 404);
    }
    const updated = await getTemplateById(c.env.DB, id, tenantId);
    if (!updated) return c.json({ success: false, error: 'Not found' }, 404);
    return c.json({
      success: true,
      data: { id: updated.id, name: updated.name, category: updated.category, messageType: updated.message_type, messageContent: updated.message_content },
    });
  } catch (err) {
    console.error('PUT /api/templates/:id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

templates.delete('/api/templates/:id', async (c) => {
  try {
    const id = c.req.param('id');
    const tenantId = c.get('tenantId') || undefined;
    if (!await getTemplateById(c.env.DB, id, tenantId)) {
      return c.json({ success: false, error: 'Template not found' }, 404);
    }
    // automations.actions JSON には FK が無いので、削除すると orphan な template_id が
    // 残って実行時に空メッセージ送信→partial fail を引き起こす。auto_replies は
    // ON DELETE SET NULL + inline fallback (responseContent snapshot) で大丈夫だが、
    // automations は安全な fallback パスがないので、参照があれば削除を拒否する。
    const usage = await getTemplateUsage(c.env.DB, id, tenantId);
    if (usage.automations.length > 0) {
      return c.json({
        success: false,
        error: `automation rule (${usage.automations.length} 件) でこのテンプレートを参照しています。先にそちらの参照を解除してください。`,
        usedBy: usage,
      }, 409);
    }
    if (!await deleteTemplate(c.env.DB, id, tenantId)) {
      return c.json({ success: false, error: 'Template not found' }, 404);
    }
    return c.json({ success: true, data: null });
  } catch (err) {
    console.error('DELETE /api/templates/:id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

export { templates };
