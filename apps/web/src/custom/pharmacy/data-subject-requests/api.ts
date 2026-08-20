import { fetchApi } from '../../../lib/api'
import { accountQuery } from '../api'

export type DataSubjectRequestType = 'access' | 'correction' | 'suspension' | 'erasure'
export type DataSubjectRequestStatus =
  | 'received' | 'identity_verified' | 'legal_hold_assessed' | 'resolved' | 'rejected'

export type DataSubjectRequest = {
  id: string
  patient_id: string
  request_type: DataSubjectRequestType
  status: DataSubjectRequestStatus
  reason: string
  legal_hold: number | null
  legal_hold_basis: string | null
  legal_hold_release_at: string | null
  outcome_note: string | null
  version: number
  submitted_at: string
  identity_verified_at: string | null
  legal_hold_assessed_at: string | null
  resolved_at: string | null
  resolved_by: string | null
  updated_at: string
}

const path = '/api/custom/pharmacy/data-subject-requests'

export const dataSubjectRequestAdminApi = {
  list: (accountId: string) => fetchApi<{ requests: DataSubjectRequest[] }>(
    `${path}?${accountQuery(accountId)}`,
  ),
  create: (
    accountId: string,
    body: { patientId: string; requestType: DataSubjectRequestType; reason: string },
  ) => fetchApi<{ request: DataSubjectRequest }>(
    `${path}?${accountQuery(accountId)}`, { method: 'POST', body: JSON.stringify(body) },
  ),
  verifyIdentity: (accountId: string, requestId: string, expectedVersion: number) =>
    fetchApi<{ request: DataSubjectRequest }>(
      `${path}/${encodeURIComponent(requestId)}/identity-verification?${accountQuery(accountId)}`,
      { method: 'POST', body: JSON.stringify({ expectedVersion }) },
    ),
  assessLegalHold: (accountId: string, requestId: string, expectedVersion: number) =>
    fetchApi<{ request: DataSubjectRequest }>(
      `${path}/${encodeURIComponent(requestId)}/legal-hold-assessment?${accountQuery(accountId)}`,
      { method: 'POST', body: JSON.stringify({ expectedVersion }) },
    ),
  resolve: (
    accountId: string,
    requestId: string,
    body: { expectedVersion: number; decision: 'resolved' | 'rejected'; outcomeNote: string },
  ) => fetchApi<{ request: DataSubjectRequest }>(
    `${path}/${encodeURIComponent(requestId)}/resolution?${accountQuery(accountId)}`,
    { method: 'POST', body: JSON.stringify(body) },
  ),
}
