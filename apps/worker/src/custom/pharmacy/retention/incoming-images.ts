import {
  assertRetentionDeleteExecution,
  executionMatchesScope,
  RetentionDeleteExecution,
} from './execution.js';
import { prepareRetentionFence } from './fence.js';
import { ACTIVE_DSR_DELETION_BLOCK_PREDICATE_SQL } from '../data-subject-requests/legal-hold.js';
import {
  isR2RetentionTombstone,
  putR2RetentionTombstone,
} from '../../../services/immutable-r2.js';

type IncomingDispositionStatus =
  | 'TRACKED'
  | 'CLAIMED'
  | 'CANCELLED_HELD'
  | 'CANCELLED_UNKNOWN'
  | 'CANCELLED_STALE'
  | 'DELETE_COMMITTED'
  | 'FINALIZED_DELETED'
  | 'OUTCOME_UNKNOWN'
  | 'ORPHAN'
  | 'MISSING'
  | 'OWNERSHIP_MISMATCH'
  | 'UNKNOWN'
  | 'BLOCKED';

interface IncomingOptions {
  execution?: RetentionDeleteExecution;
  now?: Date;
  limit?: number;
}

export interface IncomingImageBackfillResult {
  tracked: number;
  skipped: number;
  blocked: number;
}

export interface IncomingImagePurgeResult {
  purged: number;
  failed: number;
  skipped: number;
}

export interface IncomingImageReadiness {
  status: 'READY' | 'BLOCKED';
  blockedReasons: string[];
  tracked: number;
  dispositions: number;
}

const SAFE_IMAGE_KEY = /^[A-Za-z0-9_-]+\.(?:jpg|png|gif|webp)$/u;
const UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const MAX_BATCH = 100;
const MAX_INVENTORY_OBJECTS = 10_000;

async function readR2Sha256(images: R2Bucket, key: string): Promise<string | null> {
  try {
    const object = await images.get(key);
    if (!object) return null;
    const digest = await crypto.subtle.digest('SHA-256', await object.arrayBuffer());
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
  } catch {
    return null;
  }
}

async function verifiedExecution(
  db: D1Database,
  value: RetentionDeleteExecution | undefined,
): Promise<RetentionDeleteExecution | null> {
  if (!value) return null;
  return assertRetentionDeleteExecution(db, value);
}

function safeTenantPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9:-]/g, '_');
}

function safeAccountPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9-]/g, '_');
}

function validR2Key(key: string, tenantId: string, lineAccountId: string): boolean {
  const prefix = `tenants/${safeTenantPart(tenantId)}/accounts/${safeAccountPart(lineAccountId)}/incoming/`;
  return key.startsWith(prefix) && SAFE_IMAGE_KEY.test(key.slice(prefix.length)) && !key.includes('..');
}

function extractR2Key(content: string): string | null {
  try {
    const parsed: unknown = JSON.parse(content);
    if (!parsed || typeof parsed !== 'object') return null;
    const key = (parsed as { r2Key?: unknown }).r2Key;
    return typeof key === 'string' && key.length > 0 ? key : null;
  } catch {
    return null;
  }
}

function validStoredAt(value: string | null): value is string {
  return typeof value === 'string' && UTC_TIMESTAMP.test(value) && Number.isFinite(Date.parse(value));
}

async function activeTenantMappingCount(
  db: D1Database,
  tenantId: string,
  lineAccountId: string,
): Promise<number> {
  try {
    const row = await db.prepare(
      `SELECT COUNT(*) AS count
         FROM tenant_line_accounts AS mapping
         INNER JOIN tenants AS tenant ON tenant.id = mapping.tenant_id
        WHERE mapping.tenant_id = ? AND mapping.line_account_id = ?
          AND tenant.status = 'active'`,
    ).bind(tenantId, lineAccountId).first<{ count: number }>();
    return row?.count ?? 0;
  } catch {
    return 0;
  }
}

