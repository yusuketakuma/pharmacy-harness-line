import type { PrescriptionPatient } from '../prescriptions/patient.js';

export type PharmacyPatientOwner = PrescriptionPatient;
export type PatientRelationship = 'self' | 'child' | 'spouse' | 'parent' | 'other';
export type PatientSex = 'male' | 'female' | 'other' | 'prefer_not_to_say';
export type MedicalHistoryTag =
  | 'hypertension' | 'diabetes' | 'dyslipidemia' | 'heart_disease'
  | 'kidney_disease' | 'liver_disease' | 'asthma' | 'other';
export type SmokingStatus = 'never' | 'former' | 'current' | 'unknown';
export type AlcoholStatus = 'none' | 'occasional' | 'weekly' | 'frequent' | 'unknown';
export type MedicationAdherence = 'none' | 'sometimes' | 'often' | 'unknown';

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
  postal_code: string | null;
  prefecture: string | null;
  city: string | null;
  address_line1: string | null;
  address_line2: string | null;
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
  postalCode: string | null;
  prefecture: string | null;
  city: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
}

export interface PatientIntakeAnswers {
  allergiesStatus: 'none' | 'yes' | 'unknown';
  allergiesDetail?: string;
  adverseReactionStatus: 'none' | 'yes' | 'unknown';
  adverseReactionDetail?: string;
  medicationStatus: 'none' | 'yes' | 'unknown';
  medicationSummary?: string;
  medicalHistoryStatus: 'none' | 'yes' | 'unknown';
  medicalHistoryTags: MedicalHistoryTag[];
  medicalHistory?: string;
  medicationNotebook: 'paper' | 'electronic' | 'none' | 'unknown';
  smokingStatus: SmokingStatus;
  alcoholStatus: AlcoholStatus;
  medicationAdherence: MedicationAdherence;
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
  'adverseReactionDetail', 'medicationStatus', 'medicationSummary',
  'medicalHistoryStatus', 'medicalHistoryTags', 'medicalHistory', 'medicationNotebook',
  'smokingStatus', 'alcoholStatus', 'medicationAdherence',
  'pregnancyStatus', 'breastfeedingStatus', 'notes',
]);
const STATUS_VALUES = new Set(['none', 'yes', 'unknown']);
const SMOKING_VALUES = new Set(['never', 'former', 'current', 'unknown']);
const ALCOHOL_VALUES = new Set(['none', 'occasional', 'weekly', 'frequent', 'unknown']);
const MEDICATION_ADHERENCE_VALUES = new Set(['none', 'sometimes', 'often', 'unknown']);
const PREGNANCY_VALUES = new Set(['not_applicable', 'yes', 'no', 'unknown']);
const INTAKE_SCHEMA_VERSION = 2;
const MEDICAL_HISTORY_TAGS = new Set([
  'hypertension', 'diabetes', 'dyslipidemia', 'heart_disease',
  'kidney_disease', 'liver_disease', 'asthma', 'other',
]);
const PATIENT_SELECT = `
  SELECT id, line_account_id, owner_friend_id, relationship, name, name_kana,
         birth_date, sex, contact_phone, postal_code, prefecture, city,
         address_line1, address_line2, archived_at, created_at, updated_at
    FROM pharmacy_patients`;
const INTAKE_SELECT = `
  SELECT id, line_account_id, owner_friend_id, patient_id, revision, schema_version,
         patient_snapshot_json, answers_json, base_response_id, idempotency_key,
         representative_consent_at, privacy_consent_at, created_at
    FROM pharmacy_patient_intake_responses`;

function boundedText(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.trim().length <= max;
}

function isValidDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

