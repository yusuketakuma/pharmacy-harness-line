import {
  LEGAL_HOLD_BASIS,
  assessPatientRetention,
  RetentionStatus,
  isRetentionBlockedRequestType,
} from './legal-hold.js';

export type DataSubjectRequestType = 'access' | 'correction' | 'suspension' | 'erasure';
export type DataSubjectRequestStatus =
  | 'received' | 'identity_verified' | 'legal_hold_assessed' | 'resolved' | 'rejected';

export type DataSubjectRequest = {
  id: string;
  tenant_id: string;
  line_account_id: string;
  owner_friend_id: string;
  patient_id: string;
  request_type: DataSubjectRequestType;
  status: DataSubjectRequestStatus;
  reason: string;
  legal_hold: number | null;
  legal_hold_basis: string | null;
  legal_hold_release_at: string | null;
  retention_status: RetentionStatus;
  hold_epoch: number;
  outcome_note: string | null;
  version: number;
  submitted_at: string;
  identity_verified_at: string | null;
  legal_hold_assessed_at: string | null;
  resolved_at: string | null;
  resolved_by: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
};

const COLUMNS = `request.id, request.tenant_id, request.line_account_id, request.owner_friend_id,
  request.patient_id, request.request_type, request.status, request.reason, request.legal_hold,
  request.legal_hold_basis, request.legal_hold_release_at,
  CASE
    WHEN EXISTS (
      SELECT 1 FROM pharmacy_retention_hold_epochs AS unknown_hold
       WHERE unknown_hold.tenant_id = request.tenant_id
         AND unknown_hold.line_account_id = request.line_account_id
         AND unknown_hold.owner_friend_id = request.owner_friend_id
         AND unknown_hold.patient_key IN (request.patient_id, '*')
         AND unknown_hold.status = 'unknown'
    ) THEN 'unknown'
    WHEN EXISTS (
      SELECT 1 FROM pharmacy_retention_hold_epochs AS active_hold
       WHERE active_hold.tenant_id = request.tenant_id
         AND active_hold.line_account_id = request.line_account_id
         AND active_hold.owner_friend_id = request.owner_friend_id
         AND active_hold.patient_key IN (request.patient_id, '*')
         AND active_hold.status = 'held'
    ) THEN 'held'
    WHEN EXISTS (
      SELECT 1 FROM pharmacy_retention_hold_epochs AS released_hold
       WHERE released_hold.tenant_id = request.tenant_id
         AND released_hold.line_account_id = request.line_account_id
         AND released_hold.owner_friend_id = request.owner_friend_id
         AND released_hold.patient_key IN (request.patient_id, '*')
         AND released_hold.status = 'released'
    ) THEN 'released'
    WHEN request.legal_hold = 1 THEN 'held'
    WHEN request.legal_hold = 0 THEN 'released'
    ELSE 'unknown'
  END AS retention_status,
  COALESCE((
    SELECT MAX(epoch) FROM pharmacy_retention_hold_epochs AS epoch_hold
     WHERE epoch_hold.tenant_id = request.tenant_id
       AND epoch_hold.line_account_id = request.line_account_id
       AND epoch_hold.owner_friend_id = request.owner_friend_id
       AND epoch_hold.patient_key IN (request.patient_id, '*')
  ), 0) AS hold_epoch,
  request.outcome_note, request.version, request.submitted_at, request.identity_verified_at,
  request.legal_hold_assessed_at, request.resolved_at, request.resolved_by, request.created_by,
  request.created_at, request.updated_at`;

const REQUEST_FROM = 'pharmacy_data_subject_requests AS request';

export async function getDataSubjectRequest(
  db: D1Database,
  lineAccountId: string,
  requestId: string,
): Promise<DataSubjectRequest | null> {
  return db.prepare(
    `SELECT ${COLUMNS} FROM ${REQUEST_FROM}
      WHERE request.id = ? AND request.line_account_id = ?`,
  ).bind(requestId, lineAccountId).first<DataSubjectRequest>();
}

export async function listDataSubjectRequests(
  db: D1Database,
  lineAccountId: string,
): Promise<DataSubjectRequest[]> {
  const result = await db.prepare(
    `SELECT ${COLUMNS} FROM ${REQUEST_FROM}
      WHERE request.line_account_id = ?
      ORDER BY request.submitted_at DESC, request.id DESC
      LIMIT 200`,
  ).bind(lineAccountId).all<DataSubjectRequest>();
  return result.results ?? [];
}

