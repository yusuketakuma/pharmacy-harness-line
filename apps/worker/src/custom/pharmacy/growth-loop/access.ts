import type { AuthenticatedStaff } from '../../../middleware/auth.js';

export const PHARMACY_CAPABILITIES = [
  'prescription_intake',
  'patient_intake',
  'fulfillment_quote',
  'continuity',
  'medication_followup',
  'manual_chat',
  'pharmacy_rich_menu',
  'account_settings',
  'pharmacy_dashboard',
] as const;

export type PharmacyCapability = (typeof PHARMACY_CAPABILITIES)[number];

export type PharmacyStaff = Pick<AuthenticatedStaff, 'id' | 'role'>;

export interface PharmacyCapabilityConfig {
  line_account_id: string;
  mode: 'pharmacy';
  capabilities: PharmacyCapability[];
  proactive_monthly_limit: number;
  unfollow_alert_state: 'alert_only' | 'auto_pause';
  created_at: string;
  updated_at: string;
}

export function parsePharmacyCapabilities(raw: string | null | undefined): PharmacyCapability[] {
  if (!raw) return [];
  try {
    const value = JSON.parse(raw) as unknown;
    if (!Array.isArray(value)) return [];
    return value.filter((item): item is PharmacyCapability =>
      typeof item === 'string' && (PHARMACY_CAPABILITIES as readonly string[]).includes(item),
    );
  } catch {
    return [];
  }
}

export async function canAccessPharmacyAccount(
  db: D1Database,
  staff: PharmacyStaff | null | undefined,
  lineAccountId: string,
): Promise<boolean> {
  if (!staff || !lineAccountId) return false;
  const account = await db.prepare(
    `SELECT id FROM line_accounts WHERE id = ? AND is_active = 1`,
  ).bind(lineAccountId).first<{ id: string }>();
  if (!account) return false;
  if (staff.id === 'env-owner') return true;

  const assigned = await db.prepare(
    `SELECT 1 AS ok FROM pharmacy_staff_accounts
      WHERE line_account_id = ? AND staff_id = ? AND is_active = 1
     LIMIT 1`,
  ).bind(lineAccountId, staff.id).first<{ ok: number }>();
  return Boolean(assigned);
}

export async function hasPharmacyCapability(
  db: D1Database,
  lineAccountId: string,
  capability: PharmacyCapability,
): Promise<boolean> {
  const row = await db.prepare(
    `SELECT mode, capabilities_json FROM pharmacy_account_capabilities
      WHERE line_account_id = ?`,
  ).bind(lineAccountId).first<{ mode: string; capabilities_json: string }>();
  return row?.mode === 'pharmacy' && parsePharmacyCapabilities(row.capabilities_json).includes(capability);
}

export async function isPharmacyModeAccount(
  db: D1Database,
  lineAccountId: string | null | undefined,
): Promise<boolean> {
  if (!lineAccountId) return false;
  const row = await db.prepare(
    `SELECT mode FROM pharmacy_account_capabilities WHERE line_account_id = ?`,
  ).bind(lineAccountId).first<{ mode: string }>();
  return row?.mode === 'pharmacy';
}
