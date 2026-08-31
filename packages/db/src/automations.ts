import { jstNow } from './utils.js';
// アクション自動化 (IF-THEN ルール) クエリヘルパー

export interface AutomationRow {
  id: string;
  name: string;
  description: string | null;
  event_type: string;
  conditions: string;  // JSON
  actions: string;     // JSON配列
  line_account_id: string | null;
  is_active: number;
  priority: number;
  created_at: string;
  updated_at: string;
}

export interface AutomationLogRow {
  id: string;
  automation_id: string;
  friend_id: string | null;
  event_data: string | null;
  actions_result: string | null;
  status: string;
  created_at: string;
}

const SAFE_ACTION_TYPES = new Set([
  'add_tag',
  'remove_tag',
  'start_scenario',
  'send_message',
  'send_webhook',
  'switch_rich_menu',
  'remove_rich_menu',
  'set_metadata',
]);

function redactActionsResult(actionsResult?: string): string | null {
  if (!actionsResult) return null;
  try {
    const parsed = JSON.parse(actionsResult) as unknown;
    if (!Array.isArray(parsed)) return null;
    return JSON.stringify(parsed.map((entry) => {
      if (!entry || typeof entry !== 'object') return { action: 'unknown', success: false };
      const raw = entry as Record<string, unknown>;
      return {
        action: typeof raw.action === 'string' && SAFE_ACTION_TYPES.has(raw.action)
          ? raw.action
          : 'unknown',
        success: raw.success === true,
      };
    }));
  } catch {
    return null;
  }
}

// --- 自動化ルール ---

/** 管理画面用: server-resolved tenant が所有する account-bound rule のみ返す。 */
export async function getAutomations(
  db: D1Database,
  tenantId: string,
  lineAccountId?: string,
): Promise<AutomationRow[]> {
  const accountFilter = lineAccountId !== undefined
    ? ' AND automation.line_account_id = ?'
    : '';
  const binds = lineAccountId !== undefined ? [tenantId, lineAccountId] : [tenantId];
  const result = await db.prepare(`
    SELECT automation.*
      FROM automations AS automation
      INNER JOIN tenant_line_accounts AS mapping
              ON mapping.line_account_id = automation.line_account_id
      INNER JOIN line_accounts AS account
              ON account.id = automation.line_account_id
             AND account.is_active = 1
      INNER JOIN tenants AS tenant
              ON tenant.id = mapping.tenant_id
             AND tenant.status = 'active'
     WHERE mapping.tenant_id = ?
       AND automation.line_account_id IS NOT NULL
       ${accountFilter}
     ORDER BY automation.priority DESC, automation.created_at DESC
  `).bind(...binds).all<AutomationRow>();
  return result.results;
}

/** IDOR 防止用の tenant-scoped detail lookup。 */
export async function getAutomationById(
  db: D1Database,
  id: string,
  tenantId: string,
): Promise<AutomationRow | null> {
  return db.prepare(`
    SELECT automation.*
      FROM automations AS automation
      INNER JOIN tenant_line_accounts AS mapping
              ON mapping.line_account_id = automation.line_account_id
      INNER JOIN line_accounts AS account
              ON account.id = automation.line_account_id
             AND account.is_active = 1
      INNER JOIN tenants AS tenant
              ON tenant.id = mapping.tenant_id
             AND tenant.status = 'active'
     WHERE automation.id = ?
       AND mapping.tenant_id = ?
       AND automation.line_account_id IS NOT NULL
     LIMIT 1
  `).bind(id, tenantId).first<AutomationRow>();
}

export async function createAutomation(
  db: D1Database,
  input: {
    name: string;
    description?: string | null;
    eventType: string;
    conditions?: Record<string, unknown>;
    actions: unknown[];
    priority?: number;
    lineAccountId: string;
    tenantId: string;
  },
): Promise<AutomationRow | null> {
  const id = crypto.randomUUID();
  const now = jstNow();
  const inserted = await db.prepare(`
    INSERT INTO automations
      (id, name, description, event_type, conditions, actions, priority, line_account_id, created_at, updated_at)
    SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      FROM tenant_line_accounts AS mapping
      INNER JOIN line_accounts AS account
              ON account.id = mapping.line_account_id
             AND account.is_active = 1
      INNER JOIN tenants AS tenant
              ON tenant.id = mapping.tenant_id
             AND tenant.status = 'active'
     WHERE mapping.tenant_id = ?
       AND mapping.line_account_id = ?
  `).bind(
    id,
    input.name,
    input.description ?? null,
    input.eventType,
    JSON.stringify(input.conditions ?? {}),
    JSON.stringify(input.actions),
    input.priority ?? 0,
    input.lineAccountId,
    now,
    now,
    input.tenantId,
    input.lineAccountId,
  ).run();
  if ((inserted.meta?.changes ?? 0) !== 1) return null;
  return getAutomationById(db, id, input.tenantId);
}

