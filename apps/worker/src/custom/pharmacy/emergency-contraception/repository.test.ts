import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  createEmergencyIntake, getAdminEmergencyIntakeDetail, saveEmergencySettings,
} from './repository.js';

const DB_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../../../../packages/db');
const require = createRequire(import.meta.url);

type SqliteStatement = {
  get(...values: unknown[]): unknown;
  all(...values: unknown[]): unknown[];
  run(...values: unknown[]): { changes: number };
};
type Sqlite3Database = {
  pragma(sql: string): unknown;
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  transaction<T extends (...args: never[]) => unknown>(fn: T): T;
};
const Sqlite = require(join(DB_ROOT, 'node_modules/better-sqlite3')) as
  new (filename: string) => Sqlite3Database;

type RunnableStatement = {
  bind(...next: unknown[]): RunnableStatement;
  first(): Promise<unknown>;
  all(): Promise<{ success: true; results: unknown[]; meta: Record<string, never> }>;
  run(): Promise<{ success: true; meta: { changes: number }; results: never[] }>;
  runSync(): { success: true; meta: { changes: number }; results: never[] };
};

/** Adapts better-sqlite3 to the D1 surface the worker uses, including batch(). */
function d1From(sqlite: Sqlite3Database): D1Database {
  const statement = (sql: string, values: unknown[] = []): RunnableStatement => ({
    bind: (...next: unknown[]) => statement(sql, next),
    first: async () => sqlite.prepare(sql).get(...values) ?? null,
    all: async () => ({ success: true, results: sqlite.prepare(sql).all(...values), meta: {} }),
    run: async () => statement(sql, values).runSync(),
    runSync: () => {
      const info = sqlite.prepare(sql).run(...values);
      return { success: true, meta: { changes: info.changes }, results: [] };
    },
  });
  return {
    prepare: (sql: string) => statement(sql),
    batch: async (statements: RunnableStatement[]) => sqlite.transaction(() =>
      statements.map((item) => item.runSync()),
    )(),
  } as unknown as D1Database;
}

function settingsDb(
  calls: Array<{ sql: string; values: unknown[] }>,
  currentRow: { purpose_text: string; retention_days: number; consent_version: string } | null,
): D1Database {
  return {
    prepare: (sql: string) => ({
      bind: (...values: unknown[]) => ({
        first: async () => currentRow,
        run: async () => { calls.push({ sql, values }); return { meta: { changes: 1 } }; },
      }),
    }),
  } as unknown as D1Database;
}

describe('emergency contraception settings authority', () => {
  it('derives enabled state from the canonical capability and never overwrites it on config updates', async () => {
    const calls: Array<{ sql: string; values: unknown[] }> = [];
    const db = settingsDb(calls, null);

    await saveEmergencySettings(db, {
      lineAccountId: 'account-a', staffId: 'staff-a', pharmacyRegistrationNumber: 'REG-A',
      productCode: 'norlevo-otc', manufacturerCheckUrl: 'https://manufacturer.example/check',
      privacyPolicyUrl: 'https://pharmacy.example/privacy', privacyContact: 'privacy@example.test',
      purposeText: '対面相談受付', consentVersion: '2026-08-21', retentionDays: 30,
      consultationMinutes: 30, reservationTtlMinutes: 30, privacySpaceReady: true,
      drinkingWaterReady: true, partnerClinicUrl: 'https://clinic.example',
      supportCenterUrl: 'https://support.example',
    });

    expect(calls[0].sql).toContain("value = 'emergency_contraception'");
    expect(calls[0].sql).not.toContain('is_enabled = excluded.is_enabled');
    expect(calls[0].values.slice(0, 2)).toEqual(['account-a', 'account-a']);
  });

  it('rejects a purpose_text or retention_days change that keeps the same consent_version', async () => {
    const calls: Array<{ sql: string; values: unknown[] }> = [];
    const base = {
      lineAccountId: 'account-a', staffId: 'staff-a', pharmacyRegistrationNumber: 'REG-A',
      productCode: 'norlevo-otc', manufacturerCheckUrl: 'https://manufacturer.example/check',
      privacyPolicyUrl: 'https://pharmacy.example/privacy', privacyContact: 'privacy@example.test',
      consultationMinutes: 30, reservationTtlMinutes: 30, privacySpaceReady: true,
      drinkingWaterReady: true, partnerClinicUrl: 'https://clinic.example',
      supportCenterUrl: 'https://support.example',
    };

    await expect(saveEmergencySettings(settingsDb(calls, {
      purpose_text: '旧・対面相談受付', retention_days: 30, consent_version: '2026-08-21',
    }), {
      ...base, purposeText: '新・対面相談受付', consentVersion: '2026-08-21', retentionDays: 30,
    })).rejects.toThrow('EMERGENCY_CONSENT_VERSION_STALE');

    await expect(saveEmergencySettings(settingsDb(calls, {
      purpose_text: '対面相談受付', retention_days: 30, consent_version: '2026-08-21',
    }), {
      ...base, purposeText: '対面相談受付', consentVersion: '2026-08-21', retentionDays: 60,
    })).rejects.toThrow('EMERGENCY_CONSENT_VERSION_STALE');

    // Bumping consent_version alongside the wording/retention change is allowed.
    await expect(saveEmergencySettings(settingsDb(calls, {
      purpose_text: '旧・対面相談受付', retention_days: 30, consent_version: '2026-08-21',
    }), {
      ...base, purposeText: '新・対面相談受付', consentVersion: '2026-08-22', retentionDays: 30,
    })).resolves.toBeUndefined();
    expect(calls).toHaveLength(1);
  });
});

