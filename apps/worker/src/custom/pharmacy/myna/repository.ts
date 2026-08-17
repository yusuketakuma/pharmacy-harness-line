import {
  canLaunchMynaHandoff,
  patientReportToStatus,
  type MynaHandoffStatus,
  type MynaMethod,
  type MynaPatientReport,
  type MynaVerificationStatus,
  verificationToHandoffStatus,
  verificationToReceiptStatus,
  type PrescriptionReceiptStatus,
} from './state.js';

const ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const CORRELATION_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;
const CODE_PATTERN = /^[a-zA-Z0-9._:-]{1,128}$/;
const HANDOFF_SELECT = `
  SELECT id, line_account_id, friend_id, patient_id, expectation_id, method, status,
         source, correlation_id, launched_at, patient_reported_at, expires_at,
         closed_at, created_at, updated_at
    FROM pharmacy_myna_handoffs`;

export interface MynaHandoff {
  id: string;
  line_account_id: string;
  friend_id: string;
  patient_id: string | null;
  expectation_id: string | null;
  method: MynaMethod;
  status: MynaHandoffStatus;
  source: 'RICH_MENU' | 'MESSAGE' | 'LIFF';
  correlation_id: string;
  launched_at: string | null;
  patient_reported_at: string | null;
  expires_at: string;
  closed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface MynaExpectation {
  id: string;
  handoff_id: string;
  line_account_id: string;
  friend_id: string;
  patient_id: string | null;
  method: MynaMethod;
  receipt_status: PrescriptionReceiptStatus;
  shadow_submission_id: string | null;
}

export interface MynaVerification {
  id: string;
  handoff_id: string;
  line_account_id: string;
  status: MynaVerificationStatus;
  verified_by: string;
  verified_at: string;
  reason_code: string | null;
  source_system: string;
  source_reference: string | null;
}

export interface CreateMynaHandoffInput {
  lineAccountId: string;
  friendId: string;
  patientId?: string;
  method: MynaMethod;
  source: 'RICH_MENU' | 'MESSAGE' | 'LIFF';
  correlationId: string;
  expiresAt: string;
}

export interface RecordMynaVerificationInput {
  lineAccountId: string;
  handoffId: string;
  staffId: string;
  status: MynaVerificationStatus;
  reasonCode?: string | null;
  sourceSystem: string;
  sourceReference?: string | null;
}

export interface MynaVerificationResult {
  verification: MynaVerification;
  receiptStatus: PrescriptionReceiptStatus;
  shadowSubmissionId: string | null;
  handoff: MynaHandoff;
}

function decodeHandoff(row: Record<string, unknown>): MynaHandoff {
  return {
    id: String(row.id),
    line_account_id: String(row.line_account_id),
    friend_id: String(row.friend_id),
    patient_id: (row.patient_id as string | null) ?? null,
    expectation_id: (row.expectation_id as string | null) ?? null,
    method: row.method as MynaMethod,
    status: row.status as MynaHandoffStatus,
    source: row.source as MynaHandoff['source'],
    correlation_id: String(row.correlation_id),
    launched_at: (row.launched_at as string | null) ?? null,
    patient_reported_at: (row.patient_reported_at as string | null) ?? null,
    expires_at: String(row.expires_at),
    closed_at: (row.closed_at as string | null) ?? null,
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

function decodeExpectation(row: Record<string, unknown>): MynaExpectation {
  return {
    id: String(row.id),
    handoff_id: String(row.handoff_id),
    line_account_id: String(row.line_account_id),
    friend_id: String(row.friend_id),
    patient_id: (row.patient_id as string | null) ?? null,
    method: row.method as MynaMethod,
    receipt_status: row.receipt_status as PrescriptionReceiptStatus,
    shadow_submission_id: (row.shadow_submission_id as string | null) ?? null,
  };
}

function decodeVerification(row: Record<string, unknown>): MynaVerification {
  return {
    id: String(row.id),
    handoff_id: String(row.handoff_id),
    line_account_id: String(row.line_account_id),
    status: row.status as MynaVerificationStatus,
    verified_by: String(row.verified_by),
    verified_at: String(row.verified_at),
    reason_code: (row.reason_code as string | null) ?? null,
    source_system: String(row.source_system),
    source_reference: (row.source_reference as string | null) ?? null,
  };
}

async function getHandoff(
  db: D1Database,
  lineAccountId: string,
  handoffId: string,
  friendId?: string,
): Promise<MynaHandoff | null> {
  const suffix = friendId ? ' AND friend_id = ?' : '';
  const values = friendId ? [handoffId, lineAccountId, friendId] : [handoffId, lineAccountId];
  const row = await db.prepare(
    `${HANDOFF_SELECT}
      WHERE id = ? AND line_account_id = ?${suffix}`,
  ).bind(...values).first<Record<string, unknown>>();
  return row ? decodeHandoff(row) : null;
}

async function getHandoffByCorrelation(
  db: D1Database,
  lineAccountId: string,
  friendId: string,
  correlationId: string,
): Promise<MynaHandoff | null> {
  const row = await db.prepare(
    `${HANDOFF_SELECT}
      WHERE line_account_id = ? AND friend_id = ? AND correlation_id = ?`,
  ).bind(lineAccountId, friendId, correlationId).first<Record<string, unknown>>();
  return row ? decodeHandoff(row) : null;
}

async function getExpectation(
  db: D1Database,
  lineAccountId: string,
  handoffId: string,
): Promise<MynaExpectation | null> {
  const row = await db.prepare(
    `SELECT id, handoff_id, line_account_id, friend_id, patient_id, method,
            receipt_status, shadow_submission_id
       FROM pharmacy_prescription_expectations
      WHERE handoff_id = ? AND line_account_id = ?`,
  ).bind(handoffId, lineAccountId).first<Record<string, unknown>>();
  return row ? decodeExpectation(row) : null;
}

async function getLatestVerification(
  db: D1Database,
  lineAccountId: string,
  handoffId: string,
): Promise<MynaVerification | null> {
  const row = await db.prepare(
    `SELECT id, handoff_id, line_account_id, status, verified_by, verified_at,
            reason_code, source_system, source_reference
       FROM pharmacy_myna_verifications
      WHERE handoff_id = ? AND line_account_id = ?
      ORDER BY verified_at DESC, id DESC
      LIMIT 1`,
  ).bind(handoffId, lineAccountId).first<Record<string, unknown>>();
  return row ? decodeVerification(row) : null;
}

async function expireMynaHandoffs(
  db: D1Database,
  lineAccountId: string,
  handoffId?: string,
): Promise<void> {
  const now = new Date().toISOString();
  const idClause = handoffId ? ' AND id = ?' : '';
  const values = handoffId
    ? [now, lineAccountId, handoffId, now]
    : [now, lineAccountId, now];
  await db.prepare(
    `UPDATE pharmacy_myna_handoffs
        SET status = 'EXPIRED', updated_at = ?
      WHERE line_account_id = ?${idClause}
        AND status NOT IN ('CLOSED','EXPIRED') AND expires_at <= ?`,
  ).bind(...values).run();
}

function assertValidHandoffInput(input: CreateMynaHandoffInput): void {
  if (!ID_PATTERN.test(input.lineAccountId) || !ID_PATTERN.test(input.friendId) ||
      (input.patientId !== undefined && !ID_PATTERN.test(input.patientId)) ||
      !CORRELATION_PATTERN.test(input.correlationId) ||
      !Number.isFinite(Date.parse(input.expiresAt)) || Date.parse(input.expiresAt) <= Date.now() ||
      !['E_PRESCRIPTION', 'PAPER', 'MEDICAL_INSTITUTION_SENT'].includes(input.method)) {
    throw new Error('invalid Myna handoff');
  }
}

export async function createMynaHandoff(
  db: D1Database,
  input: CreateMynaHandoffInput,
): Promise<{ handoff: MynaHandoff; expectation: MynaExpectation }> {
  assertValidHandoffInput(input);
  const existing = await getHandoffByCorrelation(
    db, input.lineAccountId, input.friendId, input.correlationId,
  );
  if (existing) {
    const expectation = await getExpectation(db, input.lineAccountId, existing.id);
    if (!expectation) throw new Error('Myna expectation not found');
    return { handoff: existing, expectation };
  }

  if (input.patientId) {
    const patient = await db.prepare(
      `SELECT id FROM pharmacy_patients
        WHERE id = ? AND line_account_id = ? AND owner_friend_id = ? AND archived_at IS NULL`,
    ).bind(input.patientId, input.lineAccountId, input.friendId).first<{ id: string }>();
    if (!patient) throw new Error('patient not found');
  }

  const now = new Date().toISOString();
  const handoffId = crypto.randomUUID();
  const expectationId = crypto.randomUUID();
  const handoffRow: MynaHandoff = {
    id: handoffId,
    line_account_id: input.lineAccountId,
    friend_id: input.friendId,
    patient_id: input.patientId ?? null,
    expectation_id: expectationId,
    method: input.method,
    status: 'CREATED',
    source: input.source,
    correlation_id: input.correlationId,
    launched_at: null,
    patient_reported_at: null,
    expires_at: input.expiresAt,
    closed_at: null,
    created_at: now,
    updated_at: now,
  };
  const expectation: MynaExpectation = {
    id: expectationId,
    handoff_id: handoffId,
    line_account_id: input.lineAccountId,
    friend_id: input.friendId,
    patient_id: input.patientId ?? null,
    method: input.method,
    receipt_status: 'EXPECTED',
    shadow_submission_id: null,
  };
  try {
    await db.batch([
      db.prepare(
        `INSERT INTO pharmacy_myna_handoffs
         (id, line_account_id, friend_id, patient_id, expectation_id, method, status,
          source, correlation_id, expires_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'CREATED', ?, ?, ?, ?, ?)`,
      ).bind(
        handoffId, input.lineAccountId, input.friendId, input.patientId ?? null,
        expectationId, input.method, input.source, input.correlationId, input.expiresAt, now, now,
      ),
      db.prepare(
        `INSERT INTO pharmacy_prescription_expectations
         (id, line_account_id, friend_id, patient_id, handoff_id, method,
          receipt_status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'EXPECTED', ?, ?)`,
      ).bind(
        expectationId, input.lineAccountId, input.friendId, input.patientId ?? null,
        handoffId, input.method, now, now,
      ),
      db.prepare(
        `INSERT INTO pharmacy_myna_events
         (id, handoff_id, line_account_id, event_type, actor_type, actor_id,
          correlation_id, metadata_json, occurred_at)
         VALUES (?, ?, ?, 'PRESCRIPTION_INTENT_CREATED', 'PATIENT_CONTACT', ?, ?, '{}', ?)`,
      ).bind(crypto.randomUUID(), handoffId, input.lineAccountId, input.friendId, input.correlationId, now),
    ]);
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes('UNIQUE')) throw error;
    const raced = await getHandoffByCorrelation(
      db, input.lineAccountId, input.friendId, input.correlationId,
    );
    if (!raced) throw error;
    const racedExpectation = await getExpectation(db, input.lineAccountId, raced.id);
    if (!racedExpectation) throw error;
    return { handoff: raced, expectation: racedExpectation };
  }
  return { handoff: handoffRow, expectation };
}

export async function markMynaLaunchRequested(
  db: D1Database,
  lineAccountId: string,
  friendId: string,
  handoffId: string,
): Promise<MynaHandoff> {
  await expireMynaHandoffs(db, lineAccountId, handoffId);
  const handoff = await getHandoff(db, lineAccountId, handoffId, friendId);
  if (!handoff) throw new Error('Myna handoff not found');
  if (handoff.status === 'LAUNCH_REQUESTED') return handoff;
  if (!canLaunchMynaHandoff(handoff.status, handoff.expires_at)) {
    throw new Error(Date.parse(handoff.expires_at) <= Date.now() ? 'Myna handoff expired' : 'Myna handoff cannot launch');
  }
  const now = new Date().toISOString();
  const result = await db.prepare(
    `UPDATE pharmacy_myna_handoffs
        SET status = 'LAUNCH_REQUESTED', launched_at = COALESCE(launched_at, ?), updated_at = ?
      WHERE id = ? AND line_account_id = ? AND friend_id = ?
        AND status = 'CREATED' AND expires_at > ?`,
  ).bind(now, now, handoffId, lineAccountId, friendId, now).run();
  if ((result.meta?.changes ?? 0) !== 1) throw new Error('Myna handoff launch conflict');
  await db.prepare(
    `INSERT INTO pharmacy_myna_events
     (id, handoff_id, line_account_id, event_type, actor_type, actor_id,
      correlation_id, metadata_json, occurred_at)
     VALUES (?, ?, ?, 'MYNA_EXTERNAL_LAUNCH_REQUESTED', 'PATIENT_CONTACT', ?, ?, '{}', ?)`,
  ).bind(crypto.randomUUID(), handoffId, lineAccountId, friendId, handoff.correlation_id, now).run();
  return { ...handoff, status: 'LAUNCH_REQUESTED', launched_at: handoff.launched_at ?? now, updated_at: now };
}

export async function recordMynaPatientReport(
  db: D1Database,
  lineAccountId: string,
  friendId: string,
  handoffId: string,
  result: MynaPatientReport,
): Promise<MynaHandoff> {
  await expireMynaHandoffs(db, lineAccountId, handoffId);
  const handoff = await getHandoff(db, lineAccountId, handoffId, friendId);
  if (!handoff) throw new Error('Myna handoff not found');
  if (handoff.status === 'CLOSED' || handoff.status === 'EXPIRED') {
    throw new Error('Myna handoff is closed');
  }
  if (Date.parse(handoff.expires_at) <= Date.now()) throw new Error('Myna handoff expired');
  const next = patientReportToStatus(result);
  if (handoff.status === next) return handoff;
  const now = new Date().toISOString();
  const eventType = result === 'COMPLETED'
    ? 'MYNA_PATIENT_REPORTED_COMPLETE'
    : result === 'NO_PRESCRIPTION_FOUND'
      ? 'MYNA_PATIENT_REPORTED_NO_PRESCRIPTION'
      : 'MYNA_SUPPORT_REQUESTED';
  const resultRow = await db.prepare(
    `UPDATE pharmacy_myna_handoffs
        SET status = ?, patient_reported_at = ?, updated_at = ?
      WHERE id = ? AND line_account_id = ? AND friend_id = ?
        AND status NOT IN ('CLOSED','EXPIRED') AND updated_at = ?`,
  ).bind(next, now, now, handoffId, lineAccountId, friendId, handoff.updated_at).run();
  if ((resultRow.meta?.changes ?? 0) !== 1) throw new Error('Myna handoff report conflict');
  await db.prepare(
    `INSERT INTO pharmacy_myna_events
     (id, handoff_id, line_account_id, event_type, actor_type, actor_id,
      correlation_id, metadata_json, occurred_at)
     VALUES (?, ?, ?, ?, 'PATIENT_CONTACT', ?, ?, ?, ?)`,
  ).bind(
    crypto.randomUUID(), handoffId, lineAccountId, eventType, friendId,
    handoff.correlation_id, JSON.stringify({ result }), now,
  ).run();
  return { ...handoff, status: next, patient_reported_at: now, updated_at: now };
}

export async function listMynaHandoffs(
  db: D1Database,
  lineAccountId: string,
  status?: MynaHandoffStatus,
): Promise<MynaHandoff[]> {
  await expireMynaHandoffs(db, lineAccountId);
  const where = status ? ' AND status = ?' : '';
  const values = status ? [lineAccountId, status] : [lineAccountId];
  const rows = await db.prepare(
    `${HANDOFF_SELECT}
      WHERE line_account_id = ?${where}
      ORDER BY created_at DESC, id DESC
      LIMIT 100`,
  ).bind(...values).all<Record<string, unknown>>();
  return rows.results.map(decodeHandoff);
}

export async function getAdminMynaHandoff(
  db: D1Database,
  lineAccountId: string,
  handoffId: string,
): Promise<{ handoff: MynaHandoff; expectation: MynaExpectation | null; verification: MynaVerification | null } | null> {
  await expireMynaHandoffs(db, lineAccountId, handoffId);
  const handoff = await getHandoff(db, lineAccountId, handoffId);
  if (!handoff) return null;
  return {
    handoff,
    expectation: await getExpectation(db, lineAccountId, handoffId),
    verification: await getLatestVerification(db, lineAccountId, handoffId),
  };
}

function receiptStatusForVerification(
  status: MynaVerificationStatus,
): PrescriptionReceiptStatus {
  if (status === 'PRESCRIPTION_EXPIRED') return 'EXPIRED';
  return verificationToReceiptStatus(status);
}

function validateVerificationInput(input: RecordMynaVerificationInput): void {
  if (!ID_PATTERN.test(input.lineAccountId) || !ID_PATTERN.test(input.handoffId) ||
      !ID_PATTERN.test(input.staffId) || !CODE_PATTERN.test(input.sourceSystem) ||
      (input.reasonCode !== undefined && input.reasonCode !== null && !CODE_PATTERN.test(input.reasonCode)) ||
      (input.sourceReference !== undefined && input.sourceReference !== null && !CODE_PATTERN.test(input.sourceReference))) {
    throw new Error('invalid Myna verification');
  }
}

export async function recordMynaVerification(
  db: D1Database,
  input: RecordMynaVerificationInput,
): Promise<MynaVerificationResult> {
  validateVerificationInput(input);
  const handoff = await getHandoff(db, input.lineAccountId, input.handoffId);
  if (!handoff) throw new Error('Myna handoff not found');
  const expectation = await getExpectation(db, input.lineAccountId, input.handoffId);
  if (!expectation) throw new Error('Myna expectation not found');
  if (handoff.method !== expectation.method ||
      (input.status === 'E_PRESCRIPTION_RECEIVED' && handoff.method !== 'E_PRESCRIPTION')) {
    throw new Error('invalid Myna verification');
  }
  if (Date.parse(handoff.expires_at) <= Date.now() && input.status !== 'PRESCRIPTION_EXPIRED') {
    throw new Error('Myna handoff expired');
  }
  if (expectation.receipt_status === 'RECEIVED' && expectation.shadow_submission_id) {
    const verification = await getLatestVerification(db, input.lineAccountId, input.handoffId);
    if (verification?.status === 'E_PRESCRIPTION_RECEIVED') {
      return { verification, receiptStatus: 'RECEIVED', shadowSubmissionId: expectation.shadow_submission_id, handoff };
    }
  }

  const now = new Date().toISOString();
  const verificationId = crypto.randomUUID();
  const shadowSubmissionId = input.status === 'E_PRESCRIPTION_RECEIVED'
    ? (expectation.shadow_submission_id ?? `submission-${input.handoffId}`)
    : null;
  const receiptStatus = receiptStatusForVerification(input.status);
  const nextHandoffStatus = verificationToHandoffStatus(input.status);
  const eventType = input.status === 'E_PRESCRIPTION_RECEIVED'
    ? 'E_PRESCRIPTION_RECEIPT_CONFIRMED'
    : 'PRESCRIPTION_RECEIPT_REJECTED';
  const statements: D1PreparedStatement[] = [
    db.prepare(
      `INSERT INTO pharmacy_myna_verifications
       (id, handoff_id, line_account_id, status, verified_by, verified_at,
        reason_code, note, source_system, source_reference, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
    ).bind(
      verificationId, input.handoffId, input.lineAccountId, input.status, input.staffId, now,
      input.reasonCode ?? null, input.sourceSystem, input.sourceReference ?? null, now,
    ),
  ];
  if (shadowSubmissionId) {
    statements.push(db.prepare(
      `INSERT INTO pharmacy_prescription_submissions
       (id, line_account_id, friend_id, idempotency_key, status, active_revision,
        upload_revision, requested_at, created_at, updated_at, intake_required,
        intake_method, source_handoff_id)
       VALUES (?, ?, ?, ?, 'received', 1, 1, ?, ?, ?, 0, 'E_PRESCRIPTION', ?)
       ON CONFLICT(line_account_id, friend_id, idempotency_key) DO NOTHING`,
    ).bind(
      shadowSubmissionId, input.lineAccountId, handoff.friend_id,
      `myna-${input.handoffId}`, now, now, now, input.handoffId,
    ));
    statements.push(db.prepare(
      `INSERT INTO pharmacy_prescription_events
       (id, submission_id, actor_type, actor_id, event_type, from_status,
        to_status, revision, created_at)
       VALUES (?, ?, 'staff', ?, 'status_changed', 'draft', 'received', 1, ?)
       ON CONFLICT(id) DO NOTHING`,
    ).bind(crypto.randomUUID(), shadowSubmissionId, input.staffId, now));
  }
  statements.push(db.prepare(
    `UPDATE pharmacy_prescription_expectations
        SET receipt_status = ?, shadow_submission_id = COALESCE(shadow_submission_id, ?), updated_at = ?
      WHERE id = ? AND line_account_id = ?`,
  ).bind(receiptStatus, shadowSubmissionId, now, expectation.id, input.lineAccountId));
  statements.push(db.prepare(
    `UPDATE pharmacy_myna_handoffs
        SET status = ?, closed_at = CASE WHEN ? = 'CLOSED' THEN ? ELSE closed_at END, updated_at = ?
      WHERE id = ? AND line_account_id = ?`,
  ).bind(nextHandoffStatus, nextHandoffStatus, now, now, input.handoffId, input.lineAccountId));
  statements.push(db.prepare(
    `INSERT INTO pharmacy_myna_events
     (id, handoff_id, line_account_id, event_type, actor_type, actor_id,
      correlation_id, metadata_json, occurred_at)
     VALUES (?, ?, ?, 'MYNA_VERIFICATION_RECORDED', 'STAFF', ?, ?, ?, ?)`,
  ).bind(
    crypto.randomUUID(), input.handoffId, input.lineAccountId, input.staffId,
    handoff.correlation_id, JSON.stringify({ status: input.status, reasonCode: input.reasonCode ?? null }), now,
  ));
  statements.push(db.prepare(
    `INSERT INTO pharmacy_myna_events
     (id, handoff_id, line_account_id, event_type, actor_type, actor_id,
      correlation_id, metadata_json, occurred_at)
     VALUES (?, ?, ?, ?, 'STAFF', ?, ?, '{}', ?)`,
  ).bind(
    crypto.randomUUID(), input.handoffId, input.lineAccountId, eventType, input.staffId,
    handoff.correlation_id, now,
  ));
  if (input.status === 'E_PRESCRIPTION_RECEIVED') {
    statements.push(db.prepare(
      `INSERT INTO pharmacy_myna_events
       (id, handoff_id, line_account_id, event_type, actor_type, actor_id,
        correlation_id, metadata_json, occurred_at)
       VALUES (?, ?, ?, 'FULFILLMENT_REVIEW_STARTED', 'STAFF', ?, ?, '{}', ?)`,
    ).bind(
      crypto.randomUUID(), input.handoffId, input.lineAccountId, input.staffId,
      handoff.correlation_id, now,
    ));
  }
  await db.batch(statements);

  const verification: MynaVerification = {
    id: verificationId,
    handoff_id: input.handoffId,
    line_account_id: input.lineAccountId,
    status: input.status,
    verified_by: input.staffId,
    verified_at: now,
    reason_code: input.reasonCode ?? null,
    source_system: input.sourceSystem,
    source_reference: input.sourceReference ?? null,
  };
  return {
    verification,
    receiptStatus,
    shadowSubmissionId,
    handoff: {
      ...handoff,
      status: nextHandoffStatus,
      closed_at: nextHandoffStatus === 'CLOSED' ? now : handoff.closed_at,
      updated_at: now,
    },
  };
}
