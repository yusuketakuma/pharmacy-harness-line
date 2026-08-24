import {
  assessPatientRetention,
  RetentionAssessment,
} from '../data-subject-requests/legal-hold.js';
import { readRetentionFence, RetentionFence } from './deletion-intents.js';
import { assertRetentionDeleteExecution, RetentionDeleteExecution } from './execution.js';

export interface RetentionFenceScope {
  tenantId: string;
  lineAccountId: string;
  ownerFriendId: string;
  /** Null means that only the owner-wide inventory can establish the fence. */
  patientId: string | null;
}

interface SourceInventory {
  exact: RetentionAssessment | null;
  owner: RetentionAssessment;
}

function unknownAssessment(): RetentionAssessment {
  return { status: 'unknown', releaseAt: null };
}

const STRICT_UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

function aggregateAssessments(assessments: RetentionAssessment[]): RetentionAssessment {
  if (assessments.length === 0 || assessments.some((assessment) => assessment.status === 'unknown')) {
    return unknownAssessment();
  }
  if (assessments.some((assessment) => assessment.status === 'held')) {
    const releaseAt = assessments
      .map((assessment) => assessment.releaseAt)
      .filter((value): value is string => value !== null)
      .sort()
      .at(-1) ?? null;
    return { status: 'held', releaseAt };
  }
  const releaseAt = assessments
    .map((assessment) => assessment.releaseAt)
    .filter((value): value is string => value !== null)
    .sort()
    .at(-1) ?? null;
  return { status: 'released', releaseAt };
}

async function activeRequestOverlay(
  db: D1Database,
  scope: RetentionFenceScope,
  patientId: string,
  now: Date,
): Promise<RetentionAssessment | null> {
  try {
    const rows = await db.prepare(
      `SELECT status, legal_hold, legal_hold_release_at
         FROM pharmacy_data_subject_requests
        WHERE tenant_id = ? AND line_account_id = ? AND owner_friend_id = ?
          AND patient_id = ? AND request_type IN ('erasure', 'suspension')
          AND status IN ('received', 'identity_verified', 'legal_hold_assessed')`,
    ).bind(scope.tenantId, scope.lineAccountId, scope.ownerFriendId, patientId)
      .all<{ status: string; legal_hold: number | null; legal_hold_release_at: string | null }>();
    let held: string | null = null;
    for (const row of rows.results ?? []) {
      if (row.status === 'received' || row.status === 'identity_verified') {
        return unknownAssessment();
      }
      if (row.legal_hold !== 0 && row.legal_hold !== 1) return unknownAssessment();
      if (row.legal_hold === 1) {
        if (!row.legal_hold_release_at || !STRICT_UTC_TIMESTAMP.test(row.legal_hold_release_at) ||
            !Number.isFinite(Date.parse(row.legal_hold_release_at))) {
          return unknownAssessment();
        }
        if (Date.parse(row.legal_hold_release_at) > now.getTime() &&
            (!held || row.legal_hold_release_at > held)) {
          held = row.legal_hold_release_at;
        }
      }
    }
    return held ? { status: 'held', releaseAt: held } : null;
  } catch {
    return unknownAssessment();
  }
}

async function assessedPatientRetention(
  db: D1Database,
  scope: RetentionFenceScope,
  patientId: string,
  now: Date,
): Promise<RetentionAssessment> {
  const base = await assessPatientRetention(db, {
    tenantId: scope.tenantId,
    lineAccountId: scope.lineAccountId,
    ownerFriendId: scope.ownerFriendId,
    patientId,
  }, now);
  const overlay = await activeRequestOverlay(db, scope, patientId, now);
  if (!overlay) return base;
  if (overlay.status === 'unknown' || base.status === 'unknown') return unknownAssessment();
  if (overlay.status === 'held' || base.status === 'held') {
    const releaseAt = [base.releaseAt, overlay.releaseAt]
      .filter((value): value is string => value !== null)
      .sort()
      .at(-1) ?? null;
    return { status: 'held', releaseAt };
  }
  return base;
}

