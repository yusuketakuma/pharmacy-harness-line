import { fetchApi } from '../../../lib/api'
import { accountQuery } from '../api'

export type PharmacyPatient = {
  id: string
  owner_friend_id: string
  relationship: 'self' | 'child' | 'spouse' | 'parent' | 'other'
  name: string
  name_kana: string
  birth_date: string
  sex: 'male' | 'female' | 'other' | 'prefer_not_to_say' | null
  contact_phone: string | null
  postal_code: string | null
  prefecture: string | null
  city: string | null
  address_line1: string | null
  address_line2: string | null
  archived_at: string | null
  updated_at: string
}

export type PatientIntake = {
  id: string
  patient_id: string
  revision: number
  schema_version: number
  patient_snapshot_json: string
  answers_json: string
  representative_consent_at: string
  privacy_consent_at: string
  created_at: string
}

export type PatientIntakeHistoryDetail = {
  id: string
  patient_id: string
  revision: number
  schema_version: number
  representative_consent_at: string
  privacy_consent_at: string
  created_at: string
  answers: Record<string, unknown>
}

export type PharmacyPatientHistory = {
  patient: PharmacyPatient
  intakes: Array<Omit<PatientIntakeHistoryDetail, 'answers'>>
  latestIntake: PatientIntakeHistoryDetail | null
  prescriptions: Array<{
    id: string
    status: string
    active_revision: number | null
    desired_pickup_at: string | null
    requested_at: string | null
    closed_at: string | null
    created_at: string
    updated_at: string
  }>
  quotes: Array<{
    id: string
    submission_id: string
    decision: string
    estimated_ready_at: string | null
    status: string | null
    fulfillment_method: string | null
    created_at: string
  }>
  continuity: Array<{
    id: string
    status: string
    expected_next_from: string
    expected_next_to: string
    next_contact_at: string
    reminder_count: number
    created_at: string
    updated_at: string
  }>
  timeline: Array<{
    kind: 'intake' | 'prescription' | 'fulfillment' | 'continuity' | 'myna'
    occurred_at: string
    label: string
    status?: string | null
  }>
}

export const pharmacyIntakeAdminApi = {
  list: (accountId: string) => fetchApi<{ patients: PharmacyPatient[] }>(
    `/api/custom/pharmacy/patients?${accountQuery(accountId)}`,
  ),
  detail: (accountId: string, patientId: string) => fetchApi<{ patient: PharmacyPatient }>(
    `/api/custom/pharmacy/patients/${encodeURIComponent(patientId)}?${accountQuery(accountId)}`,
  ),
  latest: (accountId: string, patientId: string) => fetchApi<{ intake: PatientIntake | null }>(
    `/api/custom/pharmacy/patients/${encodeURIComponent(patientId)}/intake?${accountQuery(accountId)}`,
  ),
  history: (accountId: string, patientId: string) => fetchApi<{ history: PharmacyPatientHistory }>(
    `/api/custom/pharmacy/patients/${encodeURIComponent(patientId)}/history?${accountQuery(accountId)}`,
  ),
}
