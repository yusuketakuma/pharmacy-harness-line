import { requestPharmacyJson } from '../request.js';

export interface PharmacyPublicProfile {
  display_name: string;
  phone: string;
  fax_number: string;
  postal_code: string;
  address: string;
  business_hours: string;
  closure_notice: string;
  access_note: string;
  parking_note: string;
  google_maps_url: string;
  prescription_reception_hours: string;
  after_hours_note: string;
  services_note: string;
  accessibility_note: string;
  supported_languages: string;
  payment_methods: string;
  website_url: string;
  updated_at: string | null;
}

export const pharmacyPublicProfileApi = {
  get: () => requestPharmacyJson<{ profile: PharmacyPublicProfile }>(
    '/api/liff/pharmacy/public-profile',
    '薬局情報を取得できませんでした',
  ),
};
