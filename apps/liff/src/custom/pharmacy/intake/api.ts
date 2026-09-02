import { requestPharmacyJson } from '../request.js';

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
  updated_at: string;
}

export interface PatientIntake {
  id: string;
  patient_id: string;
  revision: number;
  schema_version: number;
  patient_snapshot_json: string;
  answers_json: string;
  created_at: string;
}

export interface PatientAccessState {
  access: 'self' | 'proxy';
  permission: 'patient_intake_v1' | null;
  proxyExpiresAt: string | null;
  privacy: 'active' | 'withdrawn';
  notifications: 'enabled' | 'stopped';
  controlVersion: number;
}

/**
 * The pharmacy's own APPI notice. The pharmacy — not the platform operator — is the
 * 個人情報取扱事業者, so every string here is authored by that pharmacy.
 */
export interface TenantPrivacyPolicy {
  purpose_text: string;
  purpose_url: string;
  contact_point: string;
  entrustment_text: string;
  policy_version: number;
  content_hash: string;
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

function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  return requestPharmacyJson<T>(path, init);
}

function json<T>(path: string, body: unknown): Promise<T> {
  return request<T>(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function patchJson<T>(path: string, body: unknown): Promise<T> {
  return request<T>(path, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export const patientIntakeApi = {
  list: () => request<{ patients: PharmacyPatient[] }>('/api/liff/pharmacy/patients'),
  createPatient: (body: {
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
    proxyConsent?: { accepted: boolean; termsVersion: number; termsHash: string };
    registrationIdempotencyKey?: string;
  }) => json<{
    patient: PharmacyPatient;
    proxyGrant?: {
      permission: 'patient_intake_v1';
      basis: 'self_attested_guardian';
      expiresAt: string;
      termsVersion: number;
      termsHash: string;
    };
  }>('/api/liff/pharmacy/patients', body),
  revokeProxy: (patientId: string) => request<{ status: 'revoked' }>(
    `/api/liff/pharmacy/patients/${encodeURIComponent(patientId)}/proxy-grant`,
    { method: 'DELETE' },
  ),
  access: (patientId: string) => request<{ access: PatientAccessState }>(
    `/api/liff/pharmacy/patients/${encodeURIComponent(patientId)}/access`,
  ),
  setNotifications: (patientId: string, body: {
    action: 'stop' | 'resume';
    expectedControlVersion: number;
  }) => json<{ status: 'stopped' | 'resumed'; version: number }>(
    `/api/liff/pharmacy/patients/${encodeURIComponent(patientId)}/notification-preference`, body,
  ),
  updatePatient: (patientId: string, body: {
    expectedUpdatedAt: string;
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
  }) => patchJson<{ status: 'updated' }>(
    `/api/liff/pharmacy/patients/${encodeURIComponent(patientId)}`, body,
  ),
  privacyPolicy: () => request<{ policy: TenantPrivacyPolicy | null }>(
    '/api/liff/pharmacy/privacy-policy',
  ),
  latest: (patientId: string) => request<{ intake: PatientIntake | null }>(
    `/api/liff/pharmacy/patients/${encodeURIComponent(patientId)}/intake`,
  ),
  submit: (patientId: string, body: {
    idempotencyKey: string;
    answers: PatientIntakeAnswers;
    representativeConsent: boolean;
    privacyConsent: boolean;
    privacyPolicyVersion: number;
    privacyPolicyHash: string;
  }) => json<{ intake: PatientIntake }>(
    `/api/liff/pharmacy/patients/${encodeURIComponent(patientId)}/intake`, body,
  ),
};
