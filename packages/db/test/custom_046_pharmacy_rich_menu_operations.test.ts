import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATION = join(ROOT, 'migrations/custom_046_pharmacy_rich_menu_operations.sql');
const HASH = 'a'.repeat(64);
const ORDER = JSON.stringify([
  'prescription-send', 'prescription-history', 'medication-followup', 'manual-chat', 'pharmacy-info',
]);

function setup(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(readFileSync(join(ROOT, 'bootstrap.sql'), 'utf8'));
  db.exec(readFileSync(MIGRATION, 'utf8'));
  for (const accountId of ['account-a', 'account-b']) {
    db.prepare(`INSERT INTO line_accounts
      (id, channel_id, name, channel_access_token, channel_secret)
      VALUES (?, ?, ?, 'token', 'secret')`).run(accountId, `channel-${accountId}`, accountId);
    db.prepare(`INSERT INTO pharmacy_rich_menu_layouts
      (line_account_id, preferred_order_json, revision, created_at, updated_at)
      VALUES (?, ?, 1, '2026-08-21T00:00:00Z', '2026-08-21T00:00:00Z')`).run(accountId, ORDER);
    db.prepare(`INSERT INTO rich_menu_groups
      (id, account_id, name, chat_bar_text, size, status)
      VALUES (?, ?, 'Menu', 'Menu', 'large', 'draft')`).run(`group-${accountId}`, accountId);
    db.prepare(`INSERT INTO rich_menu_pages
      (id, group_id, order_index, name, alias_id)
      VALUES (?, ?, 0, 'Main', 'draft-alias')`).run(`page-${accountId}`, `group-${accountId}`);
    db.prepare(`INSERT INTO pharmacy_rich_menu_draft_bindings
      (group_id, line_account_id, layout_revision, capability_revision, liff_id_hash,
       catalog_version, menu_size, catalog_variant_key, catalog_object_key,
       manifest_hash, image_hash, created_at)
      VALUES (?, ?, 1, 1, ?, 'v4-2', 'large', 'variant', 'catalog/variant.jpg', ?, ?,
              '2026-08-21T00:00:00Z')`).run(`group-${accountId}`, accountId, HASH, HASH, HASH);
  }
  return db;
}

function insertOperation(
  db: Database.Database,
  id: string,
  groupId = 'group-account-a',
  accountId = 'account-a',
  kind = 'publish',
  status = 'running',
  confirmationId = `confirmation-${id}`,
): void {
  db.prepare(`INSERT INTO pharmacy_rich_menu_operations
    (id, group_id, line_account_id, confirmation_id, kind, status, evidence_digest,
     publish_phase, publish_alias_id, publish_menu_name, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?,
      CASE WHEN ? = 'publish' THEN 'intent_recorded' END,
      CASE WHEN ? = 'publish' THEN 'lhx-group-ac-op-0' END,
      CASE WHEN ? = 'publish' THEN 'pharmacy-group-ac-op' END,
      '2026-08-21T00:00:00Z', '2026-08-21T00:00:00Z')`)
    .run(id, groupId, accountId, confirmationId, kind, status, HASH, kind, kind, kind);
}