export async function updateAutomation(
  db: D1Database,
  id: string,
  updates: Partial<{ name: string; description: string | null; eventType: string; conditions: Record<string, unknown>; actions: unknown[]; isActive: boolean; priority: number }>,
  tenantId: string,
): Promise<boolean> {
  const sets: string[] = [];
  const values: unknown[] = [];
  if (updates.name !== undefined) { sets.push('name = ?'); values.push(updates.name); }
  if (updates.description !== undefined) { sets.push('description = ?'); values.push(updates.description); }
  if (updates.eventType !== undefined) { sets.push('event_type = ?'); values.push(updates.eventType); }
  if (updates.conditions !== undefined) { sets.push('conditions = ?'); values.push(JSON.stringify(updates.conditions)); }
  if (updates.actions !== undefined) { sets.push('actions = ?'); values.push(JSON.stringify(updates.actions)); }
  if (updates.isActive !== undefined) { sets.push('is_active = ?'); values.push(updates.isActive ? 1 : 0); }
  if (updates.priority !== undefined) { sets.push('priority = ?'); values.push(updates.priority); }
  if (sets.length === 0) {
    return (await getAutomationById(db, id, tenantId)) !== null;
  }
  sets.push('updated_at = ?');
  values.push(jstNow());
  values.push(id);
  const scope = `
       AND automations.line_account_id IS NOT NULL
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
            AND mapping.line_account_id = automations.line_account_id
       )`;
  values.push(tenantId);
  const updated = await db
    .prepare(`UPDATE automations SET ${sets.join(', ')} WHERE id = ?${scope}`)
    .bind(...values)
    .run();
  return (updated.meta?.changes ?? 0) === 1;
}

export async function deleteAutomation(db: D1Database, id: string, tenantId: string): Promise<boolean> {
  const scope = `
       AND automations.line_account_id IS NOT NULL
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
            AND mapping.line_account_id = automations.line_account_id
       )`;
  const binds: unknown[] = [id];
  binds.push(tenantId);
  const deleted = await db
    .prepare(`DELETE FROM automations WHERE id = ?${scope}`)
    .bind(...binds)
    .run();
  return (deleted.meta?.changes ?? 0) === 1;
}

// --- 自動化ログ ---

export async function getAutomationLogs(
  db: D1Database,
  automationId: string,
  tenantId: string,
  limit = 100,
): Promise<AutomationLogRow[]> {
  const result = await db.prepare(`
    SELECT log.id, log.automation_id, NULL AS friend_id,
           NULL AS event_data, NULL AS actions_result, log.status, log.created_at
      FROM automation_logs AS log
      INNER JOIN automations AS automation
              ON automation.id = log.automation_id
      INNER JOIN tenant_line_accounts AS mapping
              ON mapping.line_account_id = automation.line_account_id
      INNER JOIN line_accounts AS account
              ON account.id = automation.line_account_id
             AND account.is_active = 1
      INNER JOIN tenants AS tenant
              ON tenant.id = mapping.tenant_id
             AND tenant.status = 'active'
     WHERE log.automation_id = ?
       AND mapping.tenant_id = ?
       AND automation.line_account_id IS NOT NULL
     ORDER BY log.created_at DESC
     LIMIT ?
  `).bind(automationId, tenantId, limit).all<AutomationLogRow>();
  return result.results;
}

export async function createAutomationLog(
  db: D1Database,
  input: { automationId: string; friendId?: string; eventData?: string; actionsResult?: string; status: string },
): Promise<void> {
  const id = crypto.randomUUID();
  const now = jstNow();
  await db.prepare(`INSERT INTO automation_logs (id, automation_id, friend_id, event_data, actions_result, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .bind(
      id,
      input.automationId,
      input.friendId ?? null,
      null,
      redactActionsResult(input.actionsResult),
      input.status,
      now,
    ).run();
}

/** イベントタイプに一致するアクティブな自動化ルールを取得（優先度順） */
export async function getActiveAutomationsByEvent(db: D1Database, eventType: string): Promise<AutomationRow[]> {
  const result = await db.prepare(`SELECT * FROM automations WHERE event_type = ? AND is_active = 1 ORDER BY priority DESC`)
    .bind(eventType).all<AutomationRow>();
  return result.results;
}
