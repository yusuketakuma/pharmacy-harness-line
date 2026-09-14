import { patientAuthorityPredicateFor } from '../intake/repository.js';
import {
  pharmacyHumanStaffPredicate,
  pharmacyStaffAccountPredicate,
} from '../growth-loop/access.js';

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

export type MedicationFollowUpContactChannel = 'line' | 'phone';
export type MedicationFollowUpContactOutcome =
  | 'answered'
  | 'no_answer'
  | 'resolved'
  | 'follow_up_required'
  | 'escalated';

export interface MedicationFollowUp {
  id: string;
  line_account_id: string;
  owner_friend_id: string;
  patient_id: string;
  source_submission_id: string;
  status: MedicationFollowUpStatus;
  due_at: string;
  question_set_version: number;
  response_deadline_at: string | null;
  delivered_at: string | null;
  responded_at: string | null;
  assigned_to: string | null;
  closed_at: string | null;
  version: number;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface MedicationFollowUpContactRecord {
  id: string;
  followup_id: string;
  line_account_id: string;
  channel: MedicationFollowUpContactChannel;
  outcome_code: MedicationFollowUpContactOutcome;
  next_contact_at: string | null;
  actor_staff_id: string;
  idempotency_key: string;
  occurred_at: string;
  created_at: string;
}

export interface MedicationFollowUpContactInput {
  channel: MedicationFollowUpContactChannel;
  outcomeCode: MedicationFollowUpContactOutcome;
  nextContactAt?: string | null;
  idempotencyKey: string;
}

export interface MedicationFollowUpAssignee {
  id: string;
  name: string;
  role: 'owner' | 'admin' | 'staff';
}

export interface DueMedicationFollowUp extends MedicationFollowUp {
  tenant_id: string;
  line_user_id: string;
  liff_id: string | null;
}

export interface PatientMedicationFollowUp extends MedicationFollowUp {
  patient_name: string;
}

type MedicationFollowUpSchema = {
  closureColumns: boolean;
  contactRecords: boolean;
  eventAssigneeColumn: boolean;
};

async function tableColumns(db: D1Database, table: string): Promise<Set<string>> {
  const result = await db.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>();
  return new Set((result.results ?? []).map((column) => column.name));
}

async function medicationFollowUpSchema(db: D1Database): Promise<MedicationFollowUpSchema> {
  let columns: [Set<string>, Set<string>, Set<string>];
  try {
    columns = await Promise.all([
      tableColumns(db, 'pharmacy_medication_followups'),
      tableColumns(db, 'pharmacy_medication_followup_contact_records'),
      tableColumns(db, 'pharmacy_medication_followup_events'),
    ]);
  } catch {
    throw new Error('follow-up schema unavailable');
  }
  const [followUpColumns, contactColumns, eventColumns] = columns;
  return {
    closureColumns: followUpColumns.has('question_set_version') && followUpColumns.has('response_deadline_at'),
    contactRecords: contactColumns.size > 0,
    eventAssigneeColumn: eventColumns.has('assignee_staff_id'),
  };
}

function followUpFields(schema: MedicationFollowUpSchema, alias = ''): string {
  const field = (name: string) => alias ? `${alias}.${name}` : name;
  const closure = schema.closureColumns
    ? `${field('question_set_version')}, ${field('response_deadline_at')}`
    : '1 AS question_set_version, NULL AS response_deadline_at';
  return [
    field('id'), field('line_account_id'), field('owner_friend_id'), field('patient_id'),
    field('source_submission_id'), field('status'), field('due_at'), closure,
    field('delivered_at'), field('responded_at'), field('assigned_to'), field('closed_at'),
    field('version'), field('created_by'), field('created_at'), field('updated_at'),
  ].join(', ');
}

function followUpSelect(schema: MedicationFollowUpSchema, alias = ''): string {
  return `SELECT ${followUpFields(schema, alias)}
    FROM pharmacy_medication_followups${alias ? ` ${alias}` : ''}`;
}

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
const CONTACT_CHANNELS = new Set<MedicationFollowUpContactChannel>(['line', 'phone']);
const CONTACT_OUTCOMES = new Set<MedicationFollowUpContactOutcome>([
  'answered', 'no_answer', 'resolved', 'follow_up_required', 'escalated',
]);

function validOpaqueKey(value: string, maxLength = 160): boolean {
  return value.length >= 8 && value.length <= maxLength && /^[A-Za-z0-9._:-]+$/.test(value);
}

function normalizeContactInput(input: {
  channel: MedicationFollowUpContactChannel;
  outcomeCode: MedicationFollowUpContactOutcome;
  nextContactAt?: string | null;
}): string | null {
  if (!CONTACT_CHANNELS.has(input.channel) || !CONTACT_OUTCOMES.has(input.outcomeCode)) {
    throw new Error('invalid medication follow-up contact');
  }
  if (input.nextContactAt === undefined || input.nextContactAt === null) {
    if (input.outcomeCode === 'follow_up_required') {
      throw new Error('next contact time is required');
    }
    return null;
  }
  const nextContact = new Date(input.nextContactAt);
  if (!Number.isFinite(nextContact.getTime())) throw new Error('invalid medication follow-up contact');
  return nextContact.toISOString();
}

function requireFutureContactAt(nextContactAt: string | null, now: Date): void {
  if (nextContactAt !== null && Date.parse(nextContactAt) <= now.getTime()) {
    throw new Error('next contact time must be in the future');
  }
}

async function staffAccountAuthorityPredicate(db: D1Database, accountColumn: string): Promise<string> {
  return `EXISTS (
    SELECT 1
      FROM tenant_line_accounts AS mapping
      INNER JOIN line_accounts AS account
              ON account.id = mapping.line_account_id AND account.is_active = 1
      INNER JOIN tenants AS tenant
              ON tenant.id = mapping.tenant_id AND tenant.status = 'active'
     WHERE mapping.line_account_id = ${accountColumn}
       AND ${await pharmacyStaffAccountPredicate(db, accountColumn, 'mapping')}
  )`;
}

async function humanStaffAccountPredicate(db: D1Database, accountColumn: string): Promise<string> {
  return `EXISTS (
    SELECT 1
      FROM tenant_line_accounts AS mapping
      INNER JOIN line_accounts AS account
              ON account.id = mapping.line_account_id AND account.is_active = 1
      INNER JOIN tenants AS tenant
              ON tenant.id = mapping.tenant_id AND tenant.status = 'active'
      INNER JOIN tenant_staff_memberships AS membership
              ON membership.tenant_id = mapping.tenant_id AND membership.is_active = 1
      INNER JOIN staff_members AS assignee
              ON assignee.id = membership.staff_id
             AND assignee.is_active = 1
             AND ${await pharmacyHumanStaffPredicate(db, 'assignee')}
      INNER JOIN pharmacy_staff_accounts AS assignment
              ON assignment.line_account_id = ${accountColumn}
             AND assignment.staff_id = assignee.id
             AND assignment.is_active = 1
     WHERE mapping.line_account_id = ${accountColumn}
       AND assignee.id = ?
  )`;
}

function validStaffId(value: string | null | undefined): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128 &&
    /^[A-Za-z0-9._:-]+$/.test(value);
}

