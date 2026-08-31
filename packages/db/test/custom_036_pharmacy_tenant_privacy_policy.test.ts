import { beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPatientIntakeResponse } from '../../../apps/worker/src/custom/pharmacy/intake/repository.js';
import {
  getTenantPrivacyPolicy,
  saveTenantPrivacyPolicy,
} from '../../../apps/worker/src/custom/pharmacy/privacy-policy/repository.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const NOW = '2026-08-20T00:00:00.000Z';

type RunnableStatement = D1PreparedStatement & { runSync(): D1Result };
function d1From(sqlite: Database.Database, beforeBatch?: () => void): D1Database {
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
    batch: async <T>(statements: D1PreparedStatement[]) => {
      beforeBatch?.();
      return sqlite.transaction(() =>
        statements.map((item) => (item as RunnableStatement).runSync() as D1Result<T>),
      )();
    },
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
  db.prepare(`INSERT INTO pharmacy_patients
    (id, line_account_id, owner_friend_id, relationship, name, name_kana, birth_date,
     created_at, updated_at)
    VALUES (?, ?, ?, 'self', '患者', 'カンジャ', '1990-01-01', ?, ?)`).run(
    `patient-${suffix}`, `account-${suffix}`, `friend-${suffix}`, NOW, NOW,
  );
}

const POLICY = {
  purposeText: '調剤・服薬指導および連絡のために利用します。',
  purposeUrl: 'https://pharmacy-a.example/privacy',
  contactPoint: '薬局A 個人情報相談窓口 03-0000-0000',
  entrustmentText: 'システム運営事業者に業務の一部を委託しています。',
};

const ANSWERS = {
  allergiesStatus: 'none',
  adverseReactionStatus: 'none',
  medicationStatus: 'none',
  medicalHistoryStatus: 'none',
  medicalHistoryTags: [],
  medicationNotebook: 'none',
  smokingStatus: 'never',
  alcoholStatus: 'none',
  medicationAdherence: 'none',
} as never;

