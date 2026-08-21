import {
  DEFAULT_PHARMACY_RICH_MENU_ORDER,
  validatePharmacyRichMenuPreferredOrder,
  type PharmacyRichMenuActionKey,
  type PharmacyRichMenuSize,
} from './layout.js';

export interface PharmacyRichMenuLayout {
  lineAccountId: string;
  preferredOrder: PharmacyRichMenuActionKey[];
  revision: number;
  updatedAt: string | null;
}

export type PharmacyRichMenuLifecycleState = 'inactive' | 'active' | 'frozen';

export interface PharmacyRichMenuLifecycleControl {
  lineAccountId: string;
  state: PharmacyRichMenuLifecycleState;
  revision: number;
  updatedAt: string | null;
}

export async function getPharmacyRichMenuLifecycleControl(
  db: D1Database,
  lineAccountId: string,
): Promise<PharmacyRichMenuLifecycleControl> {
  const row = await db.prepare(
    `SELECT state, revision, updated_at
       FROM pharmacy_rich_menu_lifecycle_controls
      WHERE line_account_id = ?`,
  ).bind(lineAccountId).first<{
    state: PharmacyRichMenuLifecycleState;
    revision: number;
    updated_at: string;
  }>();
  return row ? {
    lineAccountId,
    state: row.state,
    revision: row.revision,
    updatedAt: row.updated_at,
  } : { lineAccountId, state: 'inactive', revision: 0, updatedAt: null };
}

export async function savePharmacyRichMenuLifecycleControl(
  db: D1Database,
  lineAccountId: string,
  state: PharmacyRichMenuLifecycleState,
  expectedRevision: number,
): Promise<PharmacyRichMenuLifecycleControl> {
  if (!lineAccountId || !['inactive', 'active', 'frozen'].includes(state) ||
      !Number.isInteger(expectedRevision) || expectedRevision < 0) {
    throw new Error('invalid pharmacy rich-menu lifecycle control');
  }
  const now = new Date().toISOString();
  try {
    const result = expectedRevision === 0
      ? await db.prepare(
        `INSERT INTO pharmacy_rich_menu_lifecycle_controls
          (line_account_id, state, revision, created_at, updated_at)
         VALUES (?, ?, 1, ?, ?)`,
      ).bind(lineAccountId, state, now, now).run()
      : await db.prepare(
        `UPDATE pharmacy_rich_menu_lifecycle_controls
            SET state = ?, revision = revision + 1, updated_at = ?
          WHERE line_account_id = ? AND revision = ?`,
      ).bind(state, now, lineAccountId, expectedRevision).run();
    if ((result.meta?.changes ?? 0) !== 1) throw new Error('stale pharmacy rich-menu lifecycle revision');
  } catch (error) {
    if (expectedRevision === 0 && /unique|constraint/i.test(String(error))) {
      throw new Error('stale pharmacy rich-menu lifecycle revision');
    }
    throw error;
  }
  return {
    lineAccountId,
    state,
    revision: expectedRevision + 1,
    updatedAt: now,
  };
}

export interface PharmacyRichMenuDraftBindingInput {
  groupId: string;
  lineAccountId: string;
  layoutRevision: number;
  capabilityRevision: number;
  liffIdHash: string;
  catalogVersion: string;
  menuSize: PharmacyRichMenuSize;
  catalogVariantKey: string;
  catalogObjectKey: string;
  manifestHash: string;
  imageHash: string;
}

export interface PharmacyRichMenuDraftBinding extends PharmacyRichMenuDraftBindingInput {
  createdAt: string;
}

export interface PharmacyRichMenuVersion {
  groupId: string;
  lineAccountId: string;
  name: string;
  status: 'draft' | 'published';
  currentDefault: boolean;
  knownGood: boolean;
  unverified: boolean;
  unresolvedOperationId: string | null;
  unresolvedOperationKind: PharmacyRichMenuOperationKind | null;
  lineRichMenuId: string | null;
  imageR2Key: string;
  imageContentType: string;
  menuSize: PharmacyRichMenuSize;
  layoutRevision: number;
  capabilityRevision: number;
  catalogVersion: string;
  catalogVariantKey: string;
  manifestHash: string;
  imageHash: string;
  createdAt: string;
  updatedAt: string;
}

