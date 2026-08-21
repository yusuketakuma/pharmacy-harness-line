import { parsePharmacyCapabilities } from './growth-loop/access.js';
import { PHARMACY_RICH_MENU_CATALOG_VERSION } from './rich-menu/catalog.js';

export type PharmacyReadinessStatus = 'READY' | 'BLOCKED' | 'UNVERIFIED';

export const PHARMACY_READINESS_REASON_CODES = [
  'ELECTRONIC_CAPABILITY_DISABLED', 'ELECTRONIC_ENDPOINT_MISSING', 'ELECTRONIC_ENDPOINT_UNVERIFIED',
  'EMERGENCY_CAPABILITY_DISABLED', 'EMERGENCY_REQUIREMENTS_INCOMPLETE',
  'EMERGENCY_TRAINED_PHARMACIST_MISSING', 'EMERGENCY_INVENTORY_UNAVAILABLE',
  'EMERGENCY_FUTURE_SLOT_UNAVAILABLE', 'RICH_MENU_CAPABILITY_DISABLED',
  'RICH_MENU_LAYOUT_MISSING', 'RICH_MENU_SAVED_VERSION_MISSING',
  'RICH_MENU_CAPABILITY_REVISION_STALE', 'RICH_MENU_CATALOG_STALE',
  'RICH_MENU_UPLOAD_UNVERIFIED', 'RICH_MENU_PUBLISHED_VERSION_MISSING',
  'RICH_MENU_DEFAULT_NOT_RECORDED', 'RICH_MENU_DEFAULT_READBACK_UNVERIFIED',
] as const;

export type PharmacyReadinessReasonCode = (typeof PHARMACY_READINESS_REASON_CODES)[number];

export interface PharmacyReadiness {
  accountId: string;
  checkedAt: string;
  electronicPrescription: {
    status: PharmacyReadinessStatus;
    capabilityEnabled: boolean;
    endpointConfigured: boolean;
    reasonCodes: PharmacyReadinessReasonCode[];
    endpointEvidence: {
      status: 'READY' | 'UNVERIFIED';
      source: 'manual_console';
      checkedAt: string | null;
      freshnessHours: 24;
    };
  };
  emergencyContraception: {
    status: 'READY' | 'BLOCKED';
    capabilityEnabled: boolean;
    requirementsComplete: boolean;
    trainedPharmacistAvailable: boolean;
    inventoryAvailable: boolean;
    futureSlotAvailable: boolean;
    reasonCodes: PharmacyReadinessReasonCode[];
  };
  richMenu: {
    status: PharmacyReadinessStatus;
    syncStatus: 'CURRENT' | 'STALE' | 'UNVERIFIED';
    capabilityEnabled: boolean;
    layoutConfigured: boolean;
    savedVersionAvailable: boolean;
    catalogVersionCurrent: boolean;
    publishedVersionAvailable: boolean;
    currentDefaultRecorded: boolean;
    capabilityRevisionCurrent: boolean;
    uploadVerified: boolean;
    defaultReadbackVerified: boolean;
    evidenceCheckedAt: string | null;
    reasonCodes: PharmacyReadinessReasonCode[];
  };
}

type ReadinessRow = {
  id: string;
  capabilities_json: string | null;
  endpoint_configured: number;
  endpoint_checked_at: string | null;
  emergency_requirements_complete: number;
  trained_pharmacist_available: number;
  inventory_available: number;
  future_slot_available: number;
  rich_menu_layout_configured: number;
  rich_menu_saved_version_available: number;
  rich_menu_catalog_version_current: number;
  rich_menu_published_version_available: number;
  rich_menu_default_recorded: number;
  rich_menu_capability_revision_current: number;
  rich_menu_upload_verified: number;
  rich_menu_default_readback_verified: number;
  rich_menu_evidence_checked_at: string | null;
};

