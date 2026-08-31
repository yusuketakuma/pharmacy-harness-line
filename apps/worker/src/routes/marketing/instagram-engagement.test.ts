import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const dbMocks = {
  getStaffByApiKey: vi.fn(),
  applyMileageRulesForEvent: vi.fn(),
};
vi.mock('@line-crm/db', () => dbMocks);

const { authMiddleware } = await import('../../middleware/auth.js');
const { instagramEngagement } = await import('./instagram-engagement.js');
type Env = import('../../index.js').Env;
const tenantDb = {
  prepare(sql: string) {
    const statement = {
      bind: () => statement,
      first: async () => {
        if (sql.includes('FROM tenants')) return { id: 'tenant-generic', tenant_code: 'generic', display_name: 'Generic' };
        if (sql.includes('FROM tenant_staff_memberships')) return { role: 'owner' };
        return null;
      },
    };
    return statement;
  },
} as unknown as D1Database;
const env = {
  DB: tenantDb,
  API_KEY: 'owner-key',
} as unknown as Env['Bindings'];

function call(body: Record<string, unknown>, authorization = 'Bearer owner-key') {
  const app = new Hono<Env>();
  app.use('*', authMiddleware);
  app.route('/', instagramEngagement);
  return app.request('/api/integrations/ig-harness/engagement', {
    method: 'POST',
    headers: { Authorization: authorization, 'X-Tenant-Id': 'generic', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }, env);
}

beforeEach(() => {
  vi.clearAllMocks();
  dbMocks.getStaffByApiKey.mockResolvedValue({ id: 'staff-1', name: 'Owner', role: 'owner' });
  dbMocks.applyMileageRulesForEvent.mockResolvedValue({
    event: { id: 'event-1' }, granted: [], queued: true,
  });
});

describe('IG Harness engagement receiver', () => {
  it('requires the LINE Harness connection API key', async () => {
    expect((await call({}, '')).status).toBe(401);
  });

  it('applies configured rules to a linked Instagram action', async () => {
    const response = await call({
      friendId: 'friend-1',
      eventType: 'instagram_comment_created',
      sourceEventId: 'comment-1',
      subjectKey: 'post-1',
      metadata: { mediaId: 'post-1' },
    });
    expect(response.status).toBe(202);
    expect(dbMocks.applyMileageRulesForEvent).toHaveBeenCalledWith(env.DB, {
      friendId: 'friend-1', eventType: 'instagram_comment_created', source: 'instagram',
      sourceEventId: 'comment-1', subjectKey: 'post-1', metadata: { mediaId: 'post-1' },
    });
  });

  it('rejects event names outside the fixed Instagram allowlist', async () => {
    const response = await call({
      friendId: 'friend-1', eventType: 'adjust_balance', sourceEventId: 'x',
    });
    expect(response.status).toBe(422);
    expect(dbMocks.applyMileageRulesForEvent).not.toHaveBeenCalled();
  });
});
