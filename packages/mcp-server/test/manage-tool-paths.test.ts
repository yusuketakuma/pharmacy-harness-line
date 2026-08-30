import { beforeEach, describe, expect, it, vi } from 'vitest';

const apiCall = vi.fn();
const toToolResult = vi.fn((result: unknown) => result);
vi.mock('../src/api-call.js', () => ({ apiCall, toToolResult }));

const { registerManageMessageTemplates } = await import(
  '../src/tools/manage-message-templates.js'
);
const { registerManageTrafficPools } = await import(
  '../src/tools/manage-traffic-pools.js'
);

function registeredHandler(register: (server: never) => void) {
  const server = { tool: vi.fn() };
  register(server as never);
  return server.tool.mock.calls[0]?.[3] as (
    input: Record<string, unknown>,
  ) => Promise<unknown>;
}

describe('MCP management tool paths', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiCall.mockResolvedValue({ ok: true, status: 200, data: { success: true } });
  });

  it.each(['get', 'update', 'delete'])(
    'keeps message-template id in one segment for %s',
    async (action) => {
      await registeredHandler(registerManageMessageTemplates as never)({
        action,
        templateId: '../line-accounts/account-a',
      });

      expect(apiCall.mock.calls[0]?.[0]).toBe(
        '/api/message-templates/..%2Fline-accounts%2Faccount-a',
      );
    },
  );

  it.each(['update', 'delete', 'list_accounts', 'add_account'])(
    'keeps traffic-pool id in one segment for %s',
    async (action) => {
      await registeredHandler(registerManageTrafficPools as never)({
        action,
        poolId: '../line-accounts',
        lineAccountId: 'account-a',
      });

      expect(apiCall.mock.calls[0]?.[0]).toMatch(
        /^\/api\/traffic-pools\/\.\.%2Fline-accounts(?:\/accounts)?$/,
      );
    },
  );

  it.each(['remove_account', 'toggle_account'])(
    'keeps pool and pool-account ids in one segment for %s',
    async (action) => {
      await registeredHandler(registerManageTrafficPools as never)({
        action,
        poolId: '../line-accounts',
        poolAccountId: '../accounts',
        isActive: true,
      });

      expect(apiCall.mock.calls[0]?.[0]).toBe(
        '/api/traffic-pools/..%2Fline-accounts/accounts/..%2Faccounts',
      );
    },
  );
});
