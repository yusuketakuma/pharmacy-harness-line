import { parsePharmacyCapabilities } from './growth-loop/access.js';

export type PharmacyReadinessStatus = 'READY' | 'BLOCKED' | 'UNVERIFIED';

export interface PharmacyReadiness {
  accountId: string;
  checkedAt: string;
  electronicPrescription: {
    status: PharmacyReadinessStatus;
    capabilityEnabled: boolean;
    endpointConfigured: boolean;
    endpointEvidence: {
      status: 'UNVERIFIED';
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
  };
}

type ReadinessRow = {
  id: string;
  capabilities_json: string | null;
  endpoint_configured: number;
  emergency_requirements_complete: number;
  trained_pharmacist_available: number;
  inventory_available: number;
  future_slot_available: number;
};

export async function getPharmacyReadiness(
  db: D1Database,
  lineAccountId: string,
  now = new Date(),
): Promise<PharmacyReadiness | null> {
  const checkedAt = now.toISOString();
  const row = await db.prepare(
    `SELECT account.id, capability.capabilities_json,
       EXISTS (
         SELECT 1 FROM pharmacy_myna_endpoint_configs AS endpoint
          WHERE endpoint.line_account_id = account.id AND endpoint.enabled = 1
            AND endpoint.retired_at IS NULL
       ) AS endpoint_configured,
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
       ) AS future_slot_available
      FROM line_accounts AS account
      LEFT JOIN pharmacy_account_capabilities AS capability
             ON capability.line_account_id = account.id AND capability.mode = 'pharmacy'
      LEFT JOIN pharmacy_emergency_settings AS settings ON settings.line_account_id = account.id
     WHERE account.id = ?
     LIMIT 1`,
  ).bind(checkedAt, checkedAt, checkedAt, lineAccountId).first<ReadinessRow>();
  if (!row) return null;

  const capabilities = parsePharmacyCapabilities(row.capabilities_json);
  const electronicCapability = capabilities.includes('electronic_prescription');
  const endpointConfigured = row.endpoint_configured === 1;
  const emergencyCapability = capabilities.includes('emergency_contraception');
  const requirementsComplete = row.emergency_requirements_complete === 1;
  const trainedPharmacistAvailable = row.trained_pharmacist_available === 1;
  const inventoryAvailable = row.inventory_available === 1;
  const futureSlotAvailable = row.future_slot_available === 1;

  return {
    accountId: row.id,
    checkedAt,
    electronicPrescription: {
      status: electronicCapability && endpointConfigured ? 'UNVERIFIED' : 'BLOCKED',
      capabilityEnabled: electronicCapability,
      endpointConfigured,
      endpointEvidence: {
        status: 'UNVERIFIED',
        source: 'manual_console',
        checkedAt: null,
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
    },
  };
}