const PREFECTURES = new Set([
  '北海道', '青森県', '岩手県', '宮城県', '秋田県', '山形県', '福島県',
  '茨城県', '栃木県', '群馬県', '埼玉県', '千葉県', '東京都', '神奈川県',
  '新潟県', '富山県', '石川県', '福井県', '山梨県', '長野県', '岐阜県',
  '静岡県', '愛知県', '三重県', '滋賀県', '京都府', '大阪府', '兵庫県',
  '奈良県', '和歌山県', '鳥取県', '島根県', '岡山県', '広島県', '山口県',
  '徳島県', '香川県', '愛媛県', '高知県', '福岡県', '佐賀県', '長崎県',
  '熊本県', '大分県', '宮崎県', '鹿児島県', '沖縄県',
]);

function normalizedOptional(value: string | null): string | null {
  return value?.trim() || null;
}

function validateAddress(input: CreatePharmacyPatientInput): void {
  const postalCode = normalizedOptional(input.postalCode);
  const prefecture = normalizedOptional(input.prefecture);
  const city = normalizedOptional(input.city);
  const addressLine1 = normalizedOptional(input.addressLine1);
  const addressLine2 = normalizedOptional(input.addressLine2);
  if (!postalCode && !prefecture && !city && !addressLine1 && !addressLine2) return;
  if (!postalCode || !/^\d{3}-?\d{4}$/.test(postalCode) ||
      !prefecture || !PREFECTURES.has(prefecture) ||
      !city || !boundedText(city, 120) ||
      !addressLine1 || !boundedText(addressLine1, 240) ||
      (addressLine2 !== null && !boundedText(addressLine2, 240))) {
    throw new Error('invalid patient address');
  }
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
  validateAddress(input);
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
      !STATUS_VALUES.has(answerRecord.adverseReactionStatus as string) ||
      !STATUS_VALUES.has(answerRecord.medicationStatus as string) ||
      !STATUS_VALUES.has(answerRecord.medicalHistoryStatus as string) ||
      !new Set(['paper', 'electronic', 'none', 'unknown']).has(answerRecord.medicationNotebook as string) ||
      !SMOKING_VALUES.has(answerRecord.smokingStatus as string) ||
      !ALCOHOL_VALUES.has(answerRecord.alcoholStatus as string) ||
      !MEDICATION_ADHERENCE_VALUES.has(answerRecord.medicationAdherence as string)) {
    throw new Error('invalid intake answers');
  }
  if (!Array.isArray(answerRecord.medicalHistoryTags) ||
      answerRecord.medicalHistoryTags.length > 8 ||
      answerRecord.medicalHistoryTags.some((tag) => !MEDICAL_HISTORY_TAGS.has(tag as string))) {
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
    postal_code: normalizedOptional(input.postalCode),
    prefecture: normalizedOptional(input.prefecture),
    city: normalizedOptional(input.city),
    address_line1: normalizedOptional(input.addressLine1),
    address_line2: normalizedOptional(input.addressLine2),
    archived_at: null,
    created_at: now,
    updated_at: now,
  };
  await db.prepare(
    `INSERT INTO pharmacy_patients
       (id, line_account_id, owner_friend_id, relationship, name, name_kana,
        birth_date, sex, contact_phone, postal_code, prefecture, city,
        address_line1, address_line2, archived_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
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
    patient.postal_code,
    patient.prefecture,
    patient.city,
    patient.address_line1,
    patient.address_line2,
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
    `${PATIENT_SELECT}
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
): Promise<AdminPharmacyPatient[]> {
  const archivedClause = includeArchived ? '' : ' AND archived_at IS NULL';
  const result = await db.prepare(
    `${PATIENT_SELECT}
      WHERE line_account_id = ?${archivedClause}
      ORDER BY updated_at DESC, id DESC`,
  ).bind(lineAccountId).all<PharmacyPatient>();
  return result.results.map(toAdminPatient);
}

export async function getPharmacyPatient(
  db: D1Database,
  owner: PharmacyPatientOwner,
  patientId: string,
): Promise<PharmacyPatient | null> {
  return db.prepare(
    `${PATIENT_SELECT}
      WHERE id = ? AND line_account_id = ? AND owner_friend_id = ?`,
  ).bind(patientId, owner.lineAccountId, owner.friendId).first<PharmacyPatient>();
}

