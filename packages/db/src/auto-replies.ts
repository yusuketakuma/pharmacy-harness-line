import { jstNow } from './utils.js';
// =============================================================================
// Auto-Replies — Keyword-triggered automatic responses (L社 自動応答 equivalent)
// =============================================================================

export interface AutoReply {
  id: string;
  keyword: string;
  match_type: 'exact' | 'contains';
  response_type: string;
  response_content: string;
  template_id: string | null;
  line_account_id: string | null;
  is_active: number;
  created_at: string;
}

// ── CRUD ─────────────────────────────────────────────────────────────────────

export async function getAutoReplies(
  db: D1Database,
  lineAccountId?: string,
  tenantId?: string,
): Promise<AutoReply[]> {
  if (tenantId !== undefined) {
    const accountFilter = lineAccountId ? ' AND reply.line_account_id = ?' : '';
    const binds = lineAccountId ? [tenantId, lineAccountId] : [tenantId];
    const result = await db
      .prepare(`
        SELECT reply.*
          FROM auto_replies AS reply
          INNER JOIN tenant_line_accounts AS mapping
                  ON mapping.line_account_id = reply.line_account_id
          INNER JOIN line_accounts AS account
                  ON account.id = reply.line_account_id
                 AND account.is_active = 1
          INNER JOIN tenants AS tenant
                  ON tenant.id = mapping.tenant_id
                 AND tenant.status = 'active'
         WHERE mapping.tenant_id = ?
           AND reply.line_account_id IS NOT NULL
           ${accountFilter}
         ORDER BY reply.created_at DESC`)
      .bind(...binds)
      .all<AutoReply>();
    return result.results;
  }
  if (lineAccountId) {
    const result = await db
      .prepare(`SELECT * FROM auto_replies WHERE (line_account_id IS NULL OR line_account_id = ?) ORDER BY created_at DESC`)
      .bind(lineAccountId)
      .all<AutoReply>();
    return result.results;
  }
  const result = await db
    .prepare(`SELECT * FROM auto_replies ORDER BY created_at DESC`)
    .all<AutoReply>();
  return result.results;
}

export async function getAutoReplyById(
  db: D1Database,
  id: string,
  tenantId?: string,
): Promise<AutoReply | null> {
  if (tenantId !== undefined) {
    return db
      .prepare(`
        SELECT reply.*
          FROM auto_replies AS reply
          INNER JOIN tenant_line_accounts AS mapping
                  ON mapping.line_account_id = reply.line_account_id
          INNER JOIN line_accounts AS account
                  ON account.id = reply.line_account_id
                 AND account.is_active = 1
          INNER JOIN tenants AS tenant
                  ON tenant.id = mapping.tenant_id
                 AND tenant.status = 'active'
         WHERE reply.id = ?
           AND mapping.tenant_id = ?
           AND reply.line_account_id IS NOT NULL
         LIMIT 1`)
      .bind(id, tenantId)
      .first<AutoReply>();
  }
  return db
    .prepare(`SELECT * FROM auto_replies WHERE id = ?`)
    .bind(id)
    .first<AutoReply>();
}

export interface CreateAutoReplyInput {
  keyword: string;
  matchType?: 'exact' | 'contains';
  responseType?: string;
  responseContent: string;
  templateId?: string | null;
  lineAccountId?: string | null;
  tenantId?: string;
}

