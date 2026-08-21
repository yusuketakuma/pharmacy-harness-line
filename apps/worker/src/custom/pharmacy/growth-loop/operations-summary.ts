import { getPharmacyReadiness } from '../readiness.js';
import type { PharmacyCapability } from './access.js';
import { getPharmacyCapabilityConfig } from './repository.js';

const DOMAIN_QUERIES = [
  {
    key: 'prescriptionIntake', capability: 'prescription_intake',
    sql: `SELECT status, COUNT(*) AS count, MAX(updated_at) AS updated_at
            FROM pharmacy_prescription_submissions
           WHERE line_account_id = ? AND status NOT IN ('closed', 'cancelled')
           GROUP BY status`,
  },
  {
    key: 'electronicPrescription', capability: 'electronic_prescription',
    sql: `SELECT status, COUNT(*) AS count, MAX(updated_at) AS updated_at
            FROM pharmacy_myna_handoffs
           WHERE line_account_id = ?
             AND status NOT IN ('PAPER_FALLBACK', 'ABANDONED', 'EXPIRED', 'CLOSED')
           GROUP BY status`,
  },
  {
    key: 'patientIntake', capability: 'patient_intake',
    sql: `SELECT 'unreviewed' AS status, COUNT(*) AS count, MAX(created_at) AS updated_at
            FROM pharmacy_prescription_patients
           WHERE line_account_id = ? AND reviewed_at IS NULL
          HAVING COUNT(*) > 0`,
  },
  {
    key: 'continuity', capability: 'continuity',
    sql: `SELECT status, COUNT(*) AS count, MAX(updated_at) AS updated_at
            FROM pharmacy_next_intake_expectations
           WHERE line_account_id = ? AND status NOT IN ('linked', 'fulfilled', 'ended')
           GROUP BY status`,
  },
  {
    key: 'medicationFollowup', capability: 'medication_followup',
    sql: `SELECT status, COUNT(*) AS count, MAX(updated_at) AS updated_at
            FROM pharmacy_medication_followups
           WHERE line_account_id = ? AND status NOT IN ('closed', 'cancelled')
           GROUP BY status`,
  },
  {
    key: 'emergencyContraception', capability: 'emergency_contraception',
    sql: `SELECT status, COUNT(*) AS count, MAX(updated_at) AS updated_at
            FROM pharmacy_emergency_intakes
           WHERE line_account_id = ? AND status IN ('provisional', 'reviewed')
             AND expires_at > ?
           GROUP BY status`,
  },
] as const satisfies ReadonlyArray<{
  key: string;
  capability: PharmacyCapability;
  sql: string;
}>;

type DomainKey = (typeof DOMAIN_QUERIES)[number]['key'];
type StatusRow = { status: string; count: number; updated_at: string | null };

export interface PharmacyOperationDomainSummary {
  enabled: boolean | null;
  activeCount: number | null;
  statusCounts: Record<string, number>;
  updatedAt: string | null;
  error: boolean;
}

export interface PharmacyOperationsSummary {
  accountId: string;
  checkedAt: string;
  capabilityError: boolean;
  domains: Record<DomainKey, PharmacyOperationDomainSummary>;
  richMenu: {
    status: 'READY' | 'BLOCKED' | 'UNVERIFIED' | null;
    capabilityEnabled: boolean | null;
    layoutConfigured: boolean | null;
    savedVersionAvailable: boolean | null;
    catalogVersionCurrent: boolean | null;
    publishedVersionAvailable: boolean | null;
    currentDefaultRecorded: boolean | null;
    error: boolean;
  };
}

export async function getPharmacyOperationsSummary(
  db: D1Database,
  lineAccountId: string,
  at = new Date(),
): Promise<PharmacyOperationsSummary> {
  const [configResult, readinessResult, domainResults] = await Promise.all([
    Promise.allSettled([getPharmacyCapabilityConfig(db, lineAccountId)]).then(([result]) => result),
    Promise.allSettled([getPharmacyReadiness(db, lineAccountId, at)]).then(([result]) => result),
    Promise.allSettled(DOMAIN_QUERIES.map(async ({ sql, key }) => {
      const values = key === 'emergencyContraception' ? [lineAccountId, at.toISOString()] : [lineAccountId];
      const result = await db.prepare(sql).bind(...values).all<StatusRow>();
      return result.results ?? [];
    })),
  ]);

  const capabilities = configResult.status === 'fulfilled'
    ? configResult.value?.capabilities ?? []
    : null;
  const domains = Object.fromEntries(DOMAIN_QUERIES.map(({ key, capability }, index) => {
    const result = domainResults[index];
    if (result.status === 'rejected') return [key, {
      enabled: capabilities?.includes(capability) ?? null,
      activeCount: null,
      statusCounts: {},
      updatedAt: null,
      error: true,
    }];
    const statusCounts = Object.fromEntries(result.value.map((row) => [row.status, Number(row.count)]));
    return [key, {
      enabled: capabilities?.includes(capability) ?? null,
      activeCount: Object.values(statusCounts).reduce((sum, count) => sum + count, 0),
      statusCounts,
      updatedAt: result.value.reduce<string | null>(
        (latest, row) => !latest || (row.updated_at && row.updated_at > latest) ? row.updated_at : latest,
        null,
      ),
      error: false,
    }];
  })) as Record<DomainKey, PharmacyOperationDomainSummary>;

  const richMenu = readinessResult.status === 'fulfilled' && readinessResult.value
    ? { ...readinessResult.value.richMenu, error: false }
    : {
      status: null,
      capabilityEnabled: null,
      layoutConfigured: null,
      savedVersionAvailable: null,
      catalogVersionCurrent: null,
      publishedVersionAvailable: null,
      currentDefaultRecorded: null,
      error: true,
    };

  return {
    accountId: lineAccountId,
    checkedAt: at.toISOString(),
    capabilityError: configResult.status === 'rejected',
    domains,
    richMenu,
  };
}
