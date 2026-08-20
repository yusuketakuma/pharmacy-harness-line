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
  prescription_reception_hours: string
  after_hours_note: string
  services_note: string
  accessibility_note: string
  supported_languages: string
  payment_methods: string
  website_url: string
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
  prescriptionReceptionHours: string
  afterHoursNote: string
  servicesNote: string
  accessibilityNote: string
  supportedLanguages: string
  paymentMethods: string
  websiteUrl: string
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