function sameContactInput(
  existing: MedicationFollowUpContactRecord,
  input: MedicationFollowUpContactInput,
  nextContactAt: string | null,
  followUpId: string,
): boolean {
  return existing.followup_id === followUpId &&
    existing.channel === input.channel &&
    existing.outcome_code === input.outcomeCode &&
    existing.next_contact_at === nextContactAt;
}

async function getMedicationFollowUpContactByKey(
  db: D1Database,
  lineAccountId: string,
  idempotencyKey: string,
): Promise<MedicationFollowUpContactRecord | null> {
  return db.prepare(
    `SELECT id, followup_id, line_account_id, channel, outcome_code,
            next_contact_at, actor_staff_id, idempotency_key, occurred_at, created_at
       FROM pharmacy_medication_followup_contact_records
      WHERE line_account_id = ? AND idempotency_key = ?
      LIMIT 1`,
  ).bind(lineAccountId, idempotencyKey).first<MedicationFollowUpContactRecord>();
}

async function hasResponseRecord(
  db: D1Database,
  lineAccountId: string,
  followUpId: string,
): Promise<boolean> {
  const row = await db.prepare(
    `SELECT 1 AS ok
       FROM pharmacy_medication_followup_contact_records
      WHERE line_account_id = ? AND followup_id = ?
        AND outcome_code <> 'no_answer'
      LIMIT 1`,
  ).bind(lineAccountId, followUpId).first<{ ok: number }>();
  return Boolean(row);
}