function eventStatement(
  db: D1Database,
  input: {
    lineAccountId: string;
    requestId: string;
    eventId: string;
    eventType: DataSubjectRequestStatus;
    staffId: string;
    detail: string | null;
    occurredAt: string;
    fromStatus: DataSubjectRequestStatus;
    expectedVersion: number;
    expectedHoldEpoch?: number;
  },
): D1PreparedStatement {
  const epochGuard = input.expectedHoldEpoch === undefined ? '' : `
        AND COALESCE((
          SELECT MAX(epoch) FROM pharmacy_retention_hold_epochs AS epoch_hold
           WHERE epoch_hold.tenant_id = pharmacy_data_subject_requests.tenant_id
             AND epoch_hold.line_account_id = pharmacy_data_subject_requests.line_account_id
             AND epoch_hold.owner_friend_id = pharmacy_data_subject_requests.owner_friend_id
             AND epoch_hold.patient_key IN (pharmacy_data_subject_requests.patient_id, '*')
        ), 0) = ?`;
  return db.prepare(
    `INSERT INTO pharmacy_data_subject_request_events
      (id, request_id, line_account_id, event_type, actor_staff_id, detail, occurred_at)
     SELECT ?, id, line_account_id, ?, ?, ?, ?
       FROM pharmacy_data_subject_requests
      WHERE id = ? AND line_account_id = ? AND status = ? AND version = ?${epochGuard}`,
  ).bind(
    input.eventId, input.eventType, input.staffId, input.detail, input.occurredAt,
    input.requestId, input.lineAccountId, input.fromStatus, input.expectedVersion,
    ...(input.expectedHoldEpoch === undefined ? [] : [input.expectedHoldEpoch]),
  );
}

type HoldEpochTransitionInput = {
  lineAccountId: string;
  requestId: string;
  expectedVersion: number;
  fromStatus: DataSubjectRequestStatus;
  expectedHoldEpoch?: number;
  status: RetentionStatus;
  releaseAt: string | null;
  reasonCode: string;
  updatedAt: string;
};

/**
 * Both the exact patient fence and the owner-wide fence move with the request
 * transition.  The source row is guarded by the old workflow version and,
 * when supplied, the old hold epoch so a concurrent retention writer cannot be
 * overwritten by a stale DSR worker.
 */
function holdEpochStatements(
  db: D1Database,
  input: HoldEpochTransitionInput,
): D1PreparedStatement[] {
  const source = (guardEpoch: number | undefined) => `
       FROM pharmacy_data_subject_requests AS request
      WHERE request.id = ? AND request.line_account_id = ?
        AND request.status = ? AND request.version = ?${guardEpoch === undefined ? '' : `
        AND COALESCE((
          SELECT MAX(epoch) FROM pharmacy_retention_hold_epochs AS epoch_hold
           WHERE epoch_hold.tenant_id = request.tenant_id
             AND epoch_hold.line_account_id = request.line_account_id
             AND epoch_hold.owner_friend_id = request.owner_friend_id
             AND epoch_hold.patient_key IN (request.patient_id, '*')
        ), 0) = ?`}`;
  const nextEpoch = (input.expectedHoldEpoch ?? 0) + 1;
  const binds = (keyValue: string | undefined, guardEpoch: number | undefined) => [
    ...(keyValue === undefined ? [] : [keyValue]),
    nextEpoch,
    input.status,
    input.releaseAt,
    input.reasonCode,
    input.updatedAt,
    input.requestId,
    input.lineAccountId,
    input.fromStatus,
    input.expectedVersion,
    ...(guardEpoch === undefined ? [] : [guardEpoch]),
  ];
  const statement = (keyExpression: string, keyValue: string | undefined, guardEpoch: number | undefined) => db.prepare(
    `INSERT INTO pharmacy_retention_hold_epochs
       (tenant_id, line_account_id, owner_friend_id, patient_key, epoch,
        status, release_at, reason_code, updated_at)
     SELECT request.tenant_id, request.line_account_id, request.owner_friend_id,
            ${keyExpression}, ?, ?, ?, ?, ?${source(guardEpoch)}
     ON CONFLICT (tenant_id, line_account_id, owner_friend_id, patient_key)
     DO UPDATE SET epoch = excluded.epoch,
                   status = excluded.status,
                   release_at = excluded.release_at,
                   reason_code = excluded.reason_code,
                   updated_at = excluded.updated_at`,
  ).bind(...binds(keyValue, guardEpoch));
  return [
    statement('request.patient_id', undefined, input.expectedHoldEpoch),
    // The exact row owns the old-epoch CAS. The owner-wide row accepts only the
    // resulting epoch, so a stale writer cannot leave a partial wildcard fence.
    statement('?', '*', input.expectedHoldEpoch === undefined ? undefined : nextEpoch),
  ];
}

