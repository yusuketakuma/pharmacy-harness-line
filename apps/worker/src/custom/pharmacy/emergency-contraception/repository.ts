import { openEmergencyPayload, sealEmergencyPayload } from './encryption.js';
import {
  assessEmergencyPrecheck, getChecklistVersion, validMenstruationSignals,
  type EmergencyDetailFlag, type EmergencyMenstruationSignals, type EmergencyRiskFlag,
} from './policy.js';
import { hasPharmacyCapability } from '../growth-loop/access.js';

export type EmergencyIntakeStatus =
  | 'provisional'
  | 'reviewed'
  | 'completed'
  | 'cancelled'
  | 'expired';

export type EmergencySafeContactMode = 'neutral_line' | 'no_notification' | 'phone' | 'none';

interface EmergencyIntakeRow {
  id: string;
  reference_code: string;
  tenant_id: string;
  line_account_id: string;
  owner_friend_id: string;
  slot_id: string;
  status: EmergencyIntakeStatus;
  encrypted_payload: string;
  payload_key_version: number;
  product_code: string;
  age_band: 'under_16' | '16_17' | 'adult';
  safe_contact_mode: EmergencySafeContactMode;
  consent_version: string;
  risk_flags_json: string;
  expires_at: string;
  reviewed_by: string | null;
  reviewed_at: string | null;
  closed_by: string | null;
  closed_at: string | null;
  version: number;
  created_at: string;
  updated_at: string;
  slot_starts_at: string;
  slot_ends_at: string;
}

type EmergencyProjectionRow = Pick<EmergencyIntakeRow,
  'id' | 'reference_code' | 'slot_id' | 'status' | 'age_band' |
  'safe_contact_mode' | 'consent_version' | 'risk_flags_json' | 'expires_at' |
  'version' | 'created_at' | 'updated_at' | 'slot_starts_at' | 'slot_ends_at'>;

type AdminEmergencyQueueRow = Pick<EmergencyIntakeRow,
  'id' | 'reference_code' | 'slot_id' | 'status' | 'expires_at' | 'version' |
  'created_at' | 'slot_starts_at' | 'slot_ends_at'>;

export interface AdminEmergencyQueueItem {
  id: string;
  reference_code: string;
  slot_id: string;
  status: EmergencyIntakeStatus;
  expires_at: string;
  version: number;
  slot_starts_at: string;
  slot_ends_at: string;
}

// Patient-facing shape returned by listOwnerEmergencyIntakes: no age_band,
// safe_contact_mode, consent_version, or risk_flags (see docs/pharmacy/EC_PREVISIT_FORM.md §4).
export interface EmergencyOwnerIntakeProjection {
  id: string;
  reference_code: string;
  slot_id: string;
  status: EmergencyIntakeStatus;
  expires_at: string;
  version: number;
  created_at: string;
  updated_at: string;
  slot_starts_at: string;
  slot_ends_at: string;
}

export interface EmergencyIntakeProjection extends EmergencyOwnerIntakeProjection {
  age_band: EmergencyIntakeRow['age_band'];
  safe_contact_mode: EmergencySafeContactMode;
  consent_version: string;
  risk_flags: EmergencyRiskFlag[];
}

export interface AdminEmergencyIntake extends EmergencyIntakeProjection {
  // NEXT-2: once retention-purge.ts has redacted encrypted_payload (past the
  // account's retention_days), there is nothing left to decrypt. self_reported
  // is null and redacted is true instead of decrypting and throwing.
  redacted: boolean;
  self_reported: {
    intercourseAt: string;
    intercourseTimeUnknown: boolean;
    // Payload schema_version 2 fields (A3/A4/A5/A', B1-B4, C1/C2, D3). v1 rows
    // (sealed before this change) map these to null instead of throwing.
    lngAllergy: boolean | null;
    liverDisease: boolean | null;
    currentlyPregnant: boolean | null;
    breastfeeding: boolean | null;
    underMedicalTreatment: boolean | null;
    drugAllergyHistory: boolean | null;
    heartKidneyGiDisease: boolean | null;
    stJohnsWort: boolean | null;
    lastMenstruationDate: string | null;
    menstruationSignals: EmergencyMenstruationSignals | null;
    // Pharmacist-only computed signal (see docs/pharmacy/EC_PREVISIT_FORM.md §3
    // row C2) — never shown to the patient, never in risk_flags_json.
    pregnancyTestRecommended: boolean | null;
    idDocumentAvailable: boolean | null;
    detailFlags: EmergencyDetailFlag[] | null;
    checklistVersion: string | null;
    consentContentHash: string | null;
  } | null;
}

export interface CreateEmergencyIntakeInput {
  tenantId: string;
  lineAccountId: string;
  friendId: string;
  slotId: string;
  intercourseAt: string;
  intercourseTimeUnknown: boolean;
  age: number;
  recentPurchaseCount: number;
  patientWillVisit: boolean;
  acceptsInPersonDose: boolean;
  safeContactMode: EmergencySafeContactMode;
  consentVersion: string;
  consentContentHash: string;
  manufacturerCheckAcknowledged: boolean;
  idempotencyKey: string;
  encryptionSecret: string;
  lngAllergy?: boolean;
  liverDisease?: boolean;
  currentlyPregnant?: boolean;
  breastfeeding?: boolean;
  underMedicalTreatment?: boolean;
  drugAllergyHistory?: boolean;
  heartKidneyGiDisease?: boolean;
  stJohnsWort?: boolean;
  lastMenstruationDate?: string | null;
  menstruationSignals?: EmergencyMenstruationSignals;
  idDocumentAvailable?: boolean | null;
  now?: Date;
}

export interface EmergencyServiceOverview {
  ready: boolean;
  reason: 'not_configured' | 'paused' | 'requirements_incomplete' | 'out_of_stock' | 'no_slots' | null;
  consent: null | {
    version: string;
    purpose: string;
    retention_days: number;
    privacy_policy_url: string;
    privacy_contact: string;
    text_v2: string;
    content_hash: string;
  };
  manufacturer_check_url: string | null;
  partner_clinic_url: string | null;
  support_center_url: string | null;
  slots: Array<{ id: string; starts_at: string; ends_at: string; remaining: number }>;
}

interface EmergencySettingsRow {
  line_account_id: string;
  is_enabled: number;
  pharmacy_registration_number: string;
  product_code: string;
  manufacturer_check_url: string;
  privacy_policy_url: string;
  privacy_contact: string;
  purpose_text: string;
  consent_version: string;
  retention_days: number;
  consultation_minutes: number;
  reservation_ttl_minutes: number;
  privacy_space_ready: number;
  drinking_water_ready: number;
  partner_clinic_url: string;
  support_center_url: string;
  updated_by: string;
  created_at: string;
  updated_at: string;
}

const INTAKE_SELECT = `
  SELECT intake.id, intake.reference_code, intake.tenant_id, intake.line_account_id,
         intake.owner_friend_id, intake.slot_id, intake.status, intake.encrypted_payload,
         intake.payload_key_version, intake.product_code, intake.age_band, intake.safe_contact_mode,
         intake.consent_version, intake.risk_flags_json, intake.expires_at,
         intake.reviewed_by, intake.reviewed_at, intake.closed_by, intake.closed_at,
         intake.version, intake.created_at, intake.updated_at,
         slot.starts_at AS slot_starts_at, slot.ends_at AS slot_ends_at
    FROM pharmacy_emergency_intakes AS intake
    INNER JOIN pharmacy_emergency_slots AS slot
            ON slot.id = intake.slot_id AND slot.line_account_id = intake.line_account_id`;

const ADMIN_QUEUE_SELECT = `
  SELECT intake.id, intake.reference_code, intake.slot_id, intake.status,
         intake.expires_at, intake.version, intake.created_at,
         slot.starts_at AS slot_starts_at, slot.ends_at AS slot_ends_at
    FROM pharmacy_emergency_intakes AS intake
    INNER JOIN pharmacy_emergency_slots AS slot
            ON slot.id = intake.slot_id AND slot.line_account_id = intake.line_account_id`;

const SAFE_CONTACT_MODES = new Set<EmergencySafeContactMode>([
  'neutral_line', 'no_notification', 'phone', 'none',
]);

function validHttpsUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && Boolean(url.hostname);
  } catch {
    return false;
  }
}

// Consent v2 (see docs/pharmacy/EC_PREVISIT_FORM.md §3 row E and §4): the patient
// projection cannot prove which exact wording a purpose_text/consent_version pair
// stood for, since either can be edited independently in pharmacy_emergency_settings.
// text_v2 is a server-owned constant (never authored, never stored) and
// content_hash binds it to the account's retention_days and consent_version, so a
// hash mismatch at create time proves the settings changed underneath the patient.
export function emergencyConsentTextV2(retentionDays: number): string {
  return `申告内容は来局時に薬剤師が対面で再確認し、最終的な判断は店頭で薬剤師が行います。` +
    `申告内容の保存期間は${retentionDays}日間です。` +
    `薬剤師が作成する販売記録は法令により3年間保存され、申告内容とは別に扱われます。` +
    `服用から3週間後を目安に、検査薬または受診で結果をご確認いただくご案内をお送りします。`;
}

