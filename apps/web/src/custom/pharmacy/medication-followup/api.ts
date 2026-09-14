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
  question_set_version: number
  response_deadline_at: string | null
  delivered_at: string | null
  responded_at: string | null
  assigned_to: string | null
  closed_at: string | null
  version: number
  created_at: string
  updated_at: string
}

export type MedicationFollowUpContact = {
  channel: 'line' | 'phone'
  outcomeCode: 'answered' | 'no_answer' | 'resolved' | 'follow_up_required' | 'escalated'
  nextContactAt?: string | null
  idempotencyKey: string
}

export type MedicationFollowUpAssignee = {
  id: string
  name: string
  role: 'owner' | 'admin' | 'staff'
}

export const medicationFollowUpApi = {
  listAssignees: (accountId: string) => fetchApi<{ assignees: MedicationFollowUpAssignee[] }>(
    `/api/custom/pharmacy/medication-followups/assignees?${accountQuery(accountId)}`,
  ),
  schedule: (
    accountId: string,
    submissionId: string,
    dueAt: string,
    idempotencyKey: string,
    responseDeadlineAt?: string | null,
  ) => fetchApi<{ followUp: MedicationFollowUp }>(
    `/api/custom/pharmacy/medication-followups?${accountQuery(accountId)}`,
    {
      method: 'POST',
      body: JSON.stringify({
        submissionId, dueAt, idempotencyKey,
        ...(responseDeadlineAt !== undefined ? { responseDeadlineAt } : {}),
      }),
    },
  ),
  transition: (
    accountId: string,
    followUpId: string,
    status: Extract<MedicationFollowUpStatus, 'assigned' | 'responded' | 'escalated' | 'closed' | 'cancelled'>,
    expectedVersion: number,
    contact?: MedicationFollowUpContact,
    assigneeStaffId?: string | null,
  ) => fetchApi<{ followUp: MedicationFollowUp }>(
    `/api/custom/pharmacy/medication-followups/${encodeURIComponent(followUpId)}/transitions?${accountQuery(accountId)}`,
    {
      method: 'POST',
      body: JSON.stringify({
        status, expectedVersion,
        ...(contact ? { contact } : {}),
        ...(assigneeStaffId !== undefined ? { assigneeStaffId } : {}),
      }),
    },
  ),
  recordContact: (
    accountId: string,
    followUpId: string,
    contact: MedicationFollowUpContact,
    expectedVersion: number,
  ) => fetchApi<{ contact: Omit<MedicationFollowUpContact, 'outcomeCode' | 'nextContactAt' | 'idempotencyKey'> & {
    outcome_code: MedicationFollowUpContact['outcomeCode']
    next_contact_at: string | null
    occurred_at: string
  } }>(
    `/api/custom/pharmacy/medication-followups/${encodeURIComponent(followUpId)}/contacts?${accountQuery(accountId)}`,
    {
      method: 'POST',
      body: JSON.stringify({
        channel: contact.channel,
        outcomeCode: contact.outcomeCode,
        ...(contact.nextContactAt !== undefined ? { nextContactAt: contact.nextContactAt } : {}),
        idempotencyKey: contact.idempotencyKey,
        expectedVersion,
      }),
    },
  ),
}
