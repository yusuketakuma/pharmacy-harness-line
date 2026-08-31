import { jstNow } from './utils.js';
// テンプレート管理クエリヘルパー

export interface TemplateRow {
  id: string;
  tenant_id: string | null;
  name: string;
  category: string;
  message_type: string;
  message_content: string;
  created_at: string;
  updated_at: string;
}

export async function getTemplates(
  db: D1Database,
  category?: string,
  tenantId?: string | null,
): Promise<TemplateRow[]> {
  const conditions: string[] = [];
  const values: unknown[] = [];
  if (tenantId !== undefined) {
    conditions.push('tenant_id IS ?');
    values.push(tenantId);
  }
  if (category) {
    conditions.push('category = ?');
    values.push(category);
  }
  const where = conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : '';
  const result = await db.prepare(`SELECT * FROM templates${where} ORDER BY created_at DESC`)
    .bind(...values).all<TemplateRow>();
  return result.results;
}

export async function getTemplateById(
  db: D1Database,
  id: string,
  tenantId?: string | null,
): Promise<TemplateRow | null> {
  const tenantScope = tenantId === undefined ? '' : ' AND tenant_id IS ?';
  return db.prepare(`SELECT * FROM templates WHERE id = ?${tenantScope}`)
    .bind(...(tenantId === undefined ? [id] : [id, tenantId]))
    .first<TemplateRow>();
}

