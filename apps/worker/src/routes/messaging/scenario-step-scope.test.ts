import { afterEach, beforeEach, expect, it } from 'vitest';
import { Hono } from 'hono';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Env } from '../../index.js';
import { tenantScenarioResourceGuard } from '../../middleware/tenant-boundary.js';
import { scenarios } from './scenarios.js';
import { updateScenarioStep, deleteScenarioStep } from '@line-crm/db';

const dbRoot = join(dirname(fileURLToPath(import.meta.url)), '../../../../../packages/db');
type Sqlite = {
  exec(sql: string): void;
  close(): void;
  prepare(sql: string): {
    get(...args: unknown[]): unknown;
    all(...args: unknown[]): unknown[];
    run(...args: unknown[]): { changes: number };
  };
};
const Database = createRequire(import.meta.url)(join(dbRoot, 'node_modules/better-sqlite3')) as new (
  file: string,
) => Sqlite;
let sqlite: Sqlite;
let db: D1Database;
let app: Hono<Env>;
beforeEach(() => {
  sqlite = new Database(':memory:');
  sqlite.exec(readFileSync(join(dbRoot, 'bootstrap.sql'), 'utf8'));
  sqlite.exec(`INSERT INTO tenants(id,tenant_code,display_name) VALUES ('tenant-a','a','A'),('tenant-b','b','B');
    INSERT INTO scenarios(id,name,trigger_type,tenant_id) VALUES ('parent-a','A','manual','tenant-a'),('parent-b','B','manual','tenant-b'),('other-a','Other A','manual','tenant-a');
    INSERT INTO scenario_steps(id,scenario_id,step_order,delay_minutes,message_type,message_content) VALUES
      ('step-a','parent-a',1,0,'text','original-a'),('step-b','parent-b',1,0,'text','original-b'),('other-step-a','other-a',1,0,'text','other-a');`);
  const prepare = (sql: string, args: unknown[] = []): unknown => ({
    bind: (...values: unknown[]) => prepare(sql, values),
    first: async () => sqlite.prepare(sql).get(...args) ?? null,
    all: async () => ({ results: sqlite.prepare(sql).all(...args), success: true, meta: {} }),
    run: async () => ({
      success: true,
      meta: { changes: sqlite.prepare(sql).run(...args).changes },
    }),
  });
  db = { prepare } as unknown as D1Database;
  app = new Hono<Env>();
  app.use('*', async (c, next) => {
    c.set('tenantId', 'tenant-a');
    await next();
  });
  app.use('*', tenantScenarioResourceGuard);
  app.route('/', scenarios);
});
afterEach(() => sqlite.close());
const request = (method: string, step: string, body?: unknown) =>
  app.request(
    `/api/scenarios/parent-a/steps/${step}`,
    {
      method,
      ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    },
    { DB: db } as Env['Bindings'],
  );

it.each(['step-b', 'other-step-a'])('rejects a foreign parent step update and no-op read: %s', async (step) => {
  const before = sqlite.prepare('SELECT * FROM scenario_steps WHERE id = ?').get(step);
  expect((await request('PUT', step, { messageContent: 'replaced' })).status).toBe(404);
  expect((await request('PUT', step, {})).status).toBe(404);
  expect(sqlite.prepare('SELECT * FROM scenario_steps WHERE id = ?').get(step)).toEqual(before);
});
it.each(['step-b', 'other-step-a'])('does not delete a foreign parent step: %s', async (step) => {
  const before = sqlite.prepare('SELECT * FROM scenario_steps WHERE id = ?').get(step);
  const response = await request('DELETE', step);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ success: true, data: null });
  expect(sqlite.prepare('SELECT * FROM scenario_steps WHERE id = ?').get(step)).toEqual(before);
});
it('keeps valid updates, no-op reads, and repeated deletes compatible', async () => {
  const response = await request('PUT', 'step-a', { messageContent: 'updated-a' });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    success: true,
    data: { id: 'step-a', messageContent: 'updated-a' },
  });
  expect((await request('PUT', 'step-a', {})).status).toBe(200);
  expect((await request('DELETE', 'step-a')).status).toBe(200);
  expect((await request('DELETE', 'step-a')).status).toBe(200);
  expect(sqlite.prepare("SELECT id FROM scenario_steps WHERE id = 'step-a'").get()).toBeUndefined();
});
it('retains the existing direct DB helper signatures', async () => {
  expect(await updateScenarioStep(db, 'step-b', { message_content: 'legacy' })).toMatchObject({
    message_content: 'legacy',
  });
  await deleteScenarioStep(db, 'step-b');
  expect(sqlite.prepare("SELECT id FROM scenario_steps WHERE id = 'step-b'").get()).toBeUndefined();
});

it.each([{}, { message_content: 'foreign' }])(
  'scopes the DB update and returned row by server tenant: %j',
  async (changes) => {
    const scope = { scenarioId: 'parent-b', tenantId: 'tenant-a' };
    expect(await updateScenarioStep(db, 'step-b', changes, scope)).toBeNull();
    expect(sqlite.prepare("SELECT message_content FROM scenario_steps WHERE id = 'step-b'").get()).toEqual({
      message_content: 'original-b',
    });
  },
);
it('scopes a DB delete by tenant even when its parent id matches', async () => {
  await deleteScenarioStep(db, 'step-b', { scenarioId: 'parent-b', tenantId: 'tenant-a' });
  expect(sqlite.prepare("SELECT id FROM scenario_steps WHERE id = 'step-b'").get()).toEqual({
    id: 'step-b',
  });
});
it('preserves explicit null-tenant legacy scope without widening to a named tenant', async () => {
  sqlite.exec(
    "INSERT INTO scenarios(id,name,trigger_type) VALUES ('legacy','Legacy','manual'); INSERT INTO scenario_steps(id,scenario_id,step_order,delay_minutes,message_type,message_content) VALUES ('legacy-step','legacy',1,0,'text','legacy');",
  );
  expect(
    await updateScenarioStep(
      db,
      'legacy-step',
      { message_content: 'updated' },
      { scenarioId: 'legacy', tenantId: null },
    ),
  ).toMatchObject({ message_content: 'updated' });
  expect(await updateScenarioStep(db, 'step-b', {}, { scenarioId: 'parent-b', tenantId: null })).toBeNull();
  await deleteScenarioStep(db, 'legacy-step', { scenarioId: 'legacy', tenantId: null });
  expect(sqlite.prepare("SELECT id FROM scenario_steps WHERE id = 'legacy-step'").get()).toBeUndefined();
});