export async function createAutoReply(
  db: D1Database,
  input: CreateAutoReplyInput,
): Promise<AutoReply | null> {
  const id = crypto.randomUUID();
  const now = jstNow();

  if (input.tenantId !== undefined) {
    const lineAccountId = input.lineAccountId?.trim();
    if (!lineAccountId) return null;

    const inserted = await db
      .prepare(`
        INSERT INTO auto_replies
          (id, keyword, match_type, response_type, response_content,
           template_id, line_account_id, is_active, created_at)
        SELECT ?, ?, ?, ?, ?, ?, ?, 1, ?
          FROM tenant_line_accounts AS mapping
          INNER JOIN line_accounts AS account
                  ON account.id = mapping.line_account_id
                 AND account.is_active = 1
          INNER JOIN tenants AS tenant
                  ON tenant.id = mapping.tenant_id
                 AND tenant.status = 'active'
         WHERE mapping.tenant_id = ?
           AND mapping.line_account_id = ?`)
      .bind(
        id,
        input.keyword,
        input.matchType ?? 'exact',
        input.responseType ?? 'text',
        input.responseContent,
        input.templateId ?? null,
        lineAccountId,
        now,
        input.tenantId,
        lineAccountId,
      )
      .run();
    if ((inserted.meta?.changes ?? 0) !== 1) return null;
    return getAutoReplyById(db, id, input.tenantId);
  }

  await db
    .prepare(
      `INSERT INTO auto_replies
         (id, keyword, match_type, response_type, response_content,
          template_id, line_account_id, is_active, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`,
    )
    .bind(
      id,
      input.keyword,
      input.matchType ?? 'exact',
      input.responseType ?? 'text',
      input.responseContent,
      input.templateId ?? null,
      input.lineAccountId ?? null,
      now,
    )
    .run();

  return (await getAutoReplyById(db, id))!;
}

export interface UpdateAutoReplyInput {
  keyword?: string;
  matchType?: 'exact' | 'contains';
  responseType?: string;
  responseContent?: string;
  templateId?: string | null;
  lineAccountId?: string | null;
  isActive?: boolean;
}

export async function updateAutoReply(
  db: D1Database,
  id: string,
  input: UpdateAutoReplyInput,
  tenantId?: string,
): Promise<AutoReply | null> {
  const existing = await getAutoReplyById(db, id, tenantId);
  if (!existing) return null;

  const now = jstNow();
  const tenantScope = tenantId === undefined ? '' : `
       AND auto_replies.line_account_id IS NOT NULL
       AND EXISTS (
         SELECT 1
           FROM tenant_line_accounts AS mapping
           INNER JOIN line_accounts AS account
                   ON account.id = mapping.line_account_id
                  AND account.is_active = 1
           INNER JOIN tenants AS tenant
                   ON tenant.id = mapping.tenant_id
                  AND tenant.status = 'active'
          WHERE mapping.tenant_id = ?
            AND mapping.line_account_id = auto_replies.line_account_id
       )`;

  await db
    .prepare(
      `UPDATE auto_replies
       SET keyword = ?,
           match_type = ?,
           response_type = ?,
           response_content = ?,
           template_id = ?,
           line_account_id = ?,
           is_active = ?,
           created_at = ?
       WHERE id = ?${tenantScope}`,
    )
    .bind(
      input.keyword ?? existing.keyword,
      input.matchType ?? existing.match_type,
      input.responseType ?? existing.response_type,
      input.responseContent ?? existing.response_content,
      'templateId' in input ? (input.templateId ?? null) : existing.template_id,
      tenantId === undefined && 'lineAccountId' in input
        ? (input.lineAccountId ?? null)
        : existing.line_account_id,
      'isActive' in input ? (input.isActive ? 1 : 0) : existing.is_active,
      existing.created_at,
      id,
      ...(tenantId === undefined ? [] : [tenantId]),
    )
    .run();

  return getAutoReplyById(db, id, tenantId);
}

export async function deleteAutoReply(db: D1Database, id: string, tenantId?: string): Promise<boolean> {
  const tenantScope = tenantId === undefined ? '' : `
       AND auto_replies.line_account_id IS NOT NULL
       AND EXISTS (
         SELECT 1
           FROM tenant_line_accounts AS mapping
           INNER JOIN line_accounts AS account
                   ON account.id = mapping.line_account_id
                  AND account.is_active = 1
           INNER JOIN tenants AS tenant
                   ON tenant.id = mapping.tenant_id
                  AND tenant.status = 'active'
          WHERE mapping.tenant_id = ?
            AND mapping.line_account_id = auto_replies.line_account_id
       )`;
  const binds: unknown[] = [id];
  if (tenantId !== undefined) binds.push(tenantId);
  const deleted = await db
    .prepare(`DELETE FROM auto_replies WHERE id = ?${tenantScope}`)
    .bind(...binds)
    .run();
  return (deleted.meta?.changes ?? 0) > 0;
}
