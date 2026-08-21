import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import {
  beginPharmacyRichMenuOperation,
  advancePharmacyRichMenuPublishPhase,
  createPharmacyRichMenuDraftBinding,
  consumePharmacyRichMenuResumeConfirmation,
  deletePharmacyRichMenuVersion,
  finishPharmacyRichMenuOperation,
  getPharmacyRichMenuLifecycleControl,
  getPharmacyRichMenuDraftBinding,
  getPharmacyRichMenuLayout,
  getPharmacyRichMenuOperation,
  getPharmacyRichMenuCurrentDefaultEvidence,
  getUnresolvedPharmacyRichMenuOperation,
  isPharmacyRichMenuKnownGood,
  listPharmacyRichMenuVersions,
  recordPharmacyRichMenuExpectedDefault,
  recordPharmacyRichMenuRemoteId,
  renamePharmacyRichMenuVersion,
  savePharmacyRichMenuLayout,
  savePharmacyRichMenuLifecycleControl,
} from './repository.js';

const require = createRequire(import.meta.url);
const Sqlite = require('../../../../../../packages/db/node_modules/better-sqlite3') as
  new (filename: string) => {
    exec(sql: string): void;
    prepare(sql: string): {
      get(...values: unknown[]): unknown;
      all(...values: unknown[]): unknown[];
      run(...values: unknown[]): { changes: number };
    };
    close(): void;
  };

function createDb() {
  const sqlite = new Sqlite(':memory:');
  sqlite.exec(`CREATE TABLE pharmacy_rich_menu_layouts (
    line_account_id TEXT PRIMARY KEY,
    preferred_order_json TEXT NOT NULL,
    revision INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE rich_menu_groups (
    id TEXT PRIMARY KEY, account_id TEXT NOT NULL, name TEXT NOT NULL,
    status TEXT NOT NULL, default_page_id TEXT, is_default_for_all INTEGER NOT NULL,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE rich_menu_pages (
    id TEXT PRIMARY KEY, group_id TEXT NOT NULL, alias_id TEXT, line_richmenu_id TEXT,
    image_r2_key TEXT, image_content_type TEXT
  );
  CREATE TABLE pharmacy_rich_menu_draft_bindings (
    group_id TEXT PRIMARY KEY, line_account_id TEXT NOT NULL,
    layout_revision INTEGER NOT NULL, capability_revision INTEGER NOT NULL,
    liff_id_hash TEXT NOT NULL, catalog_version TEXT NOT NULL,
    menu_size TEXT NOT NULL,
    catalog_variant_key TEXT NOT NULL, catalog_object_key TEXT NOT NULL,
    manifest_hash TEXT NOT NULL, image_hash TEXT NOT NULL, created_at TEXT NOT NULL
  );
  CREATE TABLE pharmacy_rich_menu_operations (
    id TEXT PRIMARY KEY, group_id TEXT NOT NULL, line_account_id TEXT NOT NULL,
    confirmation_id TEXT NOT NULL UNIQUE,
    kind TEXT NOT NULL, status TEXT NOT NULL, evidence_digest TEXT NOT NULL,
    publish_phase TEXT, publish_alias_id TEXT, publish_menu_name TEXT,
    expected_default_menu_id TEXT, default_read_at TEXT, remote_rich_menu_id TEXT,
    verified_default_menu_id TEXT, reason_code TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, verified_at TEXT
  );
  CREATE UNIQUE INDEX idx_pharmacy_rich_menu_one_unresolved
    ON pharmacy_rich_menu_operations(line_account_id)
    WHERE status IN ('running', 'unknown');
  CREATE TABLE pharmacy_rich_menu_operation_confirmations (
    confirmation_id TEXT PRIMARY KEY, operation_id TEXT NOT NULL, line_account_id TEXT NOT NULL,
    publish_phase TEXT NOT NULL, evidence_digest TEXT NOT NULL, created_at TEXT NOT NULL
  );
  CREATE TABLE pharmacy_rich_menu_lifecycle_controls (
    line_account_id TEXT PRIMARY KEY, state TEXT NOT NULL, revision INTEGER NOT NULL,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  )`);
  const statement = (sql: string, values: unknown[] = []) => ({
    bind: (...next: unknown[]) => statement(sql, next),
    first: async <T>() => (sqlite.prepare(sql).get(...values) as T | undefined) ?? null,
    all: async <T>() => ({ results: sqlite.prepare(sql).all(...values) as T[] }),
    run: async () => ({ meta: { changes: sqlite.prepare(sql).run(...values).changes } }),
  });
  return {
    db: { prepare: (sql: string) => statement(sql) } as unknown as D1Database,
    close: () => sqlite.close(),
  };
}