export async function emergencyConsentContentHash(input: {
  retentionDays: number;
  consentVersion: string;
}): Promise<string> {
  const canonical = JSON.stringify([
    emergencyConsentTextV2(input.retentionDays), input.retentionDays, input.consentVersion,
  ]);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function settingsComplete(settings: EmergencySettingsRow): boolean {
  return Boolean(
    settings.pharmacy_registration_number.trim() && settings.product_code.trim() &&
    settings.consent_version.trim() && settings.privacy_contact.trim() && settings.purpose_text.trim() &&
    validHttpsUrl(settings.manufacturer_check_url) &&
    validHttpsUrl(settings.privacy_policy_url) &&
    validHttpsUrl(settings.partner_clinic_url) &&
    validHttpsUrl(settings.support_center_url) &&
    settings.privacy_space_ready === 1 && settings.drinking_water_ready === 1,
  );
}

export async function getEmergencyServiceOverview(
  db: D1Database,
  lineAccountId: string,
  now = new Date(),
): Promise<EmergencyServiceOverview> {
  await expireEmergencyIntakes(db, lineAccountId, now);
  const settings = await db.prepare(
    `SELECT line_account_id, is_enabled, pharmacy_registration_number, product_code,
            manufacturer_check_url, privacy_policy_url, privacy_contact, consent_version,
            purpose_text,
            retention_days, consultation_minutes, reservation_ttl_minutes,
            privacy_space_ready, drinking_water_ready, partner_clinic_url,
            support_center_url, updated_by, created_at, updated_at
       FROM pharmacy_emergency_settings WHERE line_account_id = ?`,
  ).bind(lineAccountId).first<EmergencySettingsRow>();
  if (!settings) {
    return {
      ready: false, reason: 'not_configured', consent: null,
      manufacturer_check_url: null, partner_clinic_url: null, support_center_url: null, slots: [],
    };
  }
  const publicBase = {
    consent: {
      version: settings.consent_version,
      purpose: settings.purpose_text,
      retention_days: settings.retention_days,
      privacy_policy_url: settings.privacy_policy_url,
      privacy_contact: settings.privacy_contact,
      text_v2: emergencyConsentTextV2(settings.retention_days),
      content_hash: await emergencyConsentContentHash({
        retentionDays: settings.retention_days,
        consentVersion: settings.consent_version,
      }),
    },
    manufacturer_check_url: settings.manufacturer_check_url,
    partner_clinic_url: settings.partner_clinic_url,
    support_center_url: settings.support_center_url,
  };
  if (settings.is_enabled !== 1) return { ready: false, reason: 'paused', ...publicBase, slots: [] };
  if (!settingsComplete(settings)) {
    return { ready: false, reason: 'requirements_incomplete', ...publicBase, slots: [] };
  }
  const stock = await db.prepare(
    `SELECT inventory.on_hand - COUNT(active.id) AS remaining
       FROM pharmacy_emergency_inventory AS inventory
       LEFT JOIN pharmacy_emergency_intakes AS active
              ON active.line_account_id = inventory.line_account_id
             AND active.product_code = inventory.product_code
             AND active.status IN ('provisional', 'reviewed')
             AND active.expires_at > ?
      WHERE inventory.line_account_id = ? AND inventory.product_code = ?
      GROUP BY inventory.on_hand`,
  ).bind(now.toISOString(), lineAccountId, settings.product_code).first<{ remaining: number }>();
  if (!stock || stock.remaining <= 0) {
    return { ready: false, reason: 'out_of_stock', ...publicBase, slots: [] };
  }
  const rows = await db.prepare(
    `SELECT slot.id, slot.starts_at, slot.ends_at, slot.capacity - COUNT(active.id) AS remaining
       FROM pharmacy_emergency_slots AS slot
       INNER JOIN pharmacy_emergency_pharmacists AS pharmacist
               ON pharmacist.line_account_id = slot.line_account_id
              AND pharmacist.staff_id = slot.pharmacist_staff_id AND pharmacist.is_active = 1
       INNER JOIN pharmacy_staff_accounts AS assignment
               ON assignment.line_account_id = pharmacist.line_account_id
              AND assignment.staff_id = pharmacist.staff_id AND assignment.is_active = 1
       LEFT JOIN pharmacy_emergency_intakes AS active
              ON active.line_account_id = slot.line_account_id AND active.slot_id = slot.id
             AND active.status IN ('provisional', 'reviewed') AND active.expires_at > ?
      WHERE slot.line_account_id = ? AND slot.status = 'open' AND slot.starts_at > ?
      GROUP BY slot.id, slot.starts_at, slot.ends_at, slot.capacity
      ORDER BY slot.starts_at, slot.id`,
  ).bind(now.toISOString(), lineAccountId, now.toISOString()).all<{
    id: string;
    starts_at: string;
    ends_at: string;
    remaining: number;
  }>();
  let remainingStock = stock.remaining;
  const slots = rows.results.flatMap((slot) => {
    if (slot.remaining <= 0 || remainingStock <= 0) return [];
    const remaining = Math.min(slot.remaining, remainingStock);
    remainingStock -= remaining;
    return [{ ...slot, remaining }];
  });
  return {
    ready: slots.length > 0,
    reason: slots.length > 0 ? null : 'no_slots',
    ...publicBase,
    slots,
  };
}

export async function getEmergencyAdminConfig(
  db: D1Database,
  lineAccountId: string,
): Promise<{
  settings: EmergencySettingsRow | null;
  available_staff: Array<{ staff_id: string; name: string }>;
  pharmacists: Array<{ staff_id: string; name: string; training_registration_number: string; is_active: number }>;
  inventory: Array<{ product_code: string; on_hand: number; version: number; updated_at: string }>;
  slots: Array<{ id: string; pharmacist_staff_id: string; starts_at: string; ends_at: string; status: string; capacity: number; version: number }>;
}> {
  const [settings, availableStaff, pharmacists, inventory, slots] = await Promise.all([
    db.prepare(`SELECT * FROM pharmacy_emergency_settings WHERE line_account_id = ?`)
      .bind(lineAccountId).first<EmergencySettingsRow>(),
    db.prepare(
      `SELECT assignment.staff_id, staff.name
         FROM pharmacy_staff_accounts AS assignment
         INNER JOIN staff_members AS staff
                 ON staff.id = assignment.staff_id AND staff.is_active = 1
        WHERE assignment.line_account_id = ? AND assignment.is_active = 1
        ORDER BY staff.name, assignment.staff_id`,
    ).bind(lineAccountId).all<{ staff_id: string; name: string }>(),
    db.prepare(
      `SELECT pharmacist.staff_id, staff.name, pharmacist.training_registration_number,
              pharmacist.is_active
         FROM pharmacy_emergency_pharmacists AS pharmacist
         INNER JOIN staff_members AS staff ON staff.id = pharmacist.staff_id
        WHERE pharmacist.line_account_id = ? ORDER BY staff.name, pharmacist.staff_id`,
    ).bind(lineAccountId).all<{ staff_id: string; name: string; training_registration_number: string; is_active: number }>(),
    db.prepare(
      `SELECT product_code, on_hand, version, updated_at
         FROM pharmacy_emergency_inventory WHERE line_account_id = ? ORDER BY product_code`,
    ).bind(lineAccountId).all<{ product_code: string; on_hand: number; version: number; updated_at: string }>(),
    db.prepare(
      `SELECT id, pharmacist_staff_id, starts_at, ends_at, status, capacity, version
         FROM pharmacy_emergency_slots WHERE line_account_id = ? ORDER BY starts_at DESC, id DESC LIMIT 100`,
    ).bind(lineAccountId).all<{ id: string; pharmacist_staff_id: string; starts_at: string; ends_at: string; status: string; capacity: number; version: number }>(),
  ]);
  return {
    settings,
    available_staff: availableStaff.results,
    pharmacists: pharmacists.results,
    inventory: inventory.results,
    slots: slots.results,
  };
}

export async function saveEmergencySettings(
  db: D1Database,
  input: {
    lineAccountId: string;
    staffId: string;
    pharmacyRegistrationNumber: string;
    productCode: string;
    manufacturerCheckUrl: string;
    privacyPolicyUrl: string;
    privacyContact: string;
    purposeText: string;
    consentVersion: string;
    retentionDays: number;
    consultationMinutes: number;
    reservationTtlMinutes: number;
    privacySpaceReady: boolean;
    drinkingWaterReady: boolean;
    partnerClinicUrl: string;
    supportCenterUrl: string;
    now?: Date;
  },
): Promise<void> {
  const urls = [input.manufacturerCheckUrl, input.privacyPolicyUrl, input.partnerClinicUrl, input.supportCenterUrl];
  if (!input.lineAccountId || !input.staffId || !input.pharmacyRegistrationNumber.trim() ||
      !/^[a-z0-9][a-z0-9._-]{1,63}$/i.test(input.productCode) ||
      !input.privacyContact.trim() || !input.purposeText.trim() || !input.consentVersion.trim() ||
      urls.some((url) => !validHttpsUrl(url)) ||
      !Number.isInteger(input.retentionDays) || input.retentionDays < 1 || input.retentionDays > 365 ||
      !Number.isInteger(input.consultationMinutes) || input.consultationMinutes < 1 || input.consultationMinutes > 180 ||
      !Number.isInteger(input.reservationTtlMinutes) || input.reservationTtlMinutes < 5 || input.reservationTtlMinutes > 1440) {
    throw new Error('invalid emergency service settings');
  }
  // Consent v2 forced bump: consent_version is a free string, so nothing else proves
  // it still names the exact wording the patient read. If purpose_text or
  // retention_days (both baked into text_v2 / content_hash) changes while
  // consent_version stays put, the stored version would silently stop matching what
  // it once described. Require the caller to mint a new version instead.
  const current = await db.prepare(
    `SELECT purpose_text, retention_days, consent_version
       FROM pharmacy_emergency_settings WHERE line_account_id = ?`,
  ).bind(input.lineAccountId).first<{ purpose_text: string; retention_days: number; consent_version: string }>();
  if (current && current.consent_version === input.consentVersion &&
      (current.purpose_text !== input.purposeText.trim() || current.retention_days !== input.retentionDays)) {
    throw new Error('EMERGENCY_CONSENT_VERSION_STALE');
  }
  const timestamp = (input.now ?? new Date()).toISOString();
  await db.prepare(
    `INSERT INTO pharmacy_emergency_settings
      (line_account_id, is_enabled, pharmacy_registration_number, product_code,
       manufacturer_check_url, privacy_policy_url, privacy_contact, consent_version,
       purpose_text,
       retention_days, consultation_minutes, reservation_ttl_minutes,
       privacy_space_ready, drinking_water_ready, partner_clinic_url,
       support_center_url, updated_by, created_at, updated_at)
     SELECT ?, EXISTS (
       SELECT 1 FROM pharmacy_account_capabilities AS capability
        WHERE capability.line_account_id = ? AND capability.mode = 'pharmacy'
          AND EXISTS (SELECT 1 FROM json_each(capability.capabilities_json)
                       WHERE value = 'emergency_contraception')
     ), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
     ON CONFLICT (line_account_id) DO UPDATE SET
       pharmacy_registration_number = excluded.pharmacy_registration_number,
       product_code = excluded.product_code,
       manufacturer_check_url = excluded.manufacturer_check_url,
       privacy_policy_url = excluded.privacy_policy_url,
       privacy_contact = excluded.privacy_contact,
       purpose_text = excluded.purpose_text,
       consent_version = excluded.consent_version,
       retention_days = excluded.retention_days,
       consultation_minutes = excluded.consultation_minutes,
       reservation_ttl_minutes = excluded.reservation_ttl_minutes,
       privacy_space_ready = excluded.privacy_space_ready,
       drinking_water_ready = excluded.drinking_water_ready,
       partner_clinic_url = excluded.partner_clinic_url,
       support_center_url = excluded.support_center_url,
       updated_by = excluded.updated_by,
       updated_at = excluded.updated_at`,
  ).bind(
    input.lineAccountId, input.lineAccountId, input.pharmacyRegistrationNumber.trim(),
    input.productCode, ...urls.slice(0, 2), input.privacyContact.trim(), input.consentVersion,
    input.purposeText.trim(),
    input.retentionDays, input.consultationMinutes, input.reservationTtlMinutes,
    input.privacySpaceReady ? 1 : 0, input.drinkingWaterReady ? 1 : 0,
    input.partnerClinicUrl, input.supportCenterUrl, input.staffId, timestamp, timestamp,
  ).run();
}

export async function setEmergencyPharmacist(
  db: D1Database,
  input: { lineAccountId: string; staffId: string; registrationNumber: string; active: boolean; now?: Date },
): Promise<void> {
  if (!input.registrationNumber.trim()) throw new Error('training registration number is required');
  const timestamp = (input.now ?? new Date()).toISOString();
  const result = await db.prepare(
    `INSERT INTO pharmacy_emergency_pharmacists
      (line_account_id, staff_id, training_registration_number, is_active, created_at, updated_at)
     SELECT assignment.line_account_id, assignment.staff_id, ?, ?, ?, ?
       FROM pharmacy_staff_accounts AS assignment
      WHERE assignment.line_account_id = ? AND assignment.staff_id = ? AND assignment.is_active = 1
     ON CONFLICT (line_account_id, staff_id) DO UPDATE SET
       training_registration_number = excluded.training_registration_number,
       is_active = excluded.is_active, updated_at = excluded.updated_at`,
  ).bind(
    input.registrationNumber.trim(), input.active ? 1 : 0, timestamp, timestamp,
    input.lineAccountId, input.staffId,
  ).run();
  if ((result.meta?.changes ?? 0) !== 1) throw new Error('staff assignment not found');
}

export async function createEmergencySlot(
  db: D1Database,
  input: { lineAccountId: string; pharmacistStaffId: string; startsAt: string; endsAt: string; capacity: number; staffId: string; now?: Date },
): Promise<{ id: string }> {
  const now = input.now ?? new Date();
  const startsAt = new Date(input.startsAt);
  const endsAt = new Date(input.endsAt);
  if (!Number.isFinite(startsAt.getTime()) || !Number.isFinite(endsAt.getTime()) ||
      startsAt <= now || endsAt <= startsAt || !Number.isInteger(input.capacity) ||
      input.capacity < 1 || input.capacity > 20) throw new Error('invalid emergency service slot');
  const id = crypto.randomUUID();
  const result = await db.prepare(
    `INSERT INTO pharmacy_emergency_slots
      (id, line_account_id, pharmacist_staff_id, starts_at, ends_at, status,
       capacity, version, created_by, created_at, updated_at)
     SELECT ?, pharmacist.line_account_id, pharmacist.staff_id, ?, ?, 'open', ?, 1, ?, ?, ?
       FROM pharmacy_emergency_pharmacists AS pharmacist
      WHERE pharmacist.line_account_id = ? AND pharmacist.staff_id = ? AND pharmacist.is_active = 1`,
  ).bind(
    id, startsAt.toISOString(), endsAt.toISOString(), input.capacity, input.staffId,
    now.toISOString(), now.toISOString(), input.lineAccountId, input.pharmacistStaffId,
  ).run();
  if ((result.meta?.changes ?? 0) !== 1) throw new Error('trained pharmacist not found');
  return { id };
}

export async function cancelEmergencySlot(
  db: D1Database,
  lineAccountId: string,
  slotId: string,
  expectedVersion: number,
  now = new Date(),
): Promise<void> {
  const result = await db.prepare(
    `UPDATE pharmacy_emergency_slots SET status = 'cancelled', version = version + 1, updated_at = ?
      WHERE id = ? AND line_account_id = ? AND status = 'open' AND version = ?
        AND NOT EXISTS (SELECT 1 FROM pharmacy_emergency_intakes
                         WHERE line_account_id = ? AND slot_id = ?
                           AND status IN ('provisional', 'reviewed') AND expires_at > ?)`,
  ).bind(
    now.toISOString(), slotId, lineAccountId, expectedVersion,
    lineAccountId, slotId, now.toISOString(),
  ).run();
  if ((result.meta?.changes ?? 0) !== 1) throw new Error('slot update conflict');
}

export async function setEmergencyInventory(
  db: D1Database,
  input: { lineAccountId: string; productCode: string; onHand: number; expectedVersion: number; staffId: string; now?: Date },
): Promise<void> {
  if (!Number.isInteger(input.onHand) || input.onHand < 0 ||
      !Number.isInteger(input.expectedVersion) || input.expectedVersion < 0) {
    throw new Error('invalid inventory update');
  }
  const timestamp = (input.now ?? new Date()).toISOString();
  const nextVersion = input.expectedVersion + 1;
  const mutation = input.expectedVersion === 0
    ? db.prepare(
      `INSERT INTO pharmacy_emergency_inventory
        (line_account_id, product_code, on_hand, version, updated_by, created_at, updated_at)
       VALUES (?, ?, ?, 1, ?, ?, ?)`,
    ).bind(
      input.lineAccountId, input.productCode, input.onHand, input.staffId, timestamp, timestamp,
    )
    : db.prepare(
      `UPDATE pharmacy_emergency_inventory
          SET on_hand = ?, version = version + 1, updated_by = ?, updated_at = ?
        WHERE line_account_id = ? AND product_code = ? AND version = ?`,
    ).bind(
      input.onHand, input.staffId, timestamp,
      input.lineAccountId, input.productCode, input.expectedVersion,
    );
  const audit = db.prepare(
    `INSERT INTO pharmacy_emergency_admin_events
      (id, line_account_id, event_type, aggregate_id, actor_id,
       resulting_version, on_hand, occurred_at)
     SELECT ?, line_account_id, 'inventory_updated', product_code, updated_by,
            version, on_hand, ?
       FROM pharmacy_emergency_inventory
      WHERE changes() = 1 AND line_account_id = ? AND product_code = ?
        AND version = ? AND updated_by = ? AND on_hand = ?`,
  ).bind(
    crypto.randomUUID(), timestamp, input.lineAccountId, input.productCode,
    nextVersion, input.staffId, input.onHand,
  );
  const results = await db.batch([mutation, audit]);
  if ((results[0]?.meta?.changes ?? 0) !== 1 || (results[1]?.meta?.changes ?? 0) !== 1) {
    throw new Error('inventory update conflict');
  }
}

function projectedStatus(row: Pick<EmergencyProjectionRow, 'status' | 'expires_at'>, now: Date): EmergencyIntakeStatus {
  return ['provisional', 'reviewed'].includes(row.status) &&
    new Date(row.expires_at).getTime() <= now.getTime()
    ? 'expired'
    : row.status;
}

// Patient-facing projection (listOwnerEmergencyIntakes). Deliberately excludes
// age_band, safe_contact_mode, consent_version, and risk_flags — those are
// clinical/review signals for staff only (see docs/pharmacy/EC_PREVISIT_FORM.md §4).
function ownerProjection(row: EmergencyProjectionRow, now: Date): EmergencyOwnerIntakeProjection {
  return {
    id: row.id,
    reference_code: row.reference_code,
    slot_id: row.slot_id,
    status: projectedStatus(row, now),
    expires_at: row.expires_at,
    version: row.version,
    created_at: row.created_at,
    updated_at: row.updated_at,
    slot_starts_at: row.slot_starts_at,
    slot_ends_at: row.slot_ends_at,
  };
}

function adminProjection(row: EmergencyProjectionRow, now: Date): EmergencyIntakeProjection {
  let riskFlags: EmergencyRiskFlag[] = [];
  try {
    const parsed = JSON.parse(row.risk_flags_json);
    if (Array.isArray(parsed)) riskFlags = parsed as EmergencyRiskFlag[];
  } catch {
    riskFlags = [];
  }
  return {
    ...ownerProjection(row, now),
    age_band: row.age_band,
    safe_contact_mode: row.safe_contact_mode,
    consent_version: row.consent_version,
    risk_flags: riskFlags,
  };
}

function queueProjection(row: AdminEmergencyQueueRow, now: Date): AdminEmergencyQueueItem {
  return {
    id: row.id,
    reference_code: row.reference_code,
    slot_id: row.slot_id,
    status: ['provisional', 'reviewed'].includes(row.status) &&
      new Date(row.expires_at).getTime() <= now.getTime() ? 'expired' : row.status,
    expires_at: row.expires_at,
    version: row.version,
    slot_starts_at: row.slot_starts_at,
    slot_ends_at: row.slot_ends_at,
  };
}

function referenceCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return `EC-${Array.from(bytes, (byte) => alphabet[byte & 31]).join('')}`;
}

