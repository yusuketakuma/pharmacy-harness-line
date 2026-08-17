import { fetchApi } from '../../../lib/api'
import { accountQuery } from '../api'

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

export type NextIntakeExpectation = {
  id: string
  obligation_id: string
  patient_id: string
  status: 'offered' | 'accepted' | 'active' | 'reminded' | 'linked' | 'fulfilled' | 'paused' | 'ended'
  timing_source: 'manual_supply_days' | 'manual_window'
  supply_days: number | null
  expected_from: string
  expected_to: string
  reminder_at: string
  reminded_at: string | null
  version: number
  created_at: string
  updated_at: string
}

export type NextIntakeOffer =
  | { timingSource: 'manual_supply_days'; supplyDays: number }
  | { timingSource: 'manual_window'; expectedFrom: string; expectedTo: string; reminderAt: string }

export const continuityAdminApi = {
  list: (accountId: string) => fetchApi<{
    obligations: ContinuityObligation[]
    expectations: NextIntakeExpectation[]
  }>(
    `/api/custom/pharmacy/continuity?${accountQuery(accountId)}`,
  ),
  offer: (accountId: string, obligationId: string, offer: NextIntakeOffer) =>
    fetchApi<{ expectation: NextIntakeExpectation }>(
      `/api/custom/pharmacy/continuity/${encodeURIComponent(obligationId)}/expectations?${accountQuery(accountId)}`,
      {
        method: 'POST',
        body: JSON.stringify({ ...offer, idempotencyKey: crypto.randomUUID() }),
      },
    ),
}