async function upsertDisposition(
  db: D1Database,
  input: {
    r2Key: string;
    tenantId: string;
    lineAccountId: string;
    messageId: string;
    storedAt: string | null;
    status: IncomingDispositionStatus;
    source: 'tracked_row' | 'messages_log' | 'r2_inventory' | 'reconcile';
    reasonCode: string;
    holdEpoch: number;
    now: string;
    execution: RetentionDeleteExecution;
  },
): Promise<void> {
  await assertRetentionDeleteExecution(db, input.execution);
  if (!executionMatchesScope(input.execution, input.tenantId, input.lineAccountId)) return;
  await db.prepare(
    `INSERT INTO pharmacy_incoming_image_dispositions
      (r2_key, tenant_id, line_account_id, message_id, stored_at, status, source,
       reason_code, hold_epoch, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (r2_key) DO UPDATE SET
       status = CASE WHEN pharmacy_incoming_image_dispositions.status <> 'TRACKED'
         THEN pharmacy_incoming_image_dispositions.status ELSE excluded.status END,
       source = CASE WHEN pharmacy_incoming_image_dispositions.status <> 'TRACKED'
         THEN pharmacy_incoming_image_dispositions.source ELSE excluded.source END,
       reason_code = CASE WHEN pharmacy_incoming_image_dispositions.status <> 'TRACKED'
         THEN pharmacy_incoming_image_dispositions.reason_code ELSE excluded.reason_code END,
       hold_epoch = CASE WHEN pharmacy_incoming_image_dispositions.status <> 'TRACKED'
         THEN pharmacy_incoming_image_dispositions.hold_epoch ELSE excluded.hold_epoch END,
       updated_at = excluded.updated_at`,
  ).bind(
    input.r2Key, input.tenantId, input.lineAccountId, input.messageId, input.storedAt,
    input.status, input.source, input.reasonCode, input.holdEpoch, input.now, input.now,
  ).run();
}

async function findMessageForKey(
  db: D1Database,
  lineAccountId: string,
  r2Key: string,
): Promise<{ count: number; friendId: string | null; messageId: string | null }> {
  try {
    const row = await db.prepare(
      `SELECT COUNT(*) AS count, MIN(id) AS message_id, MIN(friend_id) AS friend_id
         FROM messages_log
        WHERE line_account_id = ? AND direction = 'incoming' AND json_valid(content)
          AND json_extract(content, '$.r2Key') = ?`,
    ).bind(lineAccountId, r2Key).first<{
      count: number; message_id: string | null; friend_id: string | null;
    }>();
    return {
      count: row?.count ?? 0,
      friendId: row?.friend_id ?? null,
      messageId: row?.message_id ?? null,
    };
  } catch {
    return { count: 0, friendId: null, messageId: null };
  }
}

