import { beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  cancelOwnerEmergencyIntake,
  createEmergencyIntake,
  emergencyConsentContentHash,
  expireEmergencyIntakes,
  getAdminEmergencyIntakeDetail,
  getEmergencyAdminConfig,
  getEmergencyServiceOverview,
  listAdminEmergencyIntakes,
  listOwnerEmergencyIntakes,
  setEmergencyInventory,
  transitionEmergencyIntake,
  recordCounterConfirmation,
} from '../../../apps/worker/src/custom/pharmacy/emergency-contraception/repository.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATION = join(ROOT, 'migrations/custom_035_pharmacy_emergency_contraception.sql');
const CAPABILITY_MIGRATION = join(ROOT, 'migrations/custom_044_pharmacy_v029_capabilities.sql');
const NOW = '2026-08-19T00:00:00.000Z';
// The readiness trigger checks `slot.starts_at` against SQLite's own real-clock `strftime('now')`,
// which vitest's fake timers cannot mock. Keep the whole reopened-slot scenario on that clock.
const REOPENED_NOW = Date.now();
const REOPENED_INTERCOURSE_AT = new Date(REOPENED_NOW - 24 * 60 * 60 * 1000).toISOString();
const REOPENED_SLOT_STARTS_AT = new Date(REOPENED_NOW + 60 * 60 * 1000).toISOString();
const REOPENED_SLOT_ENDS_AT = new Date(REOPENED_NOW + 90 * 60 * 1000).toISOString();
// seedReadyService always sets retention_days=30, consent_version='2026-08-19'.
const CONSENT_CONTENT_HASH = await emergencyConsentContentHash({
  retentionDays: 30, consentVersion: '2026-08-19',
});

type RunnableStatement = D1PreparedStatement & { runSync(): D1Result };
function d1From(sqlite: Database.Database): D1Database {
  const statement = (sql: string, values: unknown[] = []): RunnableStatement => ({
    bind: (...next: unknown[]) => statement(sql, next),
    first: async <T>() => (sqlite.prepare(sql).get(...values) as T | undefined) ?? null,
    all: async <T>() => ({
      success: true,
      results: sqlite.prepare(sql).all(...values) as T[],
      meta: {},
    }) as D1Result<T>,
    raw: async <T>() => sqlite.prepare(sql).raw().all(...values) as T[],
    run: async () => statement(sql, values).runSync(),
    runSync: () => {
      const info = sqlite.prepare(sql).run(...values);
      return { success: true, meta: { changes: info.changes }, results: [] } as unknown as D1Result;
    },
  });
  return {
    prepare: (sql: string) => statement(sql),
    batch: async <T>(statements: D1PreparedStatement[]) => sqlite.transaction(() =>
      statements.map((item) => (item as RunnableStatement).runSync() as D1Result<T>),
    )(),
  } as unknown as D1Database;
}