export async function createTemplate(
  db: D1Database,
  input: {
    name: string;
    category?: string;
    messageType: string;
    messageContent: string;
    tenantId?: string | null;
  },
): Promise<TemplateRow> {
  const id = crypto.randomUUID();
  const now = jstNow();
  const tenantId = input.tenantId ?? null;
  await db.prepare(`INSERT INTO templates (id, tenant_id, name, category, message_type, message_content, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(id, tenantId, input.name, input.category ?? 'general', input.messageType, input.messageContent, now, now).run();
  return (await getTemplateById(db, id, tenantId))!;
}

export async function updateTemplate(
  db: D1Database,
  id: string,
  updates: Partial<{ name: string; category: string; messageType: string; messageContent: string }>,
  tenantId?: string | null,
): Promise<boolean> {
  if (!await getTemplateById(db, id, tenantId)) return false;
  const sets: string[] = [];
  const values: unknown[] = [];
  if (updates.name !== undefined) { sets.push('name = ?'); values.push(updates.name); }
  if (updates.category !== undefined) { sets.push('category = ?'); values.push(updates.category); }
  if (updates.messageType !== undefined) { sets.push('message_type = ?'); values.push(updates.messageType); }
  if (updates.messageContent !== undefined) { sets.push('message_content = ?'); values.push(updates.messageContent); }
  if (sets.length === 0) return true;
  sets.push('updated_at = ?');
  values.push(jstNow());
  values.push(id);
  const tenantScope = tenantId === undefined ? '' : ' AND tenant_id IS ?';
  if (tenantId !== undefined) values.push(tenantId);
  const updated = await db.prepare(`UPDATE templates SET ${sets.join(', ')} WHERE id = ?${tenantScope}`)
    .bind(...values).run();
  return (updated.meta?.changes ?? 0) === 1;
}

export async function deleteTemplate(
  db: D1Database,
  id: string,
  tenantId?: string | null,
): Promise<boolean> {
  const tenantScope = tenantId === undefined ? '' : ' AND tenant_id IS ?';
  const deleted = await db.prepare(`DELETE FROM templates WHERE id = ?${tenantScope}`)
    .bind(...(tenantId === undefined ? [id] : [id, tenantId])).run();
  return (deleted.meta?.changes ?? 0) === 1;
}

export interface TemplateUsage {
  autoReplies: Array<{
    id: string;
    keyword: string;
    matchType: 'exact' | 'contains';
    lineAccountId: string | null;
  }>;
  automations: Array<{
    id: string;
    name: string;
    eventType: string;
  }>;
  scenarioSteps: Array<{
    scenarioId: string;
    scenarioName: string;
    stepId: string;
    stepOrder: number;
  }>;
}

/**
 * Template の参照箇所を返す。
 * - auto_replies: template_id が一致する row
 * - automations: actions JSON 内に "template_id":"<id>" を含む row (LIKE 検索)
 *   automations は数十件規模なので LIKE で十分高速。
 */
export async function getTemplateUsage(
  db: D1Database,
  templateId: string,
  tenantId?: string | null,
): Promise<TemplateUsage> {
  const arSql = tenantId === undefined
    ? `SELECT id, keyword, match_type, line_account_id
         FROM auto_replies WHERE template_id = ? ORDER BY created_at DESC`
    : `SELECT reply.id, reply.keyword, reply.match_type, reply.line_account_id
         FROM auto_replies AS reply
         LEFT JOIN tenant_line_accounts AS mapping
           ON mapping.line_account_id = reply.line_account_id
        WHERE reply.template_id = ? AND mapping.tenant_id IS ?
        ORDER BY reply.created_at DESC`;
  const arRes = await db
    .prepare(arSql)
    .bind(...(tenantId === undefined ? [templateId] : [templateId, tenantId]))
    .all<{ id: string; keyword: string; match_type: 'exact' | 'contains'; line_account_id: string | null }>();

  // automations の actions JSON を全件取って JS 側で template_id をマッチさせる。
  // SQL LIKE で "%\"template_id\":\"<id>\"%" を投げると D1 SQLite の
  // "pattern too complex" 上限に当たるので JS 処理にしている。
  const autSql = tenantId === undefined
    ? `SELECT id, name, event_type, actions FROM automations ORDER BY created_at DESC`
    : `SELECT automation.id, automation.name, automation.event_type, automation.actions
         FROM automations AS automation
         LEFT JOIN tenant_line_accounts AS mapping
           ON mapping.line_account_id = automation.line_account_id
        WHERE mapping.tenant_id IS ?
        ORDER BY automation.created_at DESC`;
  const autRes = await db
    .prepare(autSql)
    .bind(...(tenantId === undefined ? [] : [tenantId]))
    .all<{ id: string; name: string; event_type: string; actions: string }>();
  const matchedAutomations: Array<{ id: string; name: string; event_type: string }> = [];
  for (const r of autRes.results ?? []) {
    try {
      const actions = JSON.parse(r.actions) as Array<{ params?: { template_id?: string } }>;
      if (actions.some((a) => a.params?.template_id === templateId)) {
        matchedAutomations.push({ id: r.id, name: r.name, event_type: r.event_type });
      }
    } catch {
      // ignore malformed
    }
  }

  const scenarioSql = tenantId === undefined
    ? `SELECT step.id AS step_id, step.step_order, step.scenario_id,
              scenario.name AS scenario_name
         FROM scenario_steps AS step
         INNER JOIN scenarios AS scenario ON scenario.id = step.scenario_id
        WHERE step.template_id = ?
        ORDER BY scenario.name, step.step_order`
    : `SELECT step.id AS step_id, step.step_order, step.scenario_id,
              scenario.name AS scenario_name
         FROM scenario_steps AS step
         INNER JOIN scenarios AS scenario ON scenario.id = step.scenario_id
        WHERE step.template_id = ? AND scenario.tenant_id IS ?
        ORDER BY scenario.name, step.step_order`;
  const scenarioRes = await db.prepare(scenarioSql)
    .bind(...(tenantId === undefined ? [templateId] : [templateId, tenantId]))
    .all<{
      step_id: string;
      step_order: number;
      scenario_id: string;
      scenario_name: string;
    }>();

  return {
    autoReplies: (arRes.results ?? []).map((r) => ({
      id: r.id,
      keyword: r.keyword,
      matchType: r.match_type,
      lineAccountId: r.line_account_id,
    })),
    automations: matchedAutomations.map((r) => ({
      id: r.id,
      name: r.name,
      eventType: r.event_type,
    })),
    scenarioSteps: (scenarioRes.results ?? []).map((row) => ({
      scenarioId: row.scenario_id,
      scenarioName: row.scenario_name,
      stepId: row.step_id,
      stepOrder: row.step_order,
    })),
  };
}

export interface TemplateRowWithUsage extends TemplateRow {
  usage_count: number;
}

/**
 * 一覧画面用に template + 使用数を返す。
 * - auto_replies は indexed lookup (1 SQL)
 * - automations は actions JSON 全件取って JS で template_id を抽出 (LIKE が
 *   D1 SQLite の "pattern too complex" 上限に当たるので避ける)
 */
export async function getTemplatesWithUsageCount(
  db: D1Database,
  category?: string,
  tenantId?: string | null,
): Promise<TemplateRowWithUsage[]> {
  // 1. templates 本体
  const templates = await getTemplates(db, category, tenantId);

  // 2. auto_replies の template_id 別カウント (NOT NULL のみ)
  const autoReplySql = tenantId === undefined
    ? `SELECT template_id, COUNT(*) AS cnt
         FROM auto_replies WHERE template_id IS NOT NULL GROUP BY template_id`
    : `SELECT reply.template_id, COUNT(*) AS cnt
         FROM auto_replies AS reply
         LEFT JOIN tenant_line_accounts AS mapping
           ON mapping.line_account_id = reply.line_account_id
        WHERE reply.template_id IS NOT NULL AND mapping.tenant_id IS ?
        GROUP BY reply.template_id`;
  const arRes = await db
    .prepare(autoReplySql)
    .bind(...(tenantId === undefined ? [] : [tenantId]))
    .all<{ template_id: string; cnt: number }>();
  const autoReplyCount = new Map<string, number>();
  for (const r of arRes.results ?? []) autoReplyCount.set(r.template_id, r.cnt);

  // 3. automations の actions JSON を取って template_id を抽出
  const automationSql = tenantId === undefined
    ? `SELECT actions FROM automations`
    : `SELECT automation.actions
         FROM automations AS automation
         LEFT JOIN tenant_line_accounts AS mapping
           ON mapping.line_account_id = automation.line_account_id
        WHERE mapping.tenant_id IS ?`;
  const autRes = await db
    .prepare(automationSql)
    .bind(...(tenantId === undefined ? [] : [tenantId]))
    .all<{ actions: string }>();
  const automationCount = new Map<string, number>();
  for (const r of autRes.results ?? []) {
    try {
      const actions = JSON.parse(r.actions) as Array<{ params?: { template_id?: string } }>;
      for (const a of actions) {
        const tid = a.params?.template_id;
        if (tid) automationCount.set(tid, (automationCount.get(tid) ?? 0) + 1);
      }
    } catch {
      // ignore malformed JSON rows
    }
  }

  // 4. scenario_steps の template_id 別カウント
  const scenarioSql = tenantId === undefined
    ? `SELECT template_id, COUNT(*) AS cnt
         FROM scenario_steps WHERE template_id IS NOT NULL GROUP BY template_id`
    : `SELECT step.template_id, COUNT(*) AS cnt
         FROM scenario_steps AS step
         INNER JOIN scenarios AS scenario ON scenario.id = step.scenario_id
        WHERE step.template_id IS NOT NULL AND scenario.tenant_id IS ?
        GROUP BY step.template_id`;
  const ssRes = await db
    .prepare(scenarioSql)
    .bind(...(tenantId === undefined ? [] : [tenantId]))
    .all<{ template_id: string; cnt: number }>();
  const scenarioStepCount = new Map<string, number>();
  for (const r of ssRes.results ?? []) scenarioStepCount.set(r.template_id, r.cnt);

  return templates.map((t) => ({
    ...t,
    usage_count: (autoReplyCount.get(t.id) ?? 0) + (automationCount.get(t.id) ?? 0) + (scenarioStepCount.get(t.id) ?? 0),
  }));
}
