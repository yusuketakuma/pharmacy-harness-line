import {
  INVALID_PATIENT_INTAKE_ENVELOPE_ERROR,
  openPatientIntakeField,
  PATIENT_INTAKE_ENVELOPE_VERSION,
  PATIENT_INTAKE_KEY_VERSION,
  sealPatientIntakeField,
  type PatientIntakeEncryptedField,
  type PatientIntakeKeyVersion,
} from './encryption.js';

export interface PatientIntakeCryptoScope {
  tenantId: string;
  rootSecret: string;
  rootSecretV2?: string;
  activeKeyVersion?: PatientIntakeKeyVersion;
}

export interface PatientIntakeCryptoBindings {
  PHARMACY_PHI_KEY_V1?: string;
  PHARMACY_PHI_KEY_V2?: string;
  PHARMACY_PHI_ACTIVE_KEY_VERSION?: string;
}

export interface PatientIntakeEncryptedRow {
  id: string;
  line_account_id: string;
  owner_friend_id: string;
  patient_id: string;
  revision: number;
  schema_version: number;
  patient_snapshot_json: string;
  answers_json: string;
}

export interface StoredPatientIntakeEnvelope {
  field_name: PatientIntakeEncryptedField;
  envelope_version: number;
  key_version: number;
  nonce: string;
  ciphertext: string;
}

const encoder = new TextEncoder();

function validRootSecret(value: unknown): value is string {
  return typeof value === 'string' && encoder.encode(value).length >= 32 && value.length <= 4096;
}

export function resolvePatientIntakeCryptoScope(
  bindings: PatientIntakeCryptoBindings,
  tenantId: string | undefined,
): PatientIntakeCryptoScope | null {
  const active = bindings.PHARMACY_PHI_ACTIVE_KEY_VERSION ?? '1';
  if (!tenantId || !validRootSecret(bindings.PHARMACY_PHI_KEY_V1) ||
      (bindings.PHARMACY_PHI_KEY_V2 !== undefined && !validRootSecret(bindings.PHARMACY_PHI_KEY_V2)) ||
      bindings.PHARMACY_PHI_KEY_V2 === bindings.PHARMACY_PHI_KEY_V1 ||
      (active !== '1' && active !== '2') ||
      (active === '2' && !validRootSecret(bindings.PHARMACY_PHI_KEY_V2))) return null;
  return {
    tenantId,
    rootSecret: bindings.PHARMACY_PHI_KEY_V1,
    ...(bindings.PHARMACY_PHI_KEY_V2 ? { rootSecretV2: bindings.PHARMACY_PHI_KEY_V2 } : {}),
    ...(active === '2' ? { activeKeyVersion: 2 as const } : {}),
  };
}

export function activePatientIntakeKeyVersion(
  scope: PatientIntakeCryptoScope,
): PatientIntakeKeyVersion {
  return scope.activeKeyVersion ?? PATIENT_INTAKE_KEY_VERSION;
}

export function patientIntakeRootSecret(
  scope: PatientIntakeCryptoScope,
  keyVersion: number,
): string {
  const value = keyVersion === 1 ? scope.rootSecret : keyVersion === 2 ? scope.rootSecretV2 : undefined;
  if (!validRootSecret(value)) throw new Error(INVALID_PATIENT_INTAKE_ENVELOPE_ERROR);
  return value;
}

export function patientIntakeKeyVersions(scope: PatientIntakeCryptoScope): PatientIntakeKeyVersion[] {
  return scope.rootSecretV2 ? [1, 2] : [1];
}

export function patientIntakeEncryptionContext(
  row: PatientIntakeEncryptedRow,
  scope: PatientIntakeCryptoScope,
  fieldName: PatientIntakeEncryptedField,
  keyVersion = activePatientIntakeKeyVersion(scope),
) {
  return {
    tenantId: scope.tenantId,
    lineAccountId: row.line_account_id,
    ownerFriendId: row.owner_friend_id,
    patientId: row.patient_id,
    responseId: row.id,
    schemaVersion: row.schema_version,
    sourceRevision: row.revision,
    fieldName,
    envelopeVersion: PATIENT_INTAKE_ENVELOPE_VERSION,
    keyVersion,
  };
}

