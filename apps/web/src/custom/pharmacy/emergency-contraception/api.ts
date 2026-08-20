import { fetchApi } from '../../../lib/api'
import { accountQuery } from '../api'

export type EmergencyIntakeStatus =
  | 'provisional'
  | 'reviewed'
  | 'completed'
  | 'cancelled'
  | 'expired'

export type EmergencyRiskFlag =
  | 'time_unknown'
  | 'under_16'
  | 'minor_review'
  | 'repeat_purchase_review'
  | 'notification_unavailable'

export interface EmergencySettings {
  line_account_id: string
  is_enabled: number
  pharmacy_registration_number: string
  product_code: string
  purpose_text: string
  manufacturer_check_url: string
  privacy_policy_url: string
  privacy_contact: string
  consent_version: string
  retention_days: number
  consultation_minutes: number
  reservation_ttl_minutes: number
  privacy_space_ready: number
  drinking_water_ready: number
  partner_clinic_url: string
  support_center_url: string
  updated_by: string
  created_at: string
  updated_at: string
}

export interface EmergencyAvailableStaff {
  staff_id: string
  name: string
}

export interface EmergencyPharmacist {
  staff_id: string
  name: string
  training_registration_number: string
  is_active: number
}

export interface EmergencyInventory {
  product_code: string
  on_hand: number
  version: number
  updated_at: string
}

export interface EmergencySlot {
  id: string
  pharmacist_staff_id: string
  starts_at: string
  ends_at: string
  status: string
  capacity: number
  version: number
}

export interface EmergencyAdminConfig {
  settings: EmergencySettings | null
  available_staff?: EmergencyAvailableStaff[]
  pharmacists: EmergencyPharmacist[]
  inventory: EmergencyInventory[]
  slots: EmergencySlot[]
}

export interface AdminEmergencyIntake {
  id: string
  reference_code: string
  slot_id: string
  status: EmergencyIntakeStatus
  age_band: 'under_16' | '16_17' | 'adult'
  safe_contact_mode: 'neutral_line' | 'no_notification' | 'phone' | 'none'
  consent_version: string
  risk_flags: EmergencyRiskFlag[]
  expires_at: string
  version: number
  created_at: string
  updated_at: string
  slot_starts_at: string
  slot_ends_at: string
  self_reported: {
    intercourseAt: string
    intercourseTimeUnknown: boolean
  }
}

export interface EmergencyConfigInput {
  enabled: boolean
  pharmacyRegistrationNumber: string
  productCode: string
  purposeText: string
  manufacturerCheckUrl: string
  privacyPolicyUrl: string
  privacyContact: string
  consentVersion: string
  retentionDays: number
  consultationMinutes: number
  reservationTtlMinutes: number
  privacySpaceReady: boolean
  drinkingWaterReady: boolean
  partnerClinicUrl: string
  supportCenterUrl: string
}

const path = '/api/custom/pharmacy/emergency-contraception'

export const emergencyContraceptionAdminApi = {
  config: (accountId: string) => fetchApi<EmergencyAdminConfig>(
    `${path}/config?${accountQuery(accountId)}`,
  ),
  saveConfig: (accountId: string, body: EmergencyConfigInput) => fetchApi<void>(
    `${path}/config?${accountQuery(accountId)}`,
    { method: 'PUT', body: JSON.stringify(body) },
  ),
  setPharmacist: (
    accountId: string,
    staffId: string,
    body: { registrationNumber: string; active: boolean },
  ) => fetchApi<void>(
    `${path}/pharmacists/${encodeURIComponent(staffId)}?${accountQuery(accountId)}`,
    { method: 'PUT', body: JSON.stringify(body) },
  ),
  createSlot: (
    accountId: string,
    body: { pharmacistStaffId: string; startsAt: string; endsAt: string; capacity: number },
  ) => fetchApi<{ slot: { id: string } }>(
    `${path}/slots?${accountQuery(accountId)}`,
    { method: 'POST', body: JSON.stringify(body) },
  ),
  cancelSlot: (accountId: string, slotId: string, expectedVersion: number) => fetchApi<void>(
    `${path}/slots/${encodeURIComponent(slotId)}/cancel?${accountQuery(accountId)}`,
    { method: 'POST', body: JSON.stringify({ expectedVersion }) },
  ),
  setInventory: (
    accountId: string,
    body: { productCode: string; onHand: number; expectedVersion: number },
  ) => fetchApi<void>(
    `${path}/inventory?${accountQuery(accountId)}`,
    { method: 'PUT', body: JSON.stringify(body) },
  ),
  intakes: (accountId: string) => fetchApi<{ intakes: AdminEmergencyIntake[] }>(
    `${path}/intakes?${accountQuery(accountId)}`,
  ),
  transition: (
    accountId: string,
    intakeId: string,
    status: Exclude<EmergencyIntakeStatus, 'provisional'>,
    expectedVersion: number,
  ) => fetchApi<{ intake: AdminEmergencyIntake }>(
    `${path}/intakes/${encodeURIComponent(intakeId)}/transitions?${accountQuery(accountId)}`,
    { method: 'POST', body: JSON.stringify({ status, expectedVersion }) },
  ),
}
