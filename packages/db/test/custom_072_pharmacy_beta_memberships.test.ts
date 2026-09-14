import { beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  canUsePharmacyBetaParticipant,
  getPharmacyBetaMembership,
  grantPharmacyBetaMembership,
  hasActivePharmacyBetaMembership,
  transitionPharmacyBetaMembership,
} from '../../../apps/worker/src/custom/pharmacy/beta-membership/repository.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const NOW = '2026-09-14T00:00:00.000Z';
const TERMS_HASH = 'a'.repeat(64);

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
  const accountId = `account-${suffix}`;
  const now = NOW;
  db.prepare(`INSERT INTO line_accounts
    (id, channel_id, name, channel_access_token, channel_secret, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(accountId, `channel-${suffix}`, `薬局${suffix}`, `token-${suffix}`, `secret-${suffix}`, now, now);
  db.prepare(`INSERT INTO tenants
    (id, tenant_code, display_name, status, created_at, updated_at)
    VALUES (?, ?, ?, 'active', ?, ?)`)
    .run(`tenant-${suffix}`, `pharmacy-${suffix}`, `薬局${suffix}`, now, now);
  db.prepare(`INSERT INTO tenant_line_accounts
    (tenant_id, line_account_id, created_at, updated_at)
    VALUES (?, ?, ?, ?)`)
    .run(`tenant-${suffix}`, accountId, now, now);
  db.prepare(`INSERT INTO friends
    (id, line_user_id, provider_line_user_id, line_account_id, is_following, created_at, updated_at)
    VALUES (?, ?, ?, ?, 1, ?, ?)`)
    .run(`friend-${suffix}`, `legacy-${suffix}`, `U-${suffix}`, accountId, now, now);
  db.prepare(`INSERT INTO staff_members
    (id, name, role, api_key, is_active, created_at, updated_at)
    VALUES (?, ?, 'owner', ?, 1, ?, ?)`)
    .run(`staff-${suffix}`, `担当者${suffix}`, `key-${suffix}`, now, now);
  db.prepare(`INSERT INTO tenant_staff_memberships
    (tenant_id, staff_id, role, is_active, created_at, updated_at)
    VALUES (?, ?, 'owner', 1, ?, ?)`)
    .run(`tenant-${suffix}`, `staff-${suffix}`, now, now);
  db.prepare(`INSERT INTO pharmacy_staff_accounts
    (line_account_id, staff_id, is_active, created_at, updated_at)
    VALUES (?, ?, 1, ?, ?)`)
    .run(accountId, `staff-${suffix}`, now, now);

  const patient = (id: string, relationship: string, birthDate: string) => db.prepare(`INSERT INTO pharmacy_patients
    (id, line_account_id, owner_friend_id, relationship, name, name_kana,
     birth_date, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, accountId, `friend-${suffix}`, relationship, `患者${id}`, `カンジャ${id}`, birthDate, now, now);
  patient(`patient-${suffix}`, 'self', '1990-01-01');
  patient(`child-${suffix}`, 'child', '2018-01-01');
  patient(`spouse-${suffix}`, 'spouse', '1980-01-01');

  db.prepare(`INSERT INTO pharmacy_patient_proxy_grants
    (id, line_account_id, patient_id, actor_friend_id, permission_code, basis_code,
     terms_version, terms_hash, granted_at, expires_at, version, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'patient_intake_v1', 'self_attested_guardian',
            1, ?, ?, ?, 1, ?, ?)`)
    .run(
      `proxy-${suffix}`, accountId, `child-${suffix}`, `friend-${suffix}`, TERMS_HASH,
      now, '2026-12-01T00:00:00.000Z', now, now,
    );
}

function loadDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(readFileSync(join(ROOT, 'bootstrap.sql'), 'utf8'));
  seedAccount(db, 'a');
  seedAccount(db, 'b');
  return db;
}

