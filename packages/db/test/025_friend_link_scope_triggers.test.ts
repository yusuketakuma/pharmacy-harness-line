import { describe, expect, it, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

let sqlite: Database.Database;

function addAccount(id: string): void {
  sqlite
    .prepare(`INSERT INTO line_accounts (id, channel_id, name, channel_access_token, channel_secret)
      VALUES (?, ?, ?, 'token', 'secret')`)
    .run(id, `ch-${id}`, id);
}

function addFriend(id: string, accountId: string | null): void {
  sqlite
    .prepare(`INSERT INTO friends (id, line_user_id, provider_line_user_id, line_account_id)
      VALUES (?, ?, ?, ?)`)
    .run(id, `lu-${id}`, `pu-${id}`, accountId);
}

function addTenant(id: string): void {
  sqlite
    .prepare(`INSERT INTO tenants (id, tenant_code, display_name) VALUES (?, ?, ?)`)
    .run(id, `code-${id}`, id);
}

function mapAccount(accountId: string, tenantId: string): void {
  sqlite
    .prepare(`INSERT INTO tenant_line_accounts (tenant_id, line_account_id) VALUES (?, ?)`)
    .run(tenantId, accountId);
}

function addTag(id: string, tenantId: string | null): void {
  sqlite
    .prepare(`INSERT INTO tags (id, name, tenant_id) VALUES (?, ?, ?)`)
    .run(id, `tag-${id}`, tenantId);
}

function addScenario(id: string, accountId: string | null, tenantId: string | null): void {
  sqlite
    .prepare(`INSERT INTO scenarios (id, name, trigger_type, line_account_id, tenant_id)
      VALUES (?, ?, 'manual', ?, ?)`)
    .run(id, `scn-${id}`, accountId, tenantId);
}

beforeEach(() => {
  sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  sqlite.exec(readFileSync(join(ROOT, 'bootstrap.sql'), 'utf8'));
  addTenant('tenant-a');
  addTenant('tenant-b');
  addAccount('account-a');
  addAccount('account-b');
  mapAccount('account-a', 'tenant-a');
  mapAccount('account-b', 'tenant-b');
});

describe('friend_tags tenant scope trigger', () => {
  it('rejects attaching another tenant\'s tag to a mapped friend', () => {
    addFriend('friend-a', 'account-a');
    addTag('tag-b', 'tenant-b');
    expect(() =>
      sqlite.prepare(`INSERT INTO friend_tags (friend_id, tag_id) VALUES ('friend-a', 'tag-b')`).run(),
    ).toThrow(/FRIEND_TAG_TENANT_SCOPE_MISMATCH/);
  });

  it('allows same-tenant and legacy-unscoped combinations', () => {
    addFriend('friend-a', 'account-a');
    addFriend('friend-legacy', null);
    addTag('tag-a', 'tenant-a');
    addTag('tag-global', null);
    const insert = sqlite.prepare(
      `INSERT INTO friend_tags (friend_id, tag_id) VALUES (?, ?)`,
    );
    expect(() => insert.run('friend-a', 'tag-a')).not.toThrow();
    expect(() => insert.run('friend-a', 'tag-global')).not.toThrow();
    expect(() => insert.run('friend-legacy', 'tag-a')).not.toThrow();
  });
});

describe('friend_scenarios scope trigger', () => {
  it('rejects enrolling a friend into another account\'s scenario', () => {
    addFriend('friend-a', 'account-a');
    addScenario('scn-b', 'account-b', null);
    expect(() =>
      sqlite.prepare(
        `INSERT INTO friend_scenarios (id, friend_id, scenario_id) VALUES ('fs-1', 'friend-a', 'scn-b')`,
      ).run(),
    ).toThrow(/FRIEND_SCENARIO_SCOPE_MISMATCH/);
  });

  it('rejects enrolling a mapped friend into another tenant\'s account-less scenario', () => {
    addFriend('friend-a', 'account-a');
    addScenario('scn-tb', null, 'tenant-b');
    expect(() =>
      sqlite.prepare(
        `INSERT INTO friend_scenarios (id, friend_id, scenario_id) VALUES ('fs-2', 'friend-a', 'scn-tb')`,
      ).run(),
    ).toThrow(/FRIEND_SCENARIO_SCOPE_MISMATCH/);
  });

  it('allows same-account, same-tenant, and legacy combinations', () => {
    addFriend('friend-a', 'account-a');
    addFriend('friend-legacy', null);
    addScenario('scn-a', 'account-a', null);
    addScenario('scn-ta', null, 'tenant-a');
    addScenario('scn-global', null, null);
    const insert = sqlite.prepare(
      `INSERT INTO friend_scenarios (id, friend_id, scenario_id) VALUES (?, ?, ?)`,
    );
    expect(() => insert.run('fs-a', 'friend-a', 'scn-a')).not.toThrow();
    expect(() => insert.run('fs-b', 'friend-a', 'scn-ta')).not.toThrow();
    expect(() => insert.run('fs-c', 'friend-a', 'scn-global')).not.toThrow();
    expect(() => insert.run('fs-d', 'friend-legacy', 'scn-a')).not.toThrow();
  });
});