async function hasPatientAuthorityForFollowUp(
  db: D1Database,
  input: { lineAccountId: string; followUpId: string; actorId: string },
  now: string,
): Promise<boolean> {
  const authorityPredicate = await patientAuthorityPredicateFor(db, 'patient');
  const row = await db.prepare(
    `SELECT 1 AS ok
       FROM pharmacy_medication_followups AS followup
       INNER JOIN pharmacy_patients AS patient
         ON patient.id = followup.patient_id
        AND patient.line_account_id = followup.line_account_id
        AND patient.owner_friend_id = followup.owner_friend_id
      WHERE followup.id = ? AND followup.line_account_id = ?
        AND followup.owner_friend_id = ?
        AND patient.archived_at IS NULL
        ${authorityPredicate}`,
  ).bind(
    input.followUpId,
    input.lineAccountId,
    input.actorId,
    input.actorId,
    now,
  ).first<{ ok: number }>();
  return Boolean(row);
}

async function getFollowUp(
  db: D1Database,
  lineAccountId: string,
  followUpId: string,
  schema?: MedicationFollowUpSchema,
): Promise<MedicationFollowUp | null> {
  const resolvedSchema = schema ?? await medicationFollowUpSchema(db);
  return db.prepare(`${followUpSelect(resolvedSchema)} WHERE id = ? AND line_account_id = ?`)
    .bind(followUpId, lineAccountId).first<MedicationFollowUp>();
}