/** 状態変更とその監査イベントは常に同一 db.batch で確定させる(M-3)。 */
async function commitTransition(
  db: D1Database,
  input: {
    lineAccountId: string;
    requestId: string;
    expectedVersion: number;
    fromStatus: DataSubjectRequestStatus;
    eventType: DataSubjectRequestStatus;
    staffId: string;
    detail: string | null;
    occurredAt: string;
    expectedHoldEpoch?: number;
  },
  update: (eventId: string) => D1PreparedStatement,
  extras: D1PreparedStatement[] = [],
): Promise<DataSubjectRequest> {
  const eventId = crypto.randomUUID();
  const results = await db.batch([
    eventStatement(db, { ...input, eventId }),
    ...extras,
    update(eventId),
  ]);
  if (results.some((result) => (result?.meta?.changes ?? 0) !== 1)) {
    throw new Error('data subject request transition conflict');
  }
  const saved = await getDataSubjectRequest(db, input.lineAccountId, input.requestId);
  if (!saved) throw new Error('data subject request not found');
  return saved;
}

async function requireRequest(
  db: D1Database,
  lineAccountId: string,
  requestId: string,
): Promise<DataSubjectRequest> {
  const current = await getDataSubjectRequest(db, lineAccountId, requestId);
  if (!current) throw new Error('data subject request not found');
  return current;
}

export async function createDataSubjectRequest(
  db: D1Database,
  input: {
    lineAccountId: string;
    tenantId: string;
    patientId: string;
    requestType: DataSubjectRequestType;
    reason: string;
    staffId: string;
    now?: Date;
  },
): Promise<DataSubjectRequest> {
  const timestamp = (input.now ?? new Date()).toISOString();
  const id = crypto.randomUUID();
  const eventId = crypto.randomUUID();
  // tenant_id と owner_friend_id はリクエスト本文ではなくDBの所有関係から埋める。
  const results = await db.batch([
    db.prepare(
      `INSERT INTO pharmacy_data_subject_requests
        (id, tenant_id, line_account_id, owner_friend_id, patient_id, request_type,
         status, reason, version, submitted_at, created_by, created_at, updated_at)
       SELECT ?, link.tenant_id, patient.line_account_id, patient.owner_friend_id,
              patient.id, ?, 'received', ?, 1, ?, ?, ?, ?
         FROM pharmacy_patients AS patient
         INNER JOIN tenant_line_accounts AS link
                 ON link.line_account_id = patient.line_account_id
        WHERE patient.id = ? AND patient.line_account_id = ? AND link.tenant_id = ?`,
    ).bind(
      id, input.requestType, input.reason, timestamp, input.staffId, timestamp, timestamp,
      input.patientId, input.lineAccountId, input.tenantId,
    ),
    db.prepare(
      `INSERT INTO pharmacy_data_subject_request_events
        (id, request_id, line_account_id, event_type, actor_staff_id, detail, occurred_at)
       SELECT ?, id, line_account_id, 'received', ?, ?, ?
         FROM pharmacy_data_subject_requests
        WHERE id = ? AND line_account_id = ?`,
    ).bind(eventId, input.staffId, input.requestType, timestamp, id, input.lineAccountId),
    ...holdEpochStatements(db, {
      lineAccountId: input.lineAccountId,
      requestId: id,
      expectedVersion: 1,
      fromStatus: 'received',
      status: 'unknown',
      releaseAt: null,
      reasonCode: 'dsr_unassessed',
      updatedAt: timestamp,
    }),
  ]);
  if (results.some((result) => (result?.meta?.changes ?? 0) !== 1)) {
    throw new Error('patient not found for this pharmacy account');
  }
  return requireRequest(db, input.lineAccountId, id);
}