function ageBand(age: number): EmergencyIntakeRow['age_band'] {
  if (age < 16) return 'under_16';
  if (age < 18) return '16_17';
  return 'adult';
}

async function getIntake(
  db: D1Database,
  lineAccountId: string,
  intakeId: string,
): Promise<EmergencyIntakeRow | null> {
  return db.prepare(`${INTAKE_SELECT}
    WHERE intake.id = ? AND intake.line_account_id = ?`)
    .bind(intakeId, lineAccountId).first<EmergencyIntakeRow>();
}

export async function expireEmergencyIntakes(
  db: D1Database,
  lineAccountId: string,
  now = new Date(),
): Promise<number> {
  const timestamp = now.toISOString();
  const due = await db.prepare(
    `SELECT id, version FROM pharmacy_emergency_intakes
      WHERE line_account_id = ? AND status IN ('provisional', 'reviewed')
        AND expires_at <= ?
      ORDER BY expires_at, id LIMIT 100`,
  ).bind(lineAccountId, timestamp).all<{ id: string; version: number }>();
  if (due.results.length === 0) return 0;

  const statements = due.results.flatMap((intake) => {
    const eventId = crypto.randomUUID();
    const idempotencyKey = `expire:${intake.id}:${intake.version}`;
    return [
      db.prepare(
        `INSERT OR IGNORE INTO pharmacy_emergency_intake_events
          (id, intake_id, line_account_id, event_type, actor_type, actor_id,
           idempotency_key, occurred_at)
         SELECT ?, id, line_account_id, 'expired', 'system', 'system', ?, ?
           FROM pharmacy_emergency_intakes
          WHERE id = ? AND line_account_id = ? AND status IN ('provisional', 'reviewed')
            AND version = ? AND expires_at <= ?`,
      ).bind(
        eventId, idempotencyKey, timestamp, intake.id, lineAccountId,
        intake.version, timestamp,
      ),
      db.prepare(
        `UPDATE pharmacy_emergency_intakes
            SET status = 'expired', closed_at = ?, version = version + 1, updated_at = ?
          WHERE id = ? AND line_account_id = ? AND status IN ('provisional', 'reviewed')
            AND version = ? AND expires_at <= ?
            AND EXISTS (SELECT 1 FROM pharmacy_emergency_intake_events
                         WHERE id = ? AND intake_id = ? AND line_account_id = ?)`,
      ).bind(
        timestamp, timestamp, intake.id, lineAccountId, intake.version, timestamp,
        eventId, intake.id, lineAccountId,
      ),
    ];
  });
  const results = await db.batch(statements);
  return due.results.reduce(
    (count, _intake, index) => count + ((results[index * 2 + 1]?.meta?.changes ?? 0) === 1 ? 1 : 0),
    0,
  );
}

