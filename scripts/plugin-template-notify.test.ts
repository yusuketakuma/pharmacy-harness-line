import { afterEach, expect, it, vi } from 'vitest';
import { checkAndNotify } from '../packages/plugin-template/src/notify.js';

const env = {
  LINE_HARNESS_API_URL: 'https://harness.invalid',
  LINE_HARNESS_API_KEY: 'synthetic',
  LINE_HARNESS_TENANT_ID: 'synthetic-tenant',
  EXTERNAL_API_KEY: 'synthetic',
  LINE_ACCOUNT_ID: 'synthetic-account',
};
const name = 'MyService appointment reminder';
type Scenario = {
  id: string;
  name: string;
  triggerType: string;
  triggerTagId: string;
  isActive: boolean;
  stepCount: number;
};
const ready = (): Scenario => ({
  id: 'scenario',
  name,
  triggerType: 'tag_added',
  triggerTagId: 'appt-tag',
  isActive: true,
  stepCount: 1,
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function fixture(existing?: Scenario, failure?: 'step' | 'activation' | 'activation-response') {
  const scenarios: Scenario[] = existing ? [{ ...existing }] : [];
  const events: string[] = [];
  const tags = [
    { id: 'appt-tag', name: 'myservice:appt-reminder' },
    { id: 'renewal-tag', name: 'myservice:renewal-reminder' },
  ];
  const attached = new Set<string>();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      const url = new URL(input),
        method = init?.method ?? 'GET';
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      const ok = (data: unknown) => Response.json({ success: true, data });
      if (url.hostname === 'api.myservice.example.com') {
        if (url.pathname === '/v1/appointments')
          return Response.json([{ id: 'appointment', lineHarnessFriendId: 'friend' }]);
        if (url.pathname === '/v1/memberships') return Response.json([]);
      }
      expect(url.origin).toBe(env.LINE_HARNESS_API_URL);
      expect(new Headers(init?.headers).get('X-Tenant-Id')).toBe(env.LINE_HARNESS_TENANT_ID);
      if (url.pathname === '/api/tags') return ok(tags);
      if (url.pathname === '/api/scenarios' && method === 'GET') {
        expect(url.searchParams.get('lineAccountId')).toBe(env.LINE_ACCOUNT_ID);
        return ok(scenarios);
      }
      if (url.pathname === '/api/scenarios' && method === 'POST') {
        expect(body.lineAccountId).toBe(env.LINE_ACCOUNT_ID);
        events.push(`create:${body.isActive}`);
        const scenario = { ...body, id: `created-${scenarios.length}`, stepCount: 0 };
        scenarios.push(scenario);
        return ok(scenario);
      }
      const step = url.pathname.match(/^\/api\/scenarios\/([^/]+)\/steps$/);
      if (step && method === 'POST') {
        const scenario = scenarios.find((s) => s.id === step[1])!;
        events.push(`step:${scenario.isActive}`);
        if (failure === 'step') {
          failure = undefined;
          return Response.json({ error: 'synthetic step failure' }, { status: 503 });
        }
        scenario.stepCount++;
        return ok({ ...body, id: 'step' });
      }
      const update = url.pathname.match(/^\/api\/scenarios\/([^/]+)$/);
      if (update && method === 'PUT') {
        events.push('activate');
        if (failure === 'activation') return Response.json({ error: 'synthetic activation failure' }, { status: 503 });
        const scenario = scenarios.find((s) => s.id === update[1])!;
        Object.assign(scenario, body);
        if (failure === 'activation-response') {
          failure = undefined;
          throw new Error('synthetic response lost');
        }
        return ok(scenario);
      }
      if (url.pathname === '/api/friends/friend' && method === 'GET')
        return ok({ id: 'friend', tags: [...attached].map((id) => ({ id })) });
      if (url.pathname === '/api/friends/friend/tags' && method === 'POST') {
        events.push('attach');
        attached.add(body.tagId);
        return ok(null);
      }
      throw new Error(`Unexpected synthetic request: ${method} ${url.pathname}`);
    }),
  );
  return { scenarios, events, attached };
}

it('activates only after the step exists and attaches the trigger tag last', async () => {
  const f = fixture();
  await checkAndNotify(env);
  expect(f.events.slice(0, 4)).toEqual(['create:false', 'step:false', 'activate', 'attach']);
  expect(f.attached.has('appt-tag')).toBe(true);
});

it('leaves step failures inactive and never consumes the dedup tag on a later cron', async () => {
  const f = fixture(undefined, 'step');
  await expect(checkAndNotify(env)).rejects.toThrow('synthetic step failure');
  await expect(checkAndNotify(env)).rejects.toThrow();
  expect(f.scenarios[0]).toMatchObject({ isActive: false, stepCount: 0 });
  expect(f.attached.size).toBe(0);
  expect(f.events.filter((e) => e.startsWith('create'))).toHaveLength(1);
});

it('does not attach a tag when activation fails', async () => {
  const f = fixture(undefined, 'activation');
  await expect(checkAndNotify(env)).rejects.toThrow('synthetic activation failure');
  expect(f.scenarios[0]).toMatchObject({ isActive: false, stepCount: 1 });
  expect(f.attached.size).toBe(0);
});

it('can use a completed scenario on retry after its activation response was lost', async () => {
  const f = fixture(undefined, 'activation-response');
  await expect(checkAndNotify(env)).rejects.toThrow('synthetic response lost');
  expect(f.attached.size).toBe(0);
  await checkAndNotify(env);
  expect(f.attached.has('appt-tag')).toBe(true);
});

it.each([{ isActive: false }, { stepCount: 0 }, { triggerType: 'friend_add' }, { triggerTagId: 'another-tag' }])(
  'does not consume tags or rewrite an existing non-ready scenario: %j',
  async (change) => {
    const scenario = { ...ready(), ...change };
    const f = fixture(scenario);
    await expect(checkAndNotify(env)).rejects.toThrow();
    expect(f.scenarios).toEqual([scenario]);
    expect(f.events).toEqual([]);
    expect(f.attached.size).toBe(0);
  },
);

it('resumes after a human completes an inactive scenario, retaining its steps', async () => {
  const f = fixture({ ...ready(), isActive: false, stepCount: 0 });
  await expect(checkAndNotify(env)).rejects.toThrow();
  Object.assign(f.scenarios[0], { isActive: true, stepCount: 2 });
  await checkAndNotify(env);
  expect(f.scenarios[0].stepCount).toBe(2);
  expect(f.attached.has('appt-tag')).toBe(true);
  await checkAndNotify(env);
  expect(f.events.filter((e) => e === 'attach')).toHaveLength(1);
});
