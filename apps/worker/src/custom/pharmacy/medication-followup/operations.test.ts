import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { d1FromSqlite, DB_PACKAGE_ROOT, openTestSqlite, type TestSqliteDatabase } from '../test-sqlite.js';
import {
  getMedicationFollowUpOperations,
  saveMedicationFollowUpOperations,
} from './repository.js';

const NOW = new Date('2026-09-20T01:00:00.000Z');

function setup(): { sqlite: TestSqliteDatabase; db: D1Database } {
  const sqlite = openTestSqlite({ foreignKeys: true });
  sqlite.exec(readFileSync(join(DB_PACKAGE_ROOT, 'bootstrap.sql'), 'utf8'));
  sqlite.exec(`
    INSERT INTO tenants (id, tenant_code, display_name, status, created_at, updated_at)
    VALUES
      ('tenant-a', 'pharmacy-a', 'Pharmacy A', 'active', '${NOW.toISOString()}', '${NOW.toISOString()}'),
      ('tenant-b', 'pharmacy-b', 'Pharmacy B', 'active', '${NOW.toISOString()}', '${NOW.toISOString()}');
    INSERT INTO line_accounts
      (id, channel_id, name, channel_access_token, channel_secret, created_at, updated_at)
    VALUES
      ('account-a', 'channel-a', 'Account A', 'token-a', 'secret-a', '${NOW.toISOString()}', '${NOW.toISOString()}'),
      ('account-b', 'channel-b', 'Account B', 'token-b', 'secret-b', '${NOW.toISOString()}', '${NOW.toISOString()}');
    INSERT INTO tenant_line_accounts (tenant_id, line_account_id, created_at, updated_at)
    VALUES
      ('tenant-a', 'account-a', '${NOW.toISOString()}', '${NOW.toISOString()}'),
      ('tenant-b', 'account-b', '${NOW.toISOString()}', '${NOW.toISOString()}');
    INSERT INTO staff_members
      (id, name, role, api_key, is_active, principal_kind, created_at, updated_at)
    VALUES
      ('staff-a', 'Staff A', 'staff', 'disabled:staff-a', 1, 'human', '${NOW.toISOString()}', '${NOW.toISOString()}'),
      ('staff-b', 'Staff B', 'staff', 'disabled:staff-b', 1, 'human', '${NOW.toISOString()}', '${NOW.toISOString()}'),
      ('staff-c', 'Staff C', 'staff', 'disabled:staff-c', 1, 'human', '${NOW.toISOString()}', '${NOW.toISOString()}'),
      ('staff-d', 'Staff D', 'staff', 'disabled:staff-d', 1, 'human', '${NOW.toISOString()}', '${NOW.toISOString()}');
    INSERT INTO tenant_staff_memberships
      (tenant_id, staff_id, role, is_active, created_at, updated_at)
    VALUES
      ('tenant-a', 'staff-a', 'staff', 1, '${NOW.toISOString()}', '${NOW.toISOString()}'),
      ('tenant-b', 'staff-b', 'staff', 1, '${NOW.toISOString()}', '${NOW.toISOString()}'),
      ('tenant-a', 'staff-c', 'staff', 0, '${NOW.toISOString()}', '${NOW.toISOString()}'),
      ('tenant-a', 'staff-d', 'staff', 1, '${NOW.toISOString()}', '${NOW.toISOString()}');
    INSERT INTO pharmacy_staff_accounts
      (line_account_id, staff_id, is_active, created_at, updated_at)
    VALUES
      ('account-a', 'staff-a', 1, '${NOW.toISOString()}', '${NOW.toISOString()}'),
      ('account-b', 'staff-b', 1, '${NOW.toISOString()}', '${NOW.toISOString()}'),
      ('account-a', 'staff-c', 1, '${NOW.toISOString()}', '${NOW.toISOString()}'),
      ('account-a', 'staff-d', 1, '${NOW.toISOString()}', '${NOW.toISOString()}');
  `);
  return { sqlite, db: d1FromSqlite(sqlite) };
}

const baseInput = {
  lineAccountId: 'account-a',
  serviceHoursText: '9:00-18:00',
  responseSla: { typical_minutes: 30, concern_minutes: 60 },
  primaryStaffId: 'staff-a',
  backupStaffId: null as string | null,
  afterHoursMessageCode: 'contact_pharmacy_during_hours',
  emergencyMessageCode: 'seek_urgent_care',
  enabled: true,
  expectedVersion: 0,
  actorStaffId: 'staff-a',
  now: NOW,
};

