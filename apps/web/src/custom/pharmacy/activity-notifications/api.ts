import { fetchApi } from '../../../lib/api';
import { accountQuery } from '../api';

export type PharmacyActivityType =
  | 'prescription_received'
  | 'prescription_status_changed'
  | 'fulfillment_quote_created'
  | 'myna_handoff_received';

export interface PharmacyActivityNotification {
  id: string;
  line_account_id: string;
  activity_type: PharmacyActivityType;
  acknowledged_by: string | null;
  acknowledged_at: string | null;
  created_at: string;
  updated_at: string;
}

const path = (accountId: string) => `/api/custom/pharmacy/activity-notifications?${accountQuery(accountId)}`;

export const pharmacyActivityApi = {
  list: (accountId: string) => fetchApi<{ notifications: PharmacyActivityNotification[] }>(path(accountId)),
  acknowledge: (accountId: string, id: string) => fetchApi<{ notification: PharmacyActivityNotification }>(
    `/api/custom/pharmacy/activity-notifications/${encodeURIComponent(id)}/ack?${accountQuery(accountId)}`,
    { method: 'POST' },
  ),
};

export const activityTypeLabel: Record<PharmacyActivityType, string> = {
  prescription_received: '処方せんを受信',
  prescription_status_changed: '受付状態が更新',
  fulfillment_quote_created: '準備可否を更新',
  myna_handoff_received: 'マイナ受付を確認',
};
