export type MedicationFollowUpStatus =
  | 'scheduled'
  | 'due'
  | 'delivered'
  | 'no_issue'
  | 'concern'
  | 'pharmacist_requested'
  | 'assigned'
  | 'responded'
  | 'escalated'
  | 'closed'
  | 'cancelled';

export type MedicationFollowUpPatientResponse =
  | 'no_issue'
  | 'concern'
  | 'pharmacist_requested';

export interface MedicationFollowUp {
  id: string;
  line_account_id: string;
  owner_friend_id: string;
  patient_id: string;
  source_submission_id: string;
  status: MedicationFollowUpStatus;
  due_at: string;
  delivered_at: string | null;
  responded_at: string | null;
  assigned_to: string | null;
  closed_at: string | null;
  version: number;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface DueMedicationFollowUp extends MedicationFollowUp {
  tenant_id: string;
  line_user_id: string;
  liff_id: string | null;
}

export interface PatientMedicationFollowUp extends MedicationFollowUp {
  patient_name: string;
}

const SELECT = `
  SELECT id, line_account_id, owner_friend_id, patient_id, source_submission_id,
         status, due_at, delivered_at, responded_at, assigned_to, closed_at,
         version, created_by, created_at, updated_at
    FROM pharmacy_medication_followups`;

const TRANSITIONS: Record<MedicationFollowUpStatus, readonly MedicationFollowUpStatus[]> = {
  scheduled: ['due', 'cancelled'],
  due: ['delivered', 'cancelled'],
  delivered: ['no_issue', 'concern', 'pharmacist_requested', 'cancelled'],
  no_issue: ['closed'],
  concern: ['assigned', 'escalated'],
  pharmacist_requested: ['assigned', 'escalated'],
  assigned: ['responded', 'escalated'],
  responded: ['closed'],
  escalated: ['responded'],
  closed: [],
  cancelled: [],
};

export function isMedicationFollowUpTransitionAllowed(
  fromStatus: MedicationFollowUpStatus,
  toStatus: MedicationFollowUpStatus,
): boolean {
  return TRANSITIONS[fromStatus].includes(toStatus);
}

const RESPONSE_RE = /^pharmacy-followup:([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}):(no_issue|concern|pharmacist_requested)$/i;

function validOpaqueKey(value: string, maxLength = 160): boolean {
  return value.length >= 8 && value.length <= maxLength && /^[A-Za-z0-9._:-]+$/.test(value);
}

async function getFollowUp(
  db: D1Database,
  lineAccountId: string,
  followUpId: string,
): Promise<MedicationFollowUp | null> {
  return db.prepare(`${SELECT} WHERE id = ? AND line_account_id = ?`)
    .bind(followUpId, lineAccountId).first<MedicationFollowUp>();
}

export async function scheduleMedicationFollowUp(
  db: D1Database,
  input: {
    lineAccountId: string;
    submissionId: string;
    dueAt: string;
    staffId: string;
    idempotencyKey: string;
    now?: Date;
  },
): Promise<MedicationFollowUp> {
  if (!input.lineAccountId || !input.submissionId || !input.staffId || !validOpaqueKey(input.idempotencyKey, 128)) {
    throw new Error('invalid medication follow-up request');
  }
  const now = input.now ?? new Date();
  const due = new Date(input.dueAt);
  if (!Number.isFinite(due.getTime()) || due.getTime() <= now.getTime()) {
    throw new Error('medication follow-up due time must be in the future');
  }
  const dueAt = due.toISOString();
  const source = await db.prepare(
    `SELECT pp.patient_id, pp.owner_friend_id
       FROM pharmacy_prescription_patients pp
       INNER JOIN pharmacy_prescription_submissions s
         ON s.id = pp.submission_id AND s.line_account_id = pp.line_account_id
       INNER JOIN pharmacy_patients p
         ON p.id = pp.patient_id AND p.line_account_id = pp.line_account_id
        AND p.owner_friend_id = pp.owner_friend_id
      WHERE pp.submission_id = ? AND pp.line_account_id = ?
        AND s.status = 'closed' AND p.archived_at IS NULL
      LIMIT 1`,
  ).bind(input.submissionId, input.lineAccountId).first<{
    patient_id: string;
    owner_friend_id: string;
  }>();
  if (!source) throw new Error('eligible closed submission not found');

  const existing = await db.prepare(
    `${SELECT} WHERE line_account_id = ? AND source_submission_id = ?`,
  ).bind(input.lineAccountId, input.submissionId).first<MedicationFollowUp>();
  if (existing) {
    if (existing.due_at !== dueAt) throw new Error('medication follow-up already scheduled');
    return existing;
  }

  const id = crypto.randomUUID();
  const eventId = crypto.randomUUID();
  const timestamp = now.toISOString();
  const eventKey = `schedule:${input.idempotencyKey}`;
  await db.batch([
    db.prepare(
      `INSERT OR IGNORE INTO pharmacy_medication_followups
        (id, line_account_id, owner_friend_id, patient_id, source_submission_id,
         status, due_at, created_by, created_at, updated_at)
       SELECT ?, ?, ?, ?, ?, 'scheduled', ?, ?, ?, ?
        WHERE NOT EXISTS (
          SELECT 1 FROM pharmacy_medication_followup_events
           WHERE line_account_id = ? AND idempotency_key = ?
        )`,
    ).bind(
      id, input.lineAccountId, source.owner_friend_id, source.patient_id,
      input.submissionId, dueAt, input.staffId, timestamp, timestamp,
      input.lineAccountId, eventKey,
    ),
    db.prepare(
      `INSERT OR IGNORE INTO pharmacy_medication_followup_events
        (id, followup_id, line_account_id, event_type, to_status, actor_type,
         actor_id, idempotency_key, occurred_at)
       SELECT ?, f.id, f.line_account_id, 'scheduled', 'scheduled', 'staff', ?, ?, ?
         FROM pharmacy_medication_followups f
        WHERE f.line_account_id = ? AND f.source_submission_id = ? AND f.due_at = ?
          AND NOT EXISTS (
            SELECT 1 FROM pharmacy_medication_followup_events e
             WHERE e.followup_id = f.id AND e.line_account_id = f.line_account_id
               AND e.event_type = 'scheduled'
          )`,
    ).bind(
      eventId, input.staffId, eventKey, timestamp,
      input.lineAccountId, input.submissionId, dueAt,
    ),
  ]);
  const saved = await db.prepare(
    `${SELECT} WHERE line_account_id = ? AND source_submission_id = ?`,
  ).bind(input.lineAccountId, input.submissionId).first<MedicationFollowUp>();
  if (!saved || saved.due_at !== dueAt) throw new Error('medication follow-up scheduling conflict');
  return saved;
}

export async function transitionMedicationFollowUp(
  db: D1Database,
  input: {
    lineAccountId: string;
    followUpId: string;
    toStatus: MedicationFollowUpStatus;
    expectedVersion: number;
    actorType: 'patient' | 'staff' | 'system';
    actorId: string;
    idempotencyKey?: string;
    now?: Date;
  },
): Promise<MedicationFollowUp> {
  if (!input.lineAccountId || !input.followUpId || !input.actorId || !Number.isInteger(input.expectedVersion)) {
    throw new Error('invalid medication follow-up transition');
  }
  const current = await getFollowUp(db, input.lineAccountId, input.followUpId);
  if (!current) throw new Error('medication follow-up not found');
  const idempotencyKey = input.idempotencyKey
    ?? `transition:${input.followUpId}:${input.expectedVersion}:${input.toStatus}`;
  if (!validOpaqueKey(idempotencyKey)) throw new Error('invalid medication follow-up transition');
  const replay = await db.prepare(
    `SELECT 1 AS ok FROM pharmacy_medication_followup_events
      WHERE followup_id = ? AND line_account_id = ? AND idempotency_key = ?`,
  ).bind(input.followUpId, input.lineAccountId, idempotencyKey).first<{ ok: number }>();
  if (replay) return current;
  if (current.version !== input.expectedVersion ||
      !isMedicationFollowUpTransitionAllowed(current.status, input.toStatus)) {
    throw new Error(current.version !== input.expectedVersion
      ? 'medication follow-up transition conflict'
      : 'invalid follow-up transition');
  }

  const eventId = crypto.randomUUID();
  const timestamp = (input.now ?? new Date()).toISOString();
  const results = await db.batch([
    db.prepare(
      `INSERT INTO pharmacy_medication_followup_events
        (id, followup_id, line_account_id, event_type, from_status, to_status,
         actor_type, actor_id, idempotency_key, occurred_at)
       SELECT ?, id, line_account_id, ?, status, ?, ?, ?, ?, ?
         FROM pharmacy_medication_followups
        WHERE id = ? AND line_account_id = ? AND status = ? AND version = ?`,
    ).bind(
      eventId, input.toStatus, input.toStatus, input.actorType, input.actorId,
      idempotencyKey, timestamp, input.followUpId, input.lineAccountId,
      current.status, input.expectedVersion,
    ),
    db.prepare(
      `UPDATE pharmacy_medication_followups
          SET status = ?,
              delivered_at = CASE WHEN ? = 'delivered' THEN ? ELSE delivered_at END,
              responded_at = CASE WHEN ? IN ('no_issue','concern','pharmacist_requested')
                                  THEN ? ELSE responded_at END,
              assigned_to = CASE WHEN ? = 'assigned' THEN ? ELSE assigned_to END,
              closed_at = CASE WHEN ? IN ('closed','cancelled') THEN ? ELSE closed_at END,
              version = version + 1,
              updated_at = ?
        WHERE id = ? AND line_account_id = ? AND status = ? AND version = ?
          AND EXISTS (
            SELECT 1 FROM pharmacy_medication_followup_events
             WHERE id = ? AND followup_id = ? AND line_account_id = ?
          )`,
    ).bind(
      input.toStatus,
      input.toStatus, timestamp,
      input.toStatus, timestamp,
      input.toStatus, input.actorId,
      input.toStatus, timestamp,
      timestamp,
      input.followUpId, input.lineAccountId, current.status, input.expectedVersion,
      eventId, input.followUpId, input.lineAccountId,
    ),
  ]);
  if ((results[0]?.meta?.changes ?? 0) !== 1 || (results[1]?.meta?.changes ?? 0) !== 1) {
    throw new Error('medication follow-up transition conflict');
  }
  const saved = await getFollowUp(db, input.lineAccountId, input.followUpId);
  if (!saved) throw new Error('medication follow-up not found');
  return saved;
}

export function parseMedicationFollowUpPostback(
  data: string,
): { followUpId: string; response: MedicationFollowUpPatientResponse } | null {
  const match = RESPONSE_RE.exec(data);
  return match ? {
    followUpId: match[1].toLowerCase(),
    response: match[2].toLowerCase() as MedicationFollowUpPatientResponse,
  } : null;
}

export async function respondToMedicationFollowUp(
  db: D1Database,
  input: {
    lineAccountId: string;
    friendId: string;
    followUpId: string;
    response: MedicationFollowUpPatientResponse;
    expectedVersion?: number;
    idempotencyKey: string;
    now?: Date;
  },
): Promise<MedicationFollowUp> {
  if (!validOpaqueKey(input.idempotencyKey, 160)) throw new Error('follow-up response unavailable');
  const row = await db.prepare(
    `${SELECT} WHERE id = ? AND line_account_id = ? AND owner_friend_id = ?`,
  ).bind(input.followUpId, input.lineAccountId, input.friendId).first<MedicationFollowUp>();
  if (!row) throw new Error('follow-up response unavailable');
  const replay = await db.prepare(
    `SELECT 1 AS ok FROM pharmacy_medication_followup_events
      WHERE followup_id = ? AND line_account_id = ? AND idempotency_key = ?`,
  ).bind(input.followUpId, input.lineAccountId, input.idempotencyKey).first<{ ok: number }>();
  if (replay) return row;
  if (input.expectedVersion !== undefined && row.version !== input.expectedVersion) {
    throw new Error('medication follow-up transition conflict');
  }
  if (row.status !== 'delivered') throw new Error('follow-up response unavailable');
  return transitionMedicationFollowUp(db, {
    lineAccountId: input.lineAccountId,
    followUpId: input.followUpId,
    toStatus: input.response,
    expectedVersion: row.version,
    actorType: 'patient',
    actorId: input.friendId,
    idempotencyKey: input.idempotencyKey,
    now: input.now,
  });
}

export async function recordMedicationFollowUpPatientResponse(
  db: D1Database,
  input: {
    lineAccountId: string;
    friendId: string;
    followUpId: string;
    response: MedicationFollowUpPatientResponse;
    webhookEventId: string;
    now?: Date;
  },
): Promise<MedicationFollowUp> {
  if (!validOpaqueKey(input.webhookEventId, 128)) throw new Error('follow-up response unavailable');
  return respondToMedicationFollowUp(db, {
    lineAccountId: input.lineAccountId,
    friendId: input.friendId,
    followUpId: input.followUpId,
    response: input.response,
    idempotencyKey: `webhook:${input.webhookEventId}`,
    now: input.now,
  });
}

const PATIENT_SELECT = `
  SELECT f.id, f.line_account_id, f.owner_friend_id, f.patient_id,
         f.source_submission_id, f.status, f.due_at, f.delivered_at,
         f.responded_at, f.assigned_to, f.closed_at, f.version,
         f.created_by, f.created_at, f.updated_at, patient.name AS patient_name
    FROM pharmacy_medication_followups f
    INNER JOIN pharmacy_patients patient
      ON patient.id = f.patient_id
     AND patient.line_account_id = f.line_account_id
     AND patient.owner_friend_id = f.owner_friend_id`;

export async function listOwnerMedicationFollowUps(
  db: D1Database,
  lineAccountId: string,
  friendId: string,
): Promise<PatientMedicationFollowUp[]> {
  const result = await db.prepare(
    `${PATIENT_SELECT}
      WHERE f.line_account_id = ? AND f.owner_friend_id = ?
      ORDER BY f.created_at DESC, f.id DESC
      LIMIT 20`,
  ).bind(lineAccountId, friendId).all<PatientMedicationFollowUp>();
  return result.results ?? [];
}

/**
 * Targeted lookup for one owner-scoped follow-up by id. Used to confirm a
 * patient response write instead of re-deriving it from the bounded
 * `listOwnerMedicationFollowUps` (LIMIT 20) listing, which can miss the row
 * once an owner has more than 20 follow-ups on record.
 */
export async function getOwnerMedicationFollowUp(
  db: D1Database,
  lineAccountId: string,
  friendId: string,
  followUpId: string,
): Promise<PatientMedicationFollowUp | null> {
  return db.prepare(
    `${PATIENT_SELECT}
      WHERE f.id = ? AND f.line_account_id = ? AND f.owner_friend_id = ?`,
  ).bind(followUpId, lineAccountId, friendId).first<PatientMedicationFollowUp>();
}

export async function listPatientMedicationFollowUps(
  db: D1Database,
  lineAccountId: string,
  patientId: string,
): Promise<MedicationFollowUp[]> {
  const result = await db.prepare(
    `${SELECT} WHERE line_account_id = ? AND patient_id = ?
      ORDER BY created_at DESC, id DESC`,
  ).bind(lineAccountId, patientId).all<MedicationFollowUp>();
  return result.results ?? [];
}

export async function listDueMedicationFollowUps(
  db: D1Database,
  now = new Date(),
  limit = 50,
): Promise<DueMedicationFollowUp[]> {
  const boundedLimit = Math.min(100, Math.max(1, Math.floor(limit)));
  const result = await db.prepare(
    `SELECT f.id, f.line_account_id, f.owner_friend_id, f.patient_id,
            f.source_submission_id, f.status, f.due_at, f.delivered_at,
            f.responded_at, f.assigned_to, f.closed_at, f.version,
            f.created_by, f.created_at, f.updated_at,
            friend.provider_line_user_id AS line_user_id, mapping.tenant_id AS tenant_id,
            account.liff_id
       FROM pharmacy_medication_followups f
       INNER JOIN friends friend
         ON friend.id = f.owner_friend_id AND friend.line_account_id = f.line_account_id
       INNER JOIN line_accounts account ON account.id = f.line_account_id
       INNER JOIN tenant_line_accounts mapping
         ON mapping.line_account_id = f.line_account_id
       INNER JOIN tenants tenant
         ON tenant.id = mapping.tenant_id AND tenant.status = 'active'
       INNER JOIN pharmacy_account_capabilities capability
         ON capability.line_account_id = f.line_account_id AND capability.mode = 'pharmacy'
        AND EXISTS (
          SELECT 1 FROM json_each(capability.capabilities_json)
           WHERE json_each.value = 'medication_followup'
        )
      WHERE f.status IN ('scheduled','due') AND f.due_at <= ?
        AND friend.is_following = 1 AND account.is_active = 1
      ORDER BY f.due_at, f.id
      LIMIT ?`,
  ).bind(now.toISOString(), boundedLimit).all<DueMedicationFollowUp>();
  return result.results ?? [];
}