export async function getAdminPharmacyPatient(
  db: D1Database,
  lineAccountId: string,
  patientId: string,
): Promise<AdminPharmacyPatient | null> {
  const patient = await db.prepare(
    `${PATIENT_SELECT}
      WHERE id = ? AND line_account_id = ?`,
  ).bind(patientId, lineAccountId).first<PharmacyPatient>();
  return patient ? toAdminPatient(patient) : null;
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
            sex = ?, contact_phone = ?, postal_code = ?, prefecture = ?,
            city = ?, address_line1 = ?, address_line2 = ?, updated_at = ?
      WHERE id = ? AND line_account_id = ? AND owner_friend_id = ?
        AND archived_at IS NULL AND updated_at = ?`,
  ).bind(
    input.relationship, input.name.trim(), input.nameKana.trim(), input.birthDate,
    input.sex, input.contactPhone?.trim() || null,
    normalizedOptional(input.postalCode), normalizedOptional(input.prefecture),
    normalizedOptional(input.city), normalizedOptional(input.addressLine1),
    normalizedOptional(input.addressLine2), now,
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
  const now = new Date().toISOString();
  const result = await db.prepare(
    `UPDATE pharmacy_patients
        SET archived_at = ?, updated_at = ?
      WHERE id = ? AND line_account_id = ? AND owner_friend_id = ?
        AND archived_at IS NULL AND updated_at = ?`,
  ).bind(
    now, now, patientId,
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
    contactPhone: patient.contact_phone,
    postalCode: patient.postal_code,
    prefecture: patient.prefecture,
    city: patient.city,
    addressLine1: patient.address_line1,
    addressLine2: patient.address_line2,
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
            ${INTAKE_SCHEMA_VERSION}, ?, ?,
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
      `${INTAKE_SELECT}
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
    `${INTAKE_SELECT}
      WHERE line_account_id = ? AND owner_friend_id = ? AND patient_id = ?
      ORDER BY revision DESC, id DESC
      LIMIT 1`,
  ).bind(owner.lineAccountId, owner.friendId, patientId).first<PharmacyPatientIntakeResponse>();
}

export async function getLatestAdminPatientIntake(
  db: D1Database,
  lineAccountId: string,
  patientId: string,
): Promise<(AdminPatientIntakeSummary & { answers: Partial<PatientIntakeAnswers> }) | null> {
  const row = await db.prepare(
    `SELECT id, patient_id, revision, schema_version, answers_json,
            representative_consent_at, privacy_consent_at, created_at
       FROM pharmacy_patient_intake_responses
      WHERE line_account_id = ? AND patient_id = ?
      ORDER BY revision DESC, id DESC
      LIMIT 1`,
  ).bind(lineAccountId, patientId).first<AdminPatientIntakeRow>();
  return row ? { ...toAdminIntakeSummary(row), answers: parseAdminIntakeAnswers(row.answers_json) } : null;
}

export interface PharmacyPatientHistory {
  patient: AdminPharmacyPatient;
  intakes: AdminPatientIntakeSummary[];
  latestIntake: (AdminPatientIntakeSummary & { answers: Partial<PatientIntakeAnswers> }) | null;
  prescriptions: Array<{
    id: string;
    status: string;
    active_revision: number | null;
    desired_pickup_at: string | null;
    requested_at: string | null;
    closed_at: string | null;
    created_at: string;
    updated_at: string;
  }>;
  quotes: Array<{
    id: string;
    submission_id: string;
    decision: string;
    estimated_ready_at: string | null;
    status: string | null;
    fulfillment_method: string | null;
    created_at: string;
  }>;
  continuity: Array<{
    id: string;
    status: string;
    expected_next_from: string;
    expected_next_to: string;
    next_contact_at: string;
    reminder_count: number;
    created_at: string;
    updated_at: string;
  }>;
  timeline: Array<{
    kind: 'intake' | 'prescription' | 'fulfillment' | 'continuity' | 'myna';
    occurred_at: string;
    label: string;
    status?: string | null;
  }>;
}

