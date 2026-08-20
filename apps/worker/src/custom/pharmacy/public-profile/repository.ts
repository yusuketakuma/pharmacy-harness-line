export interface PharmacyPublicProfile {
  line_account_id: string;
  display_name: string;
  phone: string;
  postal_code: string;
  address: string;
  business_hours: string;
  closure_notice: string;
  access_note: string;
  parking_note: string;
  google_maps_url: string;
  updated_at: string | null;
}

export interface PharmacyPublicProfileInput {
  lineAccountId: string;
  staffId: string;
  displayName: string;
  phone: string;
  postalCode: string;
  address: string;
  businessHours: string;
  closureNotice: string;
  accessNote: string;
  parkingNote: string;
  googleMapsUrl: string;
}

const LIMITS = {
  displayName: 120, phone: 40, postalCode: 16, address: 500,
  businessHours: 2000, closureNotice: 1000, accessNote: 1000,
  parkingNote: 1000, googleMapsUrl: 2000,
} as const;

function validGoogleMapsUrl(value: string): boolean {
  if (!value) return true;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && (
      url.hostname === 'www.google.com' || url.hostname === 'google.com' ||
      url.hostname === 'maps.google.com' || url.hostname === 'www.google.co.jp' ||
      url.hostname === 'maps.app.goo.gl'
    );
  } catch {
    return false;
  }
}

function normalized(input: PharmacyPublicProfileInput) {
  return {
    displayName: input.displayName.trim(),
    phone: input.phone.trim(),
    postalCode: input.postalCode.trim(),
    address: input.address.trim(),
    businessHours: input.businessHours.trim(),
    closureNotice: input.closureNotice.trim(),
    accessNote: input.accessNote.trim(),
    parkingNote: input.parkingNote.trim(),
    googleMapsUrl: input.googleMapsUrl.trim(),
  };
}

export async function getPharmacyPublicProfile(
  db: D1Database,
  lineAccountId: string,
): Promise<PharmacyPublicProfile | null> {
  return db.prepare(
    `SELECT account.id AS line_account_id,
            COALESCE(profile.display_name, account.name) AS display_name,
            COALESCE(profile.phone, '') AS phone,
            COALESCE(profile.postal_code, '') AS postal_code,
            COALESCE(profile.address, '') AS address,
            COALESCE(profile.business_hours, '') AS business_hours,
            COALESCE(profile.closure_notice, '') AS closure_notice,
            COALESCE(profile.access_note, '') AS access_note,
            COALESCE(profile.parking_note, '') AS parking_note,
            COALESCE(profile.google_maps_url, '') AS google_maps_url,
            profile.updated_at
       FROM line_accounts account
       LEFT JOIN pharmacy_public_profiles profile ON profile.line_account_id = account.id
      WHERE account.id = ?`,
  ).bind(lineAccountId).first<PharmacyPublicProfile>();
}

export async function savePharmacyPublicProfile(
  db: D1Database,
  input: PharmacyPublicProfileInput,
): Promise<void> {
  const value = normalized(input);
  if (!value.displayName || !value.address || !value.businessHours ||
      Object.entries(value).some(([key, text]) => text.length > LIMITS[key as keyof typeof LIMITS]) ||
      (value.phone !== '' && !/^[0-9+-]+$/.test(value.phone)) ||
      !validGoogleMapsUrl(value.googleMapsUrl)) {
    throw new Error('invalid pharmacy public profile');
  }
  const now = new Date().toISOString();
  await db.prepare(
    `INSERT INTO pharmacy_public_profiles
       (line_account_id, display_name, phone, postal_code, address, business_hours,
        closure_notice, access_note, parking_note, google_maps_url, updated_by,
        created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (line_account_id) DO UPDATE SET
       display_name = excluded.display_name,
       phone = excluded.phone,
       postal_code = excluded.postal_code,
       address = excluded.address,
       business_hours = excluded.business_hours,
       closure_notice = excluded.closure_notice,
       access_note = excluded.access_note,
       parking_note = excluded.parking_note,
       google_maps_url = excluded.google_maps_url,
       updated_by = excluded.updated_by,
       updated_at = excluded.updated_at`,
  ).bind(
    input.lineAccountId, value.displayName, value.phone, value.postalCode,
    value.address, value.businessHours, value.closureNotice, value.accessNote,
    value.parkingNote, value.googleMapsUrl, input.staffId, now, now,
  ).run();
}
