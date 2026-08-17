import { fetchApi } from '../../../lib/api'
import { accountQuery } from '../api'

export type PharmacyActivityType =
  | 'prescription_received'
  | 'prescription_status_changed'
  | 'fulfillment_quote_created'
  | 'myna_handoff_received'
  | 'patient_message_received'
  | 'continuity_due'
  | 'manual_activity'

export interface PharmacyActivityNotification {
  id: string
  line_account_id: string
  staff_id: string
  activity_type: PharmacyActivityType
  status: 'unread' | 'claimed' | 'acknowledged'
  created_at: string
  updated_at: string
}

const path = (accountId: string) => `/api/custom/pharmacy/activity-notifications?${accountQuery(accountId)}`

export const pharmacyActivityApi = {
  list: (accountId: string) => fetchApi<{ notifications: PharmacyActivityNotification[] }>(path(accountId)),
  claim: (accountId: string, id: string) => fetchApi<{ notification: PharmacyActivityNotification }>(
    `/api/custom/pharmacy/activity-notifications/${encodeURIComponent(id)}/claim?${accountQuery(accountId)}`,
    { method: 'POST' },
  ),
  acknowledge: (accountId: string, id: string) => fetchApi<{ notification: PharmacyActivityNotification }>(
    `/api/custom/pharmacy/activity-notifications/${encodeURIComponent(id)}/ack?${accountQuery(accountId)}`,
    { method: 'POST' },
  ),
}

export const activityTypeLabel: Record<PharmacyActivityType, string> = {
  prescription_received: '処方せんを受信',
  prescription_status_changed: '受付状態が更新',
  fulfillment_quote_created: '準備可否を更新',
  myna_handoff_received: 'マイナ受付を確認',
  patient_message_received: '患者からメッセージ',
  continuity_due: '継続対応の時期',
  manual_activity: '薬局内メモ',
}
