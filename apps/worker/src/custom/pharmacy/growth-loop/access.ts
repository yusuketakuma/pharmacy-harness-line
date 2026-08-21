import type { AuthenticatedStaff } from '../../../middleware/auth.js';

export const PATIENT_PHARMACY_CAPABILITIES = [
  'prescription_intake',
  'patient_intake',
  'electronic_prescription',
  'continuity',
  'medication_followup',
  'emergency_contraception',
  'manual_chat',
  'pharmacy_info',
] as const;

export const MANAGEMENT_PHARMACY_CAPABILITIES = [
  'fulfillment_quote',
  'pharmacy_rich_menu',
  'account_settings',
  'pharmacy_dashboard',
] as const;

export const PHARMACY_CAPABILITIES = [
  ...PATIENT_PHARMACY_CAPABILITIES,
  ...MANAGEMENT_PHARMACY_CAPABILITIES,
] as const;

export const DEFAULT_PHARMACY_CAPABILITIES = PHARMACY_CAPABILITIES.filter(
  (capability) => capability !== 'electronic_prescription' && capability !== 'emergency_contraception',
);

export type PharmacyCapability = (typeof PHARMACY_CAPABILITIES)[number];

export type PharmacyStaff = Pick<AuthenticatedStaff, 'id' | 'role'>;

async function pharmacyCapabilityTableDeployed(db: D1Database): Promise<boolean> {
  try {
    const row = await db.prepare(
      `SELECT name FROM sqlite_master
        WHERE type = 'table' AND name = 'pharmacy_account_capabilities'
        LIMIT 1`,
    ).bind().first<{ name: string }>();
    return row?.name === 'pharmacy_account_capabilities';
  } catch {
    // A metadata read failure must not reopen generic delivery paths.
    return true;
  }
}

/** SQL predicate used when a pharmacy collection must hide unassigned accounts. */
export function pharmacyStaffAccountPredicate(accountColumn: string, mappingAlias = 'mapping'): string {
  return `EXISTS (
    SELECT 1
      FROM pharmacy_staff_accounts AS assignment
      INNER JOIN tenant_staff_memberships AS membership
              ON membership.staff_id = assignment.staff_id
             AND membership.tenant_id = ${mappingAlias}.tenant_id
             AND membership.is_active = 1
     WHERE assignment.line_account_id = ${accountColumn}
       AND assignment.staff_id = ?
       AND assignment.is_active = 1
  )`;
}

export interface PharmacyCapabilityConfig {
  line_account_id: string;
  mode: 'pharmacy';
  capabilities: PharmacyCapability[];
  proactive_monthly_limit: number;
  unfollow_alert_state: 'alert_only' | 'auto_pause';
  revision: number;
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

export async function resolveAccessiblePharmacyTenant(
  db: D1Database,
  staff: PharmacyStaff | null | undefined,
  lineAccountId: string,
): Promise<string | null> {
  if (!staff || !lineAccountId) return null;
  if (staff.id === 'env-owner') return null;
  try {
    // Keep the mapping, active tenant, membership, and account assignment in
    // one statement. Splitting these checks permits a remap between reads.
    const account = await db.prepare(
      `SELECT mapping.tenant_id
         FROM line_accounts AS account
         INNER JOIN tenant_line_accounts AS mapping
                 ON mapping.line_account_id = account.id
         INNER JOIN tenants AS tenant
                 ON tenant.id = mapping.tenant_id AND tenant.status = 'active'
         INNER JOIN tenant_staff_memberships AS membership
                 ON membership.tenant_id = mapping.tenant_id
                AND membership.staff_id = ?
                AND membership.is_active = 1
         INNER JOIN pharmacy_staff_accounts AS assignment
                 ON assignment.line_account_id = account.id
                AND assignment.staff_id = membership.staff_id
                AND assignment.is_active = 1
        WHERE account.id = ? AND account.is_active = 1
        LIMIT 1`,
    ).bind(staff.id, lineAccountId).first<{ tenant_id: string }>();
    return account?.tenant_id ?? null;
  } catch {
    return null;
  }
}

export async function canAccessPharmacyAccount(
  db: D1Database,
  staff: PharmacyStaff | null | undefined,
  lineAccountId: string,
): Promise<boolean> {
  return Boolean(await resolveAccessiblePharmacyTenant(db, staff, lineAccountId));
}

export async function hasPharmacyCapability(
  db: D1Database,
  lineAccountId: string,
  capability: PharmacyCapability,
): Promise<boolean> {
  try {
    const row = await db.prepare(
      `SELECT mode, capabilities_json FROM pharmacy_account_capabilities
        WHERE line_account_id = ?`,
    ).bind(lineAccountId).first<{ mode: string; capabilities_json: string }>();
    return row?.mode === 'pharmacy' && parsePharmacyCapabilities(row.capabilities_json).includes(capability);
  } catch {
    return false;
  }
}

export async function isPharmacyModeAccount(
  db: D1Database,
  lineAccountId: string | null | undefined,
): Promise<boolean> {
  if (!lineAccountId) return false;
  try {
    const capability = await db.prepare(
      `SELECT mode FROM pharmacy_account_capabilities WHERE line_account_id = ?`,
    ).bind(lineAccountId).first<{ mode: string }>();
    // The capability row is the explicit product-mode switch. A tenant
    // mapping alone is not enough: generic CRM tenants may still be mapped
    // for ordinary account scoping.
    return capability?.mode === 'pharmacy'
      || (!capability && await pharmacyCapabilityTableDeployed(db));
  } catch {
    // A storage error must not reopen generic delivery paths.
    return true;
  }
}

export async function isPharmacyTenant(db: D1Database, tenantId: string): Promise<boolean> {
  try {
    const capability = await db.prepare(
      `SELECT 1 AS pharmacy_install
         FROM tenant_line_accounts AS mapping
         INNER JOIN pharmacy_account_capabilities AS capability
                 ON capability.line_account_id = mapping.line_account_id
        WHERE mapping.tenant_id = ? AND capability.mode = 'pharmacy'
        LIMIT 1`,
    ).bind(tenantId).first<{ pharmacy_install: number }>();
    return capability?.pharmacy_install === 1
      || (!capability && await pharmacyCapabilityTableDeployed(db));
  } catch {
    // A storage error must not reopen generic delivery paths.
    return true;
  }
}

export async function hasPharmacyModeAccount(db: D1Database): Promise<boolean> {
  try {
    const capability = await db.prepare(
      `SELECT 1 AS ok FROM pharmacy_account_capabilities WHERE mode = ? LIMIT 1`,
    ).bind('pharmacy').first<{ ok: number }>();
    return capability?.ok === 1
      || (!capability && await pharmacyCapabilityTableDeployed(db));
  } catch {
    // A storage error must not reopen generic delivery paths.
    return true;
  }
}
