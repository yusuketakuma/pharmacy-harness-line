import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';

import type { Env } from '../../index.js';
import { verifyTenantPassword } from '../../custom/pharmacy/provisioning/credentials.js';
import { staff } from './staff.js';

const owned = {
  id: 'staff-a',
  name: 'Owned Staff',
  email: null,
  role: 'owner',
  api_key: 'lh_owned',
  login_id: 'owner-a',
  is_active: 1,
  created_at: '2026-08-18T00:00:00Z',
  updated_at: '2026-08-18T00:00:00Z',
};
const foreign = { ...owned, id: 'staff-b', name: 'Foreign Staff', api_key: 'lh_foreign' };

function mount(db: D1Database) {
  const app = new Hono<Env>();
  app.use('*', async (c, next) => {
    c.set('staff', { id: 'staff-a', name: 'Owned Staff', role: 'owner' });
    c.set('tenantId', 'tenant-a');
    await next();
  });
  app.route('/', staff);
  return { app, env: { DB: db } as Env['Bindings'] };
}

describe('staff tenant scope', () => {
  it('lists only tenant-mapped account assignments for one tenant staff member', async () => {
    const db = {
      prepare(sql: string) {
        const statement = {
          bind() { return statement; },
          async first() { return owned; },
          async all() {
            return { results: [
              { id: 'account-a', name: 'A', assigned: 1, target_active: 1, active_staff_count: 2 },
              { id: 'account-b', name: 'B', assigned: 0, target_active: 0, active_staff_count: 1 },
            ] };
          },
        };
        return statement;
      },
    } as unknown as D1Database;
    const { app, env } = mount(db);

    const response = await app.request('/api/staff/staff-a/accounts', {}, env);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ data: [
      { id: 'account-a', name: 'A', assigned: true },
      { id: 'account-b', name: 'B', assigned: false },
    ] });
  });

  it('rejects foreign account assignment and removing an account last active staff', async () => {
    const rows = [
      { id: 'account-a', name: 'A', assigned: 1, target_active: 1, active_staff_count: 1 },
    ];
    const db = {
      prepare() {
        const statement = {
          bind() { return statement; },
          async first() { return owned; },
          async all() { return { results: rows }; },
        };
        return statement;
      },
      async batch() { throw new Error('must not write'); },
    } as unknown as D1Database;
    const { app, env } = mount(db);

    const foreignAccount = await app.request('/api/staff/staff-a/accounts', {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accountIds: ['account-b'] }),
    }, env);
    const lastStaff = await app.request('/api/staff/staff-a/accounts', {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accountIds: [] }),
    }, env);

    expect(foreignAccount.status).toBe(400);
    expect(lastStaff.status).toBe(409);
  });

  it('updates assignments only inside the authenticated tenant mapping', async () => {
    const writes: Array<{ sql: string; params: unknown[] }> = [];
    const db = {
      prepare(sql: string) {
        const statement = {
          params: [] as unknown[],
          bind(...params: unknown[]) { statement.params = params; return statement; },
          async first() { return owned; },
          async all() { return { results: [
            { id: 'account-a', name: 'A', assigned: 1, target_active: 1, active_staff_count: 2 },
            { id: 'account-b', name: 'B', assigned: 0, target_active: 0, active_staff_count: 1 },
          ] }; },
          async run() { writes.push({ sql, params: statement.params }); return { meta: { changes: 1 } }; },
        };
        return statement;
      },
      async batch(statements: Array<{ run(): Promise<unknown> }>) {
        return Promise.all(statements.map((statement) => statement.run()));
      },
    } as unknown as D1Database;
    const { app, env } = mount(db);

    const response = await app.request('/api/staff/staff-a/accounts', {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accountIds: ['account-b'] }),
    }, env);

    expect(response.status).toBe(200);
    expect(writes.some(({ sql, params }) =>
      sql.includes('tenant_line_accounts') && params.includes('tenant-a') && params.includes('staff-a'))).toBe(true);
    expect(writes.filter((write) => write.sql.includes('INSERT INTO tenant_admin_audit_events'))
      .map((write) => write.params.slice(1, 7)))
      .toEqual([['tenant-a', null, 'staff-a', 'staff.accounts_updated', 'staff', 'staff-a']]);
  });

  it('lists only memberships in the authenticated tenant', async () => {
    const queries: Array<{ sql: string; params: unknown[] }> = [];
    const db = {
      prepare(sql: string) {
        const statement = {
          params: [] as unknown[],
          bind(...params: unknown[]) { statement.params = params; return statement; },
          async all() {
            queries.push({ sql, params: statement.params });
            return { results: sql.includes('tenant_staff_memberships') ? [owned] : [owned, foreign] };
          },
        };
        return statement;
      },
    } as unknown as D1Database;
    const { app, env } = mount(db);

    const response = await app.request('/api/staff', {}, env);
    const body = await response.json() as { data: Array<{ id: string }> };

    expect(response.status).toBe(200);
    expect(body.data.map((member) => member.id)).toEqual(['staff-a']);
    expect(body.data[0]).toMatchObject({ loginId: 'owner-a' });
    expect(body.data[0]).not.toHaveProperty('apiKey');
    expect(queries[0]?.sql).toContain('tenant_staff_memberships');
    expect(queries[0]?.params).toContain('tenant-a');
  });

  it('does not expose a staff identity without a membership in this tenant', async () => {
    const db = {
      prepare(sql: string) {
        const statement = {
          bind() { return statement; },
          async first() {
            return sql.includes('tenant_staff_memberships') ? null : foreign;
          },
        };
        return statement;
      },
    } as unknown as D1Database;
    const { app, env } = mount(db);

    const response = await app.request('/api/staff/staff-b', {}, env);

    expect(response.status).toBe(404);
  });

  it('adds every newly created staff identity to the authenticated tenant', async () => {
    const writes: Array<{ sql: string; params: unknown[] }> = [];
    let created = owned;
    const db = {
      prepare(sql: string) {
        const statement = {
          params: [] as unknown[],
          bind(...params: unknown[]) { statement.params = params; return statement; },
          async run() {
            writes.push({ sql, params: statement.params });
            if (sql.includes('INSERT INTO staff_members')) {
              created = {
                ...owned,
                id: String(statement.params[0]),
                name: String(statement.params[1]),
                role: String(statement.params[3]) as 'owner',
                api_key: String(statement.params[4]),
              };
            }
            if (sql.includes('INSERT INTO tenant_admin_credentials')) {
              created = { ...created, login_id: String(statement.params[2]) };
            }
            return { meta: { changes: 1 } };
          },
          async first() { return created; },
        };
        return statement;
      },
      async batch(statements: Array<{ run(): Promise<unknown> }>) {
        return Promise.all(statements.map((statement) => statement.run()));
      },
    } as unknown as D1Database;
    const { app, env } = mount(db);

    const response = await app.request('/api/staff', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'New Staff', loginId: 'new-staff', role: 'staff' }),
    }, env);

    expect(response.status).toBe(201);
    const body = await response.json() as { data: Record<string, unknown> };
    expect(body.data).toMatchObject({ loginId: 'new-staff' });
    expect(body.data.temporaryPassword).toMatch(/^Tmp-/);
    expect(body.data).not.toHaveProperty('apiKey');
    const membership = writes.find((write) => write.sql.includes('tenant_staff_memberships'));
    expect(membership?.params).toEqual(expect.arrayContaining(['tenant-a', created.id, 'staff']));
    expect(writes.some((write) => write.sql.includes('tenant_admin_credentials'))).toBe(true);
    expect(writes.filter((write) => write.sql.includes('INSERT INTO tenant_admin_audit_events'))
      .map((write) => write.params.slice(1, 7)))
      .toEqual([['tenant-a', null, 'staff-a', 'staff.created', 'staff', created.id]]);
  });

  it('rejects malformed staff input before writing credentials', async () => {
    const db = {
      prepare() { throw new Error('database must not be touched'); },
      batch() { throw new Error('database must not be touched'); },
    } as unknown as D1Database;
    const { app, env } = mount(db);

    const responses = await Promise.all([
      app.request('/api/staff', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{',
      }, env),
      app.request('/api/staff', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'New Staff',
          loginId: 'new-staff',
          email: 'not-an-email',
          role: 'staff',
        }),
      }, env),
    ]);

    expect(responses.map((response) => response.status)).toEqual([400, 400]);
  });

  it('rejects mutations for staff identities outside the authenticated tenant', async () => {
    const db = {
      prepare(sql: string) {
        const statement = {
          bind() { return statement; },
          async first() {
            return sql.includes('tenant_staff_memberships') ? null : { ...foreign, role: 'staff' };
          },
          async run() { return { meta: { changes: 1 } }; },
        };
        return statement;
      },
    } as unknown as D1Database;
    const { app, env } = mount(db);

    const responses = await Promise.all([
      app.request('/api/staff/staff-b', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Changed' }),
      }, env),
      app.request('/api/staff/staff-b', { method: 'DELETE' }, env),
      app.request('/api/staff/staff-b/reset-password', { method: 'POST' }, env),
    ]);

    expect(responses.map((response) => response.status)).toEqual([404, 404, 404]);
  });

  it('resets only the tenant credential and revokes its sessions', async () => {
    const writes: Array<{ sql: string; params: unknown[] }> = [];
    const db = {
      prepare(sql: string) {
        const statement = {
          params: [] as unknown[],
          bind(...params: unknown[]) { statement.params = params; return statement; },
          async first() { return { ...owned, role: 'staff' as const }; },
          async run() {
            writes.push({ sql, params: statement.params });
            return { meta: { changes: 1 } };
          },
        };
        return statement;
      },
      async batch(statements: Array<{ run(): Promise<unknown> }>) {
        return Promise.all(statements.map((statement) => statement.run()));
      },
    } as unknown as D1Database;
    const { app, env } = mount(db);

    const response = await app.request('/api/staff/staff-a/reset-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    }, env);
    const body = await response.json() as {
      data: { loginId: string; temporaryPassword: string };
    };

    expect(response.status).toBe(200);
    expect(body.data.loginId).toBe('owner-a');
    const credentialWrite = writes.find((write) =>
      write.sql.includes('INSERT INTO tenant_admin_credentials'),
    );
    expect(credentialWrite?.params.slice(0, 3)).toEqual(['tenant-a', 'staff-a', 'owner-a']);
    expect(await verifyTenantPassword(
      body.data.temporaryPassword,
      String(credentialWrite?.params[3]),
    )).toBe(true);
    expect(writes.some((write) => write.sql.includes('UPDATE tenant_admin_sessions'))).toBe(true);
    expect(writes.filter((write) => write.sql.includes('INSERT INTO tenant_admin_audit_events'))
      .map((write) => write.params.slice(1, 7)))
      .toEqual([['tenant-a', null, 'staff-a', 'staff.reset_password', 'staff', 'staff-a']]);
  });

  it('stores role and active-state changes on the tenant membership', async () => {
    const writes: Array<{ sql: string; params: unknown[] }> = [];
    const target = { ...owned, role: 'admin' as const };
    const db = {
      prepare(sql: string) {
        const statement = {
          params: [] as unknown[],
          bind(...params: unknown[]) { statement.params = params; return statement; },
          async first() { return target; },
          async all() { return { results: [] }; },
          async run() {
            writes.push({ sql, params: statement.params });
            return { meta: { changes: 1 } };
          },
        };
        return statement;
      },
      async batch(statements: Array<{ run(): Promise<unknown> }>) {
        return Promise.all(statements.map((statement) => statement.run()));
      },
    } as unknown as D1Database;
    const { app, env } = mount(db);

    const response = await app.request('/api/staff/staff-a', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'staff', isActive: false }),
    }, env);

    expect(response.status).toBe(200);
    const membershipWrite = writes.find((write) => write.sql.includes('UPDATE tenant_staff_memberships'));
    expect(membershipWrite?.params).toEqual(expect.arrayContaining(['staff', 0, 'tenant-a', 'staff-a']));
    expect(writes.some((write) =>
      write.sql.includes('UPDATE staff_members') && /role|is_active/.test(write.sql),
    )).toBe(false);
    expect(writes.some((write) => write.sql.includes('UPDATE tenant_admin_sessions'))).toBe(true);
    expect(writes.filter((write) => write.sql.includes('INSERT INTO tenant_admin_audit_events'))
      .map((write) => write.params.slice(1, 7)))
      .toEqual([['tenant-a', null, 'staff-a', 'staff.role_changed', 'staff', 'staff-a']]);
  });

  it('deactivates a tenant membership and revokes sessions without deleting audit history', async () => {
    const writes: Array<{ sql: string; params: unknown[] }> = [];
    const target = { ...owned, id: 'staff-b', role: 'staff' as const };
    const db = {
      prepare(sql: string) {
        const statement = {
          params: [] as unknown[],
          bind(...params: unknown[]) { statement.params = params; return statement; },
          async first() { return target; },
          async all() { return { results: [] }; },
          async run() {
            writes.push({ sql, params: statement.params });
            return { meta: { changes: 1 } };
          },
        };
        return statement;
      },
      async batch(statements: Array<{ run(): Promise<unknown> }>) {
        return Promise.all(statements.map((statement) => statement.run()));
      },
    } as unknown as D1Database;
    const { app, env } = mount(db);

    const response = await app.request('/api/staff/staff-b', { method: 'DELETE' }, env);

    expect(response.status).toBe(200);
    expect(writes.some((write) => write.sql.includes('DELETE FROM tenant_staff_memberships')))
      .toBe(false);
    expect(writes.some((write) =>
      write.sql.includes('UPDATE tenant_staff_memberships') &&
      write.params.includes('tenant-a') && write.params.includes('staff-b'),
    )).toBe(true);
    expect(writes.some((write) =>
      write.sql.includes('UPDATE tenant_admin_sessions') &&
      write.params.includes('tenant-a') && write.params.includes('staff-b'),
    )).toBe(true);
    expect(writes.filter((write) => write.sql.includes('INSERT INTO tenant_admin_audit_events'))
      .map((write) => write.params.slice(1, 7)))
      .toEqual([['tenant-a', null, 'staff-a', 'staff.deleted', 'staff', 'staff-b']]);
  });

  it('rejects deactivating or deleting the last active assignee for an account', async () => {
    const target = { ...owned, id: 'staff-b', role: 'staff' as const };
    const db = {
      prepare() {
        const statement = {
          bind() { return statement; },
          async first() { return target; },
          async all() {
            return { results: [
              { id: 'account-a', name: 'A', assigned: 1, target_active: 1, active_staff_count: 1 },
            ] };
          },
        };
        return statement;
      },
      async batch() { throw new Error('must not write'); },
    } as unknown as D1Database;
    const { app, env } = mount(db);

    const [deactivate, remove] = await Promise.all([
      app.request('/api/staff/staff-b', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isActive: false }),
      }, env),
      app.request('/api/staff/staff-b', { method: 'DELETE' }, env),
    ]);

    expect(deactivate.status).toBe(409);
    expect(remove.status).toBe(409);
  });
});
