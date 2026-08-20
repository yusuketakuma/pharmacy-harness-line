import { fetchApi } from '../../../lib/api'
import { accountQuery } from '../api'

export interface PharmacyPublicProfile {
  line_account_id: string
  display_name: string
  phone: string
  postal_code: string
  address: string
  business_hours: string
  closure_notice: string
  access_note: string
  parking_note: string
  google_maps_url: string
  updated_at: string | null
}

export interface PharmacyPublicProfileInput {
  displayName: string
  phone: string
  postalCode: string
  address: string
  businessHours: string
  closureNotice: string
  accessNote: string
  parkingNote: string
  googleMapsUrl: string
}

const path = '/api/custom/pharmacy/public-profile'

export const pharmacyPublicProfileAdminApi = {
  get: (accountId: string) => fetchApi<{ profile: PharmacyPublicProfile | null }>(
    `${path}?${accountQuery(accountId)}`,
  ),
  save: (accountId: string, body: PharmacyPublicProfileInput) => fetchApi<void>(
    `${path}?${accountQuery(accountId)}`,
    { method: 'PUT', body: JSON.stringify(body) },
  ),
}