export type PharmacyRichMenuOperationKind = 'publish' | 'set_default' | 'rollback';
export type PharmacyRichMenuOperationStatus = 'running' | 'unknown' | 'succeeded' | 'failed';
export type PharmacyRichMenuPublishPhase =
  'intent_recorded' | 'remote_created' | 'image_uploaded' | 'alias_created' | 'committed';

export interface PharmacyRichMenuOperation {
  id: string;
  groupId: string;
  lineAccountId: string;
  confirmationId: string;
  kind: PharmacyRichMenuOperationKind;
  status: PharmacyRichMenuOperationStatus;
  evidenceDigest: string;
  publishPhase: PharmacyRichMenuPublishPhase | null;
  publishAliasId: string | null;
  publishMenuName: string | null;
  expectedDefaultMenuId: string | null;
  defaultReadAt: string | null;
  remoteRichMenuId: string | null;
  verifiedDefaultMenuId: string | null;
  reasonCode: string | null;
  createdAt: string;
  updatedAt: string;
  verifiedAt: string | null;
}

type PharmacyRichMenuOperationRow = {
  id: string;
  group_id: string;
  line_account_id: string;
  confirmation_id: string;
  kind: PharmacyRichMenuOperationKind;
  status: PharmacyRichMenuOperationStatus;
  evidence_digest: string;
  publish_phase: PharmacyRichMenuPublishPhase | null;
  publish_alias_id: string | null;
  publish_menu_name: string | null;
  expected_default_menu_id: string | null;
  default_read_at: string | null;
  remote_rich_menu_id: string | null;
  verified_default_menu_id: string | null;
  reason_code: string | null;
  created_at: string;
  updated_at: string;
  verified_at: string | null;
};

function serializeOperation(row: PharmacyRichMenuOperationRow): PharmacyRichMenuOperation {
  return {
    id: row.id,
    groupId: row.group_id,
    lineAccountId: row.line_account_id,
    confirmationId: row.confirmation_id,
    kind: row.kind,
    status: row.status,
    evidenceDigest: row.evidence_digest,
    publishPhase: row.publish_phase,
    publishAliasId: row.publish_alias_id,
    publishMenuName: row.publish_menu_name,
    expectedDefaultMenuId: row.expected_default_menu_id,
    defaultReadAt: row.default_read_at,
    remoteRichMenuId: row.remote_rich_menu_id,
    verifiedDefaultMenuId: row.verified_default_menu_id,
    reasonCode: row.reason_code,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    verifiedAt: row.verified_at,
  };
}

const OPERATION_COLUMNS = `id, group_id, line_account_id, confirmation_id, kind, status, evidence_digest,
  publish_phase, publish_alias_id, publish_menu_name,
  expected_default_menu_id, default_read_at, remote_rich_menu_id, verified_default_menu_id, reason_code,
  created_at, updated_at, verified_at`;