export async function createEmergencyIntake(
  db: D1Database,
  input: CreateEmergencyIntakeInput,
): Promise<EmergencyOwnerIntakeProjection> {
  const now = input.now ?? new Date();
  if (!input.tenantId || !input.lineAccountId || !input.friendId || !input.slotId ||
      !input.idempotencyKey || input.idempotencyKey.length < 8 || input.idempotencyKey.length > 160 ||
      !SAFE_CONTACT_MODES.has(input.safeContactMode) || !input.manufacturerCheckAcknowledged) {
    throw new Error('invalid provisional intake');
  }
  const replay = await db.prepare(`${INTAKE_SELECT}
    WHERE intake.line_account_id = ? AND intake.owner_friend_id = ?
      AND intake.idempotency_key = ?`)
    .bind(input.lineAccountId, input.friendId, input.idempotencyKey)
    .first<EmergencyIntakeRow>();
  if (replay) return ownerProjection(replay, now);
  if (!(await hasPharmacyCapability(db, input.lineAccountId, 'emergency_contraception'))) {
    throw new Error('FEATURE_DISABLED');
  }

  const service = await db.prepare(
    `SELECT settings.consent_version, settings.consultation_minutes,
            settings.reservation_ttl_minutes, settings.product_code, settings.retention_days,
            slot.starts_at, slot.ends_at
       FROM pharmacy_emergency_settings AS settings
       INNER JOIN pharmacy_emergency_slots AS slot
               ON slot.line_account_id = settings.line_account_id AND slot.id = ?
       INNER JOIN tenant_line_accounts AS mapping
               ON mapping.line_account_id = settings.line_account_id AND mapping.tenant_id = ?
      WHERE settings.line_account_id = ? AND settings.is_enabled = 1
        AND settings.privacy_space_ready = 1 AND settings.drinking_water_ready = 1
        AND slot.status = 'open'`,
  ).bind(input.slotId, input.tenantId, input.lineAccountId).first<{
    consent_version: string;
    consultation_minutes: number;
    reservation_ttl_minutes: number;
    product_code: string;
    retention_days: number;
    starts_at: string;
    ends_at: string;
  }>();
  if (!service) throw new Error('service is not ready');
  // Consent v2 (docs/pharmacy/EC_PREVISIT_FORM.md §3 row E): version and hash are
  // checked separately from service readiness so a stale consent maps to its own
  // 409, not a generic "not ready" 503.
  if (service.consent_version !== input.consentVersion) {
    throw new Error('EMERGENCY_CONSENT_VERSION_MISMATCH');
  }
  const expectedConsentHash = await emergencyConsentContentHash({
    retentionDays: service.retention_days,
    consentVersion: service.consent_version,
  });
  if (input.consentContentHash !== expectedConsentHash) {
    throw new Error('EMERGENCY_CONSENT_HASH_MISMATCH');
  }
  const lngAllergy = input.lngAllergy === true;
  const liverDisease = input.liverDisease === true;
  const currentlyPregnant = input.currentlyPregnant === true;
  const breastfeeding = input.breastfeeding === true;
  const underMedicalTreatment = input.underMedicalTreatment === true;
  const drugAllergyHistory = input.drugAllergyHistory === true;
  const heartKidneyGiDisease = input.heartKidneyGiDisease === true;
  const stJohnsWort = input.stJohnsWort === true;
  const lastMenstruationDate = input.lastMenstruationDate ?? null;
  const menstruationSignals: EmergencyMenstruationSignals = input.menstruationSignals ?? {
    noneApply: false, unknown: false, overOneMonthNoPeriod: false,
    notRecoveredAfterBirth: false, lastPeriodDifferent: false, earlierConcernOver3Weeks: false,
  };
  const idDocumentAvailable = input.idDocumentAvailable ?? null;
  if (!validMenstruationSignals(menstruationSignals)) {
    throw new Error('invalid menstruation signals');
  }
  const assessment = assessEmergencyPrecheck({
    intercourseAt: input.intercourseAt,
    intercourseTimeUnknown: input.intercourseTimeUnknown,
    slotStartsAt: service.starts_at,
    consultationMinutes: service.consultation_minutes,
    age: input.age,
    recentPurchaseCount: input.recentPurchaseCount,
    patientWillVisit: input.patientWillVisit,
    acceptsInPersonDose: input.acceptsInPersonDose,
    safeContactAvailable: input.safeContactMode === 'neutral_line' || input.safeContactMode === 'phone',
    lngAllergy,
    liverDisease,
    currentlyPregnant,
    breastfeeding,
    underMedicalTreatment,
    drugAllergyHistory,
    heartKidneyGiDisease,
    stJohnsWort,
    lastMenstruationDate,
    menstruationSignals,
    now,
  });
  if (!assessment.canCreateProvisional) throw new Error(assessment.blockingReason ?? 'service unavailable');

  const id = crypto.randomUUID();
  const timestamp = now.toISOString();
  const expiresAt = new Date(now.getTime() + service.reservation_ttl_minutes * 60_000).toISOString();
  const encryptedPayload = await sealEmergencyPayload({
    schema_version: 2,
    intercourseAt: input.intercourseAt,
    intercourseTimeUnknown: input.intercourseTimeUnknown,
    lngAllergy,
    liverDisease,
    currentlyPregnant,
    breastfeeding,
    underMedicalTreatment,
    drugAllergyHistory,
    heartKidneyGiDisease,
    stJohnsWort,
    lastMenstruationDate,
    menstruationSignals,
    pregnancyTestRecommended: assessment.pregnancyTestRecommended,
    idDocumentAvailable,
    detailFlags: assessment.detailFlags,
    checklistVersion: getChecklistVersion(service.product_code),
    consentContentHash: input.consentContentHash,
  }, input.encryptionSecret, {
    tenantId: input.tenantId,
    lineAccountId: input.lineAccountId,
    friendId: input.friendId,
    intakeId: id,
  });
  const eventKey = `created:${input.idempotencyKey}`;
  const results = await db.batch([
    db.prepare(
      // product_code is copied from settings inside the INSERT itself, so the hold is
      // anchored to the product that was active at this instant. The completion triggers
      // read it back off the row instead of re-resolving the (by then possibly changed)
      // settings value.
      `INSERT INTO pharmacy_emergency_intakes
        (id, reference_code, tenant_id, line_account_id, owner_friend_id, slot_id,
         status, encrypted_payload, payload_key_version, age_band, safe_contact_mode,
         consent_version, risk_flags_json, product_code, idempotency_key, expires_at,
         version, created_at, updated_at)
       SELECT ?, ?, ?, settings.line_account_id, ?, ?, 'provisional', ?, 1, ?, ?, ?, ?,
              settings.product_code, ?, ?, 1, ?, ?
         FROM pharmacy_emergency_settings AS settings
        WHERE settings.line_account_id = ?
          AND EXISTS (
            SELECT 1 FROM pharmacy_account_capabilities AS capability
             WHERE capability.line_account_id = settings.line_account_id
               AND capability.mode = 'pharmacy'
               AND EXISTS (SELECT 1 FROM json_each(capability.capabilities_json)
                            WHERE value = 'emergency_contraception')
          )`,
    ).bind(
      id, referenceCode(), input.tenantId, input.friendId, input.slotId,
      encryptedPayload, ageBand(input.age), input.safeContactMode, input.consentVersion,
      JSON.stringify(assessment.riskFlags), input.idempotencyKey, expiresAt, timestamp, timestamp,
      input.lineAccountId,
    ),
    db.prepare(
      `INSERT INTO pharmacy_emergency_intake_events
        (id, intake_id, line_account_id, event_type, actor_type, actor_id,
         idempotency_key, occurred_at)
       SELECT ?, id, line_account_id, 'created', 'patient', owner_friend_id, ?, ?
         FROM pharmacy_emergency_intakes
        WHERE id = ? AND line_account_id = ? AND owner_friend_id = ?`,
    ).bind(
      crypto.randomUUID(), eventKey, timestamp,
      id, input.lineAccountId, input.friendId,
    ),
  ]);
  if ((results[0]?.meta?.changes ?? 0) !== 1 || (results[1]?.meta?.changes ?? 0) !== 1) {
    throw new Error('FEATURE_DISABLED');
  }
  const saved = await getIntake(db, input.lineAccountId, id);
  if (!saved || saved.owner_friend_id !== input.friendId) throw new Error('provisional intake conflict');
  return ownerProjection(saved, now);
}