export async function markDataSubjectIdentityVerified(
  db: D1Database,
  input: {
    lineAccountId: string;
    requestId: string;
    expectedVersion: number;
    staffId: string;
    now?: Date;
  },
): Promise<DataSubjectRequest> {
  const current = await requireRequest(db, input.lineAccountId, input.requestId);
  const timestamp = (input.now ?? new Date()).toISOString();
  return commitTransition(db, {
    ...input,
    fromStatus: 'received',
    eventType: 'identity_verified',
    detail: null,
    occurredAt: timestamp,
    expectedHoldEpoch: current.hold_epoch,
  }, (eventId) => db.prepare(
    `UPDATE pharmacy_data_subject_requests
        SET status = 'identity_verified', identity_verified_at = ?,
            version = version + 1, updated_at = ?
      WHERE id = ? AND line_account_id = ? AND status = 'received' AND version = ?
        AND COALESCE((
          SELECT MAX(epoch) FROM pharmacy_retention_hold_epochs AS epoch_hold
           WHERE epoch_hold.tenant_id = pharmacy_data_subject_requests.tenant_id
             AND epoch_hold.line_account_id = pharmacy_data_subject_requests.line_account_id
             AND epoch_hold.owner_friend_id = pharmacy_data_subject_requests.owner_friend_id
             AND epoch_hold.patient_key IN (pharmacy_data_subject_requests.patient_id, '*')
        ), 0) = ?
        AND EXISTS (SELECT 1 FROM pharmacy_data_subject_request_events
                     WHERE id = ? AND request_id = ? AND line_account_id = ?)`,
  ).bind(
    timestamp, timestamp, input.requestId, input.lineAccountId, input.expectedVersion,
    current.hold_epoch + 1,
    eventId, input.requestId, input.lineAccountId,
  ), holdEpochStatements(db, {
    lineAccountId: input.lineAccountId,
    requestId: input.requestId,
    expectedVersion: input.expectedVersion,
    fromStatus: 'received',
    expectedHoldEpoch: current.hold_epoch,
    status: 'unknown',
    releaseAt: null,
    reasonCode: 'dsr_identity_verified_unassessed',
    updatedAt: timestamp,
  }));
}

export async function assessDataSubjectLegalHold(
  db: D1Database,
  input: {
    lineAccountId: string;
    requestId: string;
    expectedVersion: number;
    staffId: string;
    now?: Date;
  },
): Promise<DataSubjectRequest> {
  const current = await requireRequest(db, input.lineAccountId, input.requestId);
  const now = input.now ?? new Date();
  const timestamp = now.toISOString();
  const assessment = await assessPatientRetention(db, {
    tenantId: current.tenant_id,
    lineAccountId: current.line_account_id,
    ownerFriendId: current.owner_friend_id,
    patientId: current.patient_id,
  }, now);
  const blocked = assessment.status !== 'released';
  const detail = assessment.status === 'held'
    ? `legal_hold_until:${assessment.releaseAt}`
    : assessment.status === 'released' ? 'no_legal_hold' : 'retention_unknown';
  return commitTransition(db, {
    ...input,
    fromStatus: 'identity_verified',
    eventType: 'legal_hold_assessed',
    detail,
    occurredAt: timestamp,
    expectedHoldEpoch: current.hold_epoch,
  }, (eventId) => db.prepare(
    `UPDATE pharmacy_data_subject_requests
        SET status = 'legal_hold_assessed', legal_hold = ?, legal_hold_basis = ?,
            legal_hold_release_at = ?, legal_hold_assessed_at = ?,
            version = version + 1, updated_at = ?
      WHERE id = ? AND line_account_id = ? AND status = 'identity_verified' AND version = ?
        AND COALESCE((
          SELECT MAX(epoch) FROM pharmacy_retention_hold_epochs AS epoch_hold
           WHERE epoch_hold.tenant_id = pharmacy_data_subject_requests.tenant_id
             AND epoch_hold.line_account_id = pharmacy_data_subject_requests.line_account_id
             AND epoch_hold.owner_friend_id = pharmacy_data_subject_requests.owner_friend_id
             AND epoch_hold.patient_key IN (pharmacy_data_subject_requests.patient_id, '*')
        ), 0) = ?
        AND EXISTS (SELECT 1 FROM pharmacy_data_subject_request_events
                     WHERE id = ? AND request_id = ? AND line_account_id = ?)`,
  ).bind(
    blocked ? 1 : 0, blocked ? LEGAL_HOLD_BASIS : null,
    assessment.releaseAt, timestamp, timestamp,
    input.requestId, input.lineAccountId, input.expectedVersion,
    current.hold_epoch + 1,
    eventId, input.requestId, input.lineAccountId,
  ), holdEpochStatements(db, {
    lineAccountId: input.lineAccountId,
    requestId: input.requestId,
    expectedVersion: input.expectedVersion,
    fromStatus: 'identity_verified',
    expectedHoldEpoch: current.hold_epoch,
    status: assessment.status,
    releaseAt: assessment.releaseAt,
    reasonCode: assessment.status === 'unknown' ? 'retention_source_unknown' : 'legal_hold_assessed',
    updatedAt: timestamp,
  }));
}