describe('custom_072 pharmacy beta memberships', () => {
  let sqlite: Database.Database;
  let db: D1Database;

  beforeEach(() => {
    sqlite = loadDb();
    db = d1From(sqlite);
  });

  it('ships an additive, default-off membership schema with account-safe foreign keys', () => {
    expect(sqlite.prepare(`SELECT beta_enabled FROM pharmacy_account_capabilities
      WHERE line_account_id = 'account-a'`).get()).toEqual({ beta_enabled: 0 });
    expect((sqlite.prepare('PRAGMA table_info(pharmacy_beta_memberships)').all() as Array<{ name: string }>)
      .map((column) => column.name)).toEqual(expect.arrayContaining([
        'line_account_id', 'participant_friend_id', 'subject_patient_id', 'access_kind',
        'status', 'starts_at', 'expires_at', 'version', 'last_transition_id',
      ]));
    expect((sqlite.prepare(`SELECT sql FROM sqlite_master
      WHERE type = 'index' AND name = 'ux_pharmacy_beta_membership_current'`).get() as { sql: string }).sql)
      .toContain("status IN ('active', 'suspended')");

    expect(() => sqlite.prepare(`INSERT INTO pharmacy_beta_memberships
      (id, line_account_id, participant_friend_id, subject_patient_id, subject_owner_friend_id,
       access_kind, status, starts_at, expires_at, created_at, updated_at)
      VALUES ('cross', 'account-b', 'friend-a', 'patient-a', 'friend-a', 'self', 'active', ?, ?, ?, ?)`)
      .run(NOW, '2026-09-15T00:00:00.000Z', NOW, NOW)).toThrow(/FOREIGN KEY constraint failed/i);
  });

  it('grants self and existing minor proxy access, then applies audited CAS transitions', async () => {
    sqlite.prepare(`UPDATE pharmacy_account_capabilities SET beta_enabled = 1
      WHERE line_account_id = 'account-a'`).run();

    const self = await grantPharmacyBetaMembership(db, {
      lineAccountId: 'account-a', patientId: 'patient-a',
      expiresAt: '2026-10-01T00:00:00.000Z', actorStaffId: 'staff-a', now: new Date(NOW),
    });
    const child = await grantPharmacyBetaMembership(db, {
      lineAccountId: 'account-a', patientId: 'child-a',
      expiresAt: '2026-10-01T00:00:00.000Z', actorStaffId: 'staff-a', now: new Date(NOW),
    });
    expect(self).toMatchObject({ access_kind: 'self', status: 'active', version: 1 });
    expect(child).toMatchObject({ access_kind: 'family', status: 'active', version: 1 });
    expect(await canUsePharmacyBetaParticipant(db, 'account-a', 'friend-a')).toBe(true);
    expect(await hasActivePharmacyBetaMembership(db, {
      lineAccountId: 'account-a', participantFriendId: 'friend-a',
      subjectPatientId: 'child-a', now: new Date(NOW),
    })).toBe(true);
    expect(await canUsePharmacyBetaParticipant(db, 'account-a', 'friend-b')).toBe(false);

    const suspended = await transitionPharmacyBetaMembership(db, {
      lineAccountId: 'account-a', membershipId: child.id, action: 'suspend',
      expectedVersion: 1, actorStaffId: 'staff-a', now: new Date(NOW),
    });
    expect(suspended).toMatchObject({ status: 'suspended', version: 2 });
    expect(await hasActivePharmacyBetaMembership(db, {
      lineAccountId: 'account-a', participantFriendId: 'friend-a',
      subjectPatientId: 'child-a', now: new Date(NOW),
    })).toBe(false);

    const resumed = await transitionPharmacyBetaMembership(db, {
      lineAccountId: 'account-a', membershipId: child.id, action: 'resume',
      expectedVersion: 2, actorStaffId: 'staff-a', now: new Date(NOW),
    });
    expect(resumed).toMatchObject({ status: 'active', version: 3 });
    const revoked = await transitionPharmacyBetaMembership(db, {
      lineAccountId: 'account-a', membershipId: child.id, action: 'revoke',
      expectedVersion: 3, actorStaffId: 'staff-a', reasonCode: 'manual_stop', now: new Date(NOW),
    });
    expect(revoked).toMatchObject({ status: 'revoked', version: 4, revoke_reason_code: 'manual_stop' });
    expect(await hasActivePharmacyBetaMembership(db, {
      lineAccountId: 'account-a', participantFriendId: 'friend-a',
      subjectPatientId: 'child-a', now: new Date(NOW),
    })).toBe(false);

    const actions = sqlite.prepare(`SELECT action FROM tenant_admin_audit_events
      WHERE line_account_id = 'account-a' ORDER BY created_at, rowid`).all();
    expect(actions).toEqual([
      { action: 'beta_membership_granted' },
      { action: 'beta_membership_granted' },
      { action: 'beta_membership_suspended' },
      { action: 'beta_membership_resumed' },
      { action: 'beta_membership_revoked' },
    ]);
    expect(await getPharmacyBetaMembership(db, 'account-b', self.id)).toBeNull();
  });

  it('derives the expiry boundary, allows explicit stop, and keeps adult family closed', async () => {
    const membership = await grantPharmacyBetaMembership(db, {
      lineAccountId: 'account-a', patientId: 'child-a',
      expiresAt: '2026-09-15T00:00:00.000Z', actorStaffId: 'staff-a', now: new Date(NOW),
    });
    const boundary = new Date('2026-09-15T00:00:00.000Z');
    await expect(getPharmacyBetaMembership(db, 'account-a', membership.id, boundary))
      .resolves.toMatchObject({ status: 'expired' });
    await expect(hasActivePharmacyBetaMembership(db, {
      lineAccountId: 'account-a', participantFriendId: 'friend-a',
      subjectPatientId: 'child-a', now: boundary,
    })).resolves.toBe(false);

    const stopped = await transitionPharmacyBetaMembership(db, {
      lineAccountId: 'account-a', membershipId: membership.id, action: 'revoke',
      expectedVersion: 1, actorStaffId: 'staff-a', reasonCode: 'expired_stop', now: boundary,
    });
    expect(stopped).toMatchObject({ status: 'revoked', revoke_reason_code: 'expired_stop' });
    await expect(grantPharmacyBetaMembership(db, {
      lineAccountId: 'account-a', patientId: 'spouse-a',
      expiresAt: '2026-10-01T00:00:00.000Z', actorStaffId: 'staff-a', now: new Date(NOW),
    })).rejects.toThrow('adult family verification required');
  });

  it('rolls back the membership when the paired audit insert fails', async () => {
    sqlite.exec(`CREATE TRIGGER deny_beta_membership_audit
      BEFORE INSERT ON tenant_admin_audit_events
      WHEN NEW.action = 'beta_membership_granted'
      BEGIN SELECT RAISE(ABORT, 'synthetic audit failure'); END`);

    await expect(grantPharmacyBetaMembership(db, {
      lineAccountId: 'account-b', patientId: 'patient-b',
      expiresAt: '2026-10-01T00:00:00.000Z', actorStaffId: 'staff-b', now: new Date(NOW),
    })).rejects.toThrow('synthetic audit failure');
    expect(sqlite.prepare(`SELECT COUNT(*) AS count FROM pharmacy_beta_memberships
      WHERE line_account_id = 'account-b'`).get()).toEqual({ count: 0 });
  });
});