function seedAccount(db: Database.Database, suffix: 'a' | 'b'): void {
  db.prepare(`INSERT INTO line_accounts
    (id, channel_id, name, channel_access_token, channel_secret, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
    `account-${suffix}`, `channel-${suffix}`, suffix, `token-${suffix}`, `secret-${suffix}`, NOW, NOW,
  );
  db.prepare(`INSERT INTO tenants
    (id, tenant_code, display_name, status, created_at, updated_at)
    VALUES (?, ?, ?, 'active', ?, ?)`).run(`tenant-${suffix}`, suffix, suffix, NOW, NOW);
  db.prepare(`INSERT INTO tenant_line_accounts
    (tenant_id, line_account_id, created_at, updated_at)
    VALUES (?, ?, ?, ?)`).run(`tenant-${suffix}`, `account-${suffix}`, NOW, NOW);
  db.prepare(`INSERT INTO friends
    (id, line_user_id, provider_line_user_id, line_account_id, is_following, created_at, updated_at)
    VALUES (?, ?, ?, ?, 1, ?, ?)`).run(
    `friend-${suffix}`, `legacy-u-${suffix}`, `U-${suffix}`, `account-${suffix}`, NOW, NOW,
  );
  db.prepare(`INSERT INTO staff_members
    (id, name, role, api_key, is_active, created_at, updated_at)
    VALUES (?, ?, 'admin', ?, 1, ?, ?)`).run(
    `staff-${suffix}`, `Staff ${suffix}`, `key-${suffix}`, NOW, NOW,
  );
  db.prepare(`INSERT INTO tenant_staff_memberships
    (tenant_id, staff_id, role, is_active, created_at, updated_at)
    VALUES (?, ?, 'admin', 1, ?, ?)`).run(`tenant-${suffix}`, `staff-${suffix}`, NOW, NOW);
  db.prepare(`INSERT INTO pharmacy_staff_accounts
    (line_account_id, staff_id, is_active, created_at, updated_at)
    VALUES (?, ?, 1, ?, ?)`).run(`account-${suffix}`, `staff-${suffix}`, NOW, NOW);
}

function seedReadyService(db: Database.Database): void {
  db.prepare(`UPDATE pharmacy_account_capabilities
    SET capabilities_json = json_insert(capabilities_json, '$[#]', 'emergency_contraception'),
        updated_at = ?
    WHERE line_account_id = 'account-a'`).run(NOW);
  db.prepare(`INSERT INTO pharmacy_emergency_settings
    (line_account_id, is_enabled, pharmacy_registration_number, product_code,
     manufacturer_check_url, privacy_policy_url, privacy_contact,
     purpose_text, consent_version, retention_days, consultation_minutes, reservation_ttl_minutes,
     privacy_space_ready, drinking_water_ready, partner_clinic_url, support_center_url,
     updated_by, created_at, updated_at)
    VALUES ('account-a', 1, 'REG-A', 'norlevo-otc',
            'https://manufacturer.example/check', 'https://pharmacy.example/privacy',
            'privacy@example.test', '来局前確認と仮受付のため', '2026-08-19', 30, 30, 30, 1, 1,
            'https://clinic.example', 'https://support.example', 'staff-a', ?, ?)`).run(NOW, NOW);
  db.prepare(`INSERT INTO pharmacy_emergency_pharmacists
    (line_account_id, staff_id, training_registration_number, is_active, created_at, updated_at)
    VALUES ('account-a', 'staff-a', 'TRAIN-A', 1, ?, ?)`).run(NOW, NOW);
  db.prepare(`INSERT INTO pharmacy_emergency_inventory
    (line_account_id, product_code, on_hand, version, updated_by, created_at, updated_at)
    VALUES ('account-a', 'norlevo-otc', 1, 1, 'staff-a', ?, ?)`).run(NOW, NOW);
  db.prepare(`INSERT INTO pharmacy_emergency_slots
    (id, line_account_id, pharmacist_staff_id, starts_at, ends_at, status,
     capacity, version, created_by, created_at, updated_at)
    VALUES ('slot-a', 'account-a', 'staff-a', '2099-08-20T00:00:00.000Z',
            '2099-08-20T00:30:00.000Z', 'open', 1, 1, 'staff-a', ?, ?)`).run(NOW, NOW);
}

function insertIntake(db: Database.Database, id: string, friendId = 'friend-a'): void {
  db.prepare(`INSERT INTO pharmacy_emergency_intakes
    (id, reference_code, tenant_id, line_account_id, owner_friend_id, slot_id,
     status, encrypted_payload, payload_key_version, age_band, safe_contact_mode,
     consent_version, risk_flags_json, product_code, idempotency_key, expires_at,
     version, created_at, updated_at)
    VALUES (?, ?, 'tenant-a', 'account-a', ?, 'slot-a', 'provisional',
            'v1.nonce.ciphertext', 1, 'adult', 'neutral_line', '2026-08-19',
            '[]', 'norlevo-otc', ?, '2099-08-19T00:00:00.000Z', 1, ?, ?)`).run(
    id, `REF-${id}`, friendId, `idem-${id}`, NOW, NOW,
  );
}

describe('custom_035 pharmacy emergency contraception MVP', () => {
  let db: Database.Database;
  let d1: D1Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(readFileSync(join(ROOT, 'bootstrap.sql'), 'utf8'));
    db.exec(readFileSync(MIGRATION, 'utf8'));
    db.exec(readFileSync(CAPABILITY_MIGRATION, 'utf8'));
    seedAccount(db, 'a');
    seedAccount(db, 'b');
    seedReadyService(db);
    d1 = d1From(db);
  });

  it('stores only encrypted Phase 1 payload and account-scoped projections', () => {
    const columns = db.prepare(`PRAGMA table_info(pharmacy_emergency_intakes)`).all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).not.toEqual(expect.arrayContaining([
      'intercourse_at', 'medical_history', 'menstrual_history', 'assault_details', 'answers_json',
    ]));
    expect(columns.map((column) => column.name)).toContain('encrypted_payload');
  });

  it('atomically rejects a second active hold when one unit is on hand', () => {
    insertIntake(db, 'intake-1');
    expect(() => insertIntake(db, 'intake-2')).toThrow('EMERGENCY_STOCK_UNAVAILABLE');
    expect(db.prepare(`SELECT COUNT(*) AS count FROM pharmacy_emergency_intakes`).get())
      .toEqual({ count: 1 });

    db.prepare(`UPDATE pharmacy_emergency_intakes
      SET status = 'cancelled', version = version + 1 WHERE id = 'intake-1'`).run();
    expect(() => insertIntake(db, 'intake-2')).not.toThrow();
  });

  it('rejects cross-account patient and pharmacist references', () => {
    expect(() => insertIntake(db, 'intake-cross', 'friend-b')).toThrow();
    expect(() => db.prepare(`INSERT INTO pharmacy_emergency_slots
      (id, line_account_id, pharmacist_staff_id, starts_at, ends_at, status,
       capacity, version, created_by, created_at, updated_at)
      VALUES ('slot-cross', 'account-a', 'staff-b', '2099-08-21T00:00:00.000Z',
              '2099-08-21T00:30:00.000Z', 'open', 1, 1, 'staff-a', ?, ?)`)
      .run(NOW, NOW)).toThrow();
  });

  it('lists only account-assigned staff as pharmacist registration candidates', async () => {
    await expect(getEmergencyAdminConfig(d1, 'account-a')).resolves.toMatchObject({
      available_staff: [{ staff_id: 'staff-a', name: 'Staff a' }],
    });
  });

  it('returns the approved purpose and retention notice to the patient', async () => {
    await expect(getEmergencyServiceOverview(d1, 'account-a', new Date(NOW)))
      .resolves.toMatchObject({
        consent: {
          version: '2026-08-19',
          purpose: '来局前確認と仮受付のため',
          retention_days: 30,
          text_v2: expect.stringContaining('30日間'),
          content_hash: CONSENT_CONTENT_HASH,
        },
      });
  });

  it('rejects create with an outdated consent_version or a content_hash that no longer matches', async () => {
    db.prepare(`UPDATE pharmacy_emergency_slots
      SET starts_at = ?, ends_at = ?
      WHERE id = 'slot-a'`).run(REOPENED_SLOT_STARTS_AT, REOPENED_SLOT_ENDS_AT);
    const base = {
      tenantId: 'tenant-a', lineAccountId: 'account-a', friendId: 'friend-a', slotId: 'slot-a',
      intercourseAt: REOPENED_INTERCOURSE_AT, intercourseTimeUnknown: false,
      age: 20, recentPurchaseCount: 0, patientWillVisit: true, acceptsInPersonDose: true,
      safeContactMode: 'neutral_line' as const, manufacturerCheckAcknowledged: true,
      encryptionSecret: 'test-secret', now: new Date(REOPENED_NOW),
    };
    await expect(createEmergencyIntake(d1, {
      ...base, consentVersion: '2020-01-01', consentContentHash: CONSENT_CONTENT_HASH,
      idempotencyKey: 'request-key-stale-version',
    })).rejects.toThrow('EMERGENCY_CONSENT_VERSION_MISMATCH');
    await expect(createEmergencyIntake(d1, {
      ...base, consentVersion: '2026-08-19', consentContentHash: 'not-the-real-hash',
      idempotencyKey: 'request-key-stale-hash',
    })).rejects.toThrow('EMERGENCY_CONSENT_HASH_MISMATCH');
    expect(db.prepare(`SELECT COUNT(*) AS count FROM pharmacy_emergency_intakes`).get())
      .toEqual({ count: 0 });
  });

  it('does not offer or admit a slot assigned to an inactive pharmacy staff account', async () => {
    db.prepare(`UPDATE pharmacy_staff_accounts SET is_active = 0
      WHERE line_account_id = 'account-a' AND staff_id = 'staff-a'`).run();

    await expect(getEmergencyServiceOverview(d1, 'account-a', new Date(NOW)))
      .resolves.toMatchObject({ ready: false, reason: 'no_slots', slots: [] });
    expect(() => insertIntake(db, 'inactive-staff-intake')).toThrow('EMERGENCY_SERVICE_NOT_READY');
  });

  it('updates inventory with CAS and an immutable account-scoped audit event', async () => {
    await setEmergencyInventory(d1, {
      lineAccountId: 'account-a', productCode: 'norlevo-otc', onHand: 2,
      expectedVersion: 1, staffId: 'staff-a', now: new Date(NOW),
    });
    expect(db.prepare(`SELECT on_hand, version FROM pharmacy_emergency_inventory
      WHERE line_account_id = 'account-a' AND product_code = 'norlevo-otc'`).get())
      .toEqual({ on_hand: 2, version: 2 });
    expect(db.prepare(`SELECT event_type, actor_id, aggregate_id
      FROM pharmacy_emergency_admin_events`).all()).toEqual([{
      event_type: 'inventory_updated', actor_id: 'staff-a', aggregate_id: 'norlevo-otc',
    }]);
    await expect(setEmergencyInventory(d1, {
      lineAccountId: 'account-a', productCode: 'norlevo-otc', onHand: 3,
      expectedVersion: 1, staffId: 'staff-a', now: new Date(NOW),
    })).rejects.toThrow('inventory update conflict');
    expect(db.prepare(`SELECT COUNT(*) AS count FROM pharmacy_emergency_admin_events`).get())
      .toEqual({ count: 1 });
  });

  it('keeps intake events immutable', () => {
    insertIntake(db, 'intake-1');
    db.prepare(`INSERT INTO pharmacy_emergency_intake_events
      (id, intake_id, line_account_id, event_type, actor_type, actor_id,
       idempotency_key, occurred_at)
      VALUES ('event-1', 'intake-1', 'account-a', 'created', 'patient',
              'friend-a', 'event-key-1', ?)`).run(NOW);

    expect(() => db.prepare(`UPDATE pharmacy_emergency_intake_events
      SET event_type = 'reviewed' WHERE id = 'event-1'`).run())
      .toThrow('EMERGENCY_EVENT_IMMUTABLE');
    expect(() => db.prepare(`DELETE FROM pharmacy_emergency_intake_events
      WHERE id = 'event-1'`).run()).toThrow('EMERGENCY_EVENT_IMMUTABLE');
    db.prepare(`INSERT INTO pharmacy_emergency_admin_events
      (id, line_account_id, event_type, aggregate_id, actor_id,
       resulting_version, on_hand, occurred_at)
      VALUES ('admin-event-1', 'account-a', 'inventory_updated', 'norlevo-otc',
              'staff-a', 2, 1, ?)`).run(NOW);
    expect(() => db.prepare(`DELETE FROM pharmacy_emergency_admin_events
      WHERE id = 'admin-event-1'`).run()).toThrow('EMERGENCY_EVENT_IMMUTABLE');
  });

  it('persists TTL expiry once and releases the held slot and stock', async () => {
    insertIntake(db, 'intake-expired');
    db.prepare(`UPDATE pharmacy_emergency_intakes
      SET expires_at = '2026-08-18T23:59:59.000Z' WHERE id = 'intake-expired'`).run();

    await expect(expireEmergencyIntakes(d1, 'account-a', new Date(NOW))).resolves.toBe(1);
    await expect(expireEmergencyIntakes(d1, 'account-a', new Date(NOW))).resolves.toBe(0);
    expect(db.prepare(`SELECT status, closed_by FROM pharmacy_emergency_intakes
      WHERE id = 'intake-expired'`).get()).toEqual({ status: 'expired', closed_by: null });
    expect(db.prepare(`SELECT event_type, actor_type, actor_id
      FROM pharmacy_emergency_intake_events WHERE intake_id = 'intake-expired'`).all())
      .toEqual([{ event_type: 'expired', actor_type: 'system', actor_id: 'system' }]);
    expect(() => insertIntake(db, 'intake-after-expiry')).not.toThrow();
  });

  it('consumes one inventory unit only when a pharmacist closes store handling as completed', () => {
    insertIntake(db, 'intake-1');
    db.prepare(`UPDATE pharmacy_emergency_intakes SET status = 'reviewed' WHERE id = 'intake-1'`).run();
    db.prepare(`UPDATE pharmacy_emergency_intakes SET status = 'completed' WHERE id = 'intake-1'`).run();
    expect(db.prepare(`SELECT on_hand, version FROM pharmacy_emergency_inventory
      WHERE line_account_id = 'account-a' AND product_code = 'norlevo-otc'`).get())
      .toEqual({ on_hand: 0, version: 2 });
  });

  it('completes against the product held at intake creation, not the live settings product', async () => {
    db.prepare(`UPDATE pharmacy_emergency_slots
      SET starts_at = ?, ends_at = ?
      WHERE id = 'slot-a'`).run(REOPENED_SLOT_STARTS_AT, REOPENED_SLOT_ENDS_AT);
    db.prepare(`INSERT INTO pharmacy_emergency_inventory
      (line_account_id, product_code, on_hand, version, updated_by, created_at, updated_at)
      VALUES ('account-a', 'levonelle-otc', 0, 1, 'staff-a', ?, ?)`).run(NOW, NOW);
    const created = await createEmergencyIntake(d1, {
      tenantId: 'tenant-a', lineAccountId: 'account-a', friendId: 'friend-a', slotId: 'slot-a',
      intercourseAt: REOPENED_INTERCOURSE_AT, intercourseTimeUnknown: false,
      age: 20, recentPurchaseCount: 0, patientWillVisit: true, acceptsInPersonDose: true,
      safeContactMode: 'none', consentVersion: '2026-08-19',
      manufacturerCheckAcknowledged: true, consentContentHash: CONSENT_CONTENT_HASH, idempotencyKey: 'request-key-4',
      encryptionSecret: 'test-secret', now: new Date(REOPENED_NOW),
    });
    expect(db.prepare(`SELECT product_code FROM pharmacy_emergency_intakes WHERE id = ?`)
      .get(created.id)).toEqual({ product_code: 'norlevo-otc' });
    // The admin repoints settings at another stocked product while the hold is outstanding.
    db.prepare(`UPDATE pharmacy_emergency_settings
      SET product_code = 'levonelle-otc' WHERE line_account_id = 'account-a'`).run();

    await expect(transitionEmergencyIntake(d1, {
      lineAccountId: 'account-a', intakeId: created.id, expectedVersion: 1,
      toStatus: 'reviewed', staffId: 'staff-a', now: new Date(REOPENED_NOW),
    })).resolves.toMatchObject({ status: 'reviewed' });
    // completed requires the in-person 'A' section counter confirmation (ECF-7).
    await recordCounterConfirmation(d1, {
      lineAccountId: 'account-a', intakeId: created.id, section: 'A',
      checklistVersion: 'lng-2026-08', mismatchItems: [], staffId: 'staff-a',
      now: new Date(REOPENED_NOW),
    });
    await expect(transitionEmergencyIntake(d1, {
      lineAccountId: 'account-a', intakeId: created.id, expectedVersion: 2,
      toStatus: 'completed', staffId: 'staff-a', now: new Date(REOPENED_NOW),
    })).resolves.toMatchObject({ status: 'completed' });

    expect(db.prepare(`SELECT product_code, on_hand, version FROM pharmacy_emergency_inventory
      WHERE line_account_id = 'account-a' ORDER BY product_code`).all()).toEqual([
      { product_code: 'levonelle-otc', on_hand: 0, version: 1 },
      { product_code: 'norlevo-otc', on_hand: 0, version: 2 },
    ]);
  });

  it('creates one encrypted owner-scoped provisional intake idempotently', async () => {
    db.prepare(`UPDATE pharmacy_emergency_slots
      SET starts_at = ?, ends_at = ?
      WHERE id = 'slot-a'`).run(REOPENED_SLOT_STARTS_AT, REOPENED_SLOT_ENDS_AT);
    const input = {
      tenantId: 'tenant-a',
      lineAccountId: 'account-a',
      friendId: 'friend-a',
      slotId: 'slot-a',
      intercourseAt: REOPENED_INTERCOURSE_AT,
      intercourseTimeUnknown: false,
      age: 20,
      recentPurchaseCount: 0,
      patientWillVisit: true,
      acceptsInPersonDose: true,
      safeContactMode: 'neutral_line' as const,
      consentVersion: '2026-08-19',
      consentContentHash: CONSENT_CONTENT_HASH,
      manufacturerCheckAcknowledged: true,
      idempotencyKey: 'request-key-1',
      encryptionSecret: 'test-secret',
      now: new Date(REOPENED_NOW),
    };

    const created = await createEmergencyIntake(d1, input);
    const replay = await createEmergencyIntake(d1, input);
    expect(replay.id).toBe(created.id);
    expect(created.reference_code).toMatch(/^EC-[A-Z0-9]{16}$/);
    expect(JSON.stringify(await listOwnerEmergencyIntakes(
      d1, 'account-a', 'friend-a', new Date(REOPENED_NOW),
    ))).not.toContain(input.intercourseAt);
    await expect(listOwnerEmergencyIntakes(d1, 'account-b', 'friend-a', new Date(REOPENED_NOW)))
      .resolves.toEqual([]);
    expect(db.prepare(`SELECT encrypted_payload FROM pharmacy_emergency_intakes WHERE id = ?`)
      .get(created.id)).not.toEqual(expect.objectContaining({ encrypted_payload: expect.stringContaining(input.intercourseAt) }));
  });

  it('excludes clinical fields from every patient-facing intake response (create/cancel/list)', async () => {
    db.prepare(`UPDATE pharmacy_emergency_slots
      SET starts_at = ?, ends_at = ?
      WHERE id = 'slot-a'`).run(REOPENED_SLOT_STARTS_AT, REOPENED_SLOT_ENDS_AT);
    const created = await createEmergencyIntake(d1, {
      tenantId: 'tenant-a', lineAccountId: 'account-a', friendId: 'friend-a', slotId: 'slot-a',
      // age 15 + recentPurchaseCount 1 would populate risk_flags with under_16 and
      // repeat_purchase_review under the old admin projection — proves the split holds.
      intercourseAt: REOPENED_INTERCOURSE_AT, intercourseTimeUnknown: false,
      age: 15, recentPurchaseCount: 1, patientWillVisit: true, acceptsInPersonDose: true,
      safeContactMode: 'neutral_line', consentVersion: '2026-08-19',
      manufacturerCheckAcknowledged: true, consentContentHash: CONSENT_CONTENT_HASH, idempotencyKey: 'request-key-owner-projection',
      encryptionSecret: 'test-secret', now: new Date(REOPENED_NOW),
    });
    for (const field of ['risk_flags', 'age_band', 'safe_contact_mode', 'consent_version']) {
      expect(created).not.toHaveProperty(field);
    }
    expect(created).toMatchObject({ id: expect.any(String), status: 'provisional' });

    const owned = await listOwnerEmergencyIntakes(d1, 'account-a', 'friend-a', new Date(REOPENED_NOW));
    expect(owned).toHaveLength(1);
    for (const field of ['risk_flags', 'age_band', 'safe_contact_mode', 'consent_version']) {
      expect(owned[0]).not.toHaveProperty(field);
    }
    expect(owned[0]).toMatchObject({ id: expect.any(String), status: 'provisional' });

    const cancelled = await cancelOwnerEmergencyIntake(d1, {
      lineAccountId: 'account-a', friendId: 'friend-a', intakeId: created.id,
      expectedVersion: created.version, idempotencyKey: 'request-key-owner-projection-cancel',
      now: new Date(REOPENED_NOW),
    });
    for (const field of ['risk_flags', 'age_band', 'safe_contact_mode', 'consent_version']) {
      expect(cancelled).not.toHaveProperty(field);
    }
    expect(cancelled).toMatchObject({ id: created.id, status: 'cancelled' });
  });

  it('rejects new intake admission after the account capability is disabled', async () => {
    db.prepare(`UPDATE pharmacy_emergency_slots
      SET starts_at = ?, ends_at = ? WHERE id = 'slot-a'`)
      .run(REOPENED_SLOT_STARTS_AT, REOPENED_SLOT_ENDS_AT);
    db.prepare(`UPDATE pharmacy_account_capabilities
      SET capabilities_json = (SELECT json_group_array(value)
        FROM json_each(pharmacy_account_capabilities.capabilities_json)
        WHERE value <> 'emergency_contraception'), updated_at = ?
      WHERE line_account_id = 'account-a'`).run(NOW);

    await expect(createEmergencyIntake(d1, {
      tenantId: 'tenant-a', lineAccountId: 'account-a', friendId: 'friend-a', slotId: 'slot-a',
      intercourseAt: '2026-08-18T10:00:00+09:00', intercourseTimeUnknown: false,
      age: 20, recentPurchaseCount: 0, patientWillVisit: true, acceptsInPersonDose: true,
      safeContactMode: 'neutral_line', consentVersion: '2026-08-19',
      manufacturerCheckAcknowledged: true, consentContentHash: CONSENT_CONTENT_HASH, idempotencyKey: 'request-disabled',
      encryptionSecret: 'test-secret', now: new Date(NOW),
    })).rejects.toThrow('FEATURE_DISABLED');
    expect(db.prepare(`SELECT COUNT(*) AS count FROM pharmacy_emergency_intakes`).get())
      .toEqual({ count: 0 });
  });

  it('keeps the queue non-PHI and decrypts only an audited trained-pharmacist detail', async () => {
    db.prepare(`UPDATE pharmacy_emergency_slots
      SET starts_at = ?, ends_at = ?
      WHERE id = 'slot-a'`).run(REOPENED_SLOT_STARTS_AT, REOPENED_SLOT_ENDS_AT);
    const created = await createEmergencyIntake(d1, {
      tenantId: 'tenant-a', lineAccountId: 'account-a', friendId: 'friend-a', slotId: 'slot-a',
      intercourseAt: REOPENED_INTERCOURSE_AT, intercourseTimeUnknown: false,
      age: 20, recentPurchaseCount: 0, patientWillVisit: true, acceptsInPersonDose: true,
      safeContactMode: 'no_notification', consentVersion: '2026-08-19',
      manufacturerCheckAcknowledged: true, consentContentHash: CONSENT_CONTENT_HASH, idempotencyKey: 'request-key-2',
      encryptionSecret: 'test-secret', now: new Date(REOPENED_NOW),
    });

    const page = await listAdminEmergencyIntakes(
      d1, 'account-a', { limit: 20 }, new Date(REOPENED_NOW),
    );
    expect(page.intakes).toEqual([expect.objectContaining({ id: created.id })]);
    expect(page.intakes[0]).not.toHaveProperty('self_reported');
    expect(page.intakes[0]).not.toHaveProperty('owner_friend_id');
    expect(page.intakes[0]).not.toHaveProperty('age_band');
    expect(page.intakes[0]).not.toHaveProperty('safe_contact_mode');
    expect(page.intakes[0]).not.toHaveProperty('consent_version');
    expect(page.intakes[0]).not.toHaveProperty('risk_flags');
    expect(JSON.stringify(page)).not.toContain(REOPENED_INTERCOURSE_AT);

    await expect(getAdminEmergencyIntakeDetail(
      d1, 'account-a', created.id, 'staff-a', 'test-secret', new Date(REOPENED_NOW),
    )).resolves.toEqual(expect.objectContaining({
      id: created.id,
      self_reported: expect.objectContaining({ intercourseAt: REOPENED_INTERCOURSE_AT }),
    }));
    expect(db.prepare(`SELECT intake_id, line_account_id, staff_id
      FROM pharmacy_emergency_intake_access_events`).all()).toEqual([{
      intake_id: created.id, line_account_id: 'account-a', staff_id: 'staff-a',
    }]);
    await expect(getAdminEmergencyIntakeDetail(
      d1, 'account-a', created.id, 'staff-b', 'test-secret', new Date(REOPENED_NOW),
    ))
      .rejects.toThrow('trained pharmacist access required');
  });

  it('returns a redacted detail instead of failing decryption once retention-purge has cleared the payload', async () => {
    // NEXT-2's retention-purge.ts redacts encrypted_payload to '' in place
    // rather than deleting the row (see RETENTION_MATRIX.md). Simulate that here
    // directly, since exercising the cron job itself is covered by its own tests.
    db.prepare(`UPDATE pharmacy_emergency_slots
      SET starts_at = ?, ends_at = ?
      WHERE id = 'slot-a'`).run(REOPENED_SLOT_STARTS_AT, REOPENED_SLOT_ENDS_AT);
    const created = await createEmergencyIntake(d1, {
      tenantId: 'tenant-a', lineAccountId: 'account-a', friendId: 'friend-a', slotId: 'slot-a',
      intercourseAt: REOPENED_INTERCOURSE_AT, intercourseTimeUnknown: false,
      age: 20, recentPurchaseCount: 0, patientWillVisit: true, acceptsInPersonDose: true,
      safeContactMode: 'no_notification', consentVersion: '2026-08-19',
      manufacturerCheckAcknowledged: true, consentContentHash: CONSENT_CONTENT_HASH, idempotencyKey: 'request-key-redacted',
      encryptionSecret: 'test-secret', now: new Date(REOPENED_NOW),
    });
    db.prepare(`UPDATE pharmacy_emergency_intakes
        SET encrypted_payload = '', risk_flags_json = '[]'
      WHERE id = ?`).run(created.id);

    await expect(getAdminEmergencyIntakeDetail(
      d1, 'account-a', created.id, 'staff-a', 'test-secret', new Date(REOPENED_NOW),
    )).resolves.toEqual(expect.objectContaining({
      id: created.id, redacted: true, self_reported: null,
    }));
    // The access audit still records the read; only the decrypt attempt is skipped.
    expect(db.prepare(`SELECT intake_id, staff_id
      FROM pharmacy_emergency_intake_access_events`).all()).toEqual([{
      intake_id: created.id, staff_id: 'staff-a',
    }]);

    const page = await listAdminEmergencyIntakes(
      d1, 'account-a', { limit: 20 }, new Date(REOPENED_NOW),
    );
    expect(page.intakes).toEqual([expect.objectContaining({ id: created.id })]);
  });

  it('uses CAS transitions and appends an immutable event', async () => {
    db.prepare(`UPDATE pharmacy_emergency_slots
      SET starts_at = ?, ends_at = ?
      WHERE id = 'slot-a'`).run(REOPENED_SLOT_STARTS_AT, REOPENED_SLOT_ENDS_AT);
    const created = await createEmergencyIntake(d1, {
      tenantId: 'tenant-a', lineAccountId: 'account-a', friendId: 'friend-a', slotId: 'slot-a',
      intercourseAt: REOPENED_INTERCOURSE_AT, intercourseTimeUnknown: false,
      age: 20, recentPurchaseCount: 0, patientWillVisit: true, acceptsInPersonDose: true,
      safeContactMode: 'none', consentVersion: '2026-08-19',
      manufacturerCheckAcknowledged: true, consentContentHash: CONSENT_CONTENT_HASH, idempotencyKey: 'request-key-3',
      encryptionSecret: 'test-secret', now: new Date(REOPENED_NOW),
    });
    await expect(transitionEmergencyIntake(d1, {
      lineAccountId: 'account-a', intakeId: created.id, expectedVersion: 1,
      toStatus: 'reviewed', staffId: 'staff-a', now: new Date(REOPENED_NOW),
    })).resolves.toMatchObject({ status: 'reviewed', version: 2 });
    await expect(transitionEmergencyIntake(d1, {
      lineAccountId: 'account-a', intakeId: created.id, expectedVersion: 1,
      toStatus: 'cancelled', staffId: 'staff-a', now: new Date(REOPENED_NOW),
    })).rejects.toThrow('transition conflict');
    expect(db.prepare(`SELECT event_type, actor_id FROM pharmacy_emergency_intake_events
      WHERE intake_id = ? ORDER BY occurred_at`).all(created.id)).toEqual([
      { event_type: 'created', actor_id: 'friend-a' },
      { event_type: 'reviewed', actor_id: 'staff-a' },
    ]);
  });
});
