import type { PrescriptionPatient } from '../prescriptions/patient.js';

export type PharmacyPatientOwner = PrescriptionPatient;
export type PatientRelationship = 'self' | 'child' | 'spouse' | 'parent' | 'other';
export type PatientSex = 'male' | 'female' | 'other' | 'prefer_not_to_say';

export interface PharmacyPatient {
  id: string;
  line_account_id: string;
  owner_friend_id: string;
  relationship: PatientRelationship;
  name: string;
  name_kana: string;
  birth_date: string;
  sex: PatientSex | null;
  contact_phone: string | null;
  archived_at: string | null;
  created_at?: string;
  updated_at?: string;
}

export interface CreatePharmacyPatientInput {
  relationship: PatientRelationship;
  name: string;
  nameKana: string;
  birthDate: string;
  sex: PatientSex | null;
  contactPhone: string | null;
}

export interface PatientIntakeAnswers {
  allergiesStatus: 'none' | 'yes' | 'unknown';
  allergiesDetail?: string;
  adverseReactionStatus: 'none' | 'yes' | 'unknown';
  adverseReactionDetail?: string;
  medicationSummary?: string;
  medicalHistory?: string;
  pregnancyStatus?: 'not_applicable' | 'yes' | 'no' | 'unknown';
  breastfeedingStatus?: 'not_applicable' | 'yes' | 'no' | 'unknown';
  notes?: string;
}

export interface CreatePatientIntakeInput {
  idempotencyKey: string;
  answers: PatientIntakeAnswers;
  representativeConsent: boolean;
  privacyConsent: boolean;
}

export interface PharmacyPatientIntakeResponse {
  id: string;
  line_account_id: string;
  owner_friend_id: string;
  patient_id: string;
  revision: number;
  schema_version: number;
  patient_snapshot_json: string;
  answers_json: string;
  base_response_id: string | null;
  idempotency_key: string;
  representative_consent_at: string;
  privacy_consent_at: string;
  created_at: string;
}

const RELATIONSHIPS = new Set<PatientRelationship>([
  'self', 'child', 'spouse', 'parent', 'other',
]);
const SEXES = new Set<PatientSex>([
  'male', 'female', 'other', 'prefer_not_to_say',
]);
const ANSWER_KEYS = new Set([
  'allergiesStatus', 'allergiesDetail', 'adverseReactionStatus',
  'adverseReactionDetail', 'medicationSummary', 'medicalHistory',
  'pregnancyStatus', 'breastfeedingStatus', 'notes',
]);
const STATUS_VALUES = new Set(['none', 'yes', 'unknown']);
const PREGNANCY_VALUES = new Set(['not_applicable', 'yes', 'no', 'unknown']);

function boundedText(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.trim().length <= max;
}

function isValidDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

function validatePatientInput(input: CreatePharmacyPatientInput): void {
  if (
    !RELATIONSHIPS.has(input.relationship) ||
    !boundedText(input.name, 120) || input.name.trim().length === 0 ||
    !boundedText(input.nameKana, 120) || input.nameKana.trim().length === 0 ||
    !isValidDate(input.birthDate) ||
    (input.sex !== null && !SEXES.has(input.sex)) ||
    (input.contactPhone !== null && !boundedText(input.contactPhone, 40))
  ) {
    throw new Error('invalid patient profile');
  }
}

function validateIntakeInput(input: CreatePatientIntakeInput): void {
  if (!/^[A-Za-z0-9._:-]{8,128}$/.test(input.idempotencyKey)) {
    throw new Error('invalid intake idempotency key');
  }
  if (!input.representativeConsent || !input.privacyConsent) {
    throw new Error('intake consent required');
  }
  if (!input.answers || typeof input.answers !== 'object') {
    throw new Error('invalid intake answers');
  }
  const answerRecord = input.answers as unknown as Record<string, unknown>;
  if (Object.keys(answerRecord).some((key) => !ANSWER_KEYS.has(key))) {
    throw new Error('invalid intake answers');
  }
  if (!STATUS_VALUES.has(answerRecord.allergiesStatus as string) ||
      !STATUS_VALUES.has(answerRecord.adverseReactionStatus as string)) {
    throw new Error('invalid intake answers');
  }
  for (const key of [
    'allergiesDetail', 'adverseReactionDetail', 'medicationSummary',
    'medicalHistory', 'notes',
  ]) {
    if (answerRecord[key] !== undefined && !boundedText(answerRecord[key], 2000)) {
      throw new Error('invalid intake answers');
    }
  }
  for (const key of ['pregnancyStatus', 'breastfeedingStatus']) {
    if (
      answerRecord[key] !== undefined &&
      !PREGNANCY_VALUES.has(answerRecord[key] as string)
    ) {
      throw new Error('invalid intake answers');
    }
  }
}

