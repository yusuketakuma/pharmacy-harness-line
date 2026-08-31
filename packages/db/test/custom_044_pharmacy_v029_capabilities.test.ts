import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const NOW = '2026-08-21T00:00:00.000Z';

function seedAccount(db: Database.Database, id: string, enabled: boolean): void {
  db.prepare(`INSERT INTO line_accounts
    (id, channel_id, name, channel_access_token, channel_secret, created_at, updated_at)
    VALUES (?, ?, ?, 'token', 'secret', ?, ?)`).run(id, `channel-${id}`, id, NOW, NOW);
  db.prepare(`INSERT INTO tenants
    (id, tenant_code, display_name, status, created_at, updated_at)
    VALUES (?, ?, ?, 'active', ?, ?)`).run(`tenant-${id}`, id, id, NOW, NOW);
  db.prepare(`INSERT INTO tenant_line_accounts
    (tenant_id, line_account_id, created_at, updated_at)
    VALUES (?, ?, ?, ?)`).run(`tenant-${id}`, id, NOW, NOW);
  db.prepare(`INSERT INTO staff_members
    (id, name, role, api_key, is_active, created_at, updated_at)
    VALUES (?, ?, 'admin', ?, 1, ?, ?)`).run(`staff-${id}`, id, `key-${id}`, NOW, NOW);
  db.prepare(`INSERT INTO tenant_staff_memberships
    (tenant_id, staff_id, role, is_active, created_at, updated_at)
    VALUES (?, ?, 'admin', 1, ?, ?)`).run(`tenant-${id}`, `staff-${id}`, NOW, NOW);
  db.prepare(`INSERT INTO pharmacy_staff_accounts
    (line_account_id, staff_id, is_active, created_at, updated_at)
    VALUES (?, ?, 1, ?, ?)`).run(id, `staff-${id}`, NOW, NOW);
  db.prepare(`INSERT INTO pharmacy_emergency_settings
    (line_account_id, is_enabled, pharmacy_registration_number, product_code,
     manufacturer_check_url, privacy_policy_url, privacy_contact, purpose_text,
     consent_version, retention_days, consultation_minutes, reservation_ttl_minutes,
     privacy_space_ready, drinking_water_ready, partner_clinic_url, support_center_url,
     updated_by, created_at, updated_at)
    VALUES (?, ?, 'REG', 'product', 'https://manufacturer.example/check',
            'https://pharmacy.example/privacy', 'privacy@example.test', 'purpose',
            'v1', 30, 30, 30, 1, 1, 'https://clinic.example',
            'https://support.example', ?, ?, ?)`).run(
    id, enabled ? 1 : 0, `staff-${id}`, NOW, NOW,
  );
}

function capabilities(db: Database.Database, accountId: string): string[] {
  const row = db.prepare(`SELECT capabilities_json FROM pharmacy_account_capabilities
    WHERE line_account_id = ?`).get(accountId) as { capabilities_json: string };
  return JSON.parse(row.capabilities_json) as string[];
}

describe('custom_044 pharmacy v0.29 capabilities', () => {
  it('defaults new accounts to pharmacy information but not sensitive features', () => {
    const db = new Database(':memory:');
    db.exec(readFileSync(join(ROOT, 'bootstrap.sql'), 'utf8'));
    db.prepare(`INSERT INTO line_accounts
      (id, channel_id, name, channel_access_token, channel_secret)
      VALUES ('new-account', 'new-channel', 'New', 'token', 'secret')`).run();

    expect(capabilities(db, 'new-account')).toContain('pharmacy_info');
    expect(capabilities(db, 'new-account')).not.toEqual(expect.arrayContaining([
      'electronic_prescription', 'emergency_contraception',
    ]));
  });

  it('does not let a newly inserted legacy setting override the capability', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(readFileSync(join(ROOT, 'bootstrap.sql'), 'utf8'));
    seedAccount(db, 'account-new', false);
    db.prepare(`DELETE FROM pharmacy_emergency_settings
      WHERE line_account_id = 'account-new'`).run();
    db.prepare(`UPDATE pharmacy_account_capabilities
      SET capabilities_json = json_insert(capabilities_json, '$[#]', 'emergency_contraception')
      WHERE line_account_id = 'account-new'`).run();
    db.prepare(`INSERT INTO pharmacy_emergency_settings
      (line_account_id, is_enabled, pharmacy_registration_number, product_code,
       manufacturer_check_url, privacy_policy_url, privacy_contact, purpose_text,
       consent_version, retention_days, consultation_minutes, reservation_ttl_minutes,
       privacy_space_ready, drinking_water_ready, partner_clinic_url, support_center_url,
       updated_by, created_at, updated_at)
      VALUES ('account-new', 0, 'REG', 'product', 'https://manufacturer.example/check',
              'https://pharmacy.example/privacy', 'contact', 'purpose', 'v1', 30, 30, 30,
              1, 1, 'https://clinic.example', 'https://support.example', 'staff-account-new', ?, ?)`).run(NOW, NOW);

    expect(capabilities(db, 'account-new')).toContain('emergency_contraception');
  });
});
