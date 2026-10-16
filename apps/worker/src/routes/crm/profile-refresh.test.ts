import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../../index.js';
import {
  d1FromSqlite,
  DB_PACKAGE_ROOT,
  openTestSqlite,
  type TestSqliteDatabase,
} from '../../custom/pharmacy/test-sqlite.js';
import { profileRefresh } from './profile-refresh.js';
import { scoring } from './scoring.js';

const databases: TestSqliteDatabase[] = [];
afterEach(() => {
  databases.splice(0).forEach((db) => db.close());
  vi.unstubAllGlobals();
});
function setup(role: 'owner' | 'staff' | null = 'owner', tenant = 'tenant-a') {
  const sqlite = openTestSqlite();
  databases.push(sqlite);
  sqlite.exec(readFileSync(join(DB_PACKAGE_ROOT, 'bootstrap.sql'), 'utf8'));
  for (const suffix of ['a', 'b']) {
    sqlite.exec(`
      INSERT INTO tenants (id, tenant_code, display_name) VALUES ('tenant-${suffix}', '${suffix}', 'Synthetic ${suffix}');
      INSERT INTO line_accounts (id, channel_id, name, channel_access_token, channel_secret) VALUES ('account-${suffix}', 'channel-${suffix}', 'Synthetic ${suffix}', 'synthetic', 'synthetic');
      INSERT INTO tenant_line_accounts (tenant_id, line_account_id) VALUES ('tenant-${suffix}', 'account-${suffix}');
      INSERT INTO friends (id, line_user_id, provider_line_user_id, display_name, line_account_id) VALUES ('friend-${suffix}', 'synthetic-${suffix}', 'synthetic-${suffix}', 'Synthetic ${suffix}', 'account-${suffix}');
      INSERT INTO tags (id, name, tenant_id) VALUES ('tag-${suffix}', 'tag-${suffix}', 'tenant-${suffix}');
      INSERT INTO friend_tags (friend_id, tag_id) VALUES ('friend-${suffix}', 'tag-${suffix}');
      INSERT INTO broadcasts (id,title,message_type,message_content,line_account_id,status) VALUES ('broadcast-${suffix}','synthetic','text','synthetic','account-${suffix}','sent');
      INSERT INTO messages_log (id,friend_id,direction,message_type,content,line_account_id) VALUES ('message-${suffix}','friend-${suffix}','outgoing','text','synthetic','account-${suffix}');
    `);
  }
  const app = new Hono<Env>();
  app.use('*', async (c, next) => {
    if (tenant) c.set('tenantId', tenant);
    if (role) c.set('staff', { id: 'synthetic-owner', name: 'Synthetic', role });
    return next();
  });
  app.route('/', profileRefresh);
  app.route('/', scoring);
  return { sqlite, app, env: { DB: d1FromSqlite(sqlite) } as Env['Bindings'] };
}
const cases = [
  ['GET', '/api/admin/recent-messages', null],
  ['GET', '/api/admin/friend-debug/friend-b', null],
  ['GET', '/api/admin/automations-summary', null],
  ['GET', '/api/admin/auto-reply-stats', null],
  ['POST', '/api/admin/refresh-profiles', {}],
  ['POST', '/api/admin/broadcasts/broadcast-b/reset-to-draft', {}],
  ['POST', '/api/admin/tag-leak-check', { tagsA: ['tag-b'], tagsB: ['tag-b'] }],
  ['POST', '/api/admin/content-leak-check', { tagName: 'tag-b', contentSubstring: 'synthetic' }],
  ['POST', '/api/admin/broadcast-coverage', { tagName: 'tag-b', contentSubstring: 'synthetic' }],
  ['POST', '/api/admin/tag-remove-content-dups', { tagName: 'tag-b', contentSubstring: 'synthetic' }],
] as const;
function request(app: Hono<Env>, env: Env['Bindings'], method: string, path: string, body: unknown) {
  return app.request(
    path,
    { method, ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) },
    env,
  );
}
describe('operations and score routes enforce their own tenant boundary', () => {
  it.each(cases)('requires a tenant owner: %s %s', async (method, path, body) => {
    for (const [role, tenant, status] of [
      [null, '', 401],
      ['owner', '', 401],
      ['staff', 'tenant-a', 403],
    ] as const) {
      const state = setup(role, tenant);
      expect((await request(state.app, state.env, method, path, body)).status).toBe(status);
    }
  });
  it.each(cases)('keeps operations inside the owner tenant: %s %s', async (method, path, body) => {
    const { app, env, sqlite } = setup();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ displayName: 'Synthetic refreshed' }), { status: 200 })),
    );
    const response = await request(app, env, method, path, body);
    expect(response.status).toBe(path.includes('reset-to-draft') ? 404 : 200);
    expect(JSON.stringify(await response.json())).not.toContain('friend-b');
    expect(sqlite.prepare("SELECT status FROM broadcasts WHERE id='broadcast-b'").get()).toEqual({ status: 'sent' });
    expect(sqlite.prepare("SELECT display_name FROM friends WHERE id='friend-b'").get()).toEqual({
      display_name: 'Synthetic b',
    });
    expect(sqlite.prepare("SELECT COUNT(*) n FROM friend_tags WHERE friend_id='friend-b'").get()).toEqual({ n: 1 });
  });
  it('keeps the reset safety guard for historical logs without an account', async () => {
    const { sqlite, app, env } = setup();
    sqlite.exec("UPDATE messages_log SET broadcast_id='broadcast-a', line_account_id=NULL WHERE id='message-a'");
    expect((await request(app, env, 'POST', '/api/admin/broadcasts/broadcast-a/reset-to-draft', {})).status).toBe(409);
    expect(sqlite.prepare("SELECT status FROM broadcasts WHERE id='broadcast-a'").get()).toEqual({ status: 'sent' });
  });
  it('rejects unscoped and foreign friend score reads and writes', async () => {
    for (const tenant of ['', 'tenant-a']) {
      const { app, env } = setup('owner', tenant);
      for (const method of ['GET', 'POST']) {
        expect(
          (
            await request(
              app,
              env,
              method,
              '/api/friends/friend-b/score',
              method === 'POST' ? { scoreChange: 2 } : null,
            )
          ).status,
        ).toBe(tenant ? 403 : 401);
      }
    }
  });
});
