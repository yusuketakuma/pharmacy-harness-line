import { beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CORE_MIGRATION = join(ROOT, 'migrations/custom_035_pharmacy_emergency_contraception.sql');
const DSR_MIGRATION = join(ROOT, 'migrations/custom_038_pharmacy_data_subject_requests.sql');
const MIGRATION = join(ROOT, 'migrations/custom_051_pharmacy_emergency_counter_and_sale.sql');
const NOW = '2026-08-22T00:00:00.000Z';

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
  db.prepare(`INSERT INTO pharmacy_patients
    (id, line_account_id, owner_friend_id, relationship, name, name_kana,
     birth_date, created_at, updated_at)
    VALUES (?, ?, ?, 'self', ?, ?, '1990-01-01', ?, ?)`).run(
    `patient-${suffix}`, `account-${suffix}`, `friend-${suffix}`, suffix, suffix, NOW, NOW,
  );
}

function seedReadyService(db: Database.Database, suffix: 'a' | 'b'): void {
  db.prepare(`INSERT INTO pharmacy_emergency_settings
    (line_account_id, is_enabled, pharmacy_registration_number, product_code,
     manufacturer_check_url, privacy_policy_url, privacy_contact,
     purpose_text, consent_version, retention_days, consultation_minutes, reservation_ttl_minutes,
     privacy_space_ready, drinking_water_ready, partner_clinic_url, support_center_url,
     updated_by, created_at, updated_at)
    VALUES (?, 1, ?, 'norlevo-otc',
            'https://manufacturer.example/check', 'https://pharmacy.example/privacy',
            'privacy@example.test', 'reason', '2026-08-19', 30, 30, 30, 1, 1,
            'https://clinic.example', 'https://support.example', ?, ?, ?)`).run(
    `account-${suffix}`, `REG-${suffix}`, `staff-${suffix}`, NOW, NOW,
  );
  db.prepare(`INSERT INTO pharmacy_emergency_pharmacists
    (line_account_id, staff_id, training_registration_number, is_active, created_at, updated_at)
    VALUES (?, ?, ?, 1, ?, ?)`).run(`account-${suffix}`, `staff-${suffix}`, `TRAIN-${suffix}`, NOW, NOW);
  db.prepare(`INSERT INTO pharmacy_emergency_inventory
    (line_account_id, product_code, on_hand, version, updated_by, created_at, updated_at)
    VALUES (?, 'norlevo-otc', 5, 1, ?, ?, ?)`).run(`account-${suffix}`, `staff-${suffix}`, NOW, NOW);
  db.prepare(`INSERT INTO pharmacy_emergency_slots
    (id, line_account_id, pharmacist_staff_id, starts_at, ends_at, status,
     capacity, version, created_by, created_at, updated_at)
    VALUES (?, ?, ?, '2099-08-20T00:00:00.000Z', '2099-08-20T00:30:00.000Z', 'open',
            1, 1, ?, ?, ?)`).run(`slot-${suffix}`, `account-${suffix}`, `staff-${suffix}`, `staff-${suffix}`, NOW, NOW);
}

function insertIntake(
  db: Database.Database,
  id: string,
  lineAccountId: string,
  ownerFriendId: string,
  slotId: string,
): void {
  const tenantId = lineAccountId === 'account-a' ? 'tenant-a' : 'tenant-b';
  db.prepare(`INSERT INTO pharmacy_emergency_intakes
    (id, reference_code, tenant_id, line_account_id, owner_friend_id, slot_id,
     status, encrypted_payload, payload_key_version, age_band, safe_contact_mode,
     consent_version, risk_flags_json, product_code, idempotency_key, expires_at,
     version, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'provisional',
            'v1.nonce.ciphertext', 1, 'adult', 'neutral_line', '2026-08-19',
            '[]', 'norlevo-otc', ?, '2099-08-19T00:00:00.000Z', 1, ?, ?)`).run(
    id, `REF-${id}`, tenantId, lineAccountId, ownerFriendId, slotId, `idem-${id}`, NOW, NOW,
  );
}

function insertSaleRecord(
  db: Database.Database,
  overrides: Partial<{
    id: string; lineAccountId: string; intakeId: string; ownerFriendId: string;
    quantity: number; outcome: string; identityCheck: string; inPersonDose: string;
    pharmacistStaffId: string;
  }> = {},
): void {
  const values = {
    id: 'sale-1',
    lineAccountId: 'account-a',
    intakeId: 'intake-1',
    ownerFriendId: 'friend-a',
    quantity: 1,
    outcome: 'sold',
    identityCheck: 'document',
    inPersonDose: 'done',
    pharmacistStaffId: 'staff-a',
    ...overrides,
  };
  db.prepare(`INSERT INTO pharmacy_emergency_sale_records
    (id, line_account_id, intake_id, owner_friend_id, product_code, checklist_version,
     quantity, outcome, identity_check, in_person_dose, checklist_sheets_received,
     pharmacist_staff_id, training_registration_number, determination_encrypted,
     determination_key_version, sold_at, created_at)
    VALUES (?, ?, ?, ?, 'norlevo-otc', 'v1', ?, ?, ?, ?, 1, ?, 'TRAIN-A',
            'v1.nonce.ciphertext', 1, ?, ?)`).run(
    values.id, values.lineAccountId, values.intakeId, values.ownerFriendId,
    values.quantity, values.outcome, values.identityCheck, values.inPersonDose,
    values.pharmacistStaffId, NOW, NOW,
  );
}