describe('pharmacy rich-menu layout repository', () => {
  let fake: ReturnType<typeof createDb>;

  beforeEach(() => { fake = createDb(); });
  afterEach(() => fake.close());

  it('keeps lifecycle mutation dormant by default and changes it with compare-and-swap', async () => {
    expect(await getPharmacyRichMenuLifecycleControl(fake.db, 'account-a')).toEqual({
      lineAccountId: 'account-a', state: 'inactive', revision: 0, updatedAt: null,
    });

    const active = await savePharmacyRichMenuLifecycleControl(
      fake.db, 'account-a', 'active', 0,
    );
    expect(active).toMatchObject({ state: 'active', revision: 1 });
    await expect(savePharmacyRichMenuLifecycleControl(fake.db, 'account-a', 'frozen', 0))
      .rejects.toThrow(/stale/i);
    await expect(savePharmacyRichMenuLifecycleControl(fake.db, 'account-a', 'frozen', 1))
      .resolves.toMatchObject({ state: 'frozen', revision: 2 });
    expect(await getPharmacyRichMenuLifecycleControl(fake.db, 'account-b'))
      .toMatchObject({ state: 'inactive', revision: 0 });
  });

  it('creates and updates one account layout with compare-and-swap revisions', async () => {
    expect(await getPharmacyRichMenuLayout(fake.db, 'account-a')).toMatchObject({
      lineAccountId: 'account-a', revision: 0,
    });

    const first = await savePharmacyRichMenuLayout(fake.db, 'account-a', [
      'pharmacy-info', 'manual-chat', 'medication-followup', 'prescription-history', 'prescription-send',
    ], 0);
    expect(first).toMatchObject({
      lineAccountId: 'account-a', revision: 1,
      preferredOrder: [
        'pharmacy-info', 'manual-chat', 'medication-followup', 'prescription-history', 'prescription-send',
      ],
    });

    await expect(savePharmacyRichMenuLayout(fake.db, 'account-a', first.preferredOrder, 0))
      .rejects.toThrow(/stale/i);
    await expect(savePharmacyRichMenuLayout(
      fake.db, 'account-a', [...first.preferredOrder].reverse(), first.revision,
    )).resolves.toMatchObject({ revision: 2 });
  });

  it('rejects invalid orders before writing and never touches another account', async () => {
    await savePharmacyRichMenuLayout(fake.db, 'account-b', [
      'prescription-send', 'prescription-history', 'medication-followup', 'manual-chat', 'pharmacy-info',
    ], 0);

    await expect(savePharmacyRichMenuLayout(fake.db, 'account-a', [
      'prescription-send', 'prescription-send', 'medication-followup', 'manual-chat', 'pharmacy-info',
    ], 0)).rejects.toThrow(/duplicate/i);
    expect((await getPharmacyRichMenuLayout(fake.db, 'account-b')).revision).toBe(1);
    expect((await getPharmacyRichMenuLayout(fake.db, 'account-a')).revision).toBe(0);
  });

  it('stores immutable version evidence and lists it only in the owning account', async () => {
    const now = '2026-08-21T00:00:00Z';
    const statement = (fake.db as unknown as { prepare(sql: string): D1PreparedStatement }).prepare;
    await statement(`INSERT INTO rich_menu_groups
      (id, account_id, name, status, default_page_id, is_default_for_all, created_at, updated_at)
      VALUES (?, ?, ?, 'draft', ?, 0, ?, ?)`).bind(
      'group-a', 'account-a', '夜間向けメニュー', 'page-a', now, now,
    ).run();
    await statement(`INSERT INTO rich_menu_pages
      (id, group_id, line_richmenu_id, image_r2_key, image_content_type)
      VALUES (?, ?, NULL, ?, 'image/jpeg')`).bind(
      'page-a', 'group-a', 'rich-menus/account-a/group-a/page-a/version.jpg',
    ).run();
    const hash = 'a'.repeat(64);

    await createPharmacyRichMenuDraftBinding(fake.db, {
      groupId: 'group-a', lineAccountId: 'account-a', layoutRevision: 2,
      capabilityRevision: 7, liffIdHash: hash, catalogVersion: 'v4-2', menuSize: 'compact',
      catalogVariantKey: 'v4-compact-manual-chat.pharmacy-info',
      catalogObjectKey: 'rich-menu-catalog/v4-2/v4-compact-manual-chat.pharmacy-info.jpg',
      manifestHash: hash, imageHash: hash,
    });

    await expect(listPharmacyRichMenuVersions(fake.db, 'account-a')).resolves.toEqual([
      expect.objectContaining({
        groupId: 'group-a', lineAccountId: 'account-a', name: '夜間向けメニュー',
        menuSize: 'compact', catalogVariantKey: 'v4-compact-manual-chat.pharmacy-info',
        imageR2Key: 'rich-menus/account-a/group-a/page-a/version.jpg',
        knownGood: false, unverified: false,
        unresolvedOperationId: null, unresolvedOperationKind: null,
      }),
    ]);
    await expect(listPharmacyRichMenuVersions(fake.db, 'account-b')).resolves.toEqual([]);
    await expect(getPharmacyRichMenuDraftBinding(fake.db, 'account-a', 'group-a')).resolves.toMatchObject({
      groupId: 'group-a', lineAccountId: 'account-a', liffIdHash: hash,
      menuSize: 'compact',
      catalogObjectKey: 'rich-menu-catalog/v4-2/v4-compact-manual-chat.pharmacy-info.jpg',
    });
    await expect(getPharmacyRichMenuDraftBinding(fake.db, 'account-b', 'group-a')).resolves.toBeNull();

    const renamed = await renamePharmacyRichMenuVersion(
      fake.db, 'account-a', 'group-a', '営業時間変更版', now,
    );
    expect(renamed).toMatchObject({ groupId: 'group-a', name: '営業時間変更版' });
    await expect(renamePharmacyRichMenuVersion(
      fake.db, 'account-a', 'group-a', '古い画面からの変更', now,
    )).rejects.toThrow(/stale/i);
    await expect(renamePharmacyRichMenuVersion(
      fake.db, 'account-b', 'group-a', '別accountからの変更', renamed.updatedAt,
    )).rejects.toThrow(/stale/i);
    await expect(listPharmacyRichMenuVersions(fake.db, 'account-a')).resolves.toEqual([
      expect.objectContaining({ groupId: 'group-a', name: '営業時間変更版' }),
    ]);

    await statement(`UPDATE rich_menu_pages SET line_richmenu_id = 'richmenu-1' WHERE id = 'page-a'`).run();
    await statement(`INSERT INTO pharmacy_rich_menu_operations
      (id, group_id, line_account_id, confirmation_id, kind, status, evidence_digest, remote_rich_menu_id,
       verified_default_menu_id, created_at, updated_at, verified_at)
      VALUES ('known-good', 'group-a', 'account-a', 'confirmation-known-good', 'set_default', 'succeeded', ?,
              'richmenu-1', 'richmenu-1', ?, ?, ?),
             ('unknown', 'group-a', 'account-a', 'confirmation-unknown', 'publish', 'unknown', ?, NULL, NULL, ?, ?, NULL)`)
      .bind(hash, now, now, now, hash, now, now).run();
    await expect(listPharmacyRichMenuVersions(fake.db, 'account-a')).resolves.toEqual([
      expect.objectContaining({
        groupId: 'group-a', knownGood: true, unverified: true,
        unresolvedOperationId: 'unknown', unresolvedOperationKind: 'publish',
      }),
    ]);
    await expect(deletePharmacyRichMenuVersion(
      fake.db, 'account-a', 'group-a', renamed.updatedAt,
    )).rejects.toThrow(/protected/i);

    await statement(`INSERT INTO rich_menu_groups
      (id, account_id, name, status, default_page_id, is_default_for_all, created_at, updated_at)
      VALUES ('safe-draft', 'account-a', 'Safe', 'draft', 'safe-page', 0, ?, ?)`).bind(now, now).run();
    await statement(`INSERT INTO rich_menu_pages
      (id, group_id, line_richmenu_id, image_r2_key, image_content_type)
      VALUES ('safe-page', 'safe-draft', NULL, 'rich-menus/account-a/safe.jpg', 'image/jpeg')`).run();
    await statement(`INSERT INTO pharmacy_rich_menu_draft_bindings
      (group_id, line_account_id, layout_revision, capability_revision, liff_id_hash,
       catalog_version, menu_size, catalog_variant_key, catalog_object_key,
       manifest_hash, image_hash, created_at)
      VALUES ('safe-draft', 'account-a', 1, 1, ?, 'v4-2', 'large', 'safe',
              'rich-menu-catalog/v4-2/safe.jpg', ?, ?, ?)`).bind(hash, hash, hash, now).run();
    await expect(deletePharmacyRichMenuVersion(
      fake.db, 'account-a', 'safe-draft', now,
    )).resolves.toEqual({ imageR2Key: 'rich-menus/account-a/safe.jpg' });
    expect(await statement(`SELECT id FROM rich_menu_groups WHERE id = 'safe-draft'`).first())
      .toBeNull();
  });

  it('returns only fresh account-scoped current-default read-back evidence', async () => {
    const statement = (fake.db as unknown as { prepare(sql: string): D1PreparedStatement }).prepare;
    const hash = 'a'.repeat(64);
    await statement(`INSERT INTO rich_menu_groups
      (id, account_id, name, status, default_page_id, is_default_for_all, created_at, updated_at)
      VALUES ('current-a', 'account-a', 'Current', 'published', 'page-a', 1, ?, ?)`)
      .bind('2026-08-21T00:00:00Z', '2026-08-21T00:00:00Z').run();
    await statement(`INSERT INTO rich_menu_pages
      (id, group_id, line_richmenu_id, image_r2_key, image_content_type)
      VALUES ('page-a', 'current-a', 'richmenu-a', 'rich-menus/account-a/current-a/menu.jpg', 'image/jpeg')`)
      .run();
    await statement(`INSERT INTO pharmacy_rich_menu_draft_bindings
      (group_id, line_account_id, layout_revision, capability_revision, liff_id_hash,
       catalog_version, menu_size, catalog_variant_key, catalog_object_key,
       manifest_hash, image_hash, created_at)
      VALUES ('current-a', 'account-a', 2, 3, ?, 'v4-2', 'compact', 'variant',
              'rich-menu-catalog/v4-2/variant.jpg', ?, ?, ?)`)
      .bind(hash, hash, hash, '2026-08-21T00:00:00Z').run();
    await statement(`INSERT INTO pharmacy_rich_menu_operations
      (id, group_id, line_account_id, confirmation_id, kind, status, evidence_digest,
       remote_rich_menu_id, verified_default_menu_id, created_at, updated_at, verified_at)
      VALUES ('verified-a', 'current-a', 'account-a', 'confirm-a', 'set_default', 'succeeded', ?,
              'richmenu-a', 'richmenu-a', ?, ?, ?)`)
      .bind(hash, '2026-08-21T10:00:00Z', '2026-08-21T10:00:00Z', '2026-08-21T10:00:00Z').run();

    await expect(getPharmacyRichMenuCurrentDefaultEvidence(
      fake.db, 'account-a', '2026-08-21T00:00:00Z',
    )).resolves.toEqual({ groupId: 'current-a', verifiedAt: '2026-08-21T10:00:00Z' });
    await expect(getPharmacyRichMenuCurrentDefaultEvidence(
      fake.db, 'account-a', '2026-08-22T00:00:00Z',
    )).resolves.toBeNull();
    await expect(getPharmacyRichMenuCurrentDefaultEvidence(
      fake.db, 'account-b', '2026-08-21T00:00:00Z',
    )).resolves.toBeNull();
  });

  it('records an account-scoped operation before remote work and reconciles unknown without retry', async () => {
    const now = '2026-08-21T00:00:00Z';
    const statement = (fake.db as unknown as { prepare(sql: string): D1PreparedStatement }).prepare;
    await statement(`INSERT INTO rich_menu_groups
      (id, account_id, name, status, default_page_id, is_default_for_all, created_at, updated_at)
      VALUES ('group-a', 'account-a', 'Menu', 'draft', NULL, 0, ?, ?)`).bind(now, now).run();
    await statement(`INSERT INTO pharmacy_rich_menu_draft_bindings
      (group_id, line_account_id, layout_revision, capability_revision, liff_id_hash,
       catalog_version, menu_size, catalog_variant_key, catalog_object_key,
       manifest_hash, image_hash, created_at)
      VALUES ('group-a', 'account-a', 1, 1, ?, 'v4-2', 'large', 'variant',
              'rich-menu-catalog/v4-2/variant.jpg', ?, ?, ?)`).bind(
      'a'.repeat(64), 'a'.repeat(64), 'a'.repeat(64), now,
    ).run();

    const operation = await beginPharmacyRichMenuOperation(fake.db, {
      lineAccountId: 'account-a', groupId: 'group-a', kind: 'publish',
      evidenceDigest: 'b'.repeat(64), expectedDefaultMenuId: null,
      confirmationId: 'confirmation-1',
      publishAliasId: 'lhx-group-a-confirm-0', publishMenuName: 'pharmacy-group-a-confirm',
    });
    expect(operation).toMatchObject({
      lineAccountId: 'account-a', groupId: 'group-a', kind: 'publish', status: 'running',
      publishPhase: 'intent_recorded', publishAliasId: 'lhx-group-a-confirm-0',
    });
    await expect(beginPharmacyRichMenuOperation(fake.db, {
      lineAccountId: 'account-a', groupId: 'group-a', kind: 'publish',
      evidenceDigest: 'b'.repeat(64), expectedDefaultMenuId: null,
      confirmationId: 'confirmation-2',
      publishAliasId: 'lhx-group-a-confirm-2-0', publishMenuName: 'pharmacy-group-a-confirm-2',
    })).rejects.toThrow(/unique/i);
    await expect(beginPharmacyRichMenuOperation(fake.db, {
      lineAccountId: 'account-b', groupId: 'group-a', kind: 'publish',
      evidenceDigest: 'b'.repeat(64), expectedDefaultMenuId: null,
      confirmationId: 'confirmation-3',
      publishAliasId: 'lhx-group-a-confirm-3-0', publishMenuName: 'pharmacy-group-a-confirm-3',
    })).rejects.toThrow(/account/i);

    await advancePharmacyRichMenuPublishPhase(fake.db, {
      lineAccountId: 'account-a', operationId: operation.id,
      expectedPhase: 'intent_recorded', phase: 'remote_created', remoteRichMenuId: 'richmenu-1',
    });
    await finishPharmacyRichMenuOperation(fake.db, {
      lineAccountId: 'account-a', operationId: operation.id,
      expectedStatus: 'running', status: 'unknown', reasonCode: 'LINE_RESULT_UNKNOWN',
    });
    await expect(getUnresolvedPharmacyRichMenuOperation(fake.db, 'account-a')).resolves
      .toMatchObject({
        id: operation.id, status: 'unknown', remoteRichMenuId: 'richmenu-1',
        publishPhase: 'remote_created',
      });
    await expect(consumePharmacyRichMenuResumeConfirmation(fake.db, {
      lineAccountId: 'account-a', operationId: operation.id,
      confirmationId: 'resume-confirmation-1', publishPhase: 'remote_created',
      evidenceDigest: 'b'.repeat(64),
    })).resolves.toBeUndefined();
    await expect(consumePharmacyRichMenuResumeConfirmation(fake.db, {
      lineAccountId: 'account-a', operationId: operation.id,
      confirmationId: 'resume-confirmation-1', publishPhase: 'remote_created',
      evidenceDigest: 'b'.repeat(64),
    })).rejects.toThrow(/used/i);
    await advancePharmacyRichMenuPublishPhase(fake.db, {
      lineAccountId: 'account-a', operationId: operation.id,
      expectedPhase: 'remote_created', phase: 'image_uploaded',
    });
    await advancePharmacyRichMenuPublishPhase(fake.db, {
      lineAccountId: 'account-a', operationId: operation.id,
      expectedPhase: 'image_uploaded', phase: 'alias_created',
    });
    await statement(`INSERT INTO rich_menu_pages
      (id, group_id, alias_id, line_richmenu_id, image_r2_key, image_content_type)
      VALUES ('operation-page', 'group-a', 'lhx-group-a-confirm-0', 'richmenu-1',
              'menu.jpg', 'image/jpeg')`).run();
    await advancePharmacyRichMenuPublishPhase(fake.db, {
      lineAccountId: 'account-a', operationId: operation.id,
      expectedPhase: 'alias_created', phase: 'committed',
    });
    await finishPharmacyRichMenuOperation(fake.db, {
      lineAccountId: 'account-a', operationId: operation.id,
      expectedStatus: 'unknown', status: 'succeeded',
    });
    await expect(getUnresolvedPharmacyRichMenuOperation(fake.db, 'account-a')).resolves.toBeNull();
    await expect(getPharmacyRichMenuOperation(
      fake.db, 'account-a', operation.id,
    )).resolves.toMatchObject({ id: operation.id, confirmationId: 'confirmation-1' });
    await expect(getPharmacyRichMenuOperation(
      fake.db, 'account-b', operation.id,
    )).resolves.toBeNull();
    await expect(beginPharmacyRichMenuOperation(fake.db, {
      lineAccountId: 'account-a', groupId: 'group-a', kind: 'publish',
      evidenceDigest: 'b'.repeat(64), expectedDefaultMenuId: null,
      confirmationId: 'confirmation-1',
      publishAliasId: 'lhx-group-a-confirm-0', publishMenuName: 'pharmacy-group-a-confirm',
    })).rejects.toThrow(/confirmation.*used/i);
    await expect(finishPharmacyRichMenuOperation(fake.db, {
      lineAccountId: 'account-a', operationId: operation.id,
      expectedStatus: 'unknown', status: 'failed', reasonCode: 'NOT_FOUND',
    })).rejects.toThrow(/stale/i);

    const switchOperation = await beginPharmacyRichMenuOperation(fake.db, {
      lineAccountId: 'account-a', groupId: 'group-a', kind: 'set_default',
      evidenceDigest: 'c'.repeat(64), expectedDefaultMenuId: null,
      confirmationId: 'confirmation-4',
    });
    await recordPharmacyRichMenuRemoteId(fake.db, 'account-a', switchOperation.id, 'richmenu-2');
    await recordPharmacyRichMenuExpectedDefault(
      fake.db, 'account-a', switchOperation.id, 'richmenu-1',
    );
    await finishPharmacyRichMenuOperation(fake.db, {
      lineAccountId: 'account-a', operationId: switchOperation.id,
      expectedStatus: 'running', status: 'succeeded', verifiedDefaultMenuId: 'richmenu-2',
    });
    await expect(isPharmacyRichMenuKnownGood(
      fake.db, 'account-a', 'group-a', 'richmenu-2',
    )).resolves.toBe(true);
    await expect(isPharmacyRichMenuKnownGood(
      fake.db, 'account-b', 'group-a', 'richmenu-2',
    )).resolves.toBe(false);
  });
});