export async function beginPharmacyRichMenuOperation(
  db: D1Database,
  input: {
    groupId: string;
    lineAccountId: string;
    confirmationId: string;
    kind: PharmacyRichMenuOperationKind;
    evidenceDigest: string;
    expectedDefaultMenuId: string | null;
    publishAliasId?: string;
    publishMenuName?: string;
  },
): Promise<PharmacyRichMenuOperation> {
  const publishIdentityValid = input.kind === 'publish'
    ? Boolean(input.publishAliasId && input.publishAliasId.length <= 100 &&
        input.publishMenuName && input.publishMenuName.length <= 300)
    : input.publishAliasId === undefined && input.publishMenuName === undefined;
  if (!input.groupId || !input.lineAccountId || !input.confirmationId ||
      input.confirmationId.length > 128 ||
      !['publish', 'set_default', 'rollback'].includes(input.kind) ||
      !/^[a-f0-9]{64}$/u.test(input.evidenceDigest) ||
      !publishIdentityValid ||
      (input.expectedDefaultMenuId !== null && !input.expectedDefaultMenuId)) {
    throw new Error('invalid pharmacy rich-menu operation');
  }
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  let result: D1Result<unknown>;
  try {
    result = await db.prepare(
      `INSERT INTO pharmacy_rich_menu_operations
      (id, group_id, line_account_id, confirmation_id, kind, status, evidence_digest,
       publish_phase, publish_alias_id, publish_menu_name,
       expected_default_menu_id, created_at, updated_at)
     SELECT ?, ?, ?, ?, ?, 'running', ?, ?, ?, ?, ?, ?, ?
      WHERE EXISTS (
        SELECT 1
          FROM pharmacy_rich_menu_draft_bindings binding
          JOIN rich_menu_groups menu_group ON menu_group.id = binding.group_id
         WHERE binding.group_id = ?
           AND binding.line_account_id = ?
           AND menu_group.account_id = ?
      )`,
    ).bind(
      id, input.groupId, input.lineAccountId, input.confirmationId, input.kind,
      input.evidenceDigest, input.kind === 'publish' ? 'intent_recorded' : null,
      input.publishAliasId ?? null, input.publishMenuName ?? null,
      input.expectedDefaultMenuId, now, now,
      input.groupId, input.lineAccountId, input.lineAccountId,
    ).run();
  } catch (error) {
    if (String(error).includes('confirmation_id')) {
      throw new Error('pharmacy rich-menu confirmation already used');
    }
    throw error;
  }
  if ((result.meta?.changes ?? 0) !== 1) {
    throw new Error('pharmacy rich-menu operation account mismatch');
  }
  return {
    id,
    groupId: input.groupId,
    lineAccountId: input.lineAccountId,
    confirmationId: input.confirmationId,
    kind: input.kind,
    status: 'running',
    evidenceDigest: input.evidenceDigest,
    publishPhase: input.kind === 'publish' ? 'intent_recorded' : null,
    publishAliasId: input.publishAliasId ?? null,
    publishMenuName: input.publishMenuName ?? null,
    expectedDefaultMenuId: input.expectedDefaultMenuId,
    defaultReadAt: null,
    remoteRichMenuId: null,
    verifiedDefaultMenuId: null,
    reasonCode: null,
    createdAt: now,
    updatedAt: now,
    verifiedAt: null,
  };
}

export async function advancePharmacyRichMenuPublishPhase(
  db: D1Database,
  input: {
    lineAccountId: string;
    operationId: string;
    expectedPhase: PharmacyRichMenuPublishPhase;
    phase: PharmacyRichMenuPublishPhase;
    remoteRichMenuId?: string;
  },
): Promise<void> {
  const nextPhase: Partial<Record<PharmacyRichMenuPublishPhase, PharmacyRichMenuPublishPhase>> = {
    intent_recorded: 'remote_created',
    remote_created: 'image_uploaded',
    image_uploaded: 'alias_created',
    alias_created: 'committed',
  };
  if (!input.lineAccountId || !input.operationId || nextPhase[input.expectedPhase] !== input.phase ||
      (input.expectedPhase === 'intent_recorded' && !input.remoteRichMenuId) ||
      (input.remoteRichMenuId !== undefined && !input.remoteRichMenuId)) {
    throw new Error('invalid pharmacy rich-menu publish phase');
  }
  const now = new Date().toISOString();
  const result = await db.prepare(
    `UPDATE pharmacy_rich_menu_operations
        SET publish_phase = ?, remote_rich_menu_id = COALESCE(remote_rich_menu_id, ?),
            updated_at = ?
      WHERE id = ? AND line_account_id = ? AND kind = 'publish'
        AND status IN ('running', 'unknown') AND publish_phase = ?
        AND (? IS NULL OR remote_rich_menu_id IS NULL OR remote_rich_menu_id = ?)
        AND (? <> 'committed' OR EXISTS (
          SELECT 1 FROM rich_menu_pages page
           WHERE page.group_id = pharmacy_rich_menu_operations.group_id
             AND page.line_richmenu_id = pharmacy_rich_menu_operations.remote_rich_menu_id
             AND page.alias_id = pharmacy_rich_menu_operations.publish_alias_id
        ))`,
  ).bind(
    input.phase, input.remoteRichMenuId ?? null, now,
    input.operationId, input.lineAccountId, input.expectedPhase,
    input.remoteRichMenuId ?? null, input.remoteRichMenuId ?? null, input.phase,
  ).run();
  if ((result.meta?.changes ?? 0) !== 1) {
    throw new Error('stale pharmacy rich-menu publish phase');
  }
}