type AdminPatientIntakeSummary = Pick<PharmacyPatientIntakeResponse,
  'id' | 'patient_id' | 'revision' | 'schema_version' |
  'representative_consent_at' | 'privacy_consent_at' | 'created_at'>;

type AdminPatientIntakeRow = AdminPatientIntakeSummary & { answers_json: string };
type AdminPharmacyPatient = Pick<PharmacyPatient,
  'id' | 'relationship' | 'name' | 'name_kana' | 'birth_date' | 'sex' |
  'contact_phone' | 'postal_code' | 'prefecture' | 'city' | 'address_line1' |
  'address_line2' | 'archived_at' | 'created_at' | 'updated_at'>;

function toAdminPatient(patient: PharmacyPatient): AdminPharmacyPatient {
  return {
    id: patient.id,
    relationship: patient.relationship,
    name: patient.name,
    name_kana: patient.name_kana,
    birth_date: patient.birth_date,
    sex: patient.sex,
    contact_phone: patient.contact_phone,
    postal_code: patient.postal_code,
    prefecture: patient.prefecture,
    city: patient.city,
    address_line1: patient.address_line1,
    address_line2: patient.address_line2,
    archived_at: patient.archived_at,
    created_at: patient.created_at,
    updated_at: patient.updated_at,
  };
}

function toAdminIntakeSummary(row: AdminPatientIntakeRow): AdminPatientIntakeSummary {
  return {
    id: row.id,
    patient_id: row.patient_id,
    revision: row.revision,
    schema_version: row.schema_version,
    representative_consent_at: row.representative_consent_at,
    privacy_consent_at: row.privacy_consent_at,
    created_at: row.created_at,
  };
}

function parseAdminIntakeAnswers(raw: string): Partial<PatientIntakeAnswers> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter(([key]) => ANSWER_KEYS.has(key)),
    ) as Partial<PatientIntakeAnswers>;
  } catch {
    return {};
  }
}