export async function getPharmacyReadiness(
  db: D1Database,
  lineAccountId: string,
  now = new Date(),
): Promise<PharmacyReadiness | null> {
  const checkedAt = now.toISOString();
  const evidenceFreshAfter = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  const row = await db.prepare(
    `SELECT account.id, capability.capabilities_json,
       EXISTS (
         SELECT 1 FROM pharmacy_myna_endpoint_configs AS endpoint
          WHERE endpoint.line_account_id = account.id AND endpoint.enabled = 1
            AND endpoint.retired_at IS NULL
       ) AS endpoint_configured,
       (SELECT MAX(endpoint.last_verified_at)
          FROM pharmacy_myna_endpoint_configs AS endpoint
         WHERE endpoint.line_account_id = account.id AND endpoint.enabled = 1
           AND endpoint.retired_at IS NULL) AS endpoint_checked_at,
       CASE WHEN settings.line_account_id IS NOT NULL
         AND trim(settings.pharmacy_registration_number) <> ''
         AND trim(settings.product_code) <> ''
         AND trim(settings.consent_version) <> ''
         AND trim(settings.privacy_contact) <> ''
         AND trim(settings.purpose_text) <> ''
         AND settings.manufacturer_check_url LIKE 'https://%'
         AND settings.privacy_policy_url LIKE 'https://%'
         AND settings.partner_clinic_url LIKE 'https://%'
         AND settings.support_center_url LIKE 'https://%'
         AND settings.privacy_space_ready = 1 AND settings.drinking_water_ready = 1
       THEN 1 ELSE 0 END AS emergency_requirements_complete,
       EXISTS (
         SELECT 1 FROM pharmacy_emergency_pharmacists AS pharmacist
         INNER JOIN pharmacy_staff_accounts AS assignment
                 ON assignment.line_account_id = pharmacist.line_account_id
                AND assignment.staff_id = pharmacist.staff_id AND assignment.is_active = 1
          WHERE pharmacist.line_account_id = account.id AND pharmacist.is_active = 1
       ) AS trained_pharmacist_available,
       EXISTS (
         SELECT 1 FROM pharmacy_emergency_inventory AS inventory
         INNER JOIN pharmacy_emergency_settings AS settings
                 ON settings.line_account_id = inventory.line_account_id
                AND settings.product_code = inventory.product_code
          WHERE inventory.line_account_id = account.id AND inventory.on_hand > (
            SELECT COUNT(*) FROM pharmacy_emergency_intakes AS active
             WHERE active.line_account_id = inventory.line_account_id
               AND active.product_code = inventory.product_code
               AND active.status IN ('provisional', 'reviewed') AND active.expires_at > ?
          )
       ) AS inventory_available,
       EXISTS (
         SELECT 1 FROM pharmacy_emergency_slots AS slot
         INNER JOIN pharmacy_emergency_pharmacists AS pharmacist
                 ON pharmacist.line_account_id = slot.line_account_id
                AND pharmacist.staff_id = slot.pharmacist_staff_id
                AND pharmacist.is_active = 1
         INNER JOIN pharmacy_staff_accounts AS assignment
                 ON assignment.line_account_id = pharmacist.line_account_id
                AND assignment.staff_id = pharmacist.staff_id AND assignment.is_active = 1
          WHERE slot.line_account_id = account.id AND slot.status = 'open'
            AND slot.starts_at > ?
            AND slot.capacity > (
              SELECT COUNT(*) FROM pharmacy_emergency_intakes AS intake
               WHERE intake.slot_id = slot.id AND intake.line_account_id = slot.line_account_id
                 AND intake.status IN ('provisional', 'reviewed') AND intake.expires_at > ?
            )
       ) AS future_slot_available,
       EXISTS (
         SELECT 1 FROM pharmacy_rich_menu_layouts AS layout
          WHERE layout.line_account_id = account.id AND layout.revision >= 1
       ) AS rich_menu_layout_configured,
       EXISTS (
         SELECT 1 FROM pharmacy_rich_menu_draft_bindings AS binding
          WHERE binding.line_account_id = account.id
       ) AS rich_menu_saved_version_available,
       EXISTS (
         SELECT 1 FROM pharmacy_rich_menu_draft_bindings AS binding
          WHERE binding.line_account_id = account.id
            AND binding.catalog_version = '${PHARMACY_RICH_MENU_CATALOG_VERSION}'
       ) AS rich_menu_catalog_version_current,
       EXISTS (
         SELECT 1 FROM pharmacy_rich_menu_draft_bindings AS binding
         INNER JOIN rich_menu_groups AS menu ON menu.id = binding.group_id
          WHERE binding.line_account_id = account.id AND menu.account_id = account.id
            AND menu.status = 'published'
       ) AS rich_menu_published_version_available,
       EXISTS (
         SELECT 1 FROM pharmacy_rich_menu_draft_bindings AS binding
         INNER JOIN rich_menu_groups AS menu ON menu.id = binding.group_id
          WHERE binding.line_account_id = account.id AND menu.account_id = account.id
            AND menu.status = 'published' AND menu.is_default_for_all = 1
       ) AS rich_menu_default_recorded
       , EXISTS (
         SELECT 1 FROM pharmacy_rich_menu_draft_bindings AS binding
         INNER JOIN rich_menu_groups AS menu
                 ON menu.id = binding.group_id
                AND menu.account_id = binding.line_account_id
                AND menu.is_default_for_all = 1
         LEFT JOIN pharmacy_account_capability_revisions AS revision
                ON revision.line_account_id = binding.line_account_id
          WHERE binding.line_account_id = account.id
            AND binding.capability_revision = COALESCE(revision.revision, 1)
       ) AS rich_menu_capability_revision_current
       , EXISTS (
         SELECT 1 FROM pharmacy_rich_menu_operations AS operation
         INNER JOIN pharmacy_rich_menu_draft_bindings AS binding
                 ON binding.group_id = operation.group_id
                AND binding.line_account_id = operation.line_account_id
          WHERE operation.line_account_id = account.id AND operation.kind = 'publish'
            AND operation.status = 'succeeded' AND operation.publish_phase = 'committed'
            AND operation.verified_at IS NOT NULL
       ) AS rich_menu_upload_verified
       , EXISTS (
         SELECT 1 FROM pharmacy_rich_menu_operations AS operation
         INNER JOIN rich_menu_groups AS menu ON menu.id = operation.group_id
         INNER JOIN rich_menu_pages AS page ON page.group_id = menu.id
          WHERE operation.line_account_id = account.id AND menu.account_id = account.id
            AND menu.is_default_for_all = 1
            AND operation.kind IN ('set_default', 'rollback')
            AND operation.status = 'succeeded'
            AND operation.verified_default_menu_id = page.line_richmenu_id
            AND operation.verified_at >= ?
       ) AS rich_menu_default_readback_verified
       , (SELECT MAX(operation.verified_at) FROM pharmacy_rich_menu_operations AS operation
          INNER JOIN rich_menu_groups AS menu ON menu.id = operation.group_id
          INNER JOIN rich_menu_pages AS page ON page.group_id = menu.id
           WHERE operation.line_account_id = account.id AND menu.account_id = account.id
             AND menu.is_default_for_all = 1
             AND operation.kind IN ('set_default', 'rollback')
             AND operation.status = 'succeeded'
             AND operation.verified_default_menu_id = page.line_richmenu_id)
         AS rich_menu_evidence_checked_at
      FROM line_accounts AS account
      LEFT JOIN pharmacy_account_capabilities AS capability
             ON capability.line_account_id = account.id AND capability.mode = 'pharmacy'
      LEFT JOIN pharmacy_emergency_settings AS settings ON settings.line_account_id = account.id
     WHERE account.id = ?
     LIMIT 1`,
  ).bind(checkedAt, checkedAt, checkedAt, evidenceFreshAfter, lineAccountId).first<ReadinessRow>();
  if (!row) return null;

  const capabilities = parsePharmacyCapabilities(row.capabilities_json);
  const electronicCapability = capabilities.includes('electronic_prescription');
  const endpointConfigured = row.endpoint_configured === 1;
  const endpointVerified = endpointConfigured && Boolean(row.endpoint_checked_at) &&
    row.endpoint_checked_at! >= evidenceFreshAfter && row.endpoint_checked_at! <= checkedAt;
  const emergencyCapability = capabilities.includes('emergency_contraception');
  const requirementsComplete = row.emergency_requirements_complete === 1;
  const trainedPharmacistAvailable = row.trained_pharmacist_available === 1;
  const inventoryAvailable = row.inventory_available === 1;
  const futureSlotAvailable = row.future_slot_available === 1;
  const richMenuCapability = capabilities.includes('pharmacy_rich_menu');
  const layoutConfigured = row.rich_menu_layout_configured === 1;
  const savedVersionAvailable = row.rich_menu_saved_version_available === 1;
  const catalogVersionCurrent = row.rich_menu_catalog_version_current === 1;
  const publishedVersionAvailable = row.rich_menu_published_version_available === 1;
  const currentDefaultRecorded = row.rich_menu_default_recorded === 1;
  const capabilityRevisionCurrent = row.rich_menu_capability_revision_current === 1;
  const uploadVerified = row.rich_menu_upload_verified === 1;
  const defaultReadbackVerified = row.rich_menu_default_readback_verified === 1;

  const electronicReasons: PharmacyReadinessReasonCode[] = [];
  if (!electronicCapability) electronicReasons.push('ELECTRONIC_CAPABILITY_DISABLED');
  if (!endpointConfigured) electronicReasons.push('ELECTRONIC_ENDPOINT_MISSING');
  if (electronicCapability && endpointConfigured && !endpointVerified) {
    electronicReasons.push('ELECTRONIC_ENDPOINT_UNVERIFIED');
  }

  const emergencyReasons: PharmacyReadinessReasonCode[] = [];
  if (!emergencyCapability) emergencyReasons.push('EMERGENCY_CAPABILITY_DISABLED');
  if (!requirementsComplete) emergencyReasons.push('EMERGENCY_REQUIREMENTS_INCOMPLETE');
  if (!trainedPharmacistAvailable) emergencyReasons.push('EMERGENCY_TRAINED_PHARMACIST_MISSING');
  if (!inventoryAvailable) emergencyReasons.push('EMERGENCY_INVENTORY_UNAVAILABLE');
  if (!futureSlotAvailable) emergencyReasons.push('EMERGENCY_FUTURE_SLOT_UNAVAILABLE');

  const richMenuReasons: PharmacyReadinessReasonCode[] = [];
  if (!richMenuCapability) richMenuReasons.push('RICH_MENU_CAPABILITY_DISABLED');
  if (!layoutConfigured) richMenuReasons.push('RICH_MENU_LAYOUT_MISSING');
  if (!savedVersionAvailable) richMenuReasons.push('RICH_MENU_SAVED_VERSION_MISSING');
  if (savedVersionAvailable && !capabilityRevisionCurrent) richMenuReasons.push('RICH_MENU_CAPABILITY_REVISION_STALE');
  if (savedVersionAvailable && !catalogVersionCurrent) richMenuReasons.push('RICH_MENU_CATALOG_STALE');
  if (savedVersionAvailable && !uploadVerified) richMenuReasons.push('RICH_MENU_UPLOAD_UNVERIFIED');
  if (!publishedVersionAvailable) richMenuReasons.push('RICH_MENU_PUBLISHED_VERSION_MISSING');
  if (!currentDefaultRecorded) richMenuReasons.push('RICH_MENU_DEFAULT_NOT_RECORDED');
  const richMenuBlocked = richMenuReasons.length > 0;
  if (!richMenuBlocked && !defaultReadbackVerified) {
    richMenuReasons.push('RICH_MENU_DEFAULT_READBACK_UNVERIFIED');
  }

  return {
    accountId: row.id,
    checkedAt,
    electronicPrescription: {
      status: electronicCapability && endpointConfigured
        ? endpointVerified ? 'READY' : 'UNVERIFIED'
        : 'BLOCKED',
      capabilityEnabled: electronicCapability,
      endpointConfigured,
      reasonCodes: electronicReasons,
      endpointEvidence: {
        status: endpointVerified ? 'READY' : 'UNVERIFIED',
        source: 'manual_console',
        checkedAt: row.endpoint_checked_at,
        freshnessHours: 24,
      },
    },
    emergencyContraception: {
      status: emergencyCapability && requirementsComplete && trainedPharmacistAvailable && inventoryAvailable && futureSlotAvailable
        ? 'READY' : 'BLOCKED',
      capabilityEnabled: emergencyCapability,
      requirementsComplete,
      trainedPharmacistAvailable,
      inventoryAvailable,
      futureSlotAvailable,
      reasonCodes: emergencyReasons,
    },
    richMenu: {
      status: richMenuBlocked ? 'BLOCKED' : defaultReadbackVerified ? 'READY' : 'UNVERIFIED',
      syncStatus: !richMenuCapability || !currentDefaultRecorded || !defaultReadbackVerified
        ? 'UNVERIFIED'
        : !capabilityRevisionCurrent || !catalogVersionCurrent ? 'STALE' : 'CURRENT',
      capabilityEnabled: richMenuCapability,
      layoutConfigured,
      savedVersionAvailable,
      catalogVersionCurrent,
      publishedVersionAvailable,
      currentDefaultRecorded,
      capabilityRevisionCurrent,
      uploadVerified,
      defaultReadbackVerified,
      evidenceCheckedAt: row.rich_menu_evidence_checked_at,
      reasonCodes: richMenuReasons,
    },
  };
}
