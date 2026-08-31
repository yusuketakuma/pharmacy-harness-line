import { jstNow } from './utils.js';

export interface MessageTemplate {
  id: string;
  tenant_id: string | null;
  name: string;
  message_type: 'text' | 'flex';
  message_content: string;
  created_at: string;
  updated_at: string;
}

export async function listMessageTemplates(
  db: D1Database,
  tenantId: string | null = null,
): Promise<MessageTemplate[]> {
  const result = await db
    .prepare('SELECT * FROM message_templates WHERE tenant_id IS ? ORDER BY name ASC')
    .bind(tenantId)
    .all<MessageTemplate>();
  return result.results;
}

export async function getMessageTemplateById(
  db: D1Database,
  id: string,
  tenantId?: string | null,
): Promise<MessageTemplate | null> {
  const scoped = tenantId !== undefined;
  return db
    .prepare(`SELECT * FROM message_templates WHERE id = ?${scoped ? ' AND tenant_id IS ?' : ''}`)
    .bind(...(scoped ? [id, tenantId] : [id]))
    .first<MessageTemplate>();
}

export interface CreateMessageTemplateInput {
  name: string;
  messageType: 'text' | 'flex';
  messageContent: string;
  tenantId?: string | null;
}

export async function createMessageTemplate(
  db: D1Database,
  input: CreateMessageTemplateInput,
): Promise<MessageTemplate> {
  const id = crypto.randomUUID();
  const now = jstNow();
  const result = await db
    .prepare(
      'INSERT INTO message_templates (id, tenant_id, name, message_type, message_content, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *',
    )
    .bind(id, input.tenantId ?? null, input.name, input.messageType, input.messageContent, now, now)
    .first<MessageTemplate>();
  return result!;
}

export interface UpdateMessageTemplateInput {
  name?: string;
  messageType?: 'text' | 'flex';
  messageContent?: string;
}

export async function updateMessageTemplate(
  db: D1Database,
  id: string,
  input: UpdateMessageTemplateInput,
  tenantId: string | null = null,
): Promise<MessageTemplate | null> {
  const existing = await getMessageTemplateById(db, id, tenantId);
  if (!existing) return null;

  const now = jstNow();
  const name = input.name ?? existing.name;
  const messageType = input.messageType ?? existing.message_type;
  const messageContent = input.messageContent ?? existing.message_content;

  const result = await db
    .prepare(
      'UPDATE message_templates SET name = ?, message_type = ?, message_content = ?, updated_at = ? WHERE id = ? AND tenant_id IS ? RETURNING *',
    )
    .bind(name, messageType, messageContent, now, id, tenantId)
    .first<MessageTemplate>();
  return result;
}

export async function deleteMessageTemplate(
  db: D1Database,
  id: string,
  tenantId: string | null = null,
): Promise<boolean> {
  const result = await db
    .prepare('DELETE FROM message_templates WHERE id = ? AND tenant_id IS ?')
    .bind(id, tenantId)
    .run();
  return result.meta.changes > 0;
}
