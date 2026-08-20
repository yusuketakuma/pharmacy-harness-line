import {
  LEGAL_HOLD_BASIS,
  assessRetention,
  isRetentionBlockedRequestType,
  latestPhiRecordedAt,
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

const COLUMNS = `id, tenant_id, line_account_id, owner_friend_id, patient_id, request_type,
  status, reason, legal_hold, legal_hold_basis, legal_hold_release_at, outcome_note,
  version, submitted_at, identity_verified_at, legal_hold_assessed_at, resolved_at,
  resolved_by, created_by, created_at, updated_at`;

export async function getDataSubjectRequest(
  db: D1Database,
  lineAccountId: string,
  requestId: string,
): Promise<DataSubjectRequest | null> {
  return db.prepare(
    `SELECT ${COLUMNS} FROM pharmacy_data_subject_requests
      WHERE id = ? AND line_account_id = ?`,
  ).bind(requestId, lineAccountId).first<DataSubjectRequest>();
}

export async function listDataSubjectRequests(
  db: D1Database,
  lineAccountId: string,
): Promise<DataSubjectRequest[]> {
  const result = await db.prepare(
    `SELECT ${COLUMNS} FROM pharmacy_data_subject_requests
      WHERE line_account_id = ?
      ORDER BY submitted_at DESC, id DESC
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
  },
): D1PreparedStatement {
  return db.prepare(
    `INSERT INTO pharmacy_data_subject_request_events
      (id, request_id, line_account_id, event_type, actor_staff_id, detail, occurred_at)
     SELECT ?, id, line_account_id, ?, ?, ?, ?
       FROM pharmacy_data_subject_requests
      WHERE id = ? AND line_account_id = ? AND status = ? AND version = ?`,
  ).bind(
    input.eventId, input.eventType, input.staffId, input.detail, input.occurredAt,
    input.requestId, input.lineAccountId, input.fromStatus, input.expectedVersion,
  );
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
  },
  update: (eventId: string) => D1PreparedStatement,
): Promise<DataSubjectRequest> {
  const eventId = crypto.randomUUID();
  const results = await db.batch([
    eventStatement(db, { ...input, eventId }),
    update(eventId),
  ]);
  if ((results[0]?.meta?.changes ?? 0) !== 1 || (results[1]?.meta?.changes ?? 0) !== 1) {
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
  ]);
  if ((results[0]?.meta?.changes ?? 0) !== 1 || (results[1]?.meta?.changes ?? 0) !== 1) {
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
  await requireRequest(db, input.lineAccountId, input.requestId);
  const timestamp = (input.now ?? new Date()).toISOString();
  return commitTransition(db, {
    ...input,
    fromStatus: 'received',
    eventType: 'identity_verified',
    detail: null,
    occurredAt: timestamp,
  }, (eventId) => db.prepare(
    `UPDATE pharmacy_data_subject_requests
        SET status = 'identity_verified', identity_verified_at = ?,
            version = version + 1, updated_at = ?
      WHERE id = ? AND line_account_id = ? AND status = 'received' AND version = ?
        AND EXISTS (SELECT 1 FROM pharmacy_data_subject_request_events
                     WHERE id = ? AND request_id = ? AND line_account_id = ?)`,
  ).bind(
    timestamp, timestamp, input.requestId, input.lineAccountId, input.expectedVersion,
    eventId, input.requestId, input.lineAccountId,
  ));
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
  const latestPhiAt = await latestPhiRecordedAt(db, input.lineAccountId, current.patient_id);
  const { held, releaseAt } = assessRetention(latestPhiAt, now);
  return commitTransition(db, {
    ...input,
    fromStatus: 'identity_verified',
    eventType: 'legal_hold_assessed',
    detail: held ? `legal_hold_until:${releaseAt}` : 'no_legal_hold',
    occurredAt: timestamp,
  }, (eventId) => db.prepare(
    `UPDATE pharmacy_data_subject_requests
        SET status = 'legal_hold_assessed', legal_hold = ?, legal_hold_basis = ?,
            legal_hold_release_at = ?, legal_hold_assessed_at = ?,
            version = version + 1, updated_at = ?
      WHERE id = ? AND line_account_id = ? AND status = 'identity_verified' AND version = ?
        AND EXISTS (SELECT 1 FROM pharmacy_data_subject_request_events
                     WHERE id = ? AND request_id = ? AND line_account_id = ?)`,
  ).bind(
    held ? 1 : 0, held ? LEGAL_HOLD_BASIS : null, releaseAt, timestamp, timestamp,
    input.requestId, input.lineAccountId, input.expectedVersion,
    eventId, input.requestId, input.lineAccountId,
  ));
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
  if (
    input.decision === 'resolved' && current.legal_hold === 1 &&
    isRetentionBlockedRequestType(current.request_type)
  ) {
    // 法定保存期間中の消去・利用停止は実施できない。応じられない旨を記録して閉じる。
    throw new Error('legal hold blocks this data subject request');
  }
  const timestamp = (input.now ?? new Date()).toISOString();
  return commitTransition(db, {
    ...input,
    fromStatus: 'legal_hold_assessed',
    eventType: input.decision,
    detail: input.outcomeNote,
    occurredAt: timestamp,
  }, (eventId) => db.prepare(
    `UPDATE pharmacy_data_subject_requests
        SET status = ?, outcome_note = ?, resolved_at = ?, resolved_by = ?,
            version = version + 1, updated_at = ?
      WHERE id = ? AND line_account_id = ? AND status = 'legal_hold_assessed' AND version = ?
        AND EXISTS (SELECT 1 FROM pharmacy_data_subject_request_events
                     WHERE id = ? AND request_id = ? AND line_account_id = ?)`,
  ).bind(
    input.decision, input.outcomeNote, timestamp, input.staffId, timestamp,
    input.requestId, input.lineAccountId, input.expectedVersion,
    eventId, input.requestId, input.lineAccountId,
  ));
}
