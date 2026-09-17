import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { d1FromSqlite, DB_PACKAGE_ROOT, openTestSqlite, type TestSqliteDatabase } from '../test-sqlite.js';
import {
  approveChatTemplate,
  archiveChatTemplate,
  createChatTemplate,
  getChatTemplate,
  listChatTemplates,
  updateChatTemplate,
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
      ('staff-d', 'Staff D', 'owner', 'disabled:staff-d', 1, 'human', '${NOW.toISOString()}', '${NOW.toISOString()}'),
      ('staff-b', 'Staff B', 'staff', 'disabled:staff-b', 1, 'human', '${NOW.toISOString()}', '${NOW.toISOString()}');
    INSERT INTO tenant_staff_memberships
      (tenant_id, staff_id, role, is_active, created_at, updated_at)
    VALUES
      ('tenant-a', 'staff-a', 'staff', 1, '${NOW.toISOString()}', '${NOW.toISOString()}'),
      ('tenant-a', 'staff-d', 'owner', 1, '${NOW.toISOString()}', '${NOW.toISOString()}'),
      ('tenant-b', 'staff-b', 'staff', 1, '${NOW.toISOString()}', '${NOW.toISOString()}');
    INSERT INTO pharmacy_staff_accounts
      (line_account_id, staff_id, is_active, created_at, updated_at)
    VALUES
      ('account-a', 'staff-a', 1, '${NOW.toISOString()}', '${NOW.toISOString()}'),
      ('account-a', 'staff-d', 1, '${NOW.toISOString()}', '${NOW.toISOString()}'),
      ('account-b', 'staff-b', 1, '${NOW.toISOString()}', '${NOW.toISOString()}');
  `);
  return { sqlite, db: d1FromSqlite(sqlite) };
}

const createInput = {
  lineAccountId: 'account-a',
  templateId: 'tpl-00000001',
  title: '受付確認',
  body: '処方せんを受け付けました。準備ができ次第ご連絡します。',
  actorStaffId: 'staff-a',
  now: NOW,
};

function auditRows(sqlite: TestSqliteDatabase) {
  return sqlite.prepare(
    `SELECT action, actor_staff_id FROM tenant_admin_audit_events
      WHERE resource_type = 'chat_template' ORDER BY rowid`,
  ).all() as Array<{ action: string; actor_staff_id: string }>;
}

describe('chat template repository', () => {
  it('creates a draft template with an audit row in one batch', async () => {
    const { sqlite, db } = setup();
    const saved = await createChatTemplate(db, createInput);
    expect(saved).toMatchObject({
      template_id: 'tpl-00000001', status: 'draft', version: 1,
      created_by_staff_id: 'staff-a', approved_by_staff_id: null,
    });
    expect(auditRows(sqlite)).toEqual([
      { action: 'pharmacy_chat_template_created', actor_staff_id: 'staff-a' },
    ]);
  });

  it('keeps templates scoped per account', async () => {
    const { db } = setup();
    await createChatTemplate(db, createInput);
    expect(await listChatTemplates(db, 'account-b')).toEqual([]);
    expect(await getChatTemplate(db, 'account-b', 'tpl-00000001')).toBeNull();
  });

  it('rejects PHI-like bodies and placeholder syntax', async () => {
    const { db } = setup();
    await expect(createChatTemplate(db, {
      ...createInput, templateId: 'tpl-00000002',
      body: '患者名を確認しました。糖尿病の薬です。',
    })).rejects.toThrow(/invalid chat template/);
    await expect(createChatTemplate(db, {
      ...createInput, templateId: 'tpl-00000003',
      body: '{{患者名}} 様へご連絡です。',
    })).rejects.toThrow(/invalid chat template/);
    await expect(createChatTemplate(db, {
      ...createInput, templateId: 'tpl-00000004', body: 'a'.repeat(501),
    })).rejects.toThrow(/invalid chat template/);
  });

  it('rejects a creator outside the account scope', async () => {
    const { db } = setup();
    await expect(createChatTemplate(db, {
      ...createInput, actorStaffId: 'staff-b',
    })).rejects.toThrow(/invalid chat template staff/);
  });

  it('updates an approved template back to draft', async () => {
    const { sqlite, db } = setup();
    await createChatTemplate(db, createInput);
    await approveChatTemplate(db, {
      lineAccountId: 'account-a', templateId: 'tpl-00000001',
      expectedVersion: 1, actorStaffId: 'staff-d', now: NOW,
    });
    const edited = await updateChatTemplate(db, {
      lineAccountId: 'account-a', templateId: 'tpl-00000001',
      title: '受付確認(改)', body: '処方せんを受け付けました。',
      expectedVersion: 2, actorStaffId: 'staff-a', now: NOW,
    });
    expect(edited.status).toBe('draft');
    expect(edited.approved_by_staff_id).toBeNull();
    expect(edited.version).toBe(3);
    expect(auditRows(sqlite).map((row) => row.action)).toEqual([
      'pharmacy_chat_template_created',
      'pharmacy_chat_template_approved',
      'pharmacy_chat_template_updated',
    ]);
  });

  it('requires a fresh approver and matching version', async () => {
    const { db } = setup();
    await createChatTemplate(db, createInput);
    await expect(approveChatTemplate(db, {
      lineAccountId: 'account-a', templateId: 'tpl-00000001',
      expectedVersion: 1, actorStaffId: 'staff-a', now: NOW,
    })).rejects.toThrow(/invalid chat template state/);
    await expect(approveChatTemplate(db, {
      lineAccountId: 'account-a', templateId: 'tpl-00000001',
      expectedVersion: 9, actorStaffId: 'staff-d', now: NOW,
    })).rejects.toThrow(/conflict/);
    const approved = await approveChatTemplate(db, {
      lineAccountId: 'account-a', templateId: 'tpl-00000001',
      expectedVersion: 1, actorStaffId: 'staff-d', now: NOW,
    });
    expect(approved).toMatchObject({
      status: 'approved', version: 2, approved_by_staff_id: 'staff-d',
    });
  });

  it('archives a template and blocks edits on archived rows', async () => {
    const { db } = setup();
    await createChatTemplate(db, createInput);
    const archived = await archiveChatTemplate(db, {
      lineAccountId: 'account-a', templateId: 'tpl-00000001',
      expectedVersion: 1, actorStaffId: 'staff-a', now: NOW,
    });
    expect(archived.status).toBe('archived');
    await expect(updateChatTemplate(db, {
      lineAccountId: 'account-a', templateId: 'tpl-00000001',
      title: 't', body: '本文', expectedVersion: 2,
      actorStaffId: 'staff-a', now: NOW,
    })).rejects.toThrow(/invalid chat template state/);
  });

  it('returns not found for unknown templates', async () => {
    const { db } = setup();
    await expect(archiveChatTemplate(db, {
      lineAccountId: 'account-a', templateId: 'tpl-missing0',
      expectedVersion: 1, actorStaffId: 'staff-a', now: NOW,
    })).rejects.toThrow(/not found/);
  });
});