export async function listOwnerEmergencyIntakes(
  db: D1Database,
  lineAccountId: string,
  friendId: string,
  now = new Date(),
): Promise<EmergencyOwnerIntakeProjection[]> {
  await expireEmergencyIntakes(db, lineAccountId, now);
  const rows = await db.prepare(`${INTAKE_SELECT}
    WHERE intake.line_account_id = ? AND intake.owner_friend_id = ?
    ORDER BY intake.created_at DESC, intake.id DESC`)
    .bind(lineAccountId, friendId).all<EmergencyIntakeRow>();
  return rows.results.map((row) => ownerProjection(row, now));
}

export async function cancelOwnerEmergencyIntake(
  db: D1Database,
  input: {
    lineAccountId: string;
    friendId: string;
    intakeId: string;
    expectedVersion: number;
    idempotencyKey: string;
    now?: Date;
  },
): Promise<EmergencyOwnerIntakeProjection> {
  const now = input.now ?? new Date();
  if (!input.idempotencyKey || input.idempotencyKey.length < 8 || input.idempotencyKey.length > 160 ||
      !Number.isInteger(input.expectedVersion)) throw new Error('invalid cancellation');
  const current = await getIntake(db, input.lineAccountId, input.intakeId);
  if (!current || current.owner_friend_id !== input.friendId) throw new Error('intake not found');
  const replay = await db.prepare(
    `SELECT 1 AS ok FROM pharmacy_emergency_intake_events
      WHERE intake_id = ? AND line_account_id = ? AND idempotency_key = ?`,
  ).bind(input.intakeId, input.lineAccountId, input.idempotencyKey).first<{ ok: number }>();
  if (replay) return ownerProjection(current, now);
  if (!['provisional', 'reviewed'].includes(current.status) ||
      current.version !== input.expectedVersion ||
      new Date(current.expires_at).getTime() <= now.getTime()) throw new Error('cancellation conflict');
  const eventId = crypto.randomUUID();
  const timestamp = now.toISOString();
  const results = await db.batch([
    db.prepare(
      `INSERT INTO pharmacy_emergency_intake_events
        (id, intake_id, line_account_id, event_type, actor_type, actor_id,
         idempotency_key, occurred_at)
       SELECT ?, id, line_account_id, 'cancelled', 'patient', owner_friend_id, ?, ?
         FROM pharmacy_emergency_intakes
        WHERE id = ? AND line_account_id = ? AND owner_friend_id = ?
          AND status IN ('provisional', 'reviewed') AND version = ?`,
    ).bind(
      eventId, input.idempotencyKey, timestamp, input.intakeId,
      input.lineAccountId, input.friendId, input.expectedVersion,
    ),
    db.prepare(
      `UPDATE pharmacy_emergency_intakes
          SET status = 'cancelled', closed_at = ?, version = version + 1, updated_at = ?
        WHERE id = ? AND line_account_id = ? AND owner_friend_id = ?
          AND status IN ('provisional', 'reviewed') AND version = ?
          AND EXISTS (SELECT 1 FROM pharmacy_emergency_intake_events
                       WHERE id = ? AND intake_id = ? AND line_account_id = ?)`,
    ).bind(
      timestamp, timestamp, input.intakeId, input.lineAccountId, input.friendId,
      input.expectedVersion, eventId, input.intakeId, input.lineAccountId,
    ),
  ]);
  if ((results[0]?.meta?.changes ?? 0) !== 1 || (results[1]?.meta?.changes ?? 0) !== 1) {
    throw new Error('cancellation conflict');
  }
  const saved = await getIntake(db, input.lineAccountId, input.intakeId);
  if (!saved) throw new Error('intake not found');
  return ownerProjection(saved, now);
}

async function requireTrainedPharmacist(
  db: D1Database,
  lineAccountId: string,
  staffId: string,
): Promise<void> {
  const row = await db.prepare(
    `SELECT 1 AS ok
       FROM pharmacy_emergency_pharmacists AS pharmacist
       INNER JOIN pharmacy_staff_accounts AS assignment
               ON assignment.line_account_id = pharmacist.line_account_id
              AND assignment.staff_id = pharmacist.staff_id AND assignment.is_active = 1
      WHERE pharmacist.line_account_id = ? AND pharmacist.staff_id = ?
        AND pharmacist.is_active = 1`,
  ).bind(lineAccountId, staffId).first<{ ok: number }>();
  if (!row) throw new Error('trained pharmacist access required');
}