export async function preparePatientIntakeEnvelopeStatements(
  db: D1Database,
  row: PatientIntakeEncryptedRow,
  scope: PatientIntakeCryptoScope,
  encryptedAt: string,
  verifyRoundTrip = false,
): Promise<D1PreparedStatement[]> {
  const fields = [
    ['patient_snapshot_json', row.patient_snapshot_json],
    ['answers_json', row.answers_json],
  ] as const;
  return Promise.all(fields.map(async ([fieldName, plaintext]) => {
    const context = patientIntakeEncryptionContext(row, scope, fieldName);
    const envelope = await sealPatientIntakeField(
      plaintext,
      patientIntakeRootSecret(scope, context.keyVersion),
      context,
    );
    if (verifyRoundTrip && await openPatientIntakeField(
      envelope,
      patientIntakeRootSecret(scope, context.keyVersion),
      context,
    ) !== plaintext) {
      throw new Error('byte mismatch');
    }
    return db.prepare(`INSERT INTO pharmacy_patient_intake_envelopes
      (response_id, tenant_id, line_account_id, owner_friend_id, patient_id, field_name,
       schema_version, source_revision, envelope_version, key_version, nonce,
       ciphertext, encrypted_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(
        row.id, scope.tenantId, row.line_account_id, row.owner_friend_id, row.patient_id, fieldName,
        row.schema_version, row.revision, envelope.envelopeVersion, envelope.keyVersion,
        envelope.nonce, envelope.ciphertext, encryptedAt,
      );
  }));
}

export async function openPatientIntakeFields<T extends PatientIntakeEncryptedRow>(
  db: D1Database,
  row: T,
  scope: PatientIntakeCryptoScope,
): Promise<T> {
  const result = await db.prepare(`SELECT field_name, envelope_version, key_version, nonce, ciphertext
    FROM pharmacy_patient_intake_envelopes
    WHERE response_id = ?
    ORDER BY field_name`).bind(row.id).all<StoredPatientIntakeEnvelope>();
  if (result.results.length === 0) {
    const migration = await db.prepare(`SELECT phase
      FROM pharmacy_patient_intake_migration_state
      WHERE tenant_id = ? AND line_account_id = ?`).bind(
      scope.tenantId, row.line_account_id,
    ).first<{ phase: string }>();
    if (migration) throw new Error(INVALID_PATIENT_INTAKE_ENVELOPE_ERROR);
    return row;
  }
  const opened = await decryptPatientIntakeEnvelopeFields(row, scope, result.results);
  return { ...row, ...opened };
}

export async function decryptPatientIntakeEnvelopeFields(
  row: PatientIntakeEncryptedRow,
  scope: PatientIntakeCryptoScope,
  envelopes: StoredPatientIntakeEnvelope[],
): Promise<Pick<PatientIntakeEncryptedRow, 'patient_snapshot_json' | 'answers_json'>> {
  if (envelopes.length !== 2) throw new Error(INVALID_PATIENT_INTAKE_ENVELOPE_ERROR);
  const byField = new Map(envelopes.map((item) => [item.field_name, item]));
  const snapshot = byField.get('patient_snapshot_json');
  const answers = byField.get('answers_json');
  if (!snapshot || !answers || snapshot.key_version !== answers.key_version) {
    throw new Error(INVALID_PATIENT_INTAKE_ENVELOPE_ERROR);
  }
  return {
    patient_snapshot_json: await openPatientIntakeField({
      envelopeVersion: snapshot.envelope_version,
      keyVersion: snapshot.key_version,
      nonce: snapshot.nonce,
      ciphertext: snapshot.ciphertext,
    }, patientIntakeRootSecret(scope, snapshot.key_version),
    patientIntakeEncryptionContext(row, scope, 'patient_snapshot_json', snapshot.key_version)),
    answers_json: await openPatientIntakeField({
      envelopeVersion: answers.envelope_version,
      keyVersion: answers.key_version,
      nonce: answers.nonce,
      ciphertext: answers.ciphertext,
    }, patientIntakeRootSecret(scope, answers.key_version),
    patientIntakeEncryptionContext(row, scope, 'answers_json', answers.key_version)),
  };
}
