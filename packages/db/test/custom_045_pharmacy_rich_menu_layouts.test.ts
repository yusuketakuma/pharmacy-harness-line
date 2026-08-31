import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ORDER = JSON.stringify([
  'prescription-send', 'prescription-history', 'medication-followup', 'manual-chat', 'pharmacy-info',
]);

function setup(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(readFileSync(join(ROOT, 'bootstrap.sql'), 'utf8'));
  for (const accountId of ['account-a', 'account-b']) {
    db.prepare(`INSERT INTO line_accounts
      (id, channel_id, name, channel_access_token, channel_secret)
      VALUES (?, ?, ?, 'token', 'secret')`).run(accountId, `channel-${accountId}`, accountId);
  }
  return db;
}

function insertGroup(db: Database.Database, id: string, accountId: string, status = 'draft'): void {
  db.prepare(`INSERT INTO rich_menu_groups
    (id, account_id, name, chat_bar_text, size, status)
    VALUES (?, ?, 'Menu', 'Menu', 'large', ?)`).run(id, accountId, status);
}

describe('custom_045 pharmacy rich-menu layouts', () => {
  it('stores one validated preferred order per account with a CAS revision', () => {
    const db = setup();
    const insert = db.prepare(`INSERT INTO pharmacy_rich_menu_layouts
      (line_account_id, preferred_order_json, revision, created_at, updated_at)
      VALUES (?, ?, 1, '2026-08-21T00:00:00Z', '2026-08-21T00:00:00Z')`);

    insert.run('account-a', ORDER);
    expect(db.prepare(`SELECT preferred_order_json, revision FROM pharmacy_rich_menu_layouts
      WHERE line_account_id = 'account-a'`).get()).toEqual({ preferred_order_json: ORDER, revision: 1 });
    expect(() => insert.run('account-a', ORDER)).toThrow(/unique/i);
    expect(() => insert.run('account-b', JSON.stringify(['prescription-send']))).toThrow(/check/i);
    expect(() => insert.run('missing-account', ORDER)).toThrow(/foreign key/i);
  });

  it('binds immutable draft evidence to a draft group in the same account', () => {
    const db = setup();
    const insertLayout = db.prepare(`INSERT INTO pharmacy_rich_menu_layouts
      (line_account_id, preferred_order_json, revision, created_at, updated_at)
      VALUES (?, ?, 1, '2026-08-21T00:00:00Z', '2026-08-21T00:00:00Z')`);
    insertLayout.run('account-a', ORDER);
    insertLayout.run('account-b', ORDER);
    insertGroup(db, 'draft-a', 'account-a');
    insertGroup(db, 'draft-b', 'account-b');
    insertGroup(db, 'published-a', 'account-a', 'published');

    const insertBinding = db.prepare(`INSERT INTO pharmacy_rich_menu_draft_bindings
      (group_id, line_account_id, layout_revision, capability_revision, liff_id_hash,
       catalog_version, menu_size, catalog_variant_key, catalog_object_key, manifest_hash, image_hash, created_at)
      VALUES (?, ?, 1, 1, ?, 'v4-2', 'large', 'v4-large-empty',
              'rich-menu-catalog/v4-2/v4-large-empty.jpg', ?, ?,
              '2026-08-21T00:00:00Z')`);
    const hash = 'a'.repeat(64);

    insertBinding.run('draft-a', 'account-a', hash, hash, hash);
    expect(() => db.prepare(`UPDATE pharmacy_rich_menu_draft_bindings
      SET catalog_variant_key = 'v4-other' WHERE group_id = 'draft-a'`).run()).toThrow(/immutable/i);
    expect(() => insertBinding.run('draft-b', 'account-a', hash, hash, hash)).toThrow(/account/i);
    expect(() => insertBinding.run('published-a', 'account-a', hash, hash, hash)).toThrow(/draft/i);
    const columns = (db.prepare(`PRAGMA table_info(pharmacy_rich_menu_draft_bindings)`).all() as Array<{ name: string }>).map(({ name }) => name);
    expect(columns).toContain('liff_id_hash');
    expect(columns).toContain('catalog_object_key');
    expect(columns).toContain('menu_size');
    expect(columns).not.toContain('liff_config_revision');
    expect(() => db.prepare(`INSERT INTO pharmacy_rich_menu_draft_bindings
      (group_id, line_account_id, layout_revision, capability_revision, liff_id_hash,
       catalog_version, menu_size, catalog_variant_key, catalog_object_key, manifest_hash, image_hash, created_at)
      VALUES ('draft-b', 'account-b', 1, 1, ?, 'v4-2', 'compact', 'v4-compact-empty',
              'rich-menu-catalog/v4-2/v4-compact-empty.jpg', ?, ?, '2026-08-21T00:00:00Z')`)
      .run(hash, hash, hash)).toThrow(/size/i);
  });

  it('contains no patient, friend, or credential fields', () => {
    const db = setup();
    const columns = ['pharmacy_rich_menu_layouts', 'pharmacy_rich_menu_draft_bindings']
      .flatMap((table) => (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
        .map(({ name }) => name));
    expect(columns).not.toEqual(expect.arrayContaining([
      'patient_id', 'line_user_id', 'friend_id', 'credential', 'channel_access_token',
    ]));
  });
});
