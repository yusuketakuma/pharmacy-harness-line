import { tenantAuditStatement } from '../../../lib/tenant-audit.js';
import { assertPharmacyAutomatedText } from '../growth-loop/policy.js';

export type PharmacyChatTemplateStatus = 'draft' | 'approved' | 'archived';

export interface PharmacyChatTemplate {
  line_account_id: string;
  template_id: string;
  title: string;
  body: string;
  status: PharmacyChatTemplateStatus;
  version: number;
  created_by_staff_id: string;
  approved_by_staff_id: string | null;
  approved_at: string | null;
  created_at: string;
  updated_at: string;
}

const TEMPLATE_ID_RE = /^[A-Za-z0-9._:-]{8,128}$/;
const PLACEHOLDER_RE = /\{\{|\}\}|\$\{/;
const VALID_STAFF_ID = /^[A-Za-z0-9._:-]{1,128}$/;

async function requireChatTemplateTable(db: D1Database): Promise<void> {
  let row: { name: string } | null;
  try {
    row = await db.prepare(
      `SELECT name FROM sqlite_master
        WHERE type = 'table' AND name = 'pharmacy_chat_templates'`,
    ).first<{ name: string }>();
  } catch {
    throw new Error('chat templates schema unavailable');
  }
  if (row?.name !== 'pharmacy_chat_templates') {
    throw new Error('chat templates schema unavailable');
  }
}

function normalizeTemplateText(title: unknown, body: unknown): {
  title: string;
  body: string;
} {
  const normalizedTitle = typeof title === 'string' ? title.trim() : '';
  const normalizedBody = typeof body === 'string' ? body.trim() : '';
  if (normalizedTitle.length < 1 || normalizedTitle.length > 80 ||
      normalizedBody.length < 1 || normalizedBody.length > 500 ||
      PLACEHOLDER_RE.test(normalizedTitle) || PLACEHOLDER_RE.test(normalizedBody)) {
    throw new Error('invalid chat template');
  }
  try {
    // Same second fence as automated notifications: the composer inserts this
    // body verbatim, so template text must stay PHI-free.
    assertPharmacyAutomatedText(normalizedBody);
  } catch {
    throw new Error('invalid chat template');
  }
  return { title: normalizedTitle, body: normalizedBody };
}

export async function listChatTemplates(
  db: D1Database,
  lineAccountId: string,
): Promise<PharmacyChatTemplate[]> {
  await requireChatTemplateTable(db);
  const result = await db.prepare(
    `SELECT line_account_id, template_id, title, body, status, version,
            created_by_staff_id, approved_by_staff_id, approved_at,
            created_at, updated_at
       FROM pharmacy_chat_templates
      WHERE line_account_id = ?
      ORDER BY status = 'approved' DESC, updated_at DESC`,
  ).bind(lineAccountId).all<PharmacyChatTemplate>();
  return result.results ?? [];
}

export async function getChatTemplate(
  db: D1Database,
  lineAccountId: string,
  templateId: string,
): Promise<PharmacyChatTemplate | null> {
  await requireChatTemplateTable(db);
  return db.prepare(
    `SELECT line_account_id, template_id, title, body, status, version,
            created_by_staff_id, approved_by_staff_id, approved_at,
            created_at, updated_at
       FROM pharmacy_chat_templates
      WHERE line_account_id = ? AND template_id = ?
      LIMIT 1`,
  ).bind(lineAccountId, templateId).first<PharmacyChatTemplate>();
}

interface MutationInput {
  lineAccountId: string;
  actorStaffId: string;
  expectedVersion?: number;
  now?: Date;
}

function mapScopeError(error: unknown): never {
  const message = error instanceof Error ? error.message : '';
  if (/CHAT_TEMPLATE_STAFF_SCOPE|CHAT_TEMPLATE_IDENTITY/.test(message)) {
    throw new Error('invalid chat template staff');
  }
  if (/CHECK constraint/.test(message)) {
    throw new Error('invalid chat template state');
  }
  throw error;
}

export async function createChatTemplate(
  db: D1Database,
  input: MutationInput & { title: unknown; body: unknown; templateId: string },
): Promise<PharmacyChatTemplate> {
  const { title, body } = normalizeTemplateText(input.title, input.body);
  if (!input.lineAccountId || !TEMPLATE_ID_RE.test(input.templateId) ||
      !VALID_STAFF_ID.test(input.actorStaffId)) {
    throw new Error('invalid chat template');
  }
  await requireChatTemplateTable(db);
  const timestamp = (input.now ?? new Date()).toISOString();
  const write = db.prepare(
    `INSERT INTO pharmacy_chat_templates
      (line_account_id, template_id, title, body, status, version,
       created_by_staff_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'draft', 1, ?, ?, ?)`,
  ).bind(
    input.lineAccountId, input.templateId, title, body,
    input.actorStaffId, timestamp, timestamp,
  );
  const audit = tenantAuditStatement(db, {
    lineAccountId: input.lineAccountId,
    actorStaffId: input.actorStaffId,
    action: 'pharmacy_chat_template_created',
    resourceType: 'chat_template',
    resourceId: input.templateId,
    detail: { status: 'draft' },
  }, {
    sql: `EXISTS (
      SELECT 1 FROM pharmacy_chat_templates
       WHERE line_account_id = ? AND template_id = ? AND version = 1
    )`,
    bindings: [input.lineAccountId, input.templateId],
  });
  let results: D1Result[];
  try {
    results = await db.batch([write, audit]);
  } catch (error) {
    mapScopeError(error);
  }
  if ((results[0]?.meta?.changes ?? 0) !== 1 ||
      (results[1]?.meta?.changes ?? 0) !== 1) {
    throw new Error('chat template conflict');
  }
  const saved = await getChatTemplate(db, input.lineAccountId, input.templateId);
  if (!saved) throw new Error('chat template conflict');
  return saved;
}

async function mutateTemplate(
  db: D1Database,
  input: MutationInput & { templateId: string },
  build: (
    current: PharmacyChatTemplate,
    timestamp: string,
  ) => {
    statement: D1PreparedStatement;
    action: string;
    detail: Record<string, string | number | boolean | string[] | null>;
  },
): Promise<PharmacyChatTemplate> {
  if (!input.lineAccountId || !TEMPLATE_ID_RE.test(input.templateId) ||
      !VALID_STAFF_ID.test(input.actorStaffId) ||
      !Number.isInteger(input.expectedVersion) || (input.expectedVersion ?? -1) < 1) {
    throw new Error('invalid chat template');
  }
  const current = await getChatTemplate(db, input.lineAccountId, input.templateId);
  if (!current) throw new Error('chat template not found');
  if (current.version !== input.expectedVersion) {
    throw new Error('chat template conflict');
  }
  const timestamp = (input.now ?? new Date()).toISOString();
  const nextVersion = current.version + 1;
  const { statement, action, detail } = build(current, timestamp);
  const audit = tenantAuditStatement(db, {
    lineAccountId: input.lineAccountId,
    actorStaffId: input.actorStaffId,
    action,
    resourceType: 'chat_template',
    resourceId: input.templateId,
    detail,
  }, {
    sql: `EXISTS (
      SELECT 1 FROM pharmacy_chat_templates
       WHERE line_account_id = ? AND template_id = ?
         AND version = ? AND updated_at = ?
    )`,
    bindings: [input.lineAccountId, input.templateId, nextVersion, timestamp],
  });
  let results: D1Result[];
  try {
    results = await db.batch([statement, audit]);
  } catch (error) {
    mapScopeError(error);
  }
  if ((results[0]?.meta?.changes ?? 0) !== 1 ||
      (results[1]?.meta?.changes ?? 0) !== 1) {
    throw new Error('chat template conflict');
  }
  const saved = await getChatTemplate(db, input.lineAccountId, input.templateId);
  if (!saved || saved.version !== nextVersion) {
    throw new Error('chat template conflict');
  }
  return saved;
}

export async function updateChatTemplate(
  db: D1Database,
  input: MutationInput & { templateId: string; title: unknown; body: unknown },
): Promise<PharmacyChatTemplate> {
  const { title, body } = normalizeTemplateText(input.title, input.body);
  return mutateTemplate(db, input, (current, timestamp) => {
    if (current.status === 'archived') throw new Error('invalid chat template state');
    return {
      // Edits always drop back to draft so approved copy cannot be changed
      // without a fresh owner/admin approval.
      statement: db.prepare(
        `UPDATE pharmacy_chat_templates
            SET title = ?, body = ?, status = 'draft',
                approved_by_staff_id = NULL, approved_at = NULL,
                version = version + 1, updated_at = ?
          WHERE line_account_id = ? AND template_id = ? AND version = ?`,
      ).bind(
        title, body, timestamp,
        input.lineAccountId, input.templateId, input.expectedVersion,
      ),
      action: 'pharmacy_chat_template_updated',
      detail: { status: 'draft' },
    };
  });
}

export async function approveChatTemplate(
  db: D1Database,
  input: MutationInput & { templateId: string },
): Promise<PharmacyChatTemplate> {
  return mutateTemplate(db, input, (current, timestamp) => {
    if (current.status !== 'draft') throw new Error('invalid chat template state');
    if (current.created_by_staff_id === input.actorStaffId) {
      // Separation of duties: the author cannot approve their own text.
      throw new Error('invalid chat template state');
    }
    return {
      statement: db.prepare(
        `UPDATE pharmacy_chat_templates
            SET status = 'approved', approved_by_staff_id = ?, approved_at = ?,
                version = version + 1, updated_at = ?
          WHERE line_account_id = ? AND template_id = ? AND version = ?`,
      ).bind(
        input.actorStaffId, timestamp, timestamp,
        input.lineAccountId, input.templateId, input.expectedVersion,
      ),
      action: 'pharmacy_chat_template_approved',
      detail: { status: 'approved' },
    };
  });
}

export async function archiveChatTemplate(
  db: D1Database,
  input: MutationInput & { templateId: string },
): Promise<PharmacyChatTemplate> {
  return mutateTemplate(db, input, (current, timestamp) => {
    if (current.status === 'archived') throw new Error('invalid chat template state');
    return {
      statement: db.prepare(
        `UPDATE pharmacy_chat_templates
            SET status = 'archived', approved_by_staff_id = NULL, approved_at = NULL,
                version = version + 1, updated_at = ?
          WHERE line_account_id = ? AND template_id = ? AND version = ?`,
      ).bind(
        timestamp, input.lineAccountId, input.templateId, input.expectedVersion,
      ),
      action: 'pharmacy_chat_template_archived',
      detail: { status: 'archived' },
    };
  });
}