export async function scheduleMedicationFollowUp(
  db: D1Database,
  input: {
    lineAccountId: string;
    submissionId: string;
    dueAt: string;
    responseDeadlineAt?: string | null;
    staffId: string;
    idempotencyKey: string;
    now?: Date;
  },
): Promise<MedicationFollowUp> {
  if (!input.lineAccountId || !input.submissionId || !input.staffId || !validOpaqueKey(input.idempotencyKey, 128)) {
    throw new Error('invalid medication follow-up request');
  }
  const now = input.now ?? new Date();
  const schema = await medicationFollowUpSchema(db);
  const due = new Date(input.dueAt);
  if (!Number.isFinite(due.getTime()) || due.getTime() <= now.getTime()) {
    throw new Error('medication follow-up due time must be in the future');
  }
  const dueAt = due.toISOString();
  let responseDeadlineAt: string | null = null;
  if (input.responseDeadlineAt !== undefined && input.responseDeadlineAt !== null) {
    const deadline = new Date(input.responseDeadlineAt);
    if (!Number.isFinite(deadline.getTime()) || deadline.getTime() <= due.getTime()) {
      throw new Error('medication follow-up response deadline must be after due time');
    }
    responseDeadlineAt = deadline.toISOString();
  }
  if (!schema.closureColumns && responseDeadlineAt !== null) {
    throw new Error('follow-up closure unavailable');
  }
  const staffAuthorityPredicate = await staffAccountAuthorityPredicate(db, '?');
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
    `${followUpSelect(schema)} WHERE line_account_id = ? AND source_submission_id = ?`,
  ).bind(input.lineAccountId, input.submissionId).first<MedicationFollowUp>();
  if (existing) {
    if (existing.due_at !== dueAt || existing.response_deadline_at !== responseDeadlineAt) {
      throw new Error('medication follow-up already scheduled');
    }
    return existing;
  }

  const id = crypto.randomUUID();
  const eventId = crypto.randomUUID();
  const timestamp = now.toISOString();
  const eventKey = `schedule:${input.idempotencyKey}`;
  const followUpInsert = schema.closureColumns
    ? db.prepare(
      `INSERT OR IGNORE INTO pharmacy_medication_followups
        (id, line_account_id, owner_friend_id, patient_id, source_submission_id,
         status, due_at, question_set_version, response_deadline_at,
         created_by, created_at, updated_at)
       SELECT ?, ?, ?, ?, ?, 'scheduled', ?, 1, ?, ?, ?, ?
        WHERE EXISTS (
          SELECT 1 FROM pharmacy_account_capabilities AS capability
           WHERE capability.line_account_id = ? AND capability.mode = 'pharmacy'
           AND EXISTS (SELECT 1 FROM json_each(capability.capabilities_json)
                          WHERE value = 'medication_followup')
        )
          AND ${staffAuthorityPredicate}
          AND NOT EXISTS (
          SELECT 1 FROM pharmacy_medication_followup_events
           WHERE line_account_id = ? AND idempotency_key = ?
        )`,
    ).bind(
      id, input.lineAccountId, source.owner_friend_id, source.patient_id,
      input.submissionId, dueAt, responseDeadlineAt, input.staffId, timestamp, timestamp,
      input.lineAccountId,
      input.lineAccountId, input.lineAccountId, input.staffId,
      input.lineAccountId, eventKey,
    )
    : db.prepare(
      `INSERT OR IGNORE INTO pharmacy_medication_followups
        (id, line_account_id, owner_friend_id, patient_id, source_submission_id,
         status, due_at, created_by, created_at, updated_at)
       SELECT ?, ?, ?, ?, ?, 'scheduled', ?, ?, ?, ?
        WHERE EXISTS (
          SELECT 1 FROM pharmacy_account_capabilities AS capability
           WHERE capability.line_account_id = ? AND capability.mode = 'pharmacy'
           AND EXISTS (SELECT 1 FROM json_each(capability.capabilities_json)
                          WHERE value = 'medication_followup')
        )
          AND ${staffAuthorityPredicate}
          AND NOT EXISTS (
          SELECT 1 FROM pharmacy_medication_followup_events
           WHERE line_account_id = ? AND idempotency_key = ?
        )`,
    ).bind(
      id, input.lineAccountId, source.owner_friend_id, source.patient_id,
      input.submissionId, dueAt, input.staffId, timestamp, timestamp,
      input.lineAccountId,
      input.lineAccountId, input.lineAccountId, input.staffId,
      input.lineAccountId, eventKey,
    );
  await db.batch([
    followUpInsert,
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
    `${followUpSelect(schema)} WHERE line_account_id = ? AND source_submission_id = ?`,
  ).bind(input.lineAccountId, input.submissionId).first<MedicationFollowUp>();
  if (!saved || saved.due_at !== dueAt || saved.response_deadline_at !== responseDeadlineAt) {
    throw new Error('medication follow-up scheduling conflict');
  }
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
    assigneeStaffId?: string | null;
    contact?: MedicationFollowUpContactInput;
    now?: Date;
  },
): Promise<MedicationFollowUp> {
  if (!input.lineAccountId || !input.followUpId || !input.actorId || !Number.isInteger(input.expectedVersion)) {
    throw new Error('invalid medication follow-up transition');
  }
  const schema = await medicationFollowUpSchema(db);
  const current = await getFollowUp(db, input.lineAccountId, input.followUpId, schema);
  if (!current) throw new Error('medication follow-up not found');
  const now = input.now ?? new Date();
  const timestamp = now.toISOString();
  if (input.assigneeStaffId !== undefined && input.assigneeStaffId !== null &&
      !validStaffId(input.assigneeStaffId)) {
    throw new Error('invalid assigned staff');
  }
  if (input.toStatus !== 'assigned' && input.assigneeStaffId !== undefined) {
    throw new Error('invalid assigned staff');
  }
  const idempotencyKey = input.idempotencyKey
    ?? `transition:${input.followUpId}:${input.expectedVersion}:${input.toStatus}`;
  if (!validOpaqueKey(idempotencyKey)) throw new Error('invalid medication follow-up transition');
  if (input.actorType === 'patient' &&
      !(await hasPatientAuthorityForFollowUp(db, {
        lineAccountId: input.lineAccountId,
        followUpId: input.followUpId,
        actorId: input.actorId,
      }, timestamp))) {
    throw new Error('medication follow-up transition conflict');
  }
  if (input.contact && !schema.contactRecords) {
    throw new Error('follow-up closure unavailable');
  }
  if (!schema.contactRecords &&
      (input.toStatus === 'responded' || (input.toStatus === 'closed' && current.status === 'responded'))) {
    throw new Error('follow-up closure unavailable');
  }
  const eventAssigneeColumn = (input.toStatus === 'assigned' || input.assigneeStaffId !== undefined) &&
    schema.eventAssigneeColumn;
  const replay = await db.prepare(
    `SELECT 1 AS ok${eventAssigneeColumn ? ', assignee_staff_id' : ', NULL AS assignee_staff_id'}
       FROM pharmacy_medication_followup_events
      WHERE followup_id = ? AND line_account_id = ? AND idempotency_key = ?`,
  ).bind(input.followUpId, input.lineAccountId, idempotencyKey).first<{
    ok: number;
    assignee_staff_id: string | null;
  }>();
  if (replay) {
    if (eventAssigneeColumn && input.toStatus === 'assigned' &&
        replay.assignee_staff_id !== (input.assigneeStaffId ?? null)) {
      throw new Error('medication follow-up transition conflict');
    }
    return current;
  }
  if (current.version !== input.expectedVersion ||
      !isMedicationFollowUpTransitionAllowed(current.status, input.toStatus)) {
    throw new Error(current.version !== input.expectedVersion
      ? 'medication follow-up transition conflict'
      : 'invalid follow-up transition');
  }
  if (input.toStatus === 'assigned' && !validStaffId(input.assigneeStaffId)) {
    // ponytail: preserve the pre-V036 omitted-assignee payload; new clients must send a human staff ID.
    if (input.assigneeStaffId !== undefined) throw new Error('assigned staff is required');
  }

  const patientAuthorityPredicate = await patientAuthorityPredicateFor(db, 'patient');
  const requiresHumanAssignee = input.toStatus === 'assigned' && input.assigneeStaffId !== undefined;
  const staffAuthorityPredicate = await staffAccountAuthorityPredicate(db, 'followup.line_account_id');
  const humanAssigneePredicate = await humanStaffAccountPredicate(db, 'followup.line_account_id');

  let contact: MedicationFollowUpContactRecord | null = null;
  let nextContactAt: string | null = null;
  if (input.contact) {
    if (input.actorType !== 'staff' || !validOpaqueKey(input.contact.idempotencyKey)) {
      throw new Error('invalid medication follow-up contact');
    }
    nextContactAt = normalizeContactInput(input.contact);
    contact = await getMedicationFollowUpContactByKey(
      db, input.lineAccountId, input.contact.idempotencyKey,
    );
    if (contact && !sameContactInput(contact, input.contact, nextContactAt, input.followUpId)) {
      throw new Error('medication follow-up contact conflict');
    }
    if (!contact) requireFutureContactAt(nextContactAt, now);
  }
  const requiresResponseRecord = input.toStatus === 'responded' ||
    (input.toStatus === 'closed' && current.status === 'responded');
  const hasExistingResponse = contact
    ? contact.outcome_code !== 'no_answer'
    : schema.contactRecords && requiresResponseRecord
      ? await hasResponseRecord(db, input.lineAccountId, input.followUpId)
      : false;
  const createsResponseRecord = Boolean(
    schema.contactRecords && input.contact && !contact && input.contact.outcomeCode !== 'no_answer',
  );
  if (schema.contactRecords && requiresResponseRecord && !hasExistingResponse && !createsResponseRecord) {
    throw new Error('follow-up response record required');
  }

  const responseRecordGuard = schema.contactRecords ? `
          AND (
            ? NOT IN ('responded', 'closed')
            OR (? = 'closed' AND followup.status <> 'responded')
            OR EXISTS (
              SELECT 1 FROM pharmacy_medication_followup_contact_records AS contact
               WHERE contact.line_account_id = followup.line_account_id
                 AND contact.followup_id = followup.id
                 AND contact.outcome_code <> 'no_answer'
            )
          )` : '';

  const eventId = crypto.randomUUID();
  const eventStatement = db.prepare(
    `INSERT INTO pharmacy_medication_followup_events
      (${eventAssigneeColumn
        ? 'id, followup_id, line_account_id, event_type, from_status, to_status, actor_type, actor_id, idempotency_key, occurred_at, assignee_staff_id'
        : 'id, followup_id, line_account_id, event_type, from_status, to_status, actor_type, actor_id, idempotency_key, occurred_at'})
     SELECT ?, followup.id, followup.line_account_id, ?, followup.status, ?, ?, ?, ?, ?
       ${eventAssigneeColumn ? ', ?' : ''}
         FROM pharmacy_medication_followups AS followup
         INNER JOIN pharmacy_patients AS patient
           ON patient.id = followup.patient_id
          AND patient.line_account_id = followup.line_account_id
          AND patient.owner_friend_id = followup.owner_friend_id
        WHERE followup.id = ? AND followup.line_account_id = ?
          AND followup.status = ? AND followup.version = ?
          AND (
            ? <> 'patient'
            OR (
              patient.owner_friend_id = ?
              AND patient.archived_at IS NULL
              ${patientAuthorityPredicate}
            )
          )
          AND (
            ? <> 'staff'
            OR ${staffAuthorityPredicate}
          )
          ${responseRecordGuard}
          AND (
            ? = 0
            OR ${humanAssigneePredicate}
          )`,
  ).bind(
    eventId, input.toStatus, input.toStatus, input.actorType, input.actorId,
    idempotencyKey, timestamp,
    ...(eventAssigneeColumn ? [input.assigneeStaffId ?? null] : []),
    input.followUpId, input.lineAccountId, current.status, input.expectedVersion,
    input.actorType, input.actorId, input.actorId, timestamp,
    input.actorType, input.actorId,
    ...(schema.contactRecords ? [input.toStatus, input.toStatus] : []),
    requiresHumanAssignee ? 1 : 0, input.assigneeStaffId ?? input.actorId,
  );
  const contactStatement = schema.contactRecords && input.contact && !contact
    ? db.prepare(
      `INSERT OR IGNORE INTO pharmacy_medication_followup_contact_records
        (id, followup_id, line_account_id, channel, outcome_code, next_contact_at,
         actor_staff_id, idempotency_key, occurred_at, created_at)
       SELECT ?, followup.id, followup.line_account_id, ?, ?, ?, ?, ?, ?, ?
         FROM pharmacy_medication_followups AS followup
        WHERE followup.id = ? AND followup.line_account_id = ?
          AND followup.status = ? AND followup.version = ?
          AND ${staffAuthorityPredicate}
          AND (
            ? = 0
            OR ${humanAssigneePredicate}
          )`,
    ).bind(
      crypto.randomUUID(), input.contact.channel, input.contact.outcomeCode, nextContactAt,
      input.actorId, input.contact.idempotencyKey, timestamp, timestamp,
      input.followUpId, input.lineAccountId, current.status, input.expectedVersion,
      input.actorId,
      requiresHumanAssignee ? 1 : 0, input.assigneeStaffId ?? input.actorId,
    )
    : null;
  const results = await db.batch([
    ...(contactStatement ? [contactStatement] : []),
    eventStatement,
    db.prepare(
      `UPDATE pharmacy_medication_followups AS followup
          SET status = ?,
              delivered_at = CASE WHEN ? = 'delivered' THEN ? ELSE delivered_at END,
              responded_at = CASE WHEN ? IN ('no_issue','concern','pharmacist_requested')
                                  THEN ? ELSE responded_at END,
              assigned_to = CASE WHEN ? = 'assigned' THEN ? ELSE assigned_to END,
              closed_at = CASE WHEN ? IN ('closed','cancelled') THEN ? ELSE closed_at END,
              version = version + 1,
              updated_at = ?
        WHERE followup.id = ? AND followup.line_account_id = ?
          AND followup.status = ? AND followup.version = ?
          AND EXISTS (
            SELECT 1 FROM pharmacy_medication_followup_events
             WHERE id = ? AND followup_id = ? AND line_account_id = ?
          )
          AND (
            ? <> 'patient'
            OR EXISTS (
              SELECT 1 FROM pharmacy_patients AS patient
               WHERE patient.id = followup.patient_id
                 AND patient.line_account_id = followup.line_account_id
                 AND patient.owner_friend_id = followup.owner_friend_id
                 AND patient.owner_friend_id = ?
                 AND patient.archived_at IS NULL
                 ${patientAuthorityPredicate}
            )
          )
          AND (
            ? <> 'staff'
            OR ${staffAuthorityPredicate}
          )
          ${responseRecordGuard}
          AND (
            ? = 0
            OR ${humanAssigneePredicate}
          )`,
    ).bind(
      input.toStatus,
      input.toStatus, timestamp,
      input.toStatus, timestamp,
      input.toStatus, input.assigneeStaffId ?? null,
      input.toStatus, timestamp,
      timestamp,
      input.followUpId, input.lineAccountId, current.status, input.expectedVersion,
      eventId, input.followUpId, input.lineAccountId,
      input.actorType, input.actorId, input.actorId, timestamp,
      input.actorType, input.actorId,
      ...(schema.contactRecords ? [input.toStatus, input.toStatus] : []),
      requiresHumanAssignee ? 1 : 0, input.assigneeStaffId ?? input.actorId,
    ),
  ]);
  const eventIndex = contactStatement ? 1 : 0;
  const updateIndex = eventIndex + 1;
  if ((results[eventIndex]?.meta?.changes ?? 0) !== 1 ||
      (results[updateIndex]?.meta?.changes ?? 0) !== 1) {
    throw new Error('medication follow-up transition conflict');
  }
  const saved = await getFollowUp(db, input.lineAccountId, input.followUpId);
  if (!saved) throw new Error('medication follow-up not found');
  return saved;
}

