import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  config: vi.fn(),
  readiness: vi.fn(),
}));

vi.mock('./repository.js', () => ({ getPharmacyCapabilityConfig: mocks.config }));
vi.mock('../readiness.js', () => ({ getPharmacyReadiness: mocks.readiness }));

import { getPharmacyOperationsSummary } from './operations-summary.js';

type Row = { status: string; count: number; updated_at: string | null };

function database(rows: Record<string, Row[]>, failingTable?: string) {
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const db = {
    prepare(sql: string) {
      const table = Object.keys(rows).find((name) => sql.includes(name));
      return {
        bind(...values: unknown[]) {
          calls.push({ sql, values });
          return {
            async all() {
              if (table === failingTable) throw new Error('domain unavailable');
              return { results: table ? rows[table] : [] };
            },
          };
        },
      };
    },
  } as unknown as D1Database;
  return { db, calls };
}

const rows = {
  pharmacy_prescription_submissions: [
    { status: 'received', count: 2, updated_at: '2026-08-21T01:00:00.000Z' },
  ],
  pharmacy_myna_handoffs: [
    { status: 'SUPPORT_NEEDED', count: 1, updated_at: '2026-08-21T02:00:00.000Z' },
  ],
  pharmacy_prescription_patients: [
    { status: 'unreviewed', count: 3, updated_at: '2026-08-21T03:00:00.000Z' },
  ],
  pharmacy_next_intake_expectations: [
    { status: 'active', count: 4, updated_at: '2026-08-21T04:00:00.000Z' },
  ],
  pharmacy_medication_followups: [
    { status: 'due', count: 5, updated_at: '2026-08-21T05:00:00.000Z' },
  ],
  pharmacy_emergency_intakes: [
    { status: 'reviewed', count: 1, updated_at: '2026-08-21T06:00:00.000Z' },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.config.mockResolvedValue({
    capabilities: ['prescription_intake', 'electronic_prescription', 'patient_intake'],
  });
  mocks.readiness.mockResolvedValue({
    richMenu: {
      status: 'UNVERIFIED', capabilityEnabled: true, layoutConfigured: true,
      savedVersionAvailable: true, catalogVersionCurrent: false,
      publishedVersionAvailable: true, currentDefaultRecorded: true,
    },
  });
});

describe('pharmacy operations summary', () => {
  it('returns only non-PHI status counts scoped to the authorized account', async () => {
    const { db, calls } = database(rows);
    const result = await getPharmacyOperationsSummary(
      db, 'account-a', new Date('2026-08-21T07:00:00.000Z'),
    );

    expect(result.accountId).toBe('account-a');
    expect(result.domains.prescriptionIntake).toMatchObject({
      enabled: true, activeCount: 2, statusCounts: { received: 2 }, error: false,
    });
    expect(result.domains.emergencyContraception).toMatchObject({
      enabled: false, activeCount: 1, statusCounts: { reviewed: 1 }, error: false,
    });
    expect(result.richMenu).toMatchObject({ status: 'UNVERIFIED', catalogVersionCurrent: false, error: false });
    expect(calls).toHaveLength(6);
    expect(calls.every(({ values }) => values[0] === 'account-a')).toBe(true);
    const emergencySql = calls.find(({ sql }) => sql.includes('pharmacy_emergency_intakes'))?.sql ?? '';
    expect(emergencySql).toContain("status IN ('provisional', 'reviewed')");
    expect(emergencySql).not.toMatch(/decrypt|encrypted|reference|friend_id|patient_id|json/i);
  });

  it('keeps successful domains when one domain and readiness fail', async () => {
    const { db } = database(rows, 'pharmacy_emergency_intakes');
    mocks.readiness.mockRejectedValue(new Error('readiness unavailable'));

    const result = await getPharmacyOperationsSummary(db, 'account-a');

    expect(result.domains.prescriptionIntake.activeCount).toBe(2);
    expect(result.domains.emergencyContraception).toMatchObject({ activeCount: null, error: true });
    expect(result.richMenu).toMatchObject({ status: null, error: true });
  });
});