describe('emergency contraception v2 payload round-trip (B1-B4/C1-C2/D3, ECF-6)', () => {
  let sqlite: Sqlite3Database;
  let db: D1Database;
  const now = '2026-08-01T00:00:00.000Z';

  function seedAccount(): void {
    sqlite.prepare(`INSERT INTO line_accounts
      (id, channel_id, name, channel_access_token, channel_secret, created_at, updated_at)
      VALUES ('account-a', 'channel-a', 'a', 'token-a', 'secret-a', ?, ?)`).run(now, now);
    sqlite.prepare(`INSERT INTO tenants (id, tenant_code, display_name, status, created_at, updated_at)
      VALUES ('tenant-a', 'a', 'a', 'active', ?, ?)`).run(now, now);
    sqlite.prepare(`INSERT INTO tenant_line_accounts (tenant_id, line_account_id, created_at, updated_at)
      VALUES ('tenant-a', 'account-a', ?, ?)`).run(now, now);
    sqlite.prepare(`INSERT INTO friends
      (id, line_user_id, provider_line_user_id, line_account_id, is_following, created_at, updated_at)
      VALUES ('friend-a', 'legacy-u-a', 'U-a', 'account-a', 1, ?, ?)`).run(now, now);
    sqlite.prepare(`INSERT INTO staff_members
      (id, name, role, api_key, is_active, created_at, updated_at)
      VALUES ('staff-a', 'Staff A', 'admin', 'key-a', 1, ?, ?)`).run(now, now);
    sqlite.prepare(`INSERT INTO tenant_staff_memberships
      (tenant_id, staff_id, role, is_active, created_at, updated_at)
      VALUES ('tenant-a', 'staff-a', 'admin', 1, ?, ?)`).run(now, now);
    sqlite.prepare(`INSERT INTO pharmacy_staff_accounts
      (line_account_id, staff_id, is_active, created_at, updated_at)
      VALUES ('account-a', 'staff-a', 1, ?, ?)`).run(now, now);
    // line_accounts_default_pharmacy_capability already inserted a row for
    // this account; add emergency_contraception to the existing capability list.
    sqlite.prepare(`UPDATE pharmacy_account_capabilities
      SET capabilities_json = json_insert(capabilities_json, '$[#]', 'emergency_contraception'), updated_at = ?
      WHERE line_account_id = 'account-a' AND mode = 'pharmacy'`).run(now);
    sqlite.prepare(`INSERT INTO pharmacy_emergency_settings
      (line_account_id, is_enabled, pharmacy_registration_number, product_code,
       manufacturer_check_url, privacy_policy_url, privacy_contact,
       purpose_text, consent_version, retention_days, consultation_minutes, reservation_ttl_minutes,
       privacy_space_ready, drinking_water_ready, partner_clinic_url, support_center_url,
       updated_by, created_at, updated_at)
      VALUES ('account-a', 1, 'REG-A', 'norlevo-otc',
              'https://manufacturer.example/check', 'https://pharmacy.example/privacy',
              'privacy@example.test', '来局前確認と仮受付のため', 'consent-v1', 30, 30, 30, 1, 1,
              'https://clinic.example', 'https://support.example', 'staff-a', ?, ?)`).run(now, now);
    sqlite.prepare(`INSERT INTO pharmacy_emergency_pharmacists
      (line_account_id, staff_id, training_registration_number, is_active, created_at, updated_at)
      VALUES ('account-a', 'staff-a', 'TRAIN-A', 1, ?, ?)`).run(now, now);
    sqlite.prepare(`INSERT INTO pharmacy_emergency_slots
      (id, line_account_id, pharmacist_staff_id, starts_at, ends_at, status,
       capacity, version, created_by, created_at, updated_at)
      VALUES ('slot-a', 'account-a', 'staff-a', '2099-01-01T00:00:00.000Z',
              '2099-01-01T00:30:00.000Z', 'open', 1, 1, 'staff-a', ?, ?)`).run(now, now);
    sqlite.prepare(`INSERT INTO pharmacy_emergency_inventory
      (line_account_id, product_code, on_hand, version, updated_by, created_at, updated_at)
      VALUES ('account-a', 'norlevo-otc', 10, 1, 'staff-a', ?, ?)`).run(now, now);
  }

  const consentInputBase = {
    tenantId: 'tenant-a', lineAccountId: 'account-a', friendId: 'friend-a', slotId: 'slot-a',
    // slot-a starts 2099-01-01T00:00:00.000Z; keep the event within 72h of that.
    intercourseAt: '2098-12-30T00:00:00+09:00', intercourseTimeUnknown: false,
    now: new Date('2098-12-31T00:00:00.000Z'),
    age: 20, recentPurchaseCount: 0, patientWillVisit: true, acceptsInPersonDose: true,
    safeContactMode: 'no_notification' as const,
    consentVersion: 'consent-v1',
    manufacturerCheckAcknowledged: true,
    encryptionSecret: 'phase-b-test-secret',
  };

  it('seals B1-B4/C1-C2/D3 into the v2 payload and returns them from the admin detail read with pregnancy_test_recommended', async () => {
    sqlite = new Sqlite(':memory:');
    sqlite.pragma('foreign_keys = ON');
    sqlite.exec(readFileSync(join(DB_ROOT, 'bootstrap.sql'), 'utf8'));
    db = d1From(sqlite);
    seedAccount();

    const { emergencyConsentContentHash } = await import('./repository.js');
    const consentContentHash = await emergencyConsentContentHash({ retentionDays: 30, consentVersion: 'consent-v1' });

    const created = await createEmergencyIntake(db, {
      ...consentInputBase,
      consentContentHash,
      idempotencyKey: 'idem-phase-b-1',
      underMedicalTreatment: true,
      drugAllergyHistory: true,
      heartKidneyGiDisease: true,
      stJohnsWort: true,
      lastMenstruationDate: null,
      menstruationSignals: {
        noneApply: false, unknown: true, overOneMonthNoPeriod: false,
        notRecoveredAfterBirth: false, lastPeriodDifferent: false, earlierConcernOver3Weeks: false,
      },
      idDocumentAvailable: true,
    });

    const detail = await getAdminEmergencyIntakeDetail(db, 'account-a', created.id, 'staff-a', 'phase-b-test-secret');
    expect(detail.self_reported).toMatchObject({
      underMedicalTreatment: true,
      drugAllergyHistory: true,
      heartKidneyGiDisease: true,
      stJohnsWort: true,
      lastMenstruationDate: null,
      menstruationSignals: {
        noneApply: false, unknown: true, overOneMonthNoPeriod: false,
        notRecoveredAfterBirth: false, lastPeriodDifferent: false, earlierConcernOver3Weeks: false,
      },
      pregnancyTestRecommended: true,
      idDocumentAvailable: true,
    });
    expect(detail.risk_flags).not.toContain('pregnancy_test_recommended' as never);
    expect(JSON.parse(JSON.stringify(detail.risk_flags))).not.toContain('pregnancy_test_recommended');
  });

  it('rejects a C2 exclusivity violation before sealing anything', async () => {
    sqlite = new Sqlite(':memory:');
    sqlite.pragma('foreign_keys = ON');
    sqlite.exec(readFileSync(join(DB_ROOT, 'bootstrap.sql'), 'utf8'));
    db = d1From(sqlite);
    seedAccount();

    const { emergencyConsentContentHash } = await import('./repository.js');
    const consentContentHash = await emergencyConsentContentHash({ retentionDays: 30, consentVersion: 'consent-v1' });

    await expect(createEmergencyIntake(db, {
      ...consentInputBase,
      consentContentHash,
      idempotencyKey: 'idem-phase-b-2',
      menstruationSignals: {
        noneApply: true, unknown: false, overOneMonthNoPeriod: true,
        notRecoveredAfterBirth: false, lastPeriodDifferent: false, earlierConcernOver3Weeks: false,
      },
    })).rejects.toThrow('invalid menstruation signals');
  });

  it('maps a v1-shaped payload (no Phase B fields) to null instead of throwing', async () => {
    sqlite = new Sqlite(':memory:');
    sqlite.pragma('foreign_keys = ON');
    sqlite.exec(readFileSync(join(DB_ROOT, 'bootstrap.sql'), 'utf8'));
    db = d1From(sqlite);
    seedAccount();

    const { emergencyConsentContentHash } = await import('./repository.js');
    const consentContentHash = await emergencyConsentContentHash({ retentionDays: 30, consentVersion: 'consent-v1' });

    const created = await createEmergencyIntake(db, {
      ...consentInputBase,
      consentContentHash,
      idempotencyKey: 'idem-phase-b-3',
      // No B1-B4/C1-C2/D3 fields passed: defaults apply (all false / null).
    });

    const detail = await getAdminEmergencyIntakeDetail(db, 'account-a', created.id, 'staff-a', 'phase-b-test-secret');
    expect(detail.self_reported).toMatchObject({
      underMedicalTreatment: false,
      drugAllergyHistory: false,
      heartKidneyGiDisease: false,
      stJohnsWort: false,
      lastMenstruationDate: null,
      pregnancyTestRecommended: true, // date null => recommended by default
      idDocumentAvailable: null,
    });
  });
});
