import { fetchApi } from '../../../lib/api'
import { accountQuery } from '../api'

export type MynaHandoffStatus =
  | 'CREATED'
  | 'LAUNCH_REQUESTED'
  | 'PATIENT_REPORTED_COMPLETE'
  | 'PATIENT_REPORTED_NO_PRESCRIPTION'
  | 'SUPPORT_NEEDED'
  | 'PAPER_FALLBACK'
  | 'ABANDONED'
  | 'EXPIRED'
  | 'CLOSED'

export type MynaVerificationStatus =
  | 'E_PRESCRIPTION_RECEIVED'
  | 'CONSENT_ONLY_OR_NO_PRESCRIPTION'
  | 'NO_RECORD_FOUND'
  | 'SUBMITTED_TO_OTHER_PHARMACY'
  | 'PRESCRIPTION_EXPIRED'
  | 'PAPER_FALLBACK'
  | 'PATIENT_MISMATCH'
  | 'MANUAL_EXCEPTION'

export interface MynaHandoff {
  id: string
  friend_id: string
  patient_id: string | null
  method: 'E_PRESCRIPTION' | 'PAPER' | 'MEDICAL_INSTITUTION_SENT'
  status: MynaHandoffStatus
  source: 'RICH_MENU' | 'MESSAGE' | 'LIFF'
  correlation_id: string
  launched_at: string | null
  patient_reported_at: string | null
  expires_at: string
  closed_at: string | null
  created_at: string
  updated_at: string
}

export interface MynaVerification {
  id: string
  status: MynaVerificationStatus
  verified_by: string
  verified_at: string
  reason_code: string | null
  source_system: string
  source_reference: string | null
}

export interface MynaEndpoint {
  id: string
  line_account_id: string
  tenant_alias: string
  endpoint_url_masked: string
  allowed_host: string
  enabled: boolean
  valid_from: string
  retired_at: string | null
  last_verified_at: string | null
  revision: number
}

export interface MynaHandoffDetail {
  handoff: MynaHandoff
  expectation: { receipt_status: string; shadow_submission_id: string | null } | null
  verification: MynaVerification | null
}

export const mynaAdminApi = {
  list: (accountId: string, status?: MynaHandoffStatus | '') => fetchApi<{ handoffs: MynaHandoff[] }>(
    `/api/custom/pharmacy/myna-handoffs?${accountQuery(accountId)}${status ? `&status=${encodeURIComponent(status)}` : ''}`,
  ),
  detail: (accountId: string, handoffId: string) => fetchApi<MynaHandoffDetail>(
    `/api/custom/pharmacy/myna-handoffs/${encodeURIComponent(handoffId)}?${accountQuery(accountId)}`,
  ),
  verify: (accountId: string, handoffId: string, body: {
    status: MynaVerificationStatus
    sourceSystem: string
    reasonCode?: string | null
    sourceReference?: string | null
  }) => fetchApi(`/api/custom/pharmacy/myna-handoffs/${encodeURIComponent(handoffId)}/verifications?${accountQuery(accountId)}`, {
    method: 'POST', body: JSON.stringify(body),
  }),
  endpoint: (accountId: string) => fetchApi<{ endpoint: MynaEndpoint | null }>(
    `/api/custom/pharmacy/myna-endpoint?${accountQuery(accountId)}`,
  ),
  saveEndpoint: (accountId: string, body: { tenantAlias: string; endpointUrl: string; enabled: boolean }) =>
    fetchApi<{ endpoint: MynaEndpoint }>(`/api/custom/pharmacy/myna-endpoint?${accountQuery(accountId)}`, {
      method: 'PUT', body: JSON.stringify(body),
    }),
}