export async function listAdminEmergencyIntakes(
  db: D1Database,
  lineAccountId: string,
  options: {
    status?: EmergencyIntakeStatus;
    slotId?: string;
    deadlineBefore?: string;
    cursor?: string;
    limit?: number;
  } = {},
  now = new Date(),
): Promise<{ intakes: AdminEmergencyQueueItem[]; next_cursor: string | null }> {
  await expireEmergencyIntakes(db, lineAccountId, now);
  const limit = Math.min(100, Math.max(1, options.limit ?? 50));
  const status = options.status && TRANSITIONS[options.status] ? options.status : null;
  const slotId = options.slotId ?? null;
  const deadlineBefore = options.deadlineBefore ?? null;
  const cursorSeparator = options.cursor?.lastIndexOf('|') ?? -1;
  const cursorCreatedAt = cursorSeparator > 0 ? options.cursor!.slice(0, cursorSeparator) : null;
  const cursorId = cursorSeparator > 0 ? options.cursor!.slice(cursorSeparator + 1) : null;
  if (options.cursor && (!cursorCreatedAt || !Number.isFinite(Date.parse(cursorCreatedAt)) ||
      !cursorId || !/^[A-Za-z0-9._:-]{1,128}$/.test(cursorId))) {
    throw new Error('invalid emergency intake cursor');
  }
  const rows = await db.prepare(`${ADMIN_QUEUE_SELECT}
    WHERE intake.line_account_id = ?
      AND (? IS NULL OR intake.status = ?)
      AND (? IS NULL OR intake.slot_id = ?)
      AND (? IS NULL OR intake.expires_at <= ?)
      AND (? IS NULL OR intake.created_at < ?
           OR (intake.created_at = ? AND intake.id < ?))
    ORDER BY intake.created_at DESC, intake.id DESC
    LIMIT ?`)
    .bind(
      lineAccountId, status, status,
      slotId, slotId, deadlineBefore, deadlineBefore,
      cursorCreatedAt, cursorCreatedAt, cursorCreatedAt, cursorId,
      limit + 1,
    ).all<AdminEmergencyQueueRow>();
  const page = rows.results.slice(0, limit);
  const last = page.at(-1);
  return {
    intakes: page.map((row) => queueProjection(row, now)),
    next_cursor: rows.results.length > limit && last ? `${last.created_at}|${last.id}` : null,
  };
}

export async function getAdminEmergencyIntakeDetail(
  db: D1Database,
  lineAccountId: string,
  intakeId: string,
  staffId: string,
  encryptionSecret: string,
  now = new Date(),
): Promise<AdminEmergencyIntake> {
  await requireTrainedPharmacist(db, lineAccountId, staffId);
  const row = await getIntake(db, lineAccountId, intakeId);
  if (!row) throw new Error('intake not found');
  const accessedAt = now.toISOString();
  const audit = await db.prepare(
    `INSERT INTO pharmacy_emergency_intake_access_events
      (id, intake_id, line_account_id, staff_id, accessed_at)
     SELECT ?, intake.id, intake.line_account_id, ?, ?
       FROM pharmacy_emergency_intakes AS intake
      WHERE intake.id = ? AND intake.line_account_id = ?
        AND EXISTS (
          SELECT 1 FROM pharmacy_emergency_pharmacists AS pharmacist
          INNER JOIN pharmacy_staff_accounts AS assignment
                  ON assignment.line_account_id = pharmacist.line_account_id
                 AND assignment.staff_id = pharmacist.staff_id
                 AND assignment.is_active = 1
         WHERE pharmacist.line_account_id = intake.line_account_id
           AND pharmacist.staff_id = ? AND pharmacist.is_active = 1
        )`,
  ).bind(
    crypto.randomUUID(), staffId, accessedAt, intakeId, lineAccountId, staffId,
  ).run();
  if ((audit.meta?.changes ?? 0) !== 1) throw new Error('sensitive read audit unavailable');
  // NEXT-2: retention-purge.ts redacts encrypted_payload to '' past retention_days
  // rather than deleting the row. There is nothing to decrypt at that point —
  // openEmergencyPayload would throw on the empty ciphertext, turning an expected
  // "this record aged out" state into a 503 outage for staff.
  if (row.encrypted_payload === '') {
    return { ...adminProjection(row, now), redacted: true, self_reported: null };
  }
  const payload = await openEmergencyPayload(row.encrypted_payload, encryptionSecret, {
    tenantId: row.tenant_id,
    lineAccountId: row.line_account_id,
    friendId: row.owner_friend_id,
    intakeId: row.id,
  });
  if (typeof payload.intercourseAt !== 'string' ||
      typeof payload.intercourseTimeUnknown !== 'boolean') {
    throw new Error('encrypted intake is invalid');
  }
  // schema_version 2 payloads carry A3/A4/A5/A' detail; v1 rows (sealed before
  // this change) have none of these keys, so they map to null instead of throwing.
  const schemaVersion = typeof payload.schema_version === 'number' ? payload.schema_version : 1;
  return {
    ...adminProjection(row, now),
    redacted: false,
    self_reported: {
      intercourseAt: payload.intercourseAt,
      intercourseTimeUnknown: payload.intercourseTimeUnknown,
      lngAllergy: schemaVersion >= 2 && typeof payload.lngAllergy === 'boolean' ? payload.lngAllergy : null,
      liverDisease: schemaVersion >= 2 && typeof payload.liverDisease === 'boolean' ? payload.liverDisease : null,
      currentlyPregnant: schemaVersion >= 2 && typeof payload.currentlyPregnant === 'boolean' ? payload.currentlyPregnant : null,
      breastfeeding: schemaVersion >= 2 && typeof payload.breastfeeding === 'boolean' ? payload.breastfeeding : null,
      underMedicalTreatment: schemaVersion >= 2 && typeof payload.underMedicalTreatment === 'boolean' ? payload.underMedicalTreatment : null,
      drugAllergyHistory: schemaVersion >= 2 && typeof payload.drugAllergyHistory === 'boolean' ? payload.drugAllergyHistory : null,
      heartKidneyGiDisease: schemaVersion >= 2 && typeof payload.heartKidneyGiDisease === 'boolean' ? payload.heartKidneyGiDisease : null,
      stJohnsWort: schemaVersion >= 2 && typeof payload.stJohnsWort === 'boolean' ? payload.stJohnsWort : null,
      lastMenstruationDate: schemaVersion >= 2 && (typeof payload.lastMenstruationDate === 'string' || payload.lastMenstruationDate === null)
        ? payload.lastMenstruationDate as string | null
        : null,
      menstruationSignals: schemaVersion >= 2 && payload.menstruationSignals && typeof payload.menstruationSignals === 'object'
        ? payload.menstruationSignals as EmergencyMenstruationSignals
        : null,
      pregnancyTestRecommended: schemaVersion >= 2 && typeof payload.pregnancyTestRecommended === 'boolean'
        ? payload.pregnancyTestRecommended
        : null,
      idDocumentAvailable: schemaVersion >= 2 && (typeof payload.idDocumentAvailable === 'boolean' || payload.idDocumentAvailable === null)
        ? payload.idDocumentAvailable as boolean | null
        : null,
      detailFlags: schemaVersion >= 2 && Array.isArray(payload.detailFlags)
        ? payload.detailFlags as EmergencyDetailFlag[]
        : null,
      checklistVersion: schemaVersion >= 2 && typeof payload.checklistVersion === 'string'
        ? payload.checklistVersion
        : null,
      consentContentHash: schemaVersion >= 2 && typeof payload.consentContentHash === 'string'
        ? payload.consentContentHash
        : null,
    },
  };
}

const TRANSITIONS: Record<EmergencyIntakeStatus, readonly EmergencyIntakeStatus[]> = {
  provisional: ['reviewed', 'cancelled', 'expired'],
  reviewed: ['completed', 'cancelled', 'expired'],
  completed: [],
  cancelled: [],
  expired: [],
};

export async function transitionEmergencyIntake(
  db: D1Database,
  input: {
    lineAccountId: string;
    intakeId: string;
    expectedVersion: number;
    toStatus: Exclude<EmergencyIntakeStatus, 'provisional'>;
    staffId: string;
    now?: Date;
  },
): Promise<EmergencyIntakeProjection> {
  await requireTrainedPharmacist(db, input.lineAccountId, input.staffId);
  const current = await getIntake(db, input.lineAccountId, input.intakeId);
  if (!current) throw new Error('intake not found');
  if (current.version !== input.expectedVersion ||
      !TRANSITIONS[current.status].includes(input.toStatus) ||
      (['provisional', 'reviewed'].includes(current.status) &&
       new Date(current.expires_at).getTime() <= (input.now ?? new Date()).getTime())) {
    throw new Error('transition conflict');
  }
  const now = input.now ?? new Date();
  const timestamp = now.toISOString();
  const eventId = crypto.randomUUID();
  // completed requires the in-person 'A' section counter confirmation (see
  // docs/pharmacy/EC_PREVISIT_FORM.md §5). Folded into the CAS WHERE of both
  // statements (not a trigger) so an incomplete confirmation neither records
  // a false 'completed' event nor advances the intake status.
  const results = await db.batch([
    db.prepare(
      `INSERT INTO pharmacy_emergency_intake_events
        (id, intake_id, line_account_id, event_type, actor_type, actor_id,
         idempotency_key, occurred_at)
       SELECT ?, id, line_account_id, ?, 'staff', ?, ?, ?
         FROM pharmacy_emergency_intakes
        WHERE id = ? AND line_account_id = ? AND status = ? AND version = ?
          AND (? != 'completed' OR EXISTS (
            SELECT 1 FROM pharmacy_emergency_counter_confirmations
             WHERE line_account_id = ? AND intake_id = ? AND section = 'A'))`,
    ).bind(
      eventId, input.toStatus, input.staffId,
      `transition:${input.intakeId}:${input.expectedVersion}:${input.toStatus}`,
      timestamp, input.intakeId, input.lineAccountId, current.status, input.expectedVersion,
      input.toStatus, input.lineAccountId, input.intakeId,
    ),
    db.prepare(
      `UPDATE pharmacy_emergency_intakes
          SET status = ?,
              expires_at = CASE WHEN ? = 'reviewed' THEN ? ELSE expires_at END,
              reviewed_by = CASE WHEN ? = 'reviewed' THEN ? ELSE reviewed_by END,
              reviewed_at = CASE WHEN ? = 'reviewed' THEN ? ELSE reviewed_at END,
              closed_by = CASE WHEN ? IN ('completed', 'cancelled', 'expired') THEN ? ELSE closed_by END,
              closed_at = CASE WHEN ? IN ('completed', 'cancelled', 'expired') THEN ? ELSE closed_at END,
              version = version + 1,
              updated_at = ?
        WHERE id = ? AND line_account_id = ? AND status = ? AND version = ?
          AND EXISTS (SELECT 1 FROM pharmacy_emergency_intake_events
                       WHERE id = ? AND intake_id = ? AND line_account_id = ?)
          AND (? != 'completed' OR EXISTS (
            SELECT 1 FROM pharmacy_emergency_counter_confirmations
             WHERE line_account_id = ? AND intake_id = ? AND section = 'A'))`,
    ).bind(
      input.toStatus,
      input.toStatus, current.slot_ends_at,
      input.toStatus, input.staffId,
      input.toStatus, timestamp,
      input.toStatus, input.staffId,
      input.toStatus, timestamp,
      timestamp,
      input.intakeId, input.lineAccountId, current.status, input.expectedVersion,
      eventId, input.intakeId, input.lineAccountId,
      input.toStatus, input.lineAccountId, input.intakeId,
    ),
  ]);
  if ((results[0]?.meta?.changes ?? 0) !== 1 || (results[1]?.meta?.changes ?? 0) !== 1) {
    throw new Error('transition conflict');
  }
  const saved = await getIntake(db, input.lineAccountId, input.intakeId);
  if (!saved) throw new Error('intake not found');
  return adminProjection(saved, now);
}