export async function recordMedicationFollowUpContact(
  db: D1Database,
  input: {
    lineAccountId: string;
    followUpId: string;
    channel: MedicationFollowUpContactChannel;
    outcomeCode: MedicationFollowUpContactOutcome;
    nextContactAt?: string | null;
    actorStaffId: string;
    idempotencyKey: string;
    expectedVersion?: number;
    now?: Date;
  },
): Promise<MedicationFollowUpContactRecord> {
  if (!input.lineAccountId || !input.followUpId || !input.actorStaffId ||
      !validOpaqueKey(input.idempotencyKey) ||
      (input.expectedVersion !== undefined && !Number.isInteger(input.expectedVersion))) {
    throw new Error('invalid medication follow-up contact');
  }
  const schema = await medicationFollowUpSchema(db);
  if (!schema.contactRecords) throw new Error('follow-up closure unavailable');
  const now = input.now ?? new Date();
  const nextContactAt = normalizeContactInput(input);
  const contactInput: MedicationFollowUpContactInput = {
    channel: input.channel,
    outcomeCode: input.outcomeCode,
    nextContactAt: input.nextContactAt,
    idempotencyKey: input.idempotencyKey,
  };
  const existing = await getMedicationFollowUpContactByKey(
    db, input.lineAccountId, input.idempotencyKey,
  );
  if (existing) {
    if (!sameContactInput(existing, contactInput, nextContactAt, input.followUpId)) {
      throw new Error('medication follow-up contact conflict');
    }
    return existing;
  }
  requireFutureContactAt(nextContactAt, now);

  const versionPredicate = input.expectedVersion === undefined
    ? ''
    : ' AND followup.version = ?';
  const timestamp = now.toISOString();
  const staffAuthorityPredicate = await staffAccountAuthorityPredicate(db, 'followup.line_account_id');
  const result = await db.prepare(
    `INSERT OR IGNORE INTO pharmacy_medication_followup_contact_records
      (id, followup_id, line_account_id, channel, outcome_code, next_contact_at,
       actor_staff_id, idempotency_key, occurred_at, created_at)
     SELECT ?, followup.id, followup.line_account_id, ?, ?, ?, ?, ?, ?, ?
       FROM pharmacy_medication_followups AS followup
      WHERE followup.id = ? AND followup.line_account_id = ?
        AND followup.status NOT IN ('closed', 'cancelled')
        ${versionPredicate}
        AND ${staffAuthorityPredicate}`,
  ).bind(
    crypto.randomUUID(), input.channel, input.outcomeCode, nextContactAt,
    input.actorStaffId, input.idempotencyKey, timestamp, timestamp,
    input.followUpId, input.lineAccountId,
    ...(input.expectedVersion === undefined ? [] : [input.expectedVersion]),
    input.actorStaffId,
  ).run();
  if ((result.meta?.changes ?? 0) !== 1) {
    const raced = await getMedicationFollowUpContactByKey(
      db, input.lineAccountId, input.idempotencyKey,
    );
    if (raced) {
      if (!sameContactInput(raced, contactInput, nextContactAt, input.followUpId)) {
        throw new Error('medication follow-up contact conflict');
      }
      return raced;
    }
    if (!(await getFollowUp(db, input.lineAccountId, input.followUpId))) {
      throw new Error('medication follow-up not found');
    }
    throw new Error('medication follow-up contact conflict');
  }
  const saved = await getMedicationFollowUpContactByKey(
    db, input.lineAccountId, input.idempotencyKey,
  );
  if (!saved) throw new Error('medication follow-up contact conflict');
  return saved;
}

