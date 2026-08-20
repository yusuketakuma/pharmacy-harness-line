import { requestPharmacyJson } from '../request.js';

export interface PharmacyPublicProfile {
  display_name: string;
  phone: string;
  postal_code: string;
  address: string;
  business_hours: string;
  closure_notice: string;
  access_note: string;
  parking_note: string;
  google_maps_url: string;
}

export const pharmacyPublicProfileApi = {
  get: () => requestPharmacyJson<{ profile: PharmacyPublicProfile }>(
    '/api/liff/pharmacy/public-profile',
    '薬局情報を取得できませんでした',
  ),
};