describe('custom_046 pharmacy rich-menu operations', () => {
  it('keeps the v0.30 lifecycle inactive until an account-scoped activation and supports a durable freeze', () => {
    const db = setup();

    expect(db.prepare(`SELECT state, revision FROM pharmacy_rich_menu_lifecycle_controls
      WHERE line_account_id = 'account-a'`).get()).toBeUndefined();
    db.prepare(`INSERT INTO pharmacy_rich_menu_lifecycle_controls
      (line_account_id, state, revision, created_at, updated_at)
      VALUES ('account-a', 'active', 1, '2026-08-21T00:00:00Z', '2026-08-21T00:00:00Z')`).run();
    db.prepare(`UPDATE pharmacy_rich_menu_lifecycle_controls
      SET state = 'frozen', revision = revision + 1, updated_at = '2026-08-21T00:01:00Z'
      WHERE line_account_id = 'account-a' AND revision = 1`).run();

    expect(db.prepare(`SELECT state, revision FROM pharmacy_rich_menu_lifecycle_controls
      WHERE line_account_id = 'account-a'`).get()).toEqual({ state: 'frozen', revision: 2 });
    expect(db.prepare(`SELECT state FROM pharmacy_rich_menu_lifecycle_controls
      WHERE line_account_id = 'account-b'`).get()).toBeUndefined();
    expect(() => db.prepare(`UPDATE pharmacy_rich_menu_lifecycle_controls
      SET state = 'invalid' WHERE line_account_id = 'account-a'`).run()).toThrow(/check/i);
  });

  it('accepts only same-account bound versions and lifecycle values', () => {
    const db = setup();

    insertOperation(db, 'op-a');
    expect(db.prepare(`SELECT group_id, line_account_id, kind, status
      FROM pharmacy_rich_menu_operations WHERE id = 'op-a'`).get()).toEqual({
      group_id: 'group-account-a', line_account_id: 'account-a', kind: 'publish', status: 'running',
    });
    expect(() => insertOperation(db, 'cross-account', 'group-account-b', 'account-a')).toThrow(/account/i);
    expect(() => insertOperation(db, 'bad-kind', 'group-account-b', 'account-b', 'delete')).toThrow(/check/i);
    expect(() => insertOperation(db, 'bad-status', 'group-account-b', 'account-b', 'publish', 'retrying'))
      .toThrow(/MUST_START_RUNNING|check/i);
    expect(() => insertOperation(
      db, 'replay', 'group-account-b', 'account-b', 'publish', 'running', 'confirmation-op-a',
    )).toThrow(/unique/i);
  });

  it('allows one unresolved operation per account and makes terminal evidence immutable', () => {
    const db = setup();

    insertOperation(db, 'op-a');
    expect(() => insertOperation(db, 'op-a-2')).toThrow(/unique/i);
    db.prepare(`UPDATE pharmacy_rich_menu_operations
      SET remote_rich_menu_id = 'richmenu-1', publish_phase = 'remote_created',
          updated_at = '2026-08-21T00:01:00Z'
      WHERE id = 'op-a' AND status = 'running'`).run();
    db.prepare(`UPDATE pharmacy_rich_menu_operations
      SET publish_phase = 'image_uploaded', updated_at = '2026-08-21T00:02:00Z'
      WHERE id = 'op-a' AND status = 'running'`).run();
    db.prepare(`UPDATE pharmacy_rich_menu_operations
      SET publish_phase = 'alias_created', updated_at = '2026-08-21T00:03:00Z'
      WHERE id = 'op-a' AND status = 'running'`).run();
    db.prepare(`UPDATE rich_menu_pages
      SET line_richmenu_id = 'richmenu-1', alias_id = 'lhx-group-ac-op-0'
      WHERE group_id = 'group-account-a'`).run();
    db.prepare(`UPDATE pharmacy_rich_menu_operations
      SET publish_phase = 'committed', status = 'unknown', updated_at = '2026-08-21T00:04:00Z'
      WHERE id = 'op-a' AND status = 'running'`).run();
    expect(() => insertOperation(db, 'op-a-2')).toThrow(/unique/i);
    db.prepare(`UPDATE pharmacy_rich_menu_operations
      SET status = 'succeeded', verified_at = '2026-08-21T00:05:00Z',
          updated_at = '2026-08-21T00:05:00Z'
      WHERE id = 'op-a' AND status = 'unknown'`).run();
    expect(() => db.prepare(`UPDATE pharmacy_rich_menu_operations
      SET status = 'running' WHERE id = 'op-a'`).run()).toThrow(/immutable/i);
    insertOperation(db, 'op-a-2');
  });

  it('requires ordered durable publish phases before success', () => {
    const db = setup();
    insertOperation(db, 'publish-a');

    expect(() => db.prepare(`UPDATE pharmacy_rich_menu_operations
      SET publish_phase = 'image_uploaded' WHERE id = 'publish-a'`).run()).toThrow(/phase/i);
    expect(() => db.prepare(`UPDATE pharmacy_rich_menu_operations
      SET status = 'succeeded', verified_at = '2026-08-21T00:01:00Z'
      WHERE id = 'publish-a'`).run()).toThrow(/evidence|phase/i);

    db.prepare(`UPDATE pharmacy_rich_menu_operations
      SET remote_rich_menu_id = 'richmenu-a', publish_phase = 'remote_created'
      WHERE id = 'publish-a'`).run();
    db.prepare(`UPDATE pharmacy_rich_menu_operations SET status = 'unknown'
      WHERE id = 'publish-a'`).run();
    db.prepare(`UPDATE pharmacy_rich_menu_operations SET publish_phase = 'image_uploaded'
      WHERE id = 'publish-a'`).run();
    db.prepare(`UPDATE pharmacy_rich_menu_operations SET publish_phase = 'alias_created'
      WHERE id = 'publish-a'`).run();
    expect(() => db.prepare(`UPDATE pharmacy_rich_menu_operations SET publish_phase = 'committed'
      WHERE id = 'publish-a'`).run()).toThrow(/evidence|projection/i);

    db.prepare(`UPDATE rich_menu_pages
      SET line_richmenu_id = 'richmenu-a', alias_id = 'lhx-group-ac-op-0'
      WHERE group_id = 'group-account-a'`).run();
    db.prepare(`UPDATE pharmacy_rich_menu_operations SET publish_phase = 'committed'
      WHERE id = 'publish-a'`).run();
    db.prepare(`UPDATE pharmacy_rich_menu_operations
      SET status = 'succeeded', verified_at = '2026-08-21T00:02:00Z'
      WHERE id = 'publish-a'`).run();
  });

  it('consumes each publish-resume confirmation once at the current account phase', () => {
    const db = setup();
    insertOperation(db, 'resume-a');
    db.prepare(`UPDATE pharmacy_rich_menu_operations
      SET remote_rich_menu_id = 'richmenu-a', publish_phase = 'remote_created', status = 'unknown'
      WHERE id = 'resume-a'`).run();

    const insert = (confirmationId: string, accountId = 'account-a', phase = 'remote_created') =>
      db.prepare(`INSERT INTO pharmacy_rich_menu_operation_confirmations
        (confirmation_id, operation_id, line_account_id, publish_phase, evidence_digest, created_at)
        VALUES (?, 'resume-a', ?, ?, ?, '2026-08-21T00:05:00Z')`)
        .run(confirmationId, accountId, phase, HASH);

    expect(insert('resume-confirmation-1').changes).toBe(1);
    expect(() => insert('resume-confirmation-1')).toThrow(/unique/i);
    expect(() => insert('resume-confirmation-2', 'account-b')).toThrow(/account|evidence/i);
    expect(() => insert('resume-confirmation-3', 'account-a', 'image_uploaded'))
      .toThrow(/phase|evidence/i);
  });

  it('freezes the fresh default read and requires matching read-back for known-good', () => {
    const db = setup();
    insertOperation(db, 'switch-b', 'group-account-b', 'account-b', 'set_default');
    db.prepare(`UPDATE pharmacy_rich_menu_operations
      SET remote_rich_menu_id = 'richmenu-new', updated_at = '2026-08-21T00:01:00Z'
      WHERE id = 'switch-b'`).run();
    expect(() => db.prepare(`UPDATE pharmacy_rich_menu_operations
      SET status = 'succeeded', verified_default_menu_id = 'richmenu-new',
          verified_at = '2026-08-21T00:02:00Z', updated_at = '2026-08-21T00:02:00Z'
      WHERE id = 'switch-b'`).run()).toThrow(/evidence/i);
    db.prepare(`UPDATE pharmacy_rich_menu_operations
      SET expected_default_menu_id = 'richmenu-old', default_read_at = '2026-08-21T00:02:00Z',
          updated_at = '2026-08-21T00:02:00Z'
      WHERE id = 'switch-b'`).run();
    expect(() => db.prepare(`UPDATE pharmacy_rich_menu_operations
      SET expected_default_menu_id = 'another-menu' WHERE id = 'switch-b'`).run()).toThrow(/immutable/i);
    db.prepare(`UPDATE pharmacy_rich_menu_operations
      SET status = 'succeeded', verified_default_menu_id = 'richmenu-new',
          verified_at = '2026-08-21T00:03:00Z', updated_at = '2026-08-21T00:03:00Z'
      WHERE id = 'switch-b'`).run();
  });

  it('keeps existing rows additive and excludes patient, friend, and credential fields', () => {
    const db = setup();
    expect(db.prepare(`SELECT COUNT(*) AS count FROM rich_menu_groups`).get()).toEqual({ count: 2 });
    const columns = (db.prepare(`PRAGMA table_info(pharmacy_rich_menu_operations)`).all() as Array<{ name: string }>)
      .map(({ name }) => name);
    expect(columns).toContain('confirmation_id');
    expect(columns).toEqual(expect.arrayContaining([
      'publish_phase', 'publish_alias_id', 'publish_menu_name',
    ]));
    expect(columns).not.toEqual(expect.arrayContaining([
      'patient_id', 'line_user_id', 'friend_id', 'credential', 'channel_access_token',
    ]));
    const confirmationColumns = (db.prepare(
      `PRAGMA table_info(pharmacy_rich_menu_operation_confirmations)`,
    ).all() as Array<{ name: string }>).map(({ name }) => name);
    expect(confirmationColumns).toEqual(expect.arrayContaining([
      'confirmation_id', 'operation_id', 'line_account_id', 'publish_phase', 'evidence_digest',
    ]));
  });
});