export async function listMedicationFollowUpContacts(
  db: D1Database,
  lineAccountId: string,
  followUpId: string,
): Promise<MedicationFollowUpContactRecord[]> {
  const schema = await medicationFollowUpSchema(db);
  if (!schema.contactRecords) throw new Error('follow-up closure unavailable');
  const result = await db.prepare(
    `SELECT id, followup_id, line_account_id, channel, outcome_code,
            next_contact_at, actor_staff_id, idempotency_key, occurred_at, created_at
       FROM pharmacy_medication_followup_contact_records
      WHERE line_account_id = ? AND followup_id = ?
      ORDER BY occurred_at DESC, id DESC
      LIMIT 100`,
  ).bind(lineAccountId, followUpId).all<MedicationFollowUpContactRecord>();
  return result.results ?? [];
}

export async function listMedicationFollowUpAssignees(
  db: D1Database,
  lineAccountId: string,
): Promise<MedicationFollowUpAssignee[]> {
  const humanStaffPredicate = await pharmacyHumanStaffPredicate(db, 'staff');
  const result = await db.prepare(
    `SELECT DISTINCT staff.id, staff.name, membership.role
       FROM tenant_line_accounts AS mapping
       INNER JOIN line_accounts AS account
               ON account.id = mapping.line_account_id AND account.is_active = 1
       INNER JOIN tenants AS tenant
               ON tenant.id = mapping.tenant_id AND tenant.status = 'active'
       INNER JOIN tenant_staff_memberships AS membership
               ON membership.tenant_id = mapping.tenant_id AND membership.is_active = 1
       INNER JOIN staff_members AS staff
              ON staff.id = membership.staff_id
             AND staff.is_active = 1
              AND ${humanStaffPredicate}
       INNER JOIN pharmacy_staff_accounts AS assignment
               ON assignment.line_account_id = mapping.line_account_id
              AND assignment.staff_id = staff.id
              AND assignment.is_active = 1
      WHERE mapping.line_account_id = ?
      ORDER BY staff.name COLLATE NOCASE, staff.id`,
  ).bind(lineAccountId).all<MedicationFollowUpAssignee>();
  return result.results ?? [];
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
  const now = input.now ?? new Date();
  const schema = await medicationFollowUpSchema(db);
  const patientAuthorityPredicate = await patientAuthorityPredicateFor(db, 'patient');
  const row = await db.prepare(
    `SELECT ${followUpFields(schema, 'followup')}
       FROM pharmacy_medication_followups AS followup
       INNER JOIN pharmacy_patients AS patient
         ON patient.id = followup.patient_id
        AND patient.line_account_id = followup.line_account_id
        AND patient.owner_friend_id = followup.owner_friend_id
      WHERE followup.id = ? AND followup.line_account_id = ? AND followup.owner_friend_id = ?
        AND patient.archived_at IS NULL
        ${patientAuthorityPredicate}`,
  ).bind(
    input.followUpId, input.lineAccountId, input.friendId, input.friendId, now.toISOString(),
  ).first<MedicationFollowUp>();
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
    now,
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

function patientFollowUpSelect(schema: MedicationFollowUpSchema): string {
  return `
  SELECT ${followUpFields(schema, 'f')}, patient.name AS patient_name
    FROM pharmacy_medication_followups f
    INNER JOIN pharmacy_patients patient
      ON patient.id = f.patient_id
     AND patient.line_account_id = f.line_account_id
     AND patient.owner_friend_id = f.owner_friend_id`;
}

export async function listOwnerMedicationFollowUps(
  db: D1Database,
  lineAccountId: string,
  friendId: string,
): Promise<PatientMedicationFollowUp[]> {
  const schema = await medicationFollowUpSchema(db);
  const patientAuthorityPredicate = await patientAuthorityPredicateFor(db, 'patient');
  const result = await db.prepare(
    `${patientFollowUpSelect(schema)}
      WHERE f.line_account_id = ? AND f.owner_friend_id = ?
        AND patient.archived_at IS NULL
      ${patientAuthorityPredicate}
      ORDER BY f.created_at DESC, f.id DESC
      LIMIT 20`,
  ).bind(
    lineAccountId,
    friendId,
    friendId,
    new Date().toISOString(),
  ).all<PatientMedicationFollowUp>();
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
  const schema = await medicationFollowUpSchema(db);
  const patientAuthorityPredicate = await patientAuthorityPredicateFor(db, 'patient');
  return db.prepare(
    `${patientFollowUpSelect(schema)}
      WHERE f.id = ? AND f.line_account_id = ? AND f.owner_friend_id = ?
        AND patient.archived_at IS NULL
      ${patientAuthorityPredicate}`,
  ).bind(
    followUpId,
    lineAccountId,
    friendId,
    friendId,
    new Date().toISOString(),
  ).first<PatientMedicationFollowUp>();
}

export async function listPatientMedicationFollowUps(
  db: D1Database,
  lineAccountId: string,
  patientId: string,
): Promise<MedicationFollowUp[]> {
  const schema = await medicationFollowUpSchema(db);
  const result = await db.prepare(
    `${followUpSelect(schema)} WHERE line_account_id = ? AND patient_id = ?
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
  const schema = await medicationFollowUpSchema(db);
  const result = await db.prepare(
    `SELECT ${followUpFields(schema, 'f')},
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