export async function consumePharmacyRichMenuResumeConfirmation(
  db: D1Database,
  input: {
    lineAccountId: string;
    operationId: string;
    confirmationId: string;
    publishPhase: Exclude<PharmacyRichMenuPublishPhase, 'committed'>;
    evidenceDigest: string;
  },
): Promise<void> {
  if (!input.lineAccountId || !input.operationId || !input.confirmationId ||
      input.confirmationId.length > 128 ||
      !/^[a-f0-9]{64}$/u.test(input.evidenceDigest)) {
    throw new Error('invalid pharmacy rich-menu resume confirmation');
  }
  let result: D1Result<unknown>;
  try {
    result = await db.prepare(
      `INSERT INTO pharmacy_rich_menu_operation_confirmations
        (confirmation_id, operation_id, line_account_id, publish_phase, evidence_digest, created_at)
       SELECT ?, id, line_account_id, publish_phase, evidence_digest, ?
         FROM pharmacy_rich_menu_operations
        WHERE id = ? AND line_account_id = ? AND kind = 'publish'
          AND status IN ('running', 'unknown') AND publish_phase = ? AND evidence_digest = ?`,
    ).bind(
      input.confirmationId, new Date().toISOString(), input.operationId, input.lineAccountId,
      input.publishPhase, input.evidenceDigest,
    ).run();
  } catch (error) {
    if (/confirmation_id|unique/iu.test(String(error))) {
      throw new Error('pharmacy rich-menu resume confirmation already used');
    }
    throw error;
  }
  if ((result.meta?.changes ?? 0) !== 1) {
    throw new Error('stale pharmacy rich-menu resume confirmation');
  }
}

export async function recordPharmacyRichMenuRemoteId(
  db: D1Database,
  lineAccountId: string,
  operationId: string,
  remoteRichMenuId: string,
): Promise<void> {
  if (!lineAccountId || !operationId || !remoteRichMenuId) {
    throw new Error('invalid pharmacy rich-menu remote id evidence');
  }
  const result = await db.prepare(
    `UPDATE pharmacy_rich_menu_operations
        SET remote_rich_menu_id = ?, updated_at = ?
      WHERE id = ? AND line_account_id = ? AND status = 'running'
        AND remote_rich_menu_id IS NULL`,
  ).bind(remoteRichMenuId, new Date().toISOString(), operationId, lineAccountId).run();
  if ((result.meta?.changes ?? 0) !== 1) {
    throw new Error('stale pharmacy rich-menu operation');
  }
}

export async function recordPharmacyRichMenuExpectedDefault(
  db: D1Database,
  lineAccountId: string,
  operationId: string,
  expectedDefaultMenuId: string | null,
): Promise<void> {
  if (!lineAccountId || !operationId ||
      (expectedDefaultMenuId !== null && !expectedDefaultMenuId)) {
    throw new Error('invalid pharmacy rich-menu default read evidence');
  }
  const now = new Date().toISOString();
  const result = await db.prepare(
    `UPDATE pharmacy_rich_menu_operations
        SET expected_default_menu_id = ?, default_read_at = ?, updated_at = ?
      WHERE id = ? AND line_account_id = ? AND status = 'running'
        AND default_read_at IS NULL`,
  ).bind(expectedDefaultMenuId, now, now, operationId, lineAccountId).run();
  if ((result.meta?.changes ?? 0) !== 1) {
    throw new Error('stale pharmacy rich-menu operation');
  }
}

export async function finishPharmacyRichMenuOperation(
  db: D1Database,
  input: {
    lineAccountId: string;
    operationId: string;
    expectedStatus: 'running' | 'unknown';
    status: 'unknown' | 'succeeded' | 'failed';
    verifiedDefaultMenuId?: string | null;
    reasonCode?: string | null;
  },
): Promise<void> {
  if (!input.lineAccountId || !input.operationId ||
      !['running', 'unknown'].includes(input.expectedStatus) ||
      !['unknown', 'succeeded', 'failed'].includes(input.status) ||
      (input.status !== 'succeeded' && !input.reasonCode) ||
      (input.reasonCode !== undefined && input.reasonCode !== null &&
        !/^[A-Z0-9_]{1,64}$/u.test(input.reasonCode))) {
    throw new Error('invalid pharmacy rich-menu operation result');
  }
  const current = await db.prepare(
    `SELECT ${OPERATION_COLUMNS}
       FROM pharmacy_rich_menu_operations
      WHERE id = ? AND line_account_id = ?`,
  ).bind(input.operationId, input.lineAccountId).first<PharmacyRichMenuOperationRow>();
  if (!current || current.status !== input.expectedStatus ||
      (input.status === 'succeeded' && !current.remote_rich_menu_id) ||
      (input.status === 'succeeded' && current.kind === 'publish' &&
        current.publish_phase !== 'committed') ||
      (input.status === 'succeeded' && current.kind !== 'publish' &&
        (!current.default_read_at || input.verifiedDefaultMenuId !== current.remote_rich_menu_id))) {
    throw new Error('stale pharmacy rich-menu operation');
  }
  const now = new Date().toISOString();
  const result = await db.prepare(
    `UPDATE pharmacy_rich_menu_operations
        SET status = ?, verified_default_menu_id = ?, reason_code = ?,
            updated_at = ?, verified_at = ?
      WHERE id = ? AND line_account_id = ? AND status = ?`,
  ).bind(
    input.status,
    input.verifiedDefaultMenuId ?? null,
    input.reasonCode ?? null,
    now,
    input.status === 'succeeded' ? now : null,
    input.operationId,
    input.lineAccountId,
    input.expectedStatus,
  ).run();
  if ((result.meta?.changes ?? 0) !== 1) {
    throw new Error('stale pharmacy rich-menu operation');
  }
}