/** Account-scoped operational history; raw snapshots and unknown answer fields stay in D1. */
export async function getAdminPharmacyPatientHistory(
  db: D1Database,
  lineAccountId: string,
  patientId: string,
): Promise<PharmacyPatientHistory | null> {
  const patient = await getAdminPharmacyPatient(db, lineAccountId, patientId);
  if (!patient) return null;
  const [intakes, prescriptions, quotes, continuity, prescriptionEvents, continuityEvents, myna] = await Promise.all([
    db.prepare(`SELECT id, patient_id, revision, schema_version, answers_json,
                       representative_consent_at, privacy_consent_at, created_at
                  FROM pharmacy_patient_intake_responses
                 WHERE line_account_id = ? AND patient_id = ?
                 ORDER BY revision DESC, id DESC`)
      .bind(lineAccountId, patientId).all<AdminPatientIntakeRow>(),
    db.prepare(`SELECT s.id, s.status, s.active_revision, s.desired_pickup_at,
                       s.requested_at, s.closed_at, s.created_at, s.updated_at
                  FROM pharmacy_prescription_submissions s
                  INNER JOIN pharmacy_prescription_patients pp
                    ON pp.submission_id = s.id AND pp.line_account_id = s.line_account_id
                 WHERE pp.line_account_id = ? AND pp.patient_id = ?
                 ORDER BY s.created_at DESC, s.id DESC`)
      .bind(lineAccountId, patientId).all<PharmacyPatientHistory['prescriptions'][number]>(),
    db.prepare(`SELECT q.id, q.submission_id, q.decision, q.estimated_ready_at,
                       q.status, q.fulfillment_method, q.created_at
                  FROM pharmacy_fulfillment_quotes q
                  INNER JOIN pharmacy_prescription_patients pp
                    ON pp.submission_id = q.submission_id AND pp.line_account_id = q.line_account_id
                 WHERE q.line_account_id = ? AND pp.patient_id = ?
                 ORDER BY q.created_at DESC, q.id DESC`)
      .bind(lineAccountId, patientId).all<PharmacyPatientHistory['quotes'][number]>(),
    db.prepare(`SELECT id, status, expected_next_from, expected_next_to,
                       next_contact_at, reminder_count, created_at, updated_at
                  FROM pharmacy_continuity_obligations
                 WHERE line_account_id = ? AND patient_id = ?
                 ORDER BY created_at DESC, id DESC`)
      .bind(lineAccountId, patientId).all<PharmacyPatientHistory['continuity'][number]>(),
    db.prepare(`SELECT e.event_type, e.from_status, e.to_status, e.created_at
                  FROM pharmacy_prescription_events e
                  INNER JOIN pharmacy_prescription_submissions s
                    ON s.id = e.submission_id
                  INNER JOIN pharmacy_prescription_patients pp
                    ON pp.submission_id = s.id
                   AND pp.line_account_id = s.line_account_id
                 WHERE s.line_account_id = ? AND pp.patient_id = ?
                 ORDER BY e.created_at DESC, e.id DESC`)
      .bind(lineAccountId, patientId).all<{ event_type: string; from_status: string | null; to_status: string | null; created_at: string }>(),
    db.prepare(`SELECT e.event_type, o.status, e.created_at
                  FROM pharmacy_continuity_events e
                  INNER JOIN pharmacy_continuity_obligations o
                    ON o.id = e.obligation_id AND o.line_account_id = e.line_account_id
                 WHERE e.line_account_id = ? AND o.patient_id = ?
                 ORDER BY e.created_at DESC, e.id DESC`)
      .bind(lineAccountId, patientId).all<{ event_type: string; status: string; created_at: string }>(),
    db.prepare(`SELECT h.method, h.status, h.created_at, h.updated_at
                  FROM pharmacy_myna_handoffs h
                 WHERE h.line_account_id = ? AND h.patient_id = ?
                 ORDER BY h.created_at DESC, h.id DESC`)
      .bind(lineAccountId, patientId).all<{ method: string; status: string; created_at: string; updated_at: string }>(),
  ]);

  const intakeSummaries = intakes.results.map(toAdminIntakeSummary);
  const timeline: PharmacyPatientHistory['timeline'] = [
    ...intakes.results.map((item) => ({ kind: 'intake' as const, occurred_at: item.created_at, label: `アンケート回答 第${item.revision}版`, status: null })),
    ...prescriptionEvents.results.map((item) => ({ kind: 'prescription' as const, occurred_at: item.created_at, label: item.event_type === 'status_changed' ? '処方せん受付状態を更新' : '処方せん受付を更新', status: item.to_status })),
    ...quotes.results.map((item) => ({ kind: 'fulfillment' as const, occurred_at: item.created_at, label: 'FulfillmentQuoteを登録', status: item.decision })),
    ...continuityEvents.results.map((item) => ({ kind: 'continuity' as const, occurred_at: item.created_at, label: '継続フォローを更新', status: item.status })),
    ...myna.results.map((item) => ({ kind: 'myna' as const, occurred_at: item.created_at, label: 'マイナ受付を更新', status: item.status })),
  ].sort((a, b) => b.occurred_at.localeCompare(a.occurred_at));

  return {
    patient,
    intakes: intakeSummaries,
    latestIntake: intakes.results[0]
      ? { ...intakeSummaries[0], answers: parseAdminIntakeAnswers(intakes.results[0].answers_json) }
      : null,
    prescriptions: prescriptions.results,
    quotes: quotes.results,
    continuity: continuity.results,
    timeline,
  };
}