// Phase B: in-store counter confirmation (docs/pharmacy/EC_PREVISIT_FORM.md §5).
// Only the section-level confirmation and any noted mismatch are recorded —
// never the patient's self-reported answers themselves.
export type EmergencyCounterSection = 'A' | 'B' | 'C' | 'D';
const COUNTER_SECTIONS = new Set<EmergencyCounterSection>(['A', 'B', 'C', 'D']);

export interface EmergencyCounterConfirmation {
  section: EmergencyCounterSection;
  checklist_version: string;
  mismatch_items: string[];
  staff_id: string;
  confirmed_at: string;
}

interface EmergencyCounterConfirmationRow {
  section: EmergencyCounterSection;
  checklist_version: string;
  mismatch_items_json: string;
  staff_id: string;
  confirmed_at: string;
}

function counterConfirmationProjection(row: EmergencyCounterConfirmationRow): EmergencyCounterConfirmation {
  let mismatchItems: string[] = [];
  try {
    const parsed = JSON.parse(row.mismatch_items_json);
    if (Array.isArray(parsed)) mismatchItems = parsed as string[];
  } catch {
    mismatchItems = [];
  }
  return {
    section: row.section, checklist_version: row.checklist_version, mismatch_items: mismatchItems,
    staff_id: row.staff_id, confirmed_at: row.confirmed_at,
  };
}

export async function listCounterConfirmations(
  db: D1Database,
  lineAccountId: string,
  intakeId: string,
  staffId: string,
): Promise<EmergencyCounterConfirmation[]> {
  await requireTrainedPharmacist(db, lineAccountId, staffId);
  const rows = await db.prepare(
    `SELECT section, checklist_version, mismatch_items_json, staff_id, confirmed_at
       FROM pharmacy_emergency_counter_confirmations
      WHERE line_account_id = ? AND intake_id = ?
      ORDER BY section`,
  ).bind(lineAccountId, intakeId).all<EmergencyCounterConfirmationRow>();
  return rows.results.map(counterConfirmationProjection);
}