describe('medication follow-up operations repository', () => {
  it('creates the config and its audit row in one atomic batch', async () => {
    const { sqlite, db } = setup();
    try {
      const saved = await saveMedicationFollowUpOperations(db, baseInput);
      expect(saved).toMatchObject({
        line_account_id: 'account-a', primary_staff_id: 'staff-a',
        enabled: 1, version: 1,
      });
      const audit = sqlite.prepare(
        `SELECT action, line_account_id, actor_staff_id, detail_json
           FROM tenant_admin_audit_events`,
      ).all() as Array<Record<string, unknown>>;
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({
        action: 'pharmacy_followup_operations_saved',
        line_account_id: 'account-a', actor_staff_id: 'staff-a',
      });
      expect(JSON.parse(audit[0].detail_json as string)).toMatchObject({
        enabled: true, created: true,
      });
    } finally {
      sqlite.close();
    }
  });

  it('bumps the version on save and rejects stale expected versions', async () => {
    const { sqlite, db } = setup();
    try {
      await saveMedicationFollowUpOperations(db, baseInput);
      const saved = await saveMedicationFollowUpOperations(db, {
        ...baseInput, expectedVersion: 1, serviceHoursText: '10:00-19:00',
        backupStaffId: 'staff-d',
      });
      expect(saved.version).toBe(2);
      expect(saved.service_hours_text).toBe('10:00-19:00');
      expect(saved.backup_staff_id).toBe('staff-d');

      await expect(saveMedicationFollowUpOperations(db, {
        ...baseInput, expectedVersion: 1,
      })).rejects.toThrow('follow-up operations conflict');
      await expect(saveMedicationFollowUpOperations(db, {
        ...baseInput, expectedVersion: 0,
      })).rejects.toThrow('follow-up operations conflict');
      expect(sqlite.prepare(
        `SELECT COUNT(*) AS n FROM tenant_admin_audit_events`,
      ).get()).toEqual({ n: 2 });
    } finally {
      sqlite.close();
    }
  });

  it('rolls back the audit row when the staff scope trigger rejects the write', async () => {
    const { sqlite, db } = setup();
    try {
      await expect(saveMedicationFollowUpOperations(db, {
        ...baseInput, primaryStaffId: 'staff-b', enabled: false,
      })).rejects.toThrow('invalid follow-up operations staff');
      expect(await getMedicationFollowUpOperations(db, 'account-a')).toBeNull();
      expect(sqlite.prepare(
        `SELECT COUNT(*) AS n FROM tenant_admin_audit_events`,
      ).get()).toEqual({ n: 0 });
    } finally {
      sqlite.close();
    }
  });

  it('permits disabled preconfiguration but blocks enabling inactive memberships', async () => {
    const { sqlite, db } = setup();
    try {
      await expect(saveMedicationFollowUpOperations(db, {
        ...baseInput, primaryStaffId: 'staff-c', enabled: true,
      })).rejects.toThrow('invalid follow-up operations staff');

      const saved = await saveMedicationFollowUpOperations(db, {
        ...baseInput, primaryStaffId: 'staff-c', enabled: false,
      });
      expect(saved.enabled).toBe(0);
    } finally {
      sqlite.close();
    }
  });

  it('requires the patient-facing estimate before operations can be enabled', async () => {
    const { sqlite, db } = setup();
    try {
      await expect(saveMedicationFollowUpOperations(db, {
        ...baseInput, responseSla: { concern_minutes: 60 },
      })).rejects.toThrow('invalid follow-up operations');

      const saved = await saveMedicationFollowUpOperations(db, {
        ...baseInput, responseSla: { concern_minutes: 60 }, enabled: false,
      });
      expect(saved.enabled).toBe(0);
    } finally {
      sqlite.close();
    }
  });

  it('rejects a backup equal to the primary and malformed SLA payloads', async () => {
    const { sqlite, db } = setup();
    try {
      await expect(saveMedicationFollowUpOperations(db, {
        ...baseInput, backupStaffId: 'staff-a',
      })).rejects.toThrow('invalid follow-up operations');
      await expect(saveMedicationFollowUpOperations(db, {
        ...baseInput, responseSla: { unknown_key: 5 },
      })).rejects.toThrow('invalid follow-up operations');
      await expect(saveMedicationFollowUpOperations(db, {
        ...baseInput, responseSla: { typical_minutes: 30.5 },
      })).rejects.toThrow('invalid follow-up operations');
      await expect(saveMedicationFollowUpOperations(db, {
        ...baseInput, responseSla: { typical_minutes: 0 },
      })).rejects.toThrow('invalid follow-up operations');
      await expect(saveMedicationFollowUpOperations(db, {
        ...baseInput, afterHoursMessageCode: 'free_text',
      })).rejects.toThrow('invalid follow-up operations');
    } finally {
      sqlite.close();
    }
  });

  it('reports a stable unavailable error before the operations migration lands', async () => {
    const sqlite = openTestSqlite();
    const db = d1FromSqlite(sqlite);
    try {
      await expect(getMedicationFollowUpOperations(db, 'account-a'))
        .rejects.toThrow('follow-up operations schema unavailable');
      await expect(saveMedicationFollowUpOperations(db, baseInput))
        .rejects.toThrow('follow-up operations schema unavailable');
    } finally {
      sqlite.close();
    }
  });
});