export async function getUnresolvedPharmacyRichMenuOperation(
  db: D1Database,
  lineAccountId: string,
): Promise<PharmacyRichMenuOperation | null> {
  const row = await db.prepare(
    `SELECT ${OPERATION_COLUMNS}
       FROM pharmacy_rich_menu_operations
      WHERE line_account_id = ? AND status IN ('running', 'unknown')
      ORDER BY created_at DESC LIMIT 1`,
  ).bind(lineAccountId).first<PharmacyRichMenuOperationRow>();
  return row ? serializeOperation(row) : null;
}

export async function getPharmacyRichMenuOperation(
  db: D1Database,
  lineAccountId: string,
  operationId: string,
): Promise<PharmacyRichMenuOperation | null> {
  const row = await db.prepare(
    `SELECT ${OPERATION_COLUMNS}
       FROM pharmacy_rich_menu_operations
      WHERE line_account_id = ? AND id = ?`,
  ).bind(lineAccountId, operationId).first<PharmacyRichMenuOperationRow>();
  return row ? serializeOperation(row) : null;
}

export async function isPharmacyRichMenuKnownGood(
  db: D1Database,
  lineAccountId: string,
  groupId: string,
  remoteRichMenuId: string,
): Promise<boolean> {
  if (!lineAccountId || !groupId || !remoteRichMenuId) return false;
  return Boolean(await db.prepare(
    `SELECT 1 AS ok
       FROM pharmacy_rich_menu_operations
      WHERE line_account_id = ? AND group_id = ?
        AND kind IN ('set_default', 'rollback') AND status = 'succeeded'
        AND remote_rich_menu_id = ? AND verified_default_menu_id = remote_rich_menu_id
      LIMIT 1`,
  ).bind(lineAccountId, groupId, remoteRichMenuId).first<{ ok: number }>());
}

export async function getPharmacyRichMenuLayout(
  db: D1Database,
  lineAccountId: string,
): Promise<PharmacyRichMenuLayout> {
  const row = await db.prepare(
    `SELECT preferred_order_json, revision, updated_at
       FROM pharmacy_rich_menu_layouts
      WHERE line_account_id = ?`,
  ).bind(lineAccountId).first<{
    preferred_order_json: string;
    revision: number;
    updated_at: string;
  }>();
  if (!row) {
    return {
      lineAccountId,
      preferredOrder: [...DEFAULT_PHARMACY_RICH_MENU_ORDER],
      revision: 0,
      updatedAt: null,
    };
  }
  const parsed = JSON.parse(row.preferred_order_json) as unknown;
  if (!Array.isArray(parsed) || parsed.some((value) => typeof value !== 'string')) {
    throw new Error('stored pharmacy rich-menu order is invalid');
  }
  return {
    lineAccountId,
    preferredOrder: validatePharmacyRichMenuPreferredOrder(parsed),
    revision: Number(row.revision),
    updatedAt: row.updated_at,
  };
}

