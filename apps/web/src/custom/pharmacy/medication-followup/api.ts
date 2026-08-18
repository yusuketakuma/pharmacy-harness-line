import { fetchApi } from '../../../lib/api'
import { accountQuery } from '../api'

export type MedicationFollowUpStatus =
  | 'scheduled'
  | 'due'
  | 'delivered'
  | 'no_issue'
  | 'concern'
  | 'pharmacist_requested'
  | 'assigned'
  | 'responded'
  | 'escalated'
  | 'closed'
  | 'cancelled'

export type MedicationFollowUp = {
  id: string
  source_submission_id: string
  status: MedicationFollowUpStatus
  due_at: string
  delivered_at: string | null
  responded_at: string | null
  closed_at: string | null
  version: number
  created_at: string
  updated_at: string
}

export const medicationFollowUpApi = {
  schedule: (
    accountId: string,
    submissionId: string,
    dueAt: string,
    idempotencyKey: string,
  ) => fetchApi<{ followUp: MedicationFollowUp }>(
    `/api/custom/pharmacy/medication-followups?${accountQuery(accountId)}`,
    {
      method: 'POST',
      body: JSON.stringify({ submissionId, dueAt, idempotencyKey }),
    },
  ),
  transition: (
    accountId: string,
    followUpId: string,
    status: Extract<MedicationFollowUpStatus, 'assigned' | 'responded' | 'escalated' | 'closed' | 'cancelled'>,
    expectedVersion: number,
  ) => fetchApi<{ followUp: MedicationFollowUp }>(
    `/api/custom/pharmacy/medication-followups/${encodeURIComponent(followUpId)}/transitions?${accountQuery(accountId)}`,
    { method: 'POST', body: JSON.stringify({ status, expectedVersion }) },
  ),
}