export async function recordCounterConfirmation(
  db: D1Database,
  input: {
    lineAccountId: string;
    intakeId: string;
    section: EmergencyCounterSection;
    checklistVersion: string;
    mismatchItems: string[];
    staffId: string;
    now?: Date;
  },
): Promise<EmergencyCounterConfirmation> {
  if (!COUNTER_SECTIONS.has(input.section) || !input.checklistVersion.trim() ||
      !Array.isArray(input.mismatchItems) ||
      input.mismatchItems.some((item) => typeof item !== 'string' || !item.trim())) {
    throw new Error('invalid counter confirmation');
  }
  await requireTrainedPharmacist(db, input.lineAccountId, input.staffId);
  const intake = await getIntake(db, input.lineAccountId, input.intakeId);
  if (!intake) throw new Error('intake not found');
  // Insert-only: the counter confirmation is a one-time in-person attestation,
  // not a mutable draft. A second confirmation for the same (account, intake,
  // section) is rejected — not silently overwritten by a later pharmacist —
  // so pre-check existence before the INSERT (and still treat any PK conflict
  // from the INSERT itself the same way, closing the race window).
  const existing = await db.prepare(
    `SELECT 1 AS ok FROM pharmacy_emergency_counter_confirmations
      WHERE line_account_id = ? AND intake_id = ? AND section = ?`,
  ).bind(input.lineAccountId, input.intakeId, input.section).first<{ ok: number }>();
  if (existing) throw new Error('counter confirmation exists');
  const now = input.now ?? new Date();
  const timestamp = now.toISOString();
  let result: D1Result;
  try {
    result = await db.prepare(
      `INSERT INTO pharmacy_emergency_counter_confirmations
        (line_account_id, intake_id, section, checklist_version, mismatch_items_json, staff_id, confirmed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      input.lineAccountId, input.intakeId, input.section, input.checklistVersion,
      JSON.stringify(input.mismatchItems), input.staffId, timestamp,
    ).run();
  } catch {
    throw new Error('counter confirmation exists');
  }
  if ((result.meta?.changes ?? 0) !== 1) throw new Error('counter confirmation exists');
  return {
    section: input.section, checklist_version: input.checklistVersion,
    mismatch_items: input.mismatchItems, staff_id: input.staffId, confirmed_at: timestamp,
  };
}

// Phase B statutory sale record (docs/pharmacy/EC_PREVISIT_FORM.md §5, 医薬総発
// 0331 第2号 4(3)). Refusal cannot use its own status — status/event_type CHECKs
// are additive-only — so 'refused' maps to intake status 'cancelled' and 'sold'
// maps to 'completed', both requiring the 'A' section counter confirmation.
export type EmergencyIdentityCheck = 'document' | 'verbal' | 'unverified';
export type EmergencyInPersonDose = 'done' | 'not_done';
export type EmergencySaleOutcome = 'sold' | 'refused';
export type EmergencyPregnancyTestResult = 'not_done' | 'negative' | 'positive';
export type EmergencyReferral = 'none' | 'obgyn' | 'pediatrics' | 'onestop' | 'child_guidance';

const IDENTITY_CHECKS = new Set<EmergencyIdentityCheck>(['document', 'verbal', 'unverified']);
const IN_PERSON_DOSES = new Set<EmergencyInPersonDose>(['done', 'not_done']);
const PREGNANCY_TEST_RESULTS = new Set<EmergencyPregnancyTestResult>(['not_done', 'negative', 'positive']);
const REFERRALS = new Set<EmergencyReferral>(['none', 'obgyn', 'pediatrics', 'onestop', 'child_guidance']);

export interface EmergencySaleRecordSummary {
  id: string;
  outcome: EmergencySaleOutcome;
  sold_at: string;
}

export interface EmergencySaleRecordDetail extends EmergencySaleRecordSummary {
  product_code: string;
  checklist_version: string;
  identity_check: EmergencyIdentityCheck;
  in_person_dose: EmergencyInPersonDose;
  checklist_sheets_received: number;
  pharmacist_staff_id: string;
  training_registration_number: string;
  pregnancy_test: EmergencyPregnancyTestResult;
  refusal_reason_code: string | null;
  referral: EmergencyReferral;
  explained: string[];
}

export interface RecordEmergencySaleInput {
  lineAccountId: string;
  intakeId: string;
  staffId: string;
  expectedVersion: number;
  outcome: EmergencySaleOutcome;
  identityCheck: EmergencyIdentityCheck;
  inPersonDose: EmergencyInPersonDose;
  checklistSheetsReceived: number;
  pregnancyTest: EmergencyPregnancyTestResult;
  refusalReasonCode: string | null;
  referral: EmergencyReferral;
  explained: string[];
  encryptionSecret: string;
  now?: Date;
}

function saleRecordSummary(row: { id: string; outcome: string; sold_at: string }): EmergencySaleRecordSummary {
  return { id: row.id, outcome: row.outcome as EmergencySaleOutcome, sold_at: row.sold_at };
}

export async function recordEmergencySale(
  db: D1Database,
  input: RecordEmergencySaleInput,
): Promise<EmergencySaleRecordSummary> {
  if ((input.outcome !== 'sold' && input.outcome !== 'refused') ||
      !IDENTITY_CHECKS.has(input.identityCheck) || !IN_PERSON_DOSES.has(input.inPersonDose) ||
      !PREGNANCY_TEST_RESULTS.has(input.pregnancyTest) || !REFERRALS.has(input.referral) ||
      !Number.isInteger(input.checklistSheetsReceived) || input.checklistSheetsReceived < 0 ||
      !Number.isInteger(input.expectedVersion) ||
      !Array.isArray(input.explained) || input.explained.some((item) => typeof item !== 'string') ||
      (input.refusalReasonCode !== null && typeof input.refusalReasonCode !== 'string')) {
    throw new Error('invalid sale record');
  }
  await requireTrainedPharmacist(db, input.lineAccountId, input.staffId);

  // Idempotency key sale:{intakeId}: a replayed request returns the existing
  // immutable record instead of retrying the mutation.
  const existing = await db.prepare(
    `SELECT id, outcome, sold_at FROM pharmacy_emergency_sale_records
      WHERE line_account_id = ? AND intake_id = ?`,
  ).bind(input.lineAccountId, input.intakeId).first<{ id: string; outcome: string; sold_at: string }>();
  if (existing) return saleRecordSummary(existing);

  const intake = await getIntake(db, input.lineAccountId, input.intakeId);
  if (!intake) throw new Error('intake not found');
  const pharmacist = await db.prepare(
    `SELECT training_registration_number FROM pharmacy_emergency_pharmacists
      WHERE line_account_id = ? AND staff_id = ? AND is_active = 1`,
  ).bind(input.lineAccountId, input.staffId).first<{ training_registration_number: string }>();
  if (!pharmacist) throw new Error('trained pharmacist access required');

  const toStatus = input.outcome === 'sold' ? 'completed' : 'cancelled';
  const now = input.now ?? new Date();
  const timestamp = now.toISOString();
  const saleId = crypto.randomUUID();
  const eventId = crypto.randomUUID();
  const determinationEncrypted = await sealEmergencyPayload({
    pregnancyTest: input.pregnancyTest,
    refusalReasonCode: input.refusalReasonCode,
    referral: input.referral,
    explained: input.explained,
  }, input.encryptionSecret, {
    tenantId: intake.tenant_id, lineAccountId: intake.line_account_id,
    friendId: intake.owner_friend_id, intakeId: intake.id,
  });
  const checklistVersion = getChecklistVersion(intake.product_code);

  // Event-first batch, same shape as transitionEmergencyIntake: the sale
  // outcome always requires the 'A' section counter confirmation (the
  // in-person reconciliation that must happen before any final sold/refused
  // decision), gated in the CAS WHERE — not a trigger.
  const results = await db.batch([
    db.prepare(
      `INSERT INTO pharmacy_emergency_intake_events
        (id, intake_id, line_account_id, event_type, actor_type, actor_id,
         idempotency_key, occurred_at)
       SELECT ?, id, line_account_id, ?, 'staff', ?, ?, ?
         FROM pharmacy_emergency_intakes
        WHERE id = ? AND line_account_id = ? AND status = 'reviewed' AND version = ?
          AND EXISTS (SELECT 1 FROM pharmacy_emergency_counter_confirmations
                       WHERE line_account_id = ? AND intake_id = ? AND section = 'A')`,
    ).bind(
      eventId, toStatus, input.staffId, `sale:${input.intakeId}`, timestamp,
      input.intakeId, input.lineAccountId, input.expectedVersion,
      input.lineAccountId, input.intakeId,
    ),
    db.prepare(
      `UPDATE pharmacy_emergency_intakes
          SET status = ?, closed_by = ?, closed_at = ?, version = version + 1, updated_at = ?
        WHERE id = ? AND line_account_id = ? AND status = 'reviewed' AND version = ?
          AND EXISTS (SELECT 1 FROM pharmacy_emergency_intake_events
                       WHERE id = ? AND intake_id = ? AND line_account_id = ?)`,
    ).bind(
      toStatus, input.staffId, timestamp, timestamp,
      input.intakeId, input.lineAccountId, input.expectedVersion,
      eventId, input.intakeId, input.lineAccountId,
    ),
    db.prepare(
      `INSERT INTO pharmacy_emergency_sale_records
        (id, line_account_id, intake_id, owner_friend_id, product_code, checklist_version,
         quantity, outcome, identity_check, in_person_dose, checklist_sheets_received,
         pharmacist_staff_id, training_registration_number, determination_encrypted,
         determination_key_version, sold_at, created_at)
       SELECT ?, intake.line_account_id, intake.id, intake.owner_friend_id, intake.product_code, ?,
              1, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?
         FROM pharmacy_emergency_intakes AS intake
        WHERE intake.id = ? AND intake.line_account_id = ?
          AND EXISTS (SELECT 1 FROM pharmacy_emergency_intake_events
                       WHERE id = ? AND intake_id = ? AND line_account_id = ?)`,
    ).bind(
      saleId, checklistVersion, input.outcome, input.identityCheck, input.inPersonDose,
      input.checklistSheetsReceived, input.staffId, pharmacist.training_registration_number,
      determinationEncrypted, timestamp, timestamp,
      input.intakeId, input.lineAccountId,
      eventId, input.intakeId, input.lineAccountId,
    ),
  ]);
  if ((results[0]?.meta?.changes ?? 0) !== 1 || (results[1]?.meta?.changes ?? 0) !== 1 ||
      (results[2]?.meta?.changes ?? 0) !== 1) {
    throw new Error('transition conflict');
  }
  return { id: saleId, outcome: input.outcome, sold_at: timestamp };
}

export async function getEmergencySaleRecord(
  db: D1Database,
  lineAccountId: string,
  intakeId: string,
  staffId: string,
  encryptionSecret: string,
  now = new Date(),
): Promise<EmergencySaleRecordDetail> {
  await requireTrainedPharmacist(db, lineAccountId, staffId);
  const row = await db.prepare(
    `SELECT sale.id, sale.product_code, sale.checklist_version, sale.outcome,
            sale.identity_check, sale.in_person_dose, sale.checklist_sheets_received,
            sale.pharmacist_staff_id, sale.training_registration_number,
            sale.determination_encrypted, sale.sold_at, intake.tenant_id, intake.owner_friend_id
       FROM pharmacy_emergency_sale_records AS sale
       INNER JOIN pharmacy_emergency_intakes AS intake
               ON intake.id = sale.intake_id AND intake.line_account_id = sale.line_account_id
      WHERE sale.intake_id = ? AND sale.line_account_id = ?`,
  ).bind(intakeId, lineAccountId).first<{
    id: string; product_code: string; checklist_version: string; outcome: string;
    identity_check: string; in_person_dose: string; checklist_sheets_received: number;
    pharmacist_staff_id: string; training_registration_number: string;
    determination_encrypted: string; sold_at: string; tenant_id: string; owner_friend_id: string;
  }>();
  if (!row) throw new Error('sale record not found');
  // Fail-closed access audit: decrypt only proceeds once the audited INSERT
  // (still-active pharmacist membership at read time) reports exactly one row.
  const accessedAt = now.toISOString();
  const audit = await db.prepare(
    `INSERT INTO pharmacy_emergency_intake_access_events
      (id, intake_id, line_account_id, staff_id, accessed_at)
     SELECT ?, intake.id, intake.line_account_id, ?, ?
       FROM pharmacy_emergency_intakes AS intake
      WHERE intake.id = ? AND intake.line_account_id = ?
        AND EXISTS (
          SELECT 1 FROM pharmacy_emergency_pharmacists AS pharmacist
          INNER JOIN pharmacy_staff_accounts AS assignment
                  ON assignment.line_account_id = pharmacist.line_account_id
                 AND assignment.staff_id = pharmacist.staff_id
                 AND assignment.is_active = 1
         WHERE pharmacist.line_account_id = intake.line_account_id
           AND pharmacist.staff_id = ? AND pharmacist.is_active = 1
        )`,
  ).bind(crypto.randomUUID(), staffId, accessedAt, intakeId, lineAccountId, staffId).run();
  if ((audit.meta?.changes ?? 0) !== 1) throw new Error('sensitive read audit unavailable');
  const determination = await openEmergencyPayload(row.determination_encrypted, encryptionSecret, {
    tenantId: row.tenant_id, lineAccountId, friendId: row.owner_friend_id, intakeId,
  });
  return {
    id: row.id, outcome: row.outcome as EmergencySaleOutcome, sold_at: row.sold_at,
    product_code: row.product_code, checklist_version: row.checklist_version,
    identity_check: row.identity_check as EmergencyIdentityCheck,
    in_person_dose: row.in_person_dose as EmergencyInPersonDose,
    checklist_sheets_received: row.checklist_sheets_received,
    pharmacist_staff_id: row.pharmacist_staff_id,
    training_registration_number: row.training_registration_number,
    pregnancy_test: PREGNANCY_TEST_RESULTS.has(determination.pregnancyTest as EmergencyPregnancyTestResult)
      ? determination.pregnancyTest as EmergencyPregnancyTestResult
      : 'not_done',
    refusal_reason_code: typeof determination.refusalReasonCode === 'string' ? determination.refusalReasonCode : null,
    referral: REFERRALS.has(determination.referral as EmergencyReferral)
      ? determination.referral as EmergencyReferral
      : 'none',
    explained: Array.isArray(determination.explained) ? determination.explained as string[] : [],
  };
}
