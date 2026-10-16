import Database from 'better-sqlite3';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { splitSqlStatements } from '../scripts/split-sql-statements.mjs';

const root = join(import.meta.dirname, '..');
it('upgrades existing templates additively and keeps old-column approval compatible', () => {
  const db = new Database(':memory:');
  try {
    db.pragma('foreign_keys = ON');
    for (const file of readdirSync(join(root, 'migrations'))
      .filter((file) => file.endsWith('.sql') && file < '032_')
      .sort()) {
      for (const statement of splitSqlStatements(readFileSync(join(root, 'migrations', file), 'utf8'))) {
        try {
          db.exec(statement);
        } catch (error) {
          if (!/duplicate column name|already exists/i.test(String(error))) throw error;
        }
      }
    }
    db.exec(`
      INSERT INTO tenants (id,tenant_code,display_name) VALUES ('t','synthetic','Synthetic');
      INSERT INTO line_accounts (id,channel_id,name,channel_access_token,channel_secret) VALUES ('a','c','Synthetic','synthetic','synthetic');
      INSERT INTO tenant_line_accounts (tenant_id,line_account_id) VALUES ('t','a');
      INSERT INTO staff_members (id,name,role,api_key,principal_kind) VALUES ('author','Synthetic author','staff','disabled:author','human'),('editor','Synthetic editor','admin','disabled:editor','human');
      INSERT INTO tenant_staff_memberships (tenant_id,staff_id,role) VALUES ('t','author','staff'),('t','editor','admin');
      INSERT INTO pharmacy_staff_accounts (line_account_id,staff_id,created_at,updated_at) VALUES ('a','author','2026-10-16T00:00:00Z','2026-10-16T00:00:00Z'),('a','editor','2026-10-16T00:00:00Z','2026-10-16T00:00:00Z');
      INSERT INTO pharmacy_chat_templates (line_account_id,template_id,title,body,status,version,created_by_staff_id,created_at,updated_at) VALUES ('a','synthetic-template','Synthetic','Synthetic','draft',1,'author','2026-10-16T00:00:00Z','2026-10-16T00:00:00Z');
    `);
    db.exec(readFileSync(join(root, 'migrations/032_custom_084_pharmacy_chat_template_editor.sql'), 'utf8'));
    expect(db.prepare('SELECT last_edited_by_staff_id FROM pharmacy_chat_templates').get()).toEqual({
      last_edited_by_staff_id: null,
    });
    // Previous Worker approval statement still succeeds for an untouched legacy row.
    db.exec(
      "UPDATE pharmacy_chat_templates SET status='approved',approved_by_staff_id='editor',approved_at='2026-10-16T00:01:00Z'",
    );
    db.exec(
      "UPDATE pharmacy_chat_templates SET status='draft',approved_by_staff_id=NULL,approved_at=NULL,last_edited_by_staff_id='editor'",
    );
    expect(() =>
      db.exec(
        "UPDATE pharmacy_chat_templates SET status='approved',approved_by_staff_id='editor',approved_at='2026-10-16T00:02:00Z'",
      ),
    ).toThrow(/EDITOR_APPROVAL/);
    expect(() => db.exec("UPDATE pharmacy_chat_templates SET last_edited_by_staff_id='unassigned'")).toThrow(
      /STAFF_SCOPE/,
    );
  } finally {
    db.close();
  }
});
