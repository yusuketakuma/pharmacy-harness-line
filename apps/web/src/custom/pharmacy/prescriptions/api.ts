import { fetchApi, getCsrfToken } from '../../../lib/api'
import { accountQuery } from '../api'

export type PrescriptionStatus =
  | 'draft'
  | 'received'
  | 'needs_resubmission'
  | 'accepted'
  | 'ready'
  | 'closed'
  | 'cancelled'

export type PrescriptionAdminAction =
  | 'accept'
  | 'request_resubmission'
  | 'ready'
  | 'close'
  | 'cancel'

export interface PrescriptionQueueItem {
  id: string
  friend_id: string
  status: PrescriptionStatus
  desired_pickup_at: string | null
  requested_at: string | null
  created_at: string
  updated_at: string
}

export interface PrescriptionFile {
  id: string
  revision: number
  position: number
  content_type: string
  byte_size: number
  state: string
  created_at: string
  updated_at: string
}

export interface PrescriptionEvent {
  id: string
  actor_type: string
  actor_id: string | null
  event_type: string
  from_status: PrescriptionStatus | null
  to_status: PrescriptionStatus | null
  reason_code: string | null
  revision: number | null
  created_at: string
}

export interface PrescriptionDetail {
  submission: PrescriptionQueueItem & {
    active_revision: number | null
    upload_revision: number
    resubmission_reason_code: string | null
    closed_at: string | null
  }
  files: PrescriptionFile[]
  events: PrescriptionEvent[]
}

export type PrescriptionNotificationStatus = 'sent' | 'already_sent' | 'failed' | 'skipped' | 'superseded'

export interface PrescriptionActionResult {
  status: PrescriptionStatus
  statusEventId: string
  notification: { status: PrescriptionNotificationStatus }
  continuity?: 'completed' | 'retry_pending'
}

export interface PrescriptionStats {
  pending_count: number
  oldest_wait_at: string | null
}

export type FulfillmentDecision =
  | 'fulfillable'
  | 'conditional'
  | 'needs_confirmation'
  | 'not_fulfillable'

export type FulfillmentStatus =
  | 'CHECKING'
  | 'AVAILABLE'
  | 'PARTIALLY_AVAILABLE'
  | 'UNAVAILABLE'
  | 'PHARMACIST_REVIEW_REQUIRED'

export type FulfillmentMethod =
  | 'PICKUP'
  | 'DELIVERY'
  | 'HOME_VISIT'
  | 'FACILITY_DELIVERY'

export interface FulfillmentQuote {
  id: string
  submission_id: string
  line_account_id: string
  revision: number
  decision: FulfillmentDecision
  reasonCodes: string[]
  requirements: Array<{ code: string; status: 'pending' | 'satisfied' }>
  status: FulfillmentStatus
  fulfillmentMethod: FulfillmentMethod | null
  constraints: string[]
  reservationExpiresAt: string | null
  confirmedBy: string | null
  confirmedAt: string | null
  estimatedReadyAt: string | null
  validUntil: string | null
  created_by: string
  created_at: string
}

const apiBase = process.env.NEXT_PUBLIC_API_URL
if (!apiBase) throw new Error('NEXT_PUBLIC_API_URL is not set')

export const prescriptionAdminApi = {
  list: (accountId: string, cursor?: string) => fetchApi<{
    items: PrescriptionQueueItem[]
    nextCursor: string | null
  }>(
    `/api/custom/pharmacy/prescriptions?${accountQuery(accountId)}&limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
  ),
  stats: (accountId: string) => fetchApi<{ stats: PrescriptionStats }>(
    `/api/custom/pharmacy/prescriptions/stats?${accountQuery(accountId)}`,
  ),
  detail: (accountId: string, submissionId: string) => fetchApi<PrescriptionDetail>(
    `/api/custom/pharmacy/prescriptions/${encodeURIComponent(submissionId)}?${accountQuery(accountId)}`,
  ),
  fulfillmentQuote: (accountId: string, submissionId: string) => fetchApi<{ quote: FulfillmentQuote | null }>(
    `/api/custom/pharmacy/fulfillment-quotes/${encodeURIComponent(submissionId)}?${accountQuery(accountId)}`,
  ),
  saveFulfillmentQuote: (
    accountId: string,
    submissionId: string,
    body: Pick<FulfillmentQuote, 'decision' | 'reasonCodes' | 'requirements' | 'estimatedReadyAt' | 'validUntil'> &
      Partial<Pick<FulfillmentQuote, 'status' | 'fulfillmentMethod' | 'constraints' | 'reservationExpiresAt'>>,
  ) => fetchApi<{ quote: FulfillmentQuote }>(
    `/api/custom/pharmacy/fulfillment-quotes/${encodeURIComponent(submissionId)}?${accountQuery(accountId)}`,
    { method: 'POST', body: JSON.stringify(body) },
  ),
  action: (
    accountId: string,
    submissionId: string,
    action: PrescriptionAdminAction,
    expectedUpdatedAt: string,
    reasonCode?: string,
    operationId?: string,
  ) => fetchApi<PrescriptionActionResult>(
    `/api/custom/pharmacy/prescriptions/${encodeURIComponent(submissionId)}/actions/${action}?${accountQuery(accountId)}`,
    {
      method: 'POST',
      body: JSON.stringify({
        expectedUpdatedAt,
        reasonCode: reasonCode ?? null,
        operationId: operationId ?? null,
      }),
    },
  ),
  image: async (accountId: string, submissionId: string, fileId: string) => {
    const response = await fetch(
      `${apiBase}/api/custom/pharmacy/prescriptions/${encodeURIComponent(submissionId)}/files/${encodeURIComponent(fileId)}?${accountQuery(accountId)}`,
      {
        credentials: 'include',
        headers: { 'X-CSRF-Token': getCsrfToken(), 'Cache-Control': 'no-store' },
        cache: 'no-store',
      },
    )
    if (!response.ok) {
      const error = new Error(`Prescription image API ${response.status}`) as Error & { status: number }
      error.status = response.status
      throw error
    }
    return response.blob()
  },
}