/** Bounded and idempotent backfill from messages_log JSON into the tracker. */
export async function backfillIncomingImageTracking(
  db: D1Database,
  options: IncomingOptions = {},
): Promise<IncomingImageBackfillResult> {
  const execution = await verifiedExecution(db, options.execution);
  if (!execution) return { tracked: 0, skipped: 0, blocked: 0 };
  const now = options.now ?? new Date();
  if (!Number.isFinite(now.getTime())) return { tracked: 0, skipped: 0, blocked: 0 };
  const limit = Math.min(MAX_BATCH, Math.max(1, Math.floor(options.limit ?? MAX_BATCH)));
  const logs = await db.prepare(
    `SELECT id, line_account_id, content, created_at
       FROM messages_log
      WHERE line_account_id = ? AND direction = 'incoming' AND message_type = 'image'
        AND json_valid(content)
        AND NOT EXISTS (
          SELECT 1 FROM pharmacy_incoming_image_dispositions AS disposition
           WHERE disposition.r2_key = json_extract(messages_log.content, '$.r2Key')
             AND disposition.tenant_id = ? AND disposition.line_account_id = ?
        )
      ORDER BY id
      LIMIT ?`,
  ).bind(
    execution.lineAccountId, execution.tenantId, execution.lineAccountId, limit,
  ).all<{
    id: string;
    line_account_id: string;
    content: string;
    created_at: string;
  }>();
  const result: IncomingImageBackfillResult = { tracked: 0, skipped: 0, blocked: 0 };
  for (const log of logs.results ?? []) {
    const r2Key = extractR2Key(log.content);
    if (!r2Key || !validR2Key(r2Key, execution.tenantId, execution.lineAccountId)) {
      result.blocked++;
      continue;
    }
    if (await activeTenantMappingCount(
      db, execution.tenantId, execution.lineAccountId,
    ) !== 1) {
      result.blocked++;
      continue;
    }
    const existing = await db.prepare(
      `SELECT tenant_id, line_account_id, message_id, stored_at
         FROM pharmacy_incoming_image_objects WHERE r2_key = ?`,
    ).bind(r2Key).first<{
      tenant_id: string;
      line_account_id: string;
      message_id: string;
      stored_at: string;
    }>();
    if (existing && (
      existing.tenant_id !== execution.tenantId ||
      existing.line_account_id !== execution.lineAccountId
    )) {
      await upsertDisposition(db, {
        r2Key, tenantId: execution.tenantId, lineAccountId: execution.lineAccountId,
        messageId: log.id, storedAt: null, status: 'OWNERSHIP_MISMATCH', source: 'messages_log',
        reasonCode: 'tracking_scope_mismatch', holdEpoch: 0, now: now.toISOString(),
        execution,
      });
      result.blocked++;
      continue;
    }
    await assertRetentionDeleteExecution(db, execution);
    const tracking = await db.prepare(
      `INSERT OR IGNORE INTO pharmacy_incoming_image_objects
        (r2_key, tenant_id, line_account_id, message_id, stored_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).bind(r2Key, execution.tenantId, execution.lineAccountId, log.id, log.created_at).run();
    await upsertDisposition(db, {
      r2Key, tenantId: execution.tenantId, lineAccountId: execution.lineAccountId,
      messageId: existing?.message_id ?? log.id, storedAt: existing?.stored_at ?? log.created_at,
      status: 'TRACKED', source: 'messages_log', reasonCode: 'backfill_tracked',
      holdEpoch: 0, now: now.toISOString(),
      execution,
    });
    if ((tracking.meta?.changes ?? 0) === 1) result.tracked++;
    else result.skipped++;
  }
  return result;
}

/** Alias kept explicit for callers that name the source in the operation. */
export const backfillIncomingImagesFromMessagesLog = backfillIncomingImageTracking;

async function claimIncomingDisposition(
  db: D1Database,
  input: {
    r2Key: string;
    tenantId: string;
    lineAccountId: string;
    holdEpoch: number;
    now: string;
    execution: RetentionDeleteExecution;
  },
): Promise<boolean> {
  await assertRetentionDeleteExecution(db, input.execution);
  const result = await db.prepare(
    `UPDATE pharmacy_incoming_image_dispositions
        SET status = 'CLAIMED', hold_epoch = ?, updated_at = ?
      WHERE r2_key = ? AND tenant_id = ? AND line_account_id = ?
        AND status IN ('TRACKED', 'CANCELLED_HELD', 'CANCELLED_UNKNOWN', 'CANCELLED_STALE')`,
  ).bind(input.holdEpoch, input.now, input.r2Key, input.tenantId, input.lineAccountId).run();
  return (result.meta?.changes ?? 0) === 1;
}

async function commitIncomingDisposition(
  db: D1Database,
  input: {
    r2Key: string;
    tenantId: string;
    lineAccountId: string;
    holdEpoch: number;
    previousHoldEpoch: number;
    storedSha256: string;
    now: string;
    execution: RetentionDeleteExecution;
  },
): Promise<boolean> {
  await assertRetentionDeleteExecution(db, input.execution);
  const result = await db.prepare(
      `UPDATE pharmacy_incoming_image_dispositions AS disposition
          SET hold_epoch = ?, stored_sha256 = ?, status = 'DELETE_COMMITTED', updated_at = ?
        WHERE r2_key = ? AND tenant_id = ? AND line_account_id = ?
          AND status = 'CLAIMED' AND hold_epoch = ?
          AND EXISTS (
          SELECT 1 FROM pharmacy_retention_hold_epochs AS hold
           WHERE hold.tenant_id = disposition.tenant_id
             AND hold.line_account_id = disposition.line_account_id
            AND hold.owner_friend_id = (
               SELECT MIN(message.friend_id) FROM messages_log AS message
                WHERE message.line_account_id = disposition.line_account_id
                  AND message.direction = 'incoming' AND json_valid(message.content)
                  AND json_extract(message.content, '$.r2Key') = disposition.r2_key
             )
            AND (SELECT COUNT(*) FROM messages_log AS message_count
                  WHERE message_count.line_account_id = disposition.line_account_id
                    AND message_count.direction = 'incoming'
                    AND json_valid(message_count.content)
                    AND json_extract(message_count.content, '$.r2Key') = disposition.r2_key) = 1
             AND hold.patient_key = '*'
             AND hold.status = 'released' AND hold.epoch = ?
        )
        AND NOT EXISTS (
          SELECT 1 FROM pharmacy_data_subject_requests AS request
           WHERE request.tenant_id = disposition.tenant_id
             AND request.line_account_id = disposition.line_account_id
             AND request.owner_friend_id = (
               SELECT MIN(message.friend_id) FROM messages_log AS message
                WHERE message.line_account_id = disposition.line_account_id
                  AND message.direction = 'incoming' AND json_valid(message.content)
                  AND json_extract(message.content, '$.r2Key') = disposition.r2_key
             )
             AND request.request_type IN ('erasure', 'suspension')
             AND request.status IN ('received', 'identity_verified', 'legal_hold_assessed')
             AND ${ACTIVE_DSR_DELETION_BLOCK_PREDICATE_SQL}
        )`,
    ).bind(
      input.holdEpoch, input.storedSha256, input.now, input.r2Key,
      input.tenantId, input.lineAccountId, input.previousHoldEpoch,
      input.holdEpoch, input.now,
    ).run();
  return (result.meta?.changes ?? 0) === 1;
}

async function setIncomingStatus(
  db: D1Database,
  input: {
    r2Key: string;
    status: IncomingDispositionStatus;
    reason: string;
    now: string;
    from?: string;
    execution: RetentionDeleteExecution;
  },
): Promise<boolean> {
  await assertRetentionDeleteExecution(db, input.execution);
  const result = await db.prepare(
    `UPDATE pharmacy_incoming_image_dispositions
        SET status = ?, reason_code = ?, updated_at = ?
      WHERE r2_key = ? AND tenant_id = ? AND line_account_id = ? AND status = ?`,
  ).bind(
    input.status, input.reason, input.now, input.r2Key,
    input.execution.tenantId, input.execution.lineAccountId, input.from ?? 'CLAIMED',
  ).run();
  return (result.meta?.changes ?? 0) === 1;
}

/** Tracked-image consumer. Unknown age/source/ownership is never deleted. */
export async function purgeTrackedIncomingImages(
  db: D1Database,
  images: R2Bucket,
  options: IncomingOptions = {},
): Promise<IncomingImagePurgeResult> {
  const execution = await verifiedExecution(db, options.execution);
  if (!execution) return { purged: 0, failed: 0, skipped: 0 };
  const now = options.now ?? new Date();
  if (!Number.isFinite(now.getTime())) return { purged: 0, failed: 0, skipped: 0 };
  const nowIso = now.toISOString();
  const cutoff = new Date(now.getTime());
  cutoff.setUTCFullYear(cutoff.getUTCFullYear() - 3);
  const limit = Math.min(MAX_BATCH, Math.max(1, Math.floor(options.limit ?? MAX_BATCH)));
  const rows = await db.prepare(
    `SELECT object.r2_key, object.tenant_id, object.line_account_id,
            object.message_id, object.stored_at
      FROM pharmacy_incoming_image_objects AS object
       LEFT JOIN pharmacy_incoming_image_dispositions AS disposition
              ON disposition.r2_key = object.r2_key
      WHERE object.tenant_id = ? AND object.line_account_id = ?
        AND object.stored_at < ?
        AND (disposition.status IS NULL OR disposition.status IN
          ('TRACKED', 'CANCELLED_HELD', 'CANCELLED_UNKNOWN', 'CANCELLED_STALE'))
      ORDER BY CASE WHEN disposition.status IS NULL OR disposition.status = 'TRACKED'
                    THEN 0 ELSE 1 END,
               object.stored_at, object.r2_key
      LIMIT ?`,
  ).bind(execution.tenantId, execution.lineAccountId, cutoff.toISOString(), limit).all<{
    r2_key: string;
    tenant_id: string;
    line_account_id: string;
    message_id: string;
    stored_at: string;
  }>();
  const result: IncomingImagePurgeResult = { purged: 0, failed: 0, skipped: 0 };
  for (const row of rows.results ?? []) {
    try {
      await assertRetentionDeleteExecution(db, execution);
    } catch {
      result.failed++;
      continue;
    }
    if (!validStoredAt(row.stored_at) ||
        !validR2Key(row.r2_key, row.tenant_id, row.line_account_id)) {
      await upsertDisposition(db, {
        r2Key: row.r2_key, tenantId: row.tenant_id, lineAccountId: row.line_account_id,
        messageId: row.message_id, storedAt: row.stored_at, status: 'UNKNOWN',
        source: 'tracked_row', reasonCode: 'age_or_source_unknown', holdEpoch: 0, now: nowIso,
        execution,
      });
      result.skipped++;
      continue;
    }
    if (Date.parse(row.stored_at) >= cutoff.getTime()) {
      result.skipped++;
      continue;
    }
    const message = await findMessageForKey(db, row.line_account_id, row.r2_key);
    if (message.count !== 1 || !message.friendId) {
      await upsertDisposition(db, {
        r2Key: row.r2_key, tenantId: row.tenant_id, lineAccountId: row.line_account_id,
        messageId: row.message_id, storedAt: row.stored_at, status: 'OWNERSHIP_MISMATCH',
        source: 'reconcile', reasonCode: 'message_owner_ambiguous', holdEpoch: 0, now: nowIso,
        execution,
      });
      result.skipped++;
      continue;
    }
    const fence = await prepareRetentionFence(db, {
      tenantId: row.tenant_id, lineAccountId: row.line_account_id,
      ownerFriendId: message.friendId,
      patientId: null,
    }, new Date(nowIso), execution);
    await upsertDisposition(db, {
      r2Key: row.r2_key, tenantId: row.tenant_id, lineAccountId: row.line_account_id,
      messageId: row.message_id, storedAt: row.stored_at, status: 'TRACKED',
      source: 'tracked_row', reasonCode: 'tracked_ready', holdEpoch: fence.epoch, now: nowIso,
      execution,
    });
    if (!(await claimIncomingDisposition(db, {
      r2Key: row.r2_key, tenantId: row.tenant_id, lineAccountId: row.line_account_id,
      holdEpoch: fence.epoch, now: nowIso, execution,
    }))) {
      result.skipped++;
      continue;
    }
    if (fence.status !== 'released') {
      await setIncomingStatus(db, {
        r2Key: row.r2_key,
        status: fence.status === 'held' ? 'CANCELLED_HELD' : 'CANCELLED_UNKNOWN',
        reason: fence.status === 'held' ? 'retention_held' : 'retention_unknown',
        now: nowIso,
        execution,
      });
      result.skipped++;
      continue;
    }
    let head: R2Object | null;
    try {
      head = await images.head(row.r2_key);
    } catch {
      await setIncomingStatus(db, {
        r2Key: row.r2_key, status: 'OUTCOME_UNKNOWN', reason: 'r2_inspection_unknown', now: nowIso,
        execution,
      });
      result.failed++;
      continue;
    }
    if (!head || isR2RetentionTombstone(head)) {
      await setIncomingStatus(db, {
        r2Key: row.r2_key, status: 'MISSING', reason: 'r2_object_missing', now: nowIso,
        execution,
      });
      result.skipped++;
      continue;
    }
    const selectedSha256 = await readR2Sha256(images, row.r2_key);
    if (!selectedSha256) {
      await setIncomingStatus(db, {
        r2Key: row.r2_key, status: 'OUTCOME_UNKNOWN', reason: 'r2_identity_unknown', now: nowIso,
        execution,
      });
      result.failed++;
      continue;
    }
    const latestFence = await prepareRetentionFence(db, {
      tenantId: row.tenant_id, lineAccountId: row.line_account_id,
      ownerFriendId: message.friendId,
      patientId: null,
    }, new Date(nowIso), execution);
    let committed = false;
    try {
      committed = latestFence.status === 'released' && await commitIncomingDisposition(db, {
          r2Key: row.r2_key, tenantId: row.tenant_id, lineAccountId: row.line_account_id,
          holdEpoch: latestFence.epoch, previousHoldEpoch: fence.epoch, now: nowIso, execution,
          storedSha256: selectedSha256,
        });
    } catch {
      await setIncomingStatus(db, {
        r2Key: row.r2_key, status: 'OUTCOME_UNKNOWN', reason: 'retention_execution_stale_before_commit', now: nowIso,
        execution,
      });
      result.failed++;
      continue;
    }
    if (!committed) {
      await setIncomingStatus(db, {
        r2Key: row.r2_key,
        status: latestFence.status === 'held' ? 'CANCELLED_HELD' : 'CANCELLED_UNKNOWN',
        reason: latestFence.status === 'held' ? 'retention_changed' : 'retention_unknown',
        now: nowIso,
        execution,
      });
      result.skipped++;
      continue;
    }
    const currentSha256 = await readR2Sha256(images, row.r2_key);
    if (!currentSha256 || currentSha256 !== selectedSha256) {
      await setIncomingStatus(db, {
        r2Key: row.r2_key, status: 'OUTCOME_UNKNOWN', reason: 'r2_identity_changed', now: nowIso,
        from: 'DELETE_COMMITTED',
        execution,
      });
      result.failed++;
      continue;
    }
    try {
      await assertRetentionDeleteExecution(db, execution);
      if (!head.etag || !await putR2RetentionTombstone(images, row.r2_key, head.etag)) {
        await setIncomingStatus(db, {
          r2Key: row.r2_key, status: 'OUTCOME_UNKNOWN', reason: 'r2_identity_changed', now: nowIso,
          from: 'DELETE_COMMITTED', execution,
        });
        result.failed++;
        continue;
      }
    } catch {
      await setIncomingStatus(db, {
        r2Key: row.r2_key, status: 'OUTCOME_UNKNOWN', reason: 'r2_disposition_outcome_unknown',
        now: nowIso, from: 'DELETE_COMMITTED', execution,
      });
      result.failed++;
      continue;
    }
    try {
      await assertRetentionDeleteExecution(db, execution);
    } catch {
      result.failed++;
      continue;
    }
    if (await setIncomingStatus(db, {
      r2Key: row.r2_key, status: 'FINALIZED_DELETED', reason: 'r2_deleted', now: nowIso,
      from: 'DELETE_COMMITTED',
      execution,
    })) result.purged++;
    else result.failed++;
  }
  return result;
}

export const purgeIncomingImages = purgeTrackedIncomingImages;

/** Resolve durable external outcomes without retrying a present object blindly. */
export async function reconcileIncomingImageDeletionOutcomes(
  db: D1Database,
  images: R2Bucket,
  options: IncomingOptions = {},
): Promise<IncomingImagePurgeResult> {
  const execution = await verifiedExecution(db, options.execution);
  if (!execution) return { purged: 0, failed: 0, skipped: 0 };
  const now = options.now ?? new Date();
  if (!Number.isFinite(now.getTime())) return { purged: 0, failed: 0, skipped: 0 };
  const nowIso = now.toISOString();
  const limit = Math.min(MAX_BATCH, Math.max(1, Math.floor(options.limit ?? MAX_BATCH)));
  const rows = await db.prepare(
    `SELECT r2_key, status FROM pharmacy_incoming_image_dispositions
      WHERE tenant_id = ? AND line_account_id = ?
        AND status IN ('DELETE_COMMITTED', 'OUTCOME_UNKNOWN')
      ORDER BY updated_at, r2_key LIMIT ?`,
  ).bind(execution.tenantId, execution.lineAccountId, limit).all<{
    r2_key: string;
    status: 'DELETE_COMMITTED' | 'OUTCOME_UNKNOWN';
  }>();
  const result: IncomingImagePurgeResult = { purged: 0, failed: 0, skipped: 0 };
  for (const row of rows.results ?? []) {
    try {
      await assertRetentionDeleteExecution(db, execution);
      const object = await images.head(row.r2_key);
      if (!object || isR2RetentionTombstone(object)) {
        if (await setIncomingStatus(db, {
          r2Key: row.r2_key, status: 'FINALIZED_DELETED', reason: 'r2_disposition_confirmed',
          now: nowIso, from: row.status, execution,
        })) result.purged++;
        else result.failed++;
        continue;
      }
      await setIncomingStatus(db, {
        r2Key: row.r2_key, status: 'OUTCOME_UNKNOWN', reason: 'r2_object_present',
        now: nowIso, from: row.status, execution,
      });
      result.skipped++;
    } catch {
      await setIncomingStatus(db, {
        r2Key: row.r2_key, status: 'OUTCOME_UNKNOWN', reason: 'r2_inspection_unknown',
        now: nowIso, from: row.status, execution,
      }).catch(() => false);
      result.failed++;
    }
  }
  return result;
}

/** Inventory reconciliation marks, but never deletes, unowned R2 objects. */
export async function reconcileIncomingImageInventory(
  db: D1Database,
  images: R2Bucket,
  options: IncomingOptions = {},
): Promise<{ orphan: number; missing: number; mismatch: number; unknown: number }> {
  const execution = await verifiedExecution(db, options.execution);
  if (!execution) return { orphan: 0, missing: 0, mismatch: 0, unknown: 0 };
  const now = options.now ?? new Date();
  if (!Number.isFinite(now.getTime())) return { orphan: 0, missing: 0, mismatch: 0, unknown: 0 };
  const nowIso = now.toISOString();
  const limit = Math.min(MAX_BATCH, Math.max(1, Math.floor(options.limit ?? MAX_BATCH)));
  const prefix = `tenants/${safeTenantPart(execution.tenantId)}/accounts/${safeAccountPart(execution.lineAccountId)}/incoming/`;
  const listedObjects: R2Object[] = [];
  let cursor: string | undefined;
  try {
    while (true) {
      const listed = await images.list({ prefix, limit, ...(cursor ? { cursor } : {}) });
      listedObjects.push(...(listed.objects ?? []));
      if (listedObjects.length > MAX_INVENTORY_OBJECTS) {
        return { orphan: 0, missing: 0, mismatch: 0, unknown: 1 };
      }
      if (!listed.truncated) break;
      if (!listed.cursor || listed.cursor === cursor) {
        return { orphan: 0, missing: 0, mismatch: 0, unknown: 1 };
      }
      cursor = listed.cursor;
    }
  } catch {
    return { orphan: 0, missing: 0, mismatch: 0, unknown: 1 };
  }
  const result = { orphan: 0, missing: 0, mismatch: 0, unknown: 0 };
  const listedKeys = new Set<string>();
  for (const object of listedObjects) {
    listedKeys.add(object.key);
    if (!validR2Key(object.key, execution.tenantId, execution.lineAccountId)) {
      result.unknown++;
      continue;
    }
    const tracked = await db.prepare(
      `SELECT tenant_id, line_account_id, message_id, stored_at
         FROM pharmacy_incoming_image_objects WHERE r2_key = ?`,
    ).bind(object.key).first<{
      tenant_id: string; line_account_id: string; message_id: string; stored_at: string;
    }>();
    if (!tracked) {
      await upsertDisposition(db, {
        r2Key: object.key, tenantId: execution.tenantId,
        lineAccountId: execution.lineAccountId, messageId: 'inventory', storedAt: null,
        status: 'ORPHAN', source: 'r2_inventory', reasonCode: 'r2_untracked', holdEpoch: 0, now: nowIso,
        execution,
      });
      result.orphan++;
      continue;
    }
    if (tracked.tenant_id !== execution.tenantId ||
        tracked.line_account_id !== execution.lineAccountId) {
      await upsertDisposition(db, {
        r2Key: object.key, tenantId: tracked.tenant_id, lineAccountId: tracked.line_account_id,
        messageId: tracked.message_id, storedAt: tracked.stored_at, status: 'OWNERSHIP_MISMATCH',
        source: 'r2_inventory', reasonCode: 'r2_scope_mismatch', holdEpoch: 0, now: nowIso,
        execution,
      });
      result.mismatch++;
      continue;
    }
    if (!validStoredAt(tracked.stored_at)) {
      await upsertDisposition(db, {
        r2Key: object.key, tenantId: tracked.tenant_id, lineAccountId: tracked.line_account_id,
        messageId: tracked.message_id, storedAt: tracked.stored_at, status: 'UNKNOWN',
        source: 'r2_inventory', reasonCode: 'stored_at_unknown', holdEpoch: 0, now: nowIso,
        execution,
      });
      result.unknown++;
    }
  }

  const trackedRows: Array<{
    r2_key: string; tenant_id: string; line_account_id: string; message_id: string; stored_at: string;
  }> = [];
  let afterKey = '';
  while (true) {
    const page = await db.prepare(
      `SELECT r2_key, tenant_id, line_account_id, message_id, stored_at
         FROM pharmacy_incoming_image_objects
        WHERE tenant_id = ? AND line_account_id = ? AND r2_key > ?
        ORDER BY r2_key LIMIT ?`,
    ).bind(execution.tenantId, execution.lineAccountId, afterKey, limit).all<{
      r2_key: string; tenant_id: string; line_account_id: string; message_id: string; stored_at: string;
    }>();
    const rows = page.results ?? [];
    trackedRows.push(...rows);
    if (trackedRows.length > MAX_INVENTORY_OBJECTS) {
      result.unknown++;
      return result;
    }
    if (rows.length < limit) break;
    afterKey = rows.at(-1)!.r2_key;
  }
  for (const row of trackedRows) {
    if (listedKeys.has(row.r2_key)) continue;
    if (!validStoredAt(row.stored_at)) {
      await upsertDisposition(db, {
        r2Key: row.r2_key, tenantId: row.tenant_id, lineAccountId: row.line_account_id,
        messageId: row.message_id, storedAt: row.stored_at, status: 'UNKNOWN', source: 'reconcile',
        reasonCode: 'stored_at_unknown', holdEpoch: 0, now: nowIso,
        execution,
      });
      result.unknown++;
      continue;
    }
    try {
      if (await images.head(row.r2_key)) continue;
    } catch {
      await upsertDisposition(db, {
        r2Key: row.r2_key, tenantId: row.tenant_id, lineAccountId: row.line_account_id,
        messageId: row.message_id, storedAt: row.stored_at, status: 'UNKNOWN', source: 'reconcile',
        reasonCode: 'r2_inspection_unknown', holdEpoch: 0, now: nowIso,
        execution,
      });
      result.unknown++;
      continue;
    }
    await upsertDisposition(db, {
      r2Key: row.r2_key, tenantId: row.tenant_id, lineAccountId: row.line_account_id,
      messageId: row.message_id, storedAt: row.stored_at, status: 'MISSING', source: 'reconcile',
      reasonCode: 'r2_object_missing', holdEpoch: 0, now: nowIso,
      execution,
    });
    result.missing++;
  }
  return result;
}

/**
 * Readiness remains explicitly blocked until the cross-domain deletion
 * dependencies have authoritative resolution records. No inferred retention
 * period is used to turn these blockers into a delete.
 */
export async function incomingImageRetentionReadiness(
  db: D1Database,
  options: { execution?: RetentionDeleteExecution } = {},
): Promise<IncomingImageReadiness> {
  const execution = await verifiedExecution(db, options.execution);
  if (!execution) {
    return {
      status: 'BLOCKED',
      blockedReasons: ['recovery_execution_proof_missing'],
      tracked: 0,
      dispositions: 0,
    };
  }
  const tracked = await db.prepare(
    `SELECT COUNT(*) AS count FROM pharmacy_incoming_image_objects
      WHERE tenant_id = ? AND line_account_id = ?`,
  ).bind(execution.tenantId, execution.lineAccountId).first<{ count: number }>();
  const dispositions = await db.prepare(
    `SELECT COUNT(*) AS count FROM pharmacy_incoming_image_dispositions
      WHERE tenant_id = ? AND line_account_id = ?`,
  ).bind(execution.tenantId, execution.lineAccountId).first<{ count: number }>();
  return {
    status: 'BLOCKED',
    blockedReasons: [
      'ec_sale_counter_audit_dependency_unresolved',
      'dsr_tombstone_dependency_unresolved',
    ],
    tracked: tracked?.count ?? 0,
    dispositions: dispositions?.count ?? 0,
  };
}

export const getIncomingImageRetentionReadiness = incomingImageRetentionReadiness;
