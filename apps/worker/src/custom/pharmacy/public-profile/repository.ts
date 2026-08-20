export interface PharmacyPublicProfile {
  line_account_id: string;
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

export interface PharmacyPublicProfileInput {
  lineAccountId: string;
  staffId: string;
  displayName: string;
  phone: string;
  faxNumber: string;
  postalCode: string;
  address: string;
  businessHours: string;
  closureNotice: string;
  accessNote: string;
  parkingNote: string;
  googleMapsUrl: string;
  prescriptionReceptionHours: string;
  afterHoursNote: string;
  servicesNote: string;
  accessibilityNote: string;
  supportedLanguages: string;
  paymentMethods: string;
  websiteUrl: string;
}

const LIMITS = {
  displayName: 120, phone: 40, faxNumber: 40, postalCode: 16, address: 500,
  businessHours: 2000, closureNotice: 1000, accessNote: 1000,
  parkingNote: 1000, googleMapsUrl: 2000,
  prescriptionReceptionHours: 2000, afterHoursNote: 1000, servicesNote: 2000,
  accessibilityNote: 1000, supportedLanguages: 1000, paymentMethods: 1000,
  websiteUrl: 2000,
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

function validWebsiteUrl(value: string): boolean {
  if (!value) return true;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password;
  } catch {
    return false;
  }
}

function validContactNumber(value: string): boolean {
  return value === '' || /^[0-9+-]+$/.test(value);
}

function normalized(input: PharmacyPublicProfileInput) {
  return {
    displayName: input.displayName.trim(),
    phone: input.phone.trim(),
    faxNumber: input.faxNumber.trim(),
    postalCode: input.postalCode.trim(),
    address: input.address.trim(),
    businessHours: input.businessHours.trim(),
    closureNotice: input.closureNotice.trim(),
    accessNote: input.accessNote.trim(),
    parkingNote: input.parkingNote.trim(),
    googleMapsUrl: input.googleMapsUrl.trim(),
    prescriptionReceptionHours: input.prescriptionReceptionHours.trim(),
    afterHoursNote: input.afterHoursNote.trim(),
    servicesNote: input.servicesNote.trim(),
    accessibilityNote: input.accessibilityNote.trim(),
    supportedLanguages: input.supportedLanguages.trim(),
    paymentMethods: input.paymentMethods.trim(),
    websiteUrl: input.websiteUrl.trim(),
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
            COALESCE(profile.fax_number, '') AS fax_number,
            COALESCE(profile.postal_code, '') AS postal_code,
            COALESCE(profile.address, '') AS address,
            COALESCE(profile.business_hours, '') AS business_hours,
            COALESCE(profile.closure_notice, '') AS closure_notice,
            COALESCE(profile.access_note, '') AS access_note,
            COALESCE(profile.parking_note, '') AS parking_note,
            COALESCE(profile.google_maps_url, '') AS google_maps_url,
            COALESCE(profile.prescription_reception_hours, '') AS prescription_reception_hours,
            COALESCE(profile.after_hours_note, '') AS after_hours_note,
            COALESCE(profile.services_note, '') AS services_note,
            COALESCE(profile.accessibility_note, '') AS accessibility_note,
            COALESCE(profile.supported_languages, '') AS supported_languages,
            COALESCE(profile.payment_methods, '') AS payment_methods,
            COALESCE(profile.website_url, '') AS website_url,
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
      !validContactNumber(value.phone) || !validContactNumber(value.faxNumber) ||
      !validGoogleMapsUrl(value.googleMapsUrl) || !validWebsiteUrl(value.websiteUrl)) {
    throw new Error('invalid pharmacy public profile');
  }
  const now = new Date().toISOString();
  await db.prepare(
    `INSERT INTO pharmacy_public_profiles
       (line_account_id, display_name, phone, fax_number, postal_code, address, business_hours,
        closure_notice, access_note, parking_note, google_maps_url,
        prescription_reception_hours, after_hours_note, services_note,
        accessibility_note, supported_languages, payment_methods, website_url,
        updated_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (line_account_id) DO UPDATE SET
       display_name = excluded.display_name,
       phone = excluded.phone,
       fax_number = excluded.fax_number,
       postal_code = excluded.postal_code,
       address = excluded.address,
       business_hours = excluded.business_hours,
       closure_notice = excluded.closure_notice,
       access_note = excluded.access_note,
       parking_note = excluded.parking_note,
       google_maps_url = excluded.google_maps_url,
       prescription_reception_hours = excluded.prescription_reception_hours,
       after_hours_note = excluded.after_hours_note,
       services_note = excluded.services_note,
       accessibility_note = excluded.accessibility_note,
       supported_languages = excluded.supported_languages,
       payment_methods = excluded.payment_methods,
       website_url = excluded.website_url,
       updated_by = excluded.updated_by,
       updated_at = excluded.updated_at`,
  ).bind(
    input.lineAccountId, value.displayName, value.phone, value.faxNumber, value.postalCode,
    value.address, value.businessHours, value.closureNotice, value.accessNote,
    value.parkingNote, value.googleMapsUrl, value.prescriptionReceptionHours,
    value.afterHoursNote, value.servicesNote, value.accessibilityNote,
    value.supportedLanguages, value.paymentMethods, value.websiteUrl,
    input.staffId, now, now,
  ).run();
}