describe('custom_036 pharmacy tenant privacy policy', () => {
  let db: Database.Database;
  let d1: D1Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(readFileSync(join(ROOT, 'bootstrap.sql'), 'utf8'));
    seedAccount(db, 'a');
    seedAccount(db, 'b');
    d1 = d1From(db);
  });

  it('stores one tenant-owned notice per LINE account', async () => {
    await saveTenantPrivacyPolicy(d1, {
      lineAccountId: 'account-a', staffId: 'staff-a', ...POLICY,
    });
    await expect(getTenantPrivacyPolicy(d1, 'account-a')).resolves.toMatchObject({
      purpose_text: POLICY.purposeText,
      purpose_url: POLICY.purposeUrl,
      contact_point: POLICY.contactPoint,
      entrustment_text: POLICY.entrustmentText,
      policy_version: 1,
    });
    await expect(getTenantPrivacyPolicy(d1, 'account-b')).resolves.toBeNull();
  });

  it('bumps the version only when the policy text actually changes', async () => {
    await saveTenantPrivacyPolicy(d1, { lineAccountId: 'account-a', staffId: 'staff-a', ...POLICY });
    const first = await getTenantPrivacyPolicy(d1, 'account-a');
    await saveTenantPrivacyPolicy(d1, { lineAccountId: 'account-a', staffId: 'staff-a', ...POLICY });
    const unchanged = await getTenantPrivacyPolicy(d1, 'account-a');
    expect(unchanged).toMatchObject({ policy_version: 1, content_hash: first?.content_hash });

    await saveTenantPrivacyPolicy(d1, {
      lineAccountId: 'account-a', staffId: 'staff-a', ...POLICY, purposeText: '利用目的を改定しました。',
    });
    const changed = await getTenantPrivacyPolicy(d1, 'account-a');
    expect(changed?.policy_version).toBe(2);
    expect(changed?.content_hash).not.toBe(first?.content_hash);
  });

  it('rejects a staff editor from another tenant', async () => {
    await expect(saveTenantPrivacyPolicy(d1, {
      lineAccountId: 'account-a', staffId: 'staff-b', ...POLICY,
    })).rejects.toThrow();
  });

  it('captures the policy in effect on the intake consent record', async () => {
    await saveTenantPrivacyPolicy(d1, { lineAccountId: 'account-a', staffId: 'staff-a', ...POLICY });
    const policy = await getTenantPrivacyPolicy(d1, 'account-a');
    const owner = { lineAccountId: 'account-a', friendId: 'friend-a' };

    await createPatientIntakeResponse(d1, owner, 'patient-a', {
      idempotencyKey: 'idem-key-0001',
      answers: ANSWERS,
      representativeConsent: true,
      privacyConsent: true,
      privacyPolicyVersion: policy!.policy_version,
      privacyPolicyHash: policy!.content_hash,
    }, { tenantId: 'tenant-a', rootSecret: 's'.repeat(32) });

    expect(db.prepare(`SELECT privacy_policy_version, privacy_policy_hash
      FROM pharmacy_patient_intake_responses WHERE line_account_id = 'account-a'`).get()).toEqual({
      privacy_policy_version: policy?.policy_version,
      privacy_policy_hash: policy?.content_hash,
    });
  });

  it('rejects intake consent when the tenant has published no notice', async () => {
    await expect(createPatientIntakeResponse(
      d1, { lineAccountId: 'account-b', friendId: 'friend-b' }, 'patient-b', {
        idempotencyKey: 'idem-key-0002',
        answers: ANSWERS,
        representativeConsent: true,
        privacyConsent: true,
        privacyPolicyVersion: 1,
        privacyPolicyHash: 'a'.repeat(64),
      }, { tenantId: 'tenant-b', rootSecret: 's'.repeat(32) },
    )).rejects.toThrow('privacy policy required');

    expect(db.prepare(`SELECT COUNT(*) AS count
      FROM pharmacy_patient_intake_responses WHERE line_account_id = 'account-b'`).get()).toEqual({
      count: 0,
    });
  });

  it('fails closed when the policy disappears before the atomic intake write', async () => {
    await saveTenantPrivacyPolicy(d1, { lineAccountId: 'account-a', staffId: 'staff-a', ...POLICY });
    const displayed = await getTenantPrivacyPolicy(d1, 'account-a');
    d1 = d1From(db, () => {
      db.prepare('DELETE FROM pharmacy_tenant_privacy_policy WHERE line_account_id = ?').run('account-a');
    });

    await expect(createPatientIntakeResponse(
      d1, { lineAccountId: 'account-a', friendId: 'friend-a' }, 'patient-a', {
        idempotencyKey: 'idem-key-race',
        answers: ANSWERS,
        representativeConsent: true,
        privacyConsent: true,
        privacyPolicyVersion: displayed!.policy_version,
        privacyPolicyHash: displayed!.content_hash,
      }, { tenantId: 'tenant-a', rootSecret: 's'.repeat(32) },
    )).rejects.toThrow('privacy policy required');

    expect(db.prepare(`SELECT COUNT(*) AS count
      FROM pharmacy_patient_intake_responses WHERE line_account_id = 'account-a'`).get()).toEqual({
      count: 0,
    });
    expect(db.prepare(`SELECT COUNT(*) AS count
      FROM pharmacy_patient_intake_envelopes WHERE line_account_id = 'account-a'`).get()).toEqual({
      count: 0,
    });
  });

  it('rejects consent when the displayed policy changes before the atomic write', async () => {
    await saveTenantPrivacyPolicy(d1, { lineAccountId: 'account-a', staffId: 'staff-a', ...POLICY });
    const displayed = await getTenantPrivacyPolicy(d1, 'account-a');
    d1 = d1From(db, () => {
      db.prepare(`UPDATE pharmacy_tenant_privacy_policy
        SET policy_version = 2, content_hash = ? WHERE line_account_id = ?`)
        .run('b'.repeat(64), 'account-a');
    });

    await expect(createPatientIntakeResponse(
      d1, { lineAccountId: 'account-a', friendId: 'friend-a' }, 'patient-a', {
        idempotencyKey: 'idem-key-stale',
        answers: ANSWERS,
        representativeConsent: true,
        privacyConsent: true,
        privacyPolicyVersion: displayed!.policy_version,
        privacyPolicyHash: displayed!.content_hash,
      }, { tenantId: 'tenant-a', rootSecret: 's'.repeat(32) },
    )).rejects.toThrow('privacy policy changed');

    expect(db.prepare(`SELECT COUNT(*) AS count
      FROM pharmacy_patient_intake_responses WHERE line_account_id = 'account-a'`).get()).toEqual({
      count: 0,
    });
    expect(db.prepare(`SELECT COUNT(*) AS count
      FROM pharmacy_patient_intake_envelopes WHERE line_account_id = 'account-a'`).get()).toEqual({
      count: 0,
    });
  });
});
