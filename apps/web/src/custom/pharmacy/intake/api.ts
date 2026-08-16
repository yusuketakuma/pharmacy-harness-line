import { fetchApi } from '../../../lib/api'

export type PharmacyPatient = {
  id: string
  owner_friend_id: string
  relationship: 'self' | 'child' | 'spouse' | 'parent' | 'other'
  name: string
  name_kana: string
  birth_date: string
  sex: 'male' | 'female' | 'other' | 'prefer_not_to_say' | null
  contact_phone: string | null
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

const accountQuery = (accountId: string) => `line_account_id=${encodeURIComponent(accountId)}`

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
}
