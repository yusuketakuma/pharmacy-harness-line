import { jstNow } from './utils.js';
// Webhook IN/OUT クエリヘルパー

export interface IncomingWebhookRow {
  id: string;
  tenant_id: string | null;
  name: string;
  source_type: string;
  secret: string | null;
  is_active: number;
  created_at: string;
  updated_at: string;
}

export interface OutgoingWebhookRow {
  id: string;
  tenant_id: string | null;
  name: string;
  url: string;
  event_types: string; // JSON配列
  secret: string | null;
  is_active: number;
  created_at: string;
  updated_at: string;
}

// --- 受信Webhook ---

export async function getIncomingWebhooks(db: D1Database, tenantId: string | null = null): Promise<IncomingWebhookRow[]> {
  const result = await db.prepare(`SELECT * FROM incoming_webhooks WHERE tenant_id IS ? ORDER BY created_at DESC`).bind(tenantId).all<IncomingWebhookRow>();
  return result.results;
}

export async function getIncomingWebhookById(
  db: D1Database,
  id: string,
  tenantId?: string | null,
): Promise<IncomingWebhookRow | null> {
  return tenantId === undefined
    ? db.prepare(`SELECT * FROM incoming_webhooks WHERE id = ?`).bind(id).first<IncomingWebhookRow>()
    : db.prepare(`SELECT * FROM incoming_webhooks WHERE id = ? AND tenant_id IS ?`).bind(id, tenantId).first<IncomingWebhookRow>();
}

export async function createIncomingWebhook(
  db: D1Database,
  input: { name: string; sourceType?: string; secret?: string; tenantId?: string | null },
): Promise<IncomingWebhookRow> {
  const id = crypto.randomUUID();
  const now = jstNow();
  await db
    .prepare(`INSERT INTO incoming_webhooks (id, name, source_type, secret, tenant_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .bind(id, input.name, input.sourceType ?? 'custom', input.secret ?? null, input.tenantId ?? null, now, now)
    .run();
  return (await getIncomingWebhookById(db, id, input.tenantId ?? null))!;
}

export async function updateIncomingWebhook(
  db: D1Database,
  id: string,
  updates: Partial<{ name: string; sourceType: string; secret: string; isActive: boolean }>,
  tenantId: string | null = null,
): Promise<void> {
  const sets: string[] = [];
  const values: unknown[] = [];
  if (updates.name !== undefined) { sets.push('name = ?'); values.push(updates.name); }
  if (updates.sourceType !== undefined) { sets.push('source_type = ?'); values.push(updates.sourceType); }
  if (updates.secret !== undefined) { sets.push('secret = ?'); values.push(updates.secret); }
  if (updates.isActive !== undefined) { sets.push('is_active = ?'); values.push(updates.isActive ? 1 : 0); }
  if (sets.length === 0) return;
  sets.push('updated_at = ?');
  values.push(jstNow());
  values.push(id);
  values.push(tenantId);
  await db.prepare(`UPDATE incoming_webhooks SET ${sets.join(', ')} WHERE id = ? AND tenant_id IS ?`).bind(...values).run();
}

export async function deleteIncomingWebhook(db: D1Database, id: string, tenantId: string | null = null): Promise<boolean> {
  const result = await db.prepare(`DELETE FROM incoming_webhooks WHERE id = ? AND tenant_id IS ?`).bind(id, tenantId).run();
  return (result.meta?.changes ?? 0) > 0;
}

// --- 送信Webhook ---

export async function getOutgoingWebhooks(db: D1Database, tenantId: string | null = null): Promise<OutgoingWebhookRow[]> {
  const result = await db.prepare(`SELECT * FROM outgoing_webhooks WHERE tenant_id IS ? ORDER BY created_at DESC`).bind(tenantId).all<OutgoingWebhookRow>();
  return result.results;
}

export async function getOutgoingWebhookById(
  db: D1Database,
  id: string,
  tenantId?: string | null,
): Promise<OutgoingWebhookRow | null> {
  return tenantId === undefined
    ? db.prepare(`SELECT * FROM outgoing_webhooks WHERE id = ?`).bind(id).first<OutgoingWebhookRow>()
    : db.prepare(`SELECT * FROM outgoing_webhooks WHERE id = ? AND tenant_id IS ?`).bind(id, tenantId).first<OutgoingWebhookRow>();
}

export async function createOutgoingWebhook(
  db: D1Database,
  input: { name: string; url: string; eventTypes: string[]; secret?: string; tenantId?: string | null },
): Promise<OutgoingWebhookRow> {
  const id = crypto.randomUUID();
  const now = jstNow();
  await db
    .prepare(`INSERT INTO outgoing_webhooks (id, name, url, event_types, secret, tenant_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(id, input.name, input.url, JSON.stringify(input.eventTypes), input.secret ?? null, input.tenantId ?? null, now, now)
    .run();
  return (await getOutgoingWebhookById(db, id, input.tenantId ?? null))!;
}

export async function updateOutgoingWebhook(
  db: D1Database,
  id: string,
  updates: Partial<{ name: string; url: string; eventTypes: string[]; secret: string; isActive: boolean }>,
  tenantId: string | null = null,
): Promise<void> {
  const sets: string[] = [];
  const values: unknown[] = [];
  if (updates.name !== undefined) { sets.push('name = ?'); values.push(updates.name); }
  if (updates.url !== undefined) { sets.push('url = ?'); values.push(updates.url); }
  if (updates.eventTypes !== undefined) { sets.push('event_types = ?'); values.push(JSON.stringify(updates.eventTypes)); }
  if (updates.secret !== undefined) { sets.push('secret = ?'); values.push(updates.secret); }
  if (updates.isActive !== undefined) { sets.push('is_active = ?'); values.push(updates.isActive ? 1 : 0); }
  if (sets.length === 0) return;
  sets.push('updated_at = ?');
  values.push(jstNow());
  values.push(id);
  values.push(tenantId);
  await db.prepare(`UPDATE outgoing_webhooks SET ${sets.join(', ')} WHERE id = ? AND tenant_id IS ?`).bind(...values).run();
}

export async function deleteOutgoingWebhook(db: D1Database, id: string, tenantId: string | null = null): Promise<boolean> {
  const result = await db.prepare(`DELETE FROM outgoing_webhooks WHERE id = ? AND tenant_id IS ?`).bind(id, tenantId).run();
  return (result.meta?.changes ?? 0) > 0;
}

/** 指定イベントタイプとテナントに一致するアクティブな送信Webhookを取得 */
export async function getActiveOutgoingWebhooksByEvent(
  db: D1Database,
  eventType: string,
  tenantId: string | null = null,
): Promise<OutgoingWebhookRow[]> {
  const all = await db
    .prepare(`SELECT * FROM outgoing_webhooks WHERE is_active = 1 AND tenant_id IS ?`)
    .bind(tenantId)
    .all<OutgoingWebhookRow>();
  return all.results.filter((w) => {
    const types: string[] = JSON.parse(w.event_types);
    return types.includes(eventType) || types.includes('*');
  });
}
