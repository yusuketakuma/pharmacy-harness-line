import { fetchApi } from '../../../lib/api'
import { accountQuery } from '../api'

export interface TenantPrivacyPolicy {
  line_account_id: string
  purpose_text: string
  purpose_url: string
  contact_point: string
  entrustment_text: string
  policy_version: number
  content_hash: string
  updated_at: string
}

export interface TenantPrivacyPolicyInput {
  purposeText: string
  purposeUrl: string
  contactPoint: string
  entrustmentText: string
}

const path = '/api/custom/pharmacy/privacy-policy'

export const pharmacyPrivacyPolicyApi = {
  get: (accountId: string) => fetchApi<{ policy: TenantPrivacyPolicy | null }>(
    `${path}?${accountQuery(accountId)}`,
  ),
  save: (accountId: string, body: TenantPrivacyPolicyInput) => fetchApi<void>(
    `${path}?${accountQuery(accountId)}`,
    { method: 'PUT', body: JSON.stringify(body) },
  ),
}