export async function savePharmacyRichMenuLayout(
  db: D1Database,
  lineAccountId: string,
  preferredOrder: readonly string[],
  expectedRevision: number,
): Promise<PharmacyRichMenuLayout> {
  const validatedOrder = validatePharmacyRichMenuPreferredOrder(preferredOrder);
  if (!Number.isInteger(expectedRevision) || expectedRevision < 0) {
    throw new Error('invalid pharmacy rich-menu layout revision');
  }
  const timestamp = new Date().toISOString();
  const result = expectedRevision === 0
    ? await db.prepare(
      `INSERT INTO pharmacy_rich_menu_layouts
        (line_account_id, preferred_order_json, revision, created_at, updated_at)
       VALUES (?, ?, 1, ?, ?)
       ON CONFLICT(line_account_id) DO NOTHING`,
    ).bind(lineAccountId, JSON.stringify(validatedOrder), timestamp, timestamp).run()
    : await db.prepare(
      `UPDATE pharmacy_rich_menu_layouts
          SET preferred_order_json = ?, revision = revision + 1, updated_at = ?
        WHERE line_account_id = ? AND revision = ?`,
    ).bind(JSON.stringify(validatedOrder), timestamp, lineAccountId, expectedRevision).run();
  if ((result.meta?.changes ?? 0) !== 1) {
    throw new Error('stale pharmacy rich-menu layout revision');
  }
  return getPharmacyRichMenuLayout(db, lineAccountId);
}

