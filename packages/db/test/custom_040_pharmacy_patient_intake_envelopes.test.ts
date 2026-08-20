import { beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const NOW = '2026-08-20T00:00:00.000Z';

function seed(db: Database.Database, suffix: 'a' | 'b'): void {
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
    (id, line_user_id, line_account_id, is_following, created_at, updated_at)
    VALUES (?, ?, ?, 1, ?, ?)`).run(`friend-${suffix}`, `U-${suffix}`, `account-${suffix}`, NOW, NOW);
  db.prepare(`INSERT INTO pharmacy_patients
    (id, line_account_id, owner_friend_id, relationship, name, name_kana,
     birth_date, created_at, updated_at)
    VALUES (?, ?, ?, 'self', ?, ?, '1990-01-01', ?, ?)`).run(
    `patient-${suffix}`, `account-${suffix}`, `friend-${suffix}`, suffix, suffix, NOW, NOW,
  );
  db.prepare(`INSERT INTO pharmacy_patient_intake_responses
    (id, line_account_id, owner_friend_id, patient_id, revision, schema_version,
     patient_snapshot_json, answers_json, idempotency_key,
     representative_consent_at, privacy_consent_at, created_at)
    VALUES (?, ?, ?, ?, 1, 2, '{}', '{}', ?, ?, ?, ?)`).run(
    `response-${suffix}`, `account-${suffix}`, `friend-${suffix}`, `patient-${suffix}`,
    `intake-key-${suffix}`, NOW, NOW, NOW,
  );
}

function insertEnvelope(
  db: Database.Database,
  overrides: Record<string, string | number> = {},
): void {
  const value = {
    responseId: 'response-a', tenantId: 'tenant-a', lineAccountId: 'account-a', ownerFriendId: 'friend-a',
    patientId: 'patient-a', fieldName: 'answers_json', schemaVersion: 2,
    sourceRevision: 1, envelopeVersion: 1, keyVersion: 1,
    nonce: 'AAAAAAAAAAAAAAAA', ciphertext: 'BBBBBBBBBBBBBBBBBBBBBB', encryptedAt: NOW,
    ...overrides,
  };
  db.prepare(`INSERT INTO pharmacy_patient_intake_envelopes
    (response_id, tenant_id, line_account_id, owner_friend_id, patient_id, field_name,
     schema_version, source_revision, envelope_version, key_version, nonce,
     ciphertext, encrypted_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    value.responseId, value.tenantId, value.lineAccountId, value.ownerFriendId, value.patientId,
    value.fieldName, value.schemaVersion, value.sourceRevision, value.envelopeVersion,
    value.keyVersion, value.nonce, value.ciphertext, value.encryptedAt,
  );
}

describe('custom_040 pharmacy patient intake envelopes', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(readFileSync(join(ROOT, 'bootstrap.sql'), 'utf8'));
    seed(db, 'a');
    seed(db, 'b');
  });

  it('stores exactly one envelope per response field', () => {
    insertEnvelope(db);
    insertEnvelope(db, {
      fieldName: 'patient_snapshot_json', nonce: 'CCCCCCCCCCCCCCCC', ciphertext: 'DDDDDDDDDDDDDDDDDDDDDD',
    });
    expect(db.prepare(`SELECT field_name FROM pharmacy_patient_intake_envelopes
      WHERE response_id = ? ORDER BY field_name`).all('response-a')).toEqual([
      { field_name: 'answers_json' }, { field_name: 'patient_snapshot_json' },
    ]);
    expect(() => insertEnvelope(db, { nonce: 'EEEEEEEEEEEEEEEE' })).toThrow(/unique/i);
  });

  it('rejects cross-scope and unsupported-field envelopes', () => {
    expect(() => insertEnvelope(db, { tenantId: 'tenant-b' })).toThrow(/foreign key/i);
    expect(() => insertEnvelope(db, { lineAccountId: 'account-b' })).toThrow(/foreign key/i);
    expect(() => insertEnvelope(db, { ownerFriendId: 'friend-b' })).toThrow(/foreign key/i);
    expect(() => insertEnvelope(db, { patientId: 'patient-b' })).toThrow(/foreign key/i);
    expect(() => insertEnvelope(db, { schemaVersion: 3 })).toThrow(/foreign key/i);
    expect(() => insertEnvelope(db, { sourceRevision: 2 })).toThrow(/foreign key/i);
    expect(() => insertEnvelope(db, { fieldName: 'unknown_json' })).toThrow(/check/i);
  });

  it('rejects nonce reuse under the same key version', () => {
    insertEnvelope(db);
    expect(() => insertEnvelope(db, {
      responseId: 'response-b', lineAccountId: 'account-b', ownerFriendId: 'friend-b',
      patientId: 'patient-b', fieldName: 'patient_snapshot_json',
    })).toThrow(/unique/i);
  });

  it('cascades envelopes when the source response is deleted', () => {
    insertEnvelope(db);
    db.prepare(`DELETE FROM pharmacy_patient_intake_responses WHERE id = ?`).run('response-a');
    expect(db.prepare(`SELECT COUNT(*) AS count FROM pharmacy_patient_intake_envelopes`).get())
      .toEqual({ count: 0 });
  });
});