async function ownerSourceInventory(
  db: D1Database,
  scope: RetentionFenceScope,
  now: Date,
): Promise<RetentionAssessment> {
  try {
    const mapping = await db.prepare(
      `SELECT COUNT(*) AS count
         FROM tenant_line_accounts AS mapping
         INNER JOIN tenants AS tenant ON tenant.id = mapping.tenant_id
        WHERE mapping.tenant_id = ? AND mapping.line_account_id = ?
          AND tenant.status = 'active'`,
    ).bind(scope.tenantId, scope.lineAccountId).first<{ count: number }>();
    if ((mapping?.count ?? 0) !== 1) return unknownAssessment();

    const rows = await db.prepare(
      `SELECT id FROM pharmacy_patients
        WHERE line_account_id = ? AND owner_friend_id = ?
        ORDER BY id`,
    ).bind(scope.lineAccountId, scope.ownerFriendId).all<{ id: string }>();
    const patientIds = rows.results ?? [];
    if (patientIds.length === 0) return unknownAssessment();

    const assessments: RetentionAssessment[] = [];
    for (const patient of patientIds) {
      assessments.push(await assessedPatientRetention(db, scope, patient.id, now));
    }
    return aggregateAssessments(assessments);
  } catch {
    return unknownAssessment();
  }
}

async function sourceInventory(
  db: D1Database,
  scope: RetentionFenceScope,
  now: Date,
): Promise<SourceInventory> {
  const exact = scope.patientId
    ? await assessedPatientRetention(db, scope, scope.patientId, now)
    : null;
  return { exact, owner: await ownerSourceInventory(db, scope, now) };
}

function reasonCode(status: RetentionAssessment['status']): string {
  if (status === 'held') return 'server_source_inventory_held';
  if (status === 'released') return 'server_source_inventory_released';
  return 'server_source_inventory_unknown';
}

function upsertFenceStatement(
  db: D1Database,
  scope: RetentionFenceScope,
  patientKey: string,
  assessment: RetentionAssessment,
  now: string,
) {
  return db.prepare(
    `INSERT INTO pharmacy_retention_hold_epochs
      (tenant_id, line_account_id, owner_friend_id, patient_key, epoch,
       status, release_at, reason_code, updated_at)
     VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?)
     ON CONFLICT (tenant_id, line_account_id, owner_friend_id, patient_key)
     DO UPDATE SET epoch = pharmacy_retention_hold_epochs.epoch + 1,
       status = excluded.status, release_at = excluded.release_at,
       reason_code = excluded.reason_code, updated_at = excluded.updated_at`,
  ).bind(
    scope.tenantId, scope.lineAccountId, scope.ownerFriendId, patientKey,
    assessment.status, assessment.releaseAt, reasonCode(assessment.status), now,
  );
}

/**
 * Re-evaluate every patient source and persist a fresh exact/owner fence.
 * A missing, malformed, ambiguous, or failed source query stays unknown and
 * therefore cannot authorize deletion.
 */
export async function prepareRetentionFence(
  db: D1Database,
  scope: RetentionFenceScope,
  now: Date,
  execution: RetentionDeleteExecution,
): Promise<RetentionFence> {
  if (!Number.isFinite(now.getTime())) return { status: 'unknown', epoch: 0 };
  await assertRetentionDeleteExecution(db, execution);
  const inventory = await sourceInventory(db, scope, now);
  const nowIso = now.toISOString();
  const statements = [
    upsertFenceStatement(db, scope, '*', inventory.owner, nowIso),
  ];
  if (scope.patientId && inventory.exact) {
    statements.unshift(upsertFenceStatement(db, scope, scope.patientId, inventory.exact, nowIso));
  }
  await assertRetentionDeleteExecution(db, execution);
  try {
    await db.batch(statements);
  } catch {
    return { status: 'unknown', epoch: 0 };
  }
  return readRetentionFence(db, {
    tenantId: scope.tenantId,
    lineAccountId: scope.lineAccountId,
    ownerFriendId: scope.ownerFriendId,
    patientKey: scope.patientId ?? '*',
  });
}