describe('custom_051 pharmacy emergency counter confirmations and sale records', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(readFileSync(join(ROOT, 'bootstrap.sql'), 'utf8'));
    db.exec(readFileSync(CORE_MIGRATION, 'utf8'));
    db.exec(readFileSync(DSR_MIGRATION, 'utf8'));
    db.exec(readFileSync(MIGRATION, 'utf8'));
    seedAccount(db, 'a');
    seedAccount(db, 'b');
    seedReadyService(db, 'a');
    seedReadyService(db, 'b');
    insertIntake(db, 'intake-1', 'account-a', 'friend-a', 'slot-a');
    insertIntake(db, 'intake-b', 'account-b', 'friend-b', 'slot-b');
  });

  it('rejects a counter confirmation for a cross-account intake', () => {
    expect(() => db.prepare(`INSERT INTO pharmacy_emergency_counter_confirmations
      (line_account_id, intake_id, section, checklist_version, staff_id, confirmed_at)
      VALUES ('account-a', 'intake-b', 'A', 'v1', 'staff-a', ?)`).run(NOW)).toThrow();
  });

  it('rejects a section value outside A-D', () => {
    expect(() => db.prepare(`INSERT INTO pharmacy_emergency_counter_confirmations
      (line_account_id, intake_id, section, checklist_version, staff_id, confirmed_at)
      VALUES ('account-a', 'intake-1', 'E', 'v1', 'staff-a', ?)`).run(NOW)).toThrow();
  });

  it('allows one confirmation row per section, rejecting a duplicate section for the same intake', () => {
    db.prepare(`INSERT INTO pharmacy_emergency_counter_confirmations
      (line_account_id, intake_id, section, checklist_version, staff_id, confirmed_at)
      VALUES ('account-a', 'intake-1', 'A', 'v1', 'staff-a', ?)`).run(NOW);
    expect(() => db.prepare(`INSERT INTO pharmacy_emergency_counter_confirmations
      (line_account_id, intake_id, section, checklist_version, staff_id, confirmed_at)
      VALUES ('account-a', 'intake-1', 'A', 'v1', 'staff-a', ?)`).run(NOW)).toThrow();
    expect(() => db.prepare(`INSERT INTO pharmacy_emergency_counter_confirmations
      (line_account_id, intake_id, section, checklist_version, staff_id, confirmed_at)
      VALUES ('account-a', 'intake-1', 'B', 'v1', 'staff-a', ?)`).run(NOW)).not.toThrow();
  });

  it('rejects a sale record whose owner_friend_id does not match the intake owner', () => {
    expect(() => insertSaleRecord(db, { ownerFriendId: 'friend-b' }))
      .toThrow('EMERGENCY_SALE_OWNER_MISMATCH');
  });

  it('enforces one sale record per intake, rejecting a second insert', () => {
    insertSaleRecord(db, { id: 'sale-1' });
    expect(() => insertSaleRecord(db, { id: 'sale-2' })).toThrow();
  });

  it('rejects a quantity other than 1', () => {
    expect(() => insertSaleRecord(db, { quantity: 2 })).toThrow();
  });

  it('rejects an outcome outside sold|refused', () => {
    expect(() => insertSaleRecord(db, { outcome: 'pending' })).toThrow();
  });

  it('rejects an identity_check outside document|verbal|unverified', () => {
    expect(() => insertSaleRecord(db, { identityCheck: 'photo' })).toThrow();
  });

  it('rejects an in_person_dose outside done|not_done', () => {
    expect(() => insertSaleRecord(db, { inPersonDose: 'skipped' })).toThrow();
  });

  it('aborts UPDATE and DELETE on a sale record (immutable)', () => {
    insertSaleRecord(db);
    expect(() => db.prepare(`UPDATE pharmacy_emergency_sale_records
      SET outcome = 'refused' WHERE id = 'sale-1'`).run())
      .toThrow('EMERGENCY_SALE_RECORD_IMMUTABLE');
    expect(() => db.prepare(`DELETE FROM pharmacy_emergency_sale_records
      WHERE id = 'sale-1'`).run())
      .toThrow('EMERGENCY_SALE_RECORD_IMMUTABLE');
  });

  it('supports the legal-hold join against pharmacy_data_subject_requests by owner_friend_id', () => {
    insertSaleRecord(db);
    db.prepare(`INSERT INTO pharmacy_data_subject_requests
      (id, tenant_id, line_account_id, owner_friend_id, patient_id, request_type,
       status, reason, submitted_at, created_by, created_at, updated_at)
      VALUES ('dsr-1', 'tenant-a', 'account-a', 'friend-a', 'patient-a', 'erasure',
              'received', 'requested', ?, 'staff-a', ?, ?)`).run(NOW, NOW, NOW);

    const rows = db.prepare(`SELECT sale.id
      FROM pharmacy_emergency_sale_records AS sale
      INNER JOIN pharmacy_data_subject_requests AS dsr
        ON dsr.line_account_id = sale.line_account_id
       AND dsr.owner_friend_id = sale.owner_friend_id
      WHERE sale.id = 'sale-1'`).all();
    expect(rows).toEqual([{ id: 'sale-1' }]);
  });
});