export async function createPharmacyPatient(
  db: D1Database,
  owner: PharmacyPatientOwner,
  input: CreatePharmacyPatientInput,
): Promise<PharmacyPatient> {
  validatePatientInput(input);
  const now = new Date().toISOString();
  const patient: PharmacyPatient = {
    id: crypto.randomUUID(),
    line_account_id: owner.lineAccountId,
    owner_friend_id: owner.friendId,
    relationship: input.relationship,
    name: input.name.trim(),
    name_kana: input.nameKana.trim(),
    birth_date: input.birthDate,
    sex: input.sex,
    contact_phone: input.contactPhone?.trim() || null,
    archived_at: null,
    created_at: now,
    updated_at: now,
  };
  await db.prepare(
    `INSERT INTO pharmacy_patients
       (id, line_account_id, owner_friend_id, relationship, name, name_kana,
        birth_date, sex, contact_phone, archived_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
  ).bind(
    patient.id,
    patient.line_account_id,
    patient.owner_friend_id,
    patient.relationship,
    patient.name,
    patient.name_kana,
    patient.birth_date,
    patient.sex,
    patient.contact_phone,
    now,
    now,
  ).run();
  return patient;
}

export async function listPharmacyPatients(
  db: D1Database,
  owner: PharmacyPatientOwner,
  includeArchived = false,
): Promise<PharmacyPatient[]> {
  const archivedClause = includeArchived ? '' : ' AND archived_at IS NULL';
  const result = await db.prepare(
    `SELECT id, line_account_id, owner_friend_id, relationship, name, name_kana,
            birth_date, sex, contact_phone, archived_at, created_at, updated_at
       FROM pharmacy_patients
      WHERE line_account_id = ? AND owner_friend_id = ?${archivedClause}
      ORDER BY CASE relationship WHEN 'self' THEN 0 ELSE 1 END,
               updated_at DESC, id DESC`,
  ).bind(owner.lineAccountId, owner.friendId).all<PharmacyPatient>();
  return result.results;
}

export async function listAdminPharmacyPatients(
  db: D1Database,
  lineAccountId: string,
  includeArchived = true,
): Promise<PharmacyPatient[]> {
  const archivedClause = includeArchived ? '' : ' AND archived_at IS NULL';
  const result = await db.prepare(
    `SELECT id, line_account_id, owner_friend_id, relationship, name, name_kana,
            birth_date, sex, contact_phone, archived_at, created_at, updated_at
       FROM pharmacy_patients
      WHERE line_account_id = ?${archivedClause}
      ORDER BY updated_at DESC, id DESC`,
  ).bind(lineAccountId).all<PharmacyPatient>();
  return result.results;
}

export async function getPharmacyPatient(
  db: D1Database,
  owner: PharmacyPatientOwner,
  patientId: string,
): Promise<PharmacyPatient | null> {
  return db.prepare(
    `SELECT id, line_account_id, owner_friend_id, relationship, name, name_kana,
            birth_date, sex, contact_phone, archived_at, created_at, updated_at
       FROM pharmacy_patients
      WHERE id = ? AND line_account_id = ? AND owner_friend_id = ?`,
  ).bind(patientId, owner.lineAccountId, owner.friendId).first<PharmacyPatient>();
}

export async function getAdminPharmacyPatient(
  db: D1Database,
  lineAccountId: string,
  patientId: string,
): Promise<PharmacyPatient | null> {
  return db.prepare(
    `SELECT id, line_account_id, owner_friend_id, relationship, name, name_kana,
            birth_date, sex, contact_phone, archived_at, created_at, updated_at
       FROM pharmacy_patients
      WHERE id = ? AND line_account_id = ?`,
  ).bind(patientId, lineAccountId).first<PharmacyPatient>();
}

export async function updatePharmacyPatient(
  db: D1Database,
  owner: PharmacyPatientOwner,
  patientId: string,
  expectedUpdatedAt: string,
  input: CreatePharmacyPatientInput,
): Promise<void> {
  validatePatientInput(input);
  const now = new Date().toISOString();
  const result = await db.prepare(
    `UPDATE pharmacy_patients
        SET relationship = ?, name = ?, name_kana = ?, birth_date = ?,
            sex = ?, contact_phone = ?, updated_at = ?
      WHERE id = ? AND line_account_id = ? AND owner_friend_id = ?
        AND archived_at IS NULL AND updated_at = ?`,
  ).bind(
    input.relationship, input.name.trim(), input.nameKana.trim(), input.birthDate,
    input.sex, input.contactPhone?.trim() || null, now,
    patientId, owner.lineAccountId, owner.friendId, expectedUpdatedAt,
  ).run();
  if ((result.meta?.changes ?? 0) !== 1) throw new Error('patient update conflict');
}

export async function archivePharmacyPatient(
  db: D1Database,
  owner: PharmacyPatientOwner,
  patientId: string,
  expectedUpdatedAt: string,
): Promise<void> {
  const result = await db.prepare(
    `UPDATE pharmacy_patients
        SET archived_at = ?, updated_at = ?
      WHERE id = ? AND line_account_id = ? AND owner_friend_id = ?
        AND archived_at IS NULL AND updated_at = ?`,
  ).bind(
    new Date().toISOString(), new Date().toISOString(), patientId,
    owner.lineAccountId, owner.friendId, expectedUpdatedAt,
  ).run();
  if ((result.meta?.changes ?? 0) !== 1) throw new Error('patient archive conflict');
}

export async function createPatientIntakeResponse(
  db: D1Database,
  owner: PharmacyPatientOwner,
  patientId: string,
  input: CreatePatientIntakeInput,
): Promise<PharmacyPatientIntakeResponse> {
  validateIntakeInput(input);
  const patient = await getPharmacyPatient(db, owner, patientId);
  if (!patient || patient.archived_at) throw new Error('patient not found');
  const now = new Date().toISOString();
  const snapshot = JSON.stringify({
    id: patient.id,
    relationship: patient.relationship,
    name: patient.name,
    nameKana: patient.name_kana,
    birthDate: patient.birth_date,
    sex: patient.sex,
  });
  const answers = JSON.stringify(input.answers);
  const responseId = crypto.randomUUID();
  const inserted = await db.prepare(
    `INSERT INTO pharmacy_patient_intake_responses
       (id, line_account_id, owner_friend_id, patient_id, revision, schema_version,
        patient_snapshot_json, answers_json, base_response_id,
        idempotency_key, representative_consent_at, privacy_consent_at, created_at)
     SELECT ?, ?, ?, p.id,
            COALESCE((SELECT MAX(revision) FROM pharmacy_patient_intake_responses
                       WHERE line_account_id = ? AND owner_friend_id = ? AND patient_id = p.id), 0) + 1,
            1, ?, ?,
            (SELECT id FROM pharmacy_patient_intake_responses
              WHERE line_account_id = ? AND owner_friend_id = ? AND patient_id = p.id
              ORDER BY revision DESC, id DESC LIMIT 1),
            ?, ?, ?, ?
       FROM pharmacy_patients p
      WHERE p.id = ? AND p.line_account_id = ? AND p.owner_friend_id = ?
        AND p.archived_at IS NULL
      RETURNING id, line_account_id, owner_friend_id, patient_id, revision, schema_version,
                patient_snapshot_json, answers_json, base_response_id, idempotency_key,
                representative_consent_at, privacy_consent_at, created_at`,
  ).bind(
    responseId,
    owner.lineAccountId,
    owner.friendId,
    owner.lineAccountId,
    owner.friendId,
    snapshot,
    answers,
    owner.lineAccountId,
    owner.friendId,
    input.idempotencyKey,
    now,
    now,
    now,
    patientId,
    owner.lineAccountId,
    owner.friendId,
  ).first<PharmacyPatientIntakeResponse>();
  if (!inserted) {
    const existing = await db.prepare(
      `SELECT id, line_account_id, owner_friend_id, patient_id, revision, schema_version,
              patient_snapshot_json, answers_json, base_response_id, idempotency_key,
              representative_consent_at, privacy_consent_at, created_at
         FROM pharmacy_patient_intake_responses
        WHERE line_account_id = ? AND owner_friend_id = ? AND patient_id = ?
          AND idempotency_key = ?`,
    ).bind(
      owner.lineAccountId, owner.friendId, patientId, input.idempotencyKey,
    ).first<PharmacyPatientIntakeResponse>();
    if (existing) return existing;
    throw new Error('patient intake conflict');
  }
  return inserted;
}

export async function getLatestPatientIntake(
  db: D1Database,
  owner: PharmacyPatientOwner,
  patientId: string,
): Promise<PharmacyPatientIntakeResponse | null> {
  return db.prepare(
    `SELECT id, line_account_id, owner_friend_id, patient_id, revision, schema_version,
            patient_snapshot_json, answers_json, base_response_id, idempotency_key,
            representative_consent_at, privacy_consent_at, created_at
       FROM pharmacy_patient_intake_responses
      WHERE line_account_id = ? AND owner_friend_id = ? AND patient_id = ?
      ORDER BY revision DESC, id DESC
      LIMIT 1`,
  ).bind(owner.lineAccountId, owner.friendId, patientId).first<PharmacyPatientIntakeResponse>();
}

export async function getLatestAdminPatientIntake(
  db: D1Database,
  lineAccountId: string,
  patientId: string,
): Promise<PharmacyPatientIntakeResponse | null> {
  return db.prepare(
    `SELECT id, line_account_id, owner_friend_id, patient_id, revision, schema_version,
            patient_snapshot_json, answers_json, base_response_id, idempotency_key,
            representative_consent_at, privacy_consent_at, created_at
       FROM pharmacy_patient_intake_responses
      WHERE line_account_id = ? AND patient_id = ?
      ORDER BY revision DESC, id DESC
      LIMIT 1`,
  ).bind(lineAccountId, patientId).first<PharmacyPatientIntakeResponse>();
}
