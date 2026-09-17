import { Hono } from 'hono';
import type { Context } from 'hono';
import type { Env } from '../../../index.js';
import { readJsonObject } from '../json.js';
import { canAccessPharmacyAccount, hasPharmacyCapability } from '../growth-loop/access.js';
import {
  archiveChatTemplate,
  approveChatTemplate,
  createChatTemplate,
  listChatTemplates,
  updateChatTemplate,
  type PharmacyChatTemplate,
} from './repository.js';

type ChatTemplateEnv = {
  Bindings: Env['Bindings'];
  Variables: Env['Variables'];
};

export const chatTemplateRoutes = new Hono<ChatTemplateEnv>();

async function scope(c: Context<ChatTemplateEnv>): Promise<{
  lineAccountId: string;
  staff: { id: string; name: string; role: 'owner' | 'admin' | 'staff' };
} | Response> {
  const lineAccountId = c.req.query('line_account_id');
  if (!lineAccountId) return c.json({ error: 'line_account_id is required' }, 400);
  const staff = c.get('staff');
  if (!staff) return c.json({ error: 'Unauthorized' }, 401);
  if (!(await canAccessPharmacyAccount(c.env.DB, staff, lineAccountId))) {
    return c.json({ error: 'Forbidden' }, 403);
  }
  return { lineAccountId, staff };
}

function projection(row: PharmacyChatTemplate) {
  return {
    id: row.template_id,
    title: row.title,
    body: row.body,
    status: row.status,
    version: row.version,
    approved_at: row.approved_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function templateError(c: Context<ChatTemplateEnv>, error: unknown): Response {
  const message = error instanceof Error ? error.message : '';
  if (/schema unavailable/i.test(message)) {
    return c.json({ error: 'チャット定型文は準備中です。' }, 503);
  }
  if (/not found/i.test(message)) {
    return c.json({ error: '定型文が見つかりません。' }, 404);
  }
  if (/invalid chat template state/i.test(message)) {
    return c.json({ error: '定型文の状態を確認してください。' }, 409);
  }
  if (/invalid chat template staff/i.test(message)) {
    return c.json({ error: '担当者の設定を確認してください。' }, 400);
  }
  if (/invalid chat template/i.test(message)) {
    return c.json({ error: '定型文の入力内容を確認してください。' }, 400);
  }
  if (/conflict/i.test(message)) {
    return c.json({ error: '定型文は別の操作で更新されています。再読み込みしてください。' }, 409);
  }
  return c.json({ error: '定型文を処理できませんでした。' }, 500);
}

async function requireManualChatCapability(
  c: Context<ChatTemplateEnv>,
  lineAccountId: string,
): Promise<Response | null> {
  if (!(await hasPharmacyCapability(c.env.DB, lineAccountId, 'manual_chat'))) {
    return c.json({ error: '個別チャットはこのアカウントでは無効です' }, 409);
  }
  return null;
}

chatTemplateRoutes.get('/api/custom/pharmacy/chat-templates', async (c) => {
  const account = await scope(c);
  if (account instanceof Response) return account;
  const status = c.req.query('status');
  if (status !== undefined && !['all', 'draft', 'approved', 'archived'].includes(status)) {
    return c.json({ error: '定型文の状態指定を確認してください' }, 400);
  }
  try {
    const rows = await listChatTemplates(c.env.DB, account.lineAccountId);
    const filtered = status === 'approved' || status === 'draft' || status === 'archived'
      ? rows.filter((row) => row.status === status)
      : status === 'all'
        ? rows
        : rows.filter((row) => row.status !== 'archived');
    return c.json({ templates: filtered.map(projection) });
  } catch (error) {
    return templateError(c, error);
  }
});

chatTemplateRoutes.post('/api/custom/pharmacy/chat-templates', async (c) => {
  const account = await scope(c);
  if (account instanceof Response) return account;
  const disabled = await requireManualChatCapability(c, account.lineAccountId);
  if (disabled) return disabled;
  const body = await readJsonObject(c.req);
  if (!body || typeof body.title !== 'string' || typeof body.body !== 'string') {
    return c.json({ error: 'titleとbodyは必須です' }, 400);
  }
  try {
    const template = await createChatTemplate(c.env.DB, {
      lineAccountId: account.lineAccountId,
      templateId: crypto.randomUUID(),
      title: body.title,
      body: body.body,
      actorStaffId: account.staff.id,
    });
    return c.json({ template: projection(template) }, 201);
  } catch (error) {
    return templateError(c, error);
  }
});

function parseVersionedMutation(body: Record<string, unknown> | null): number | null {
  if (!body || typeof body.expectedVersion !== 'number' ||
      !Number.isInteger(body.expectedVersion) || body.expectedVersion < 1) {
    return null;
  }
  return body.expectedVersion;
}

chatTemplateRoutes.put('/api/custom/pharmacy/chat-templates/:id', async (c) => {
  const account = await scope(c);
  if (account instanceof Response) return account;
  const disabled = await requireManualChatCapability(c, account.lineAccountId);
  if (disabled) return disabled;
  const body = await readJsonObject(c.req);
  const expectedVersion = parseVersionedMutation(body);
  if (expectedVersion === null || typeof body?.title !== 'string' ||
      typeof body?.body !== 'string') {
    return c.json({ error: 'title、body、expectedVersionは必須です' }, 400);
  }
  try {
    const template = await updateChatTemplate(c.env.DB, {
      lineAccountId: account.lineAccountId,
      templateId: c.req.param('id'),
      title: body.title,
      body: body.body,
      expectedVersion,
      actorStaffId: account.staff.id,
    });
    return c.json({ template: projection(template) });
  } catch (error) {
    return templateError(c, error);
  }
});

chatTemplateRoutes.post('/api/custom/pharmacy/chat-templates/:id/approve', async (c) => {
  const account = await scope(c);
  if (account instanceof Response) return account;
  if (account.staff.role !== 'owner' && account.staff.role !== 'admin') {
    return c.json({ error: '定型文の承認はオーナーまたは管理者のみ実行できます' }, 403);
  }
  const disabled = await requireManualChatCapability(c, account.lineAccountId);
  if (disabled) return disabled;
  const body = await readJsonObject(c.req);
  const expectedVersion = parseVersionedMutation(body);
  if (expectedVersion === null) {
    return c.json({ error: 'expectedVersionは必須です' }, 400);
  }
  try {
    const template = await approveChatTemplate(c.env.DB, {
      lineAccountId: account.lineAccountId,
      templateId: c.req.param('id'),
      expectedVersion,
      actorStaffId: account.staff.id,
    });
    return c.json({ template: projection(template) });
  } catch (error) {
    return templateError(c, error);
  }
});

chatTemplateRoutes.post('/api/custom/pharmacy/chat-templates/:id/archive', async (c) => {
  const account = await scope(c);
  if (account instanceof Response) return account;
  const disabled = await requireManualChatCapability(c, account.lineAccountId);
  if (disabled) return disabled;
  const body = await readJsonObject(c.req);
  const expectedVersion = parseVersionedMutation(body);
  if (expectedVersion === null) {
    return c.json({ error: 'expectedVersionは必須です' }, 400);
  }
  try {
    const template = await archiveChatTemplate(c.env.DB, {
      lineAccountId: account.lineAccountId,
      templateId: c.req.param('id'),
      expectedVersion,
      actorStaffId: account.staff.id,
    });
    return c.json({ template: projection(template) });
  } catch (error) {
    return templateError(c, error);
  }
});