export async function resolveDataSubjectRequest(
  db: D1Database,
  input: {
    lineAccountId: string;
    requestId: string;
    expectedVersion: number;
    decision: 'resolved' | 'rejected';
    outcomeNote: string;
    staffId: string;
    now?: Date;
  },
): Promise<DataSubjectRequest> {
  const current = await requireRequest(db, input.lineAccountId, input.requestId);
  if (current.status !== 'legal_hold_assessed') {
    // received/identity_verified は、保持判定を一度も通っていないため
    // 消去・利用停止だけでなく、結果確定前の全 resolve を許可しない。
    throw new Error('retention assessment required before resolving this request');
  }
  const now = input.now ?? new Date();
  const assessment = await assessPatientRetention(db, {
    tenantId: current.tenant_id,
    lineAccountId: current.line_account_id,
    ownerFriendId: current.owner_friend_id,
    patientId: current.patient_id,
  }, now);
  if (
    input.decision === 'resolved' && assessment.status !== 'released' &&
    isRetentionBlockedRequestType(current.request_type)
  ) {
    // 法定保存期間中または判定不能の消去・利用停止は、R2/D1 の削除へ進めない。
    throw new Error(assessment.status === 'unknown'
      ? 'retention status unknown blocks this data subject request'
      : 'legal hold blocks this data subject request');
  }
  const timestamp = now.toISOString();
  const blocked = assessment.status !== 'released';
  return commitTransition(db, {
    ...input,
    fromStatus: 'legal_hold_assessed',
    eventType: input.decision,
    detail: input.outcomeNote,
    occurredAt: timestamp,
    expectedHoldEpoch: current.hold_epoch,
  }, (eventId) => db.prepare(
    `UPDATE pharmacy_data_subject_requests
        SET status = ?, legal_hold = ?, legal_hold_basis = ?, legal_hold_release_at = ?,
            outcome_note = ?, resolved_at = ?, resolved_by = ?,
            version = version + 1, updated_at = ?
      WHERE id = ? AND line_account_id = ? AND status = 'legal_hold_assessed' AND version = ?
        AND COALESCE((
          SELECT MAX(epoch) FROM pharmacy_retention_hold_epochs AS epoch_hold
           WHERE epoch_hold.tenant_id = pharmacy_data_subject_requests.tenant_id
             AND epoch_hold.line_account_id = pharmacy_data_subject_requests.line_account_id
             AND epoch_hold.owner_friend_id = pharmacy_data_subject_requests.owner_friend_id
             AND epoch_hold.patient_key IN (pharmacy_data_subject_requests.patient_id, '*')
        ), 0) = ?
        AND EXISTS (SELECT 1 FROM pharmacy_data_subject_request_events
                     WHERE id = ? AND request_id = ? AND line_account_id = ?)`,
  ).bind(
    input.decision, blocked ? 1 : 0, blocked ? LEGAL_HOLD_BASIS : null,
    assessment.releaseAt,
    input.outcomeNote, timestamp, input.staffId, timestamp,
    // The exact hold-epoch statement runs before this UPDATE in the same batch
    // and increments the aggregate once; compare against that post-bump value.
    input.requestId, input.lineAccountId, input.expectedVersion, current.hold_epoch + 1,
    eventId, input.requestId, input.lineAccountId,
  ), holdEpochStatements(db, {
    lineAccountId: input.lineAccountId,
    requestId: input.requestId,
    expectedVersion: input.expectedVersion,
    fromStatus: 'legal_hold_assessed',
    expectedHoldEpoch: current.hold_epoch,
    status: assessment.status,
    releaseAt: assessment.releaseAt,
    reasonCode: input.decision === 'resolved' ? 'dsr_resolved' : 'dsr_rejected',
    updatedAt: timestamp,
  }));
}
