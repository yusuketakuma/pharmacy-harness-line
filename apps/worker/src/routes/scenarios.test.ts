import { describe, expect, test, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';

const dbMocks = {
  getScenarios: vi.fn(),
  getScenariosForAccount: vi.fn(),
  getScenariosForTenant: vi.fn(),
  getScenarioById: vi.fn(),
  createScenario: vi.fn(),
  updateScenario: vi.fn(),
  deleteScenario: vi.fn(),
  createScenarioStep: vi.fn(),
  updateScenarioStep: vi.fn(),
  deleteScenarioStep: vi.fn(),
  enrollFriendInScenario: vi.fn(),
  getFriendById: vi.fn(),
  computeNextDeliveryAt: vi.fn(),
  resolveStepContent: vi.fn(),
};
vi.mock('@line-crm/db', () => dbMocks);

vi.mock('../services/scenario-stats.js', () => ({
  computeScenarioStats: vi.fn(),
}));

const { scenarios: scenariosModule } = await import('./scenarios.js');

interface ScenarioRow {
  id: string;
  name: string;
  description: string | null;
  trigger_type: string;
  trigger_tag_id: string | null;
  is_active: number;
  delivery_mode: string;
  created_at: string;
  updated_at: string;
  line_account_id: string | null;
  step_count: number;
}

function makeScenarioDb(rows: ScenarioRow[]) {
  const calls: { sql: string; binds: unknown[] }[] = [];
  const db = {
    prepare(sql: string) {
      let bound: unknown[] = [];
      const stmt = {
        bind(...args: unknown[]) {
          bound = args;
          return stmt;
        },
        async all<_T>() {
          calls.push({ sql, binds: bound });
          if (/FROM scenarios s\b/i.test(sql) && /line_account_id IS NULL/i.test(sql)) {
            const [lineAccountId] = bound as [string];
            const filtered = rows.filter(
              (r) => r.line_account_id == null || r.line_account_id === lineAccountId,
            );
            return { results: filtered };
          }
          return { results: [] };
        },
      };
      return stmt;
    },
  } as unknown as D1Database;
  return { db, calls };
}

function setupApp(db: D1Database, tenantId: string | null = null) {
  const app = new Hono<{ Bindings: { DB: D1Database }; Variables: { tenantId: string | null } }>();
  app.use('*', async (c, next) => {
    c.env = { DB: db };
    if (tenantId !== null) c.set('tenantId', tenantId);
    await next();
  });
  app.route('/', scenariosModule);
  return app;
}

const rowBase = {
  description: null,
  trigger_type: 'friend_add',
  trigger_tag_id: null,
  is_active: 1,
  delivery_mode: 'relative',
  created_at: '2026-05-20T00:00:00.000',
  updated_at: '2026-05-20T00:00:00.000',
  step_count: 0,
};

beforeEach(() => {
  for (const fn of Object.values(dbMocks)) fn.mockReset();
});

describe('GET /api/scenarios?lineAccountId=X', () => {
  test('includes both account-bound and global (NULL) scenarios', async () => {
    const rows: ScenarioRow[] = [
      { id: 's-global', name: 'global', line_account_id: null, ...rowBase },
      { id: 's-acc1', name: 'acc1', line_account_id: 'acc-1', ...rowBase },
      { id: 's-acc2', name: 'acc2', line_account_id: 'acc-2', ...rowBase },
    ];
    const { db } = makeScenarioDb(rows);
    dbMocks.getScenariosForAccount.mockResolvedValue(rows.slice(0, 2));

    const res = await setupApp(db).request('/api/scenarios?lineAccountId=acc-1');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; data: { id: string; lineAccountId: string | null }[] };
    expect(body.success).toBe(true);
    // webhook.ts:211 / liff.ts:878 trigger scenarios where line_account_id is
    // NULL (global) OR matches the active account. The list endpoint must
    // mirror that so the UI does not hide records the engine will fire.
    const ids = body.data.map((d) => d.id).sort();
    expect(ids).toEqual(['s-acc1', 's-global']);
    // Serializer surfaces the binding so the UI can distinguish 全アカ共通 from
    // an account-specific scenario.
    const globalRow = body.data.find((d) => d.id === 's-global');
    expect(globalRow?.lineAccountId).toBeNull();
    expect(dbMocks.getScenariosForAccount).toHaveBeenCalledWith(db, 'acc-1');
  });

  test('falls back to the caller own tenant when no lineAccountId is provided', async () => {
    // No account filter is an admin-console "show me everything I own" query,
    // not the delivery path's "which scenarios fire for this inbound account".
    // Routing it through getScenariosForAccount(db, null) returned [] and blanked
    // out the dashboard, emergency stop-all panel, inflow-links, affiliates and
    // friend-add-settings pages.
    const rows: ScenarioRow[] = [
      { id: 's-mine-global', name: 'mine', line_account_id: null, ...rowBase },
      { id: 's-mine-acc', name: 'mine-acc', line_account_id: 'acc-1', ...rowBase },
    ];
    dbMocks.getScenariosForTenant.mockResolvedValue(rows);
    const { db } = makeScenarioDb(rows);

    const res = await setupApp(db, 'tenant-a').request('/api/scenarios');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; data: { id: string }[] };
    expect(body.data.map((d) => d.id).sort()).toEqual(['s-mine-acc', 's-mine-global']);
    expect(dbMocks.getScenariosForTenant).toHaveBeenCalledWith(db, 'tenant-a');
    // The account-scoped helper must not be reached — it fails closed by design.
    expect(dbMocks.getScenariosForAccount).not.toHaveBeenCalled();
  });

  test('passes a null tenant through rather than widening to every tenant', async () => {
    dbMocks.getScenariosForTenant.mockResolvedValue([]);
    const { db } = makeScenarioDb([]);

    const res = await setupApp(db).request('/api/scenarios');
    expect(res.status).toBe(200);
    expect(dbMocks.getScenariosForTenant).toHaveBeenCalledWith(db, null);
    expect(dbMocks.getScenarios).not.toHaveBeenCalled();
  });

  test('returns empty array when filter matches nothing and no globals exist', async () => {
    const rows: ScenarioRow[] = [
      { id: 's-other', name: 'other', line_account_id: 'acc-other', ...rowBase },
    ];
    const { db } = makeScenarioDb(rows);
    dbMocks.getScenariosForAccount.mockResolvedValue([]);

    const res = await setupApp(db).request('/api/scenarios?lineAccountId=acc-1');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; data: unknown[] };
    expect(body.data).toEqual([]);
  });
});
