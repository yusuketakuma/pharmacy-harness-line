import { getIdToken, getLiffId } from '../../../lib/liff-auth.js';

const BASE = import.meta.env.VITE_API_BASE ?? '';

export type PatientRelationship = 'self' | 'child' | 'spouse' | 'parent' | 'other';
export type PatientSex = 'male' | 'female' | 'other' | 'prefer_not_to_say';

export interface PharmacyPatient {
  id: string;
  relationship: PatientRelationship;
  name: string;
  name_kana: string;
  birth_date: string;
  sex: PatientSex | null;
  contact_phone: string | null;
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

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const origin = typeof window === 'undefined' ? 'http://localhost' : window.location.origin;
  const url = new URL(`${BASE}${path}`, origin);
  url.searchParams.set('liffId', getLiffId());
  const response = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${getIdToken()}`,
      ...init.headers,
    },
  });
  const text = await response.text();
  let body: unknown = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!response.ok) {
    const error = new Error(`Patient intake API ${response.status}`) as Error & {
      status: number;
      body: unknown;
    };
    error.status = response.status;
    error.body = body;
    throw error;
  }
  return body as T;
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
  }) => json<{ patient: PharmacyPatient }>('/api/liff/pharmacy/patients', body),
  updatePatient: (patientId: string, body: {
    expectedUpdatedAt: string;
    relationship: PatientRelationship;
    name: string;
    nameKana: string;
    birthDate: string;
    sex: PatientSex | null;
    contactPhone: string | null;
  }) => patchJson<{ status: 'updated' }>(
    `/api/liff/pharmacy/patients/${encodeURIComponent(patientId)}`, body,
  ),
  latest: (patientId: string) => request<{ intake: PatientIntake | null }>(
    `/api/liff/pharmacy/patients/${encodeURIComponent(patientId)}/intake`,
  ),
  submit: (patientId: string, body: {
    idempotencyKey: string;
    answers: PatientIntakeAnswers;
    representativeConsent: boolean;
    privacyConsent: boolean;
  }) => json<{ intake: PatientIntake }>(
    `/api/liff/pharmacy/patients/${encodeURIComponent(patientId)}/intake`, body,
  ),
};