export async function createPharmacyRichMenuDraftBinding(
  db: D1Database,
  input: PharmacyRichMenuDraftBindingInput,
): Promise<void> {
  const hash = /^[a-f0-9]{64}$/u;
  if (!input.groupId || !input.lineAccountId || input.layoutRevision < 1 ||
      input.capabilityRevision < 1 || !hash.test(input.liffIdHash) ||
      (input.menuSize !== 'large' && input.menuSize !== 'compact') ||
      !hash.test(input.manifestHash) || !hash.test(input.imageHash) ||
      input.catalogObjectKey !==
        `rich-menu-catalog/${input.catalogVersion}/${input.catalogVariantKey}.jpg`) {
    throw new Error('invalid pharmacy rich-menu draft binding');
  }
  await db.prepare(
    `INSERT INTO pharmacy_rich_menu_draft_bindings
      (group_id, line_account_id, layout_revision, capability_revision, liff_id_hash,
       catalog_version, menu_size, catalog_variant_key, catalog_object_key, manifest_hash, image_hash, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    input.groupId,
    input.lineAccountId,
    input.layoutRevision,
    input.capabilityRevision,
    input.liffIdHash,
    input.catalogVersion,
    input.menuSize,
    input.catalogVariantKey,
    input.catalogObjectKey,
    input.manifestHash,
    input.imageHash,
    new Date().toISOString(),
  ).run();
}

export async function getPharmacyRichMenuDraftBinding(
  db: D1Database,
  lineAccountId: string,
  groupId: string,
): Promise<PharmacyRichMenuDraftBinding | null> {
  const row = await db.prepare(
    `SELECT group_id, line_account_id, layout_revision, capability_revision, liff_id_hash,
            catalog_version, menu_size, catalog_variant_key, catalog_object_key,
            manifest_hash, image_hash, created_at
       FROM pharmacy_rich_menu_draft_bindings
      WHERE line_account_id = ? AND group_id = ?`,
  ).bind(lineAccountId, groupId).first<{
    group_id: string;
    line_account_id: string;
    layout_revision: number;
    capability_revision: number;
    liff_id_hash: string;
    catalog_version: string;
    menu_size: PharmacyRichMenuSize;
    catalog_variant_key: string;
    catalog_object_key: string;
    manifest_hash: string;
    image_hash: string;
    created_at: string;
  }>();
  return row ? {
    groupId: row.group_id,
    lineAccountId: row.line_account_id,
    layoutRevision: Number(row.layout_revision),
    capabilityRevision: Number(row.capability_revision),
    liffIdHash: row.liff_id_hash,
    catalogVersion: row.catalog_version,
    menuSize: row.menu_size,
    catalogVariantKey: row.catalog_variant_key,
    catalogObjectKey: row.catalog_object_key,
    manifestHash: row.manifest_hash,
    imageHash: row.image_hash,
    createdAt: row.created_at,
  } : null;
}

export async function listPharmacyRichMenuVersions(
  db: D1Database,
  lineAccountId: string,
): Promise<PharmacyRichMenuVersion[]> {
  const result = await db.prepare(
    `SELECT binding.group_id, binding.line_account_id, binding.layout_revision,
            binding.capability_revision, binding.catalog_version, binding.menu_size,
            binding.catalog_variant_key, binding.manifest_hash, binding.image_hash,
            group_row.name, group_row.status, group_row.is_default_for_all,
            group_row.created_at, group_row.updated_at,
            page.line_richmenu_id, page.image_r2_key, page.image_content_type,
            EXISTS (
              SELECT 1 FROM pharmacy_rich_menu_operations operation
               WHERE operation.group_id = binding.group_id
                 AND operation.line_account_id = binding.line_account_id
                 AND operation.kind IN ('set_default', 'rollback')
                 AND operation.status = 'succeeded'
                 AND operation.remote_rich_menu_id = page.line_richmenu_id
                 AND operation.verified_default_menu_id = page.line_richmenu_id
            ) AS known_good,
            EXISTS (
              SELECT 1 FROM pharmacy_rich_menu_operations operation
               WHERE operation.group_id = binding.group_id
                 AND operation.line_account_id = binding.line_account_id
                 AND operation.status IN ('running', 'unknown')
            ) AS unverified,
            (
              SELECT operation.id FROM pharmacy_rich_menu_operations operation
               WHERE operation.group_id = binding.group_id
                 AND operation.line_account_id = binding.line_account_id
                 AND operation.status IN ('running', 'unknown')
               LIMIT 1
            ) AS unresolved_operation_id,
            (
              SELECT operation.kind FROM pharmacy_rich_menu_operations operation
               WHERE operation.group_id = binding.group_id
                 AND operation.line_account_id = binding.line_account_id
                 AND operation.status IN ('running', 'unknown')
               LIMIT 1
            ) AS unresolved_operation_kind
       FROM pharmacy_rich_menu_draft_bindings AS binding
       INNER JOIN rich_menu_groups AS group_row
         ON group_row.id = binding.group_id AND group_row.account_id = binding.line_account_id
       INNER JOIN rich_menu_pages AS page ON page.id = group_row.default_page_id
      WHERE binding.line_account_id = ?
      ORDER BY group_row.created_at DESC, binding.group_id DESC`,
  ).bind(lineAccountId).all<{
    group_id: string;
    line_account_id: string;
    layout_revision: number;
    capability_revision: number;
    catalog_version: string;
    menu_size: PharmacyRichMenuSize;
    catalog_variant_key: string;
    manifest_hash: string;
    image_hash: string;
    name: string;
    status: 'draft' | 'published';
    is_default_for_all: number;
    created_at: string;
    updated_at: string;
    line_richmenu_id: string | null;
    image_r2_key: string;
    image_content_type: string;
    known_good: number;
    unverified: number;
    unresolved_operation_id: string | null;
    unresolved_operation_kind: PharmacyRichMenuOperationKind | null;
  }>();
  return (result.results ?? []).map((row) => ({
    groupId: row.group_id,
    lineAccountId: row.line_account_id,
    name: row.name,
    status: row.status,
    currentDefault: row.is_default_for_all === 1,
    knownGood: row.known_good === 1,
    unverified: row.unverified === 1,
    unresolvedOperationId: row.unresolved_operation_id,
    unresolvedOperationKind: row.unresolved_operation_kind,
    lineRichMenuId: row.line_richmenu_id,
    imageR2Key: row.image_r2_key,
    imageContentType: row.image_content_type,
    menuSize: row.menu_size,
    layoutRevision: Number(row.layout_revision),
    capabilityRevision: Number(row.capability_revision),
    catalogVersion: row.catalog_version,
    catalogVariantKey: row.catalog_variant_key,
    manifestHash: row.manifest_hash,
    imageHash: row.image_hash,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

export async function getPharmacyRichMenuCurrentDefaultEvidence(
  db: D1Database,
  lineAccountId: string,
  freshAfter: string,
): Promise<{ groupId: string; verifiedAt: string } | null> {
  if (!lineAccountId || !freshAfter) return null;
  const row = await db.prepare(
    `SELECT operation.group_id, operation.verified_at
       FROM pharmacy_rich_menu_operations AS operation
       INNER JOIN pharmacy_rich_menu_draft_bindings AS binding
         ON binding.group_id = operation.group_id
        AND binding.line_account_id = operation.line_account_id
       INNER JOIN rich_menu_groups AS menu_group
         ON menu_group.id = operation.group_id
        AND menu_group.account_id = operation.line_account_id
        AND menu_group.is_default_for_all = 1
       INNER JOIN rich_menu_pages AS page
         ON page.id = menu_group.default_page_id
        AND page.line_richmenu_id = operation.remote_rich_menu_id
      WHERE operation.line_account_id = ?
        AND operation.kind IN ('set_default', 'rollback')
        AND operation.status = 'succeeded'
        AND operation.verified_default_menu_id = operation.remote_rich_menu_id
        AND operation.verified_at >= ?
      ORDER BY operation.verified_at DESC, operation.id DESC
      LIMIT 1`,
  ).bind(lineAccountId, freshAfter).first<{ group_id: string; verified_at: string }>();
  return row ? { groupId: row.group_id, verifiedAt: row.verified_at } : null;
}

export async function renamePharmacyRichMenuVersion(
  db: D1Database,
  lineAccountId: string,
  groupId: string,
  name: string,
  expectedUpdatedAt: string,
): Promise<{ groupId: string; name: string; updatedAt: string }> {
  const nextName = name.trim();
  if (!lineAccountId || !groupId || !nextName || nextName.length > 80 || !expectedUpdatedAt) {
    throw new Error('invalid pharmacy rich-menu version rename');
  }
  const now = new Date();
  if (now.toISOString() === expectedUpdatedAt) now.setMilliseconds(now.getMilliseconds() + 1);
  const updatedAt = now.toISOString();
  const result = await db.prepare(
    `UPDATE rich_menu_groups
        SET name = ?, updated_at = ?
      WHERE id = ? AND account_id = ? AND updated_at = ?
        AND EXISTS (
          SELECT 1 FROM pharmacy_rich_menu_draft_bindings
           WHERE group_id = rich_menu_groups.id
             AND line_account_id = rich_menu_groups.account_id
        )`,
  ).bind(nextName, updatedAt, groupId, lineAccountId, expectedUpdatedAt).run();
  if ((result.meta?.changes ?? 0) !== 1) {
    throw new Error('stale pharmacy rich-menu version metadata');
  }
  return { groupId, name: nextName, updatedAt };
}

export async function deletePharmacyRichMenuVersion(
  db: D1Database,
  lineAccountId: string,
  groupId: string,
  expectedUpdatedAt: string,
): Promise<{ imageR2Key: string }> {
  if (!lineAccountId || !groupId || !expectedUpdatedAt) {
    throw new Error('invalid pharmacy rich-menu version delete');
  }
  const version = await db.prepare(
    `SELECT page.image_r2_key
       FROM pharmacy_rich_menu_draft_bindings binding
       JOIN rich_menu_groups menu_group
         ON menu_group.id = binding.group_id AND menu_group.account_id = binding.line_account_id
       JOIN rich_menu_pages page ON page.id = menu_group.default_page_id
      WHERE binding.line_account_id = ? AND binding.group_id = ?
        AND menu_group.updated_at = ?`,
  ).bind(lineAccountId, groupId, expectedUpdatedAt).first<{ image_r2_key: string }>();
  if (!version?.image_r2_key) throw new Error('protected pharmacy rich-menu version');

  const result = await db.prepare(
    `DELETE FROM rich_menu_groups
      WHERE id = ? AND account_id = ? AND updated_at = ?
        AND status = 'draft' AND is_default_for_all = 0
        AND EXISTS (
          SELECT 1 FROM pharmacy_rich_menu_draft_bindings binding
           WHERE binding.group_id = rich_menu_groups.id
             AND binding.line_account_id = rich_menu_groups.account_id
        )
        AND NOT EXISTS (
          SELECT 1 FROM rich_menu_pages page
           WHERE page.group_id = rich_menu_groups.id AND page.line_richmenu_id IS NOT NULL
        )
        AND NOT EXISTS (
          SELECT 1 FROM pharmacy_rich_menu_operations operation
           WHERE operation.group_id = rich_menu_groups.id
             AND operation.line_account_id = rich_menu_groups.account_id
             AND (operation.status <> 'failed' OR operation.remote_rich_menu_id IS NOT NULL)
        )`,
  ).bind(groupId, lineAccountId, expectedUpdatedAt).run();
  if ((result.meta?.changes ?? 0) !== 1) {
    throw new Error('protected pharmacy rich-menu version');
  }
  return { imageR2Key: version.image_r2_key };
}
