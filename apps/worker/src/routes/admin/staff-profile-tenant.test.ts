import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../../index.js';
import { staff } from './staff.js';

const target = {
  id: 'staff-a',
  name: 'Shared Staff',
  email: null,
  role: 'owner' as const,
  login_id: 'shared-a',
  is_active: 1,
  created_at: '2026-08-18T00:00:00Z',
  updated_at: '2026-08-18T00:00:00Z',
};

function mount(db: D1Database) {
  const app = new Hono<Env>();
  app.use('*', async (c, next) => {
    c.set('staff', { id: target.id, name: target.name, role: target.role });
    c.set('tenantId', 'tenant-a');
    await next();
  });
  app.route('/', staff);
  return { app, env: { DB: db } as Env['Bindings'] };
}

describe('PATCH /api/staff/:id profile tenant safety', () => {
  it('fails closed instead of changing a staff profile shared with another tenant', async () => {
    const writes: Array<{ sql: string; params: unknown[] }> = [];
    const db = {
      prepare(sql: string) {
        const statement = {
          params: [] as unknown[],
          bind(...params: unknown[]) {
            statement.params = params;
            return statement;
          },
          async first() {
            return target;
          },
          async run() {
            writes.push({ sql, params: statement.params });
            return { meta: { changes: sql.includes('NOT EXISTS') ? 0 : 1 } };
          },
        };
        return statement;
      },
    } as unknown as D1Database;
    const { app, env } = mount(db);

    const response = await app.request('/api/staff/staff-a', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Tenant A Name' }),
    }, env);

    expect(response.status).toBe(409);
    expect(writes).toHaveLength(1);
    expect(writes[0]?.sql).toContain('NOT EXISTS');
  });
});
