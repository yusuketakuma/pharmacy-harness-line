import { fetchApi } from '../../../lib/api'

export type ContinuityObligation = {
  id: string
  patient_id: string
  source_submission_id: string
  candidate_submission_id: string | null
  status: 'active' | 'linked' | 'fulfilled' | 'paused' | 'ended'
  expected_next_from: string
  expected_next_to: string
  next_contact_at: string
  reminder_count: number
  updated_at: string
}

export const continuityAdminApi = {
  list: (accountId: string) => fetchApi<{ obligations: ContinuityObligation[] }>(
    `/api/custom/pharmacy/continuity?line_account_id=${encodeURIComponent(accountId)}`,
  ),
}
