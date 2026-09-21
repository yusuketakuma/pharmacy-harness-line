import { afterEach, expect, it, vi } from 'vitest';
import worker, { type Env } from '../packages/plugin-template/src/index.js';
import { MyServiceClient } from '../packages/plugin-template/src/external-api.js';
import { registerExampleTool } from '../packages/plugin-template/mcp-server/tools/example-tool.js';

const sentinel = 'PHI_729';
const env: Env = { LINE_HARNESS_API_URL: 'https://synthetic.invalid', LINE_HARNESS_API_KEY: 'synthetic-key', LINE_HARNESS_TENANT_ID: 'synthetic-tenant', EXTERNAL_API_KEY: 'synthetic-external' };
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

it.each([true, false])('does not log webhook content (valid JSON=%s)', async valid => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  const response = await worker.fetch(new Request('https://synthetic.invalid/webhook', {
    method: 'POST', body: valid ? JSON.stringify({ privateData: sentinel }) : sentinel,
  }), env, {} as ExecutionContext);
  expect(response.status).toBe(valid ? 200 : 400);
  expect(await response.json()).toEqual(valid ? { received: true } : { error: 'Invalid request' });
  expect([...log.mock.calls, ...error.mock.calls].flat().map(String).join(' ')).not.toContain(sentinel);
});

it.each(['http', 'json', 'network'] as const)('does not expose external %s failure content', async mode => {
  const cancelled = vi.fn();
  const response = new Response(new ReadableStream({ start(controller) {
    controller.enqueue(new TextEncoder().encode(sentinel));
    controller.close();
  }, cancel: cancelled }), { status: mode === 'http' ? 503 : 200 });
  const readBody = vi.spyOn(response, 'text');
  vi.stubGlobal('fetch', mode === 'network' ? vi.fn().mockRejectedValue(new Error(sentinel)) : vi.fn().mockResolvedValue(response));
  const error = await new MyServiceClient('synthetic-key').listCustomers().catch(error => error);
  expect(error).toBeInstanceOf(Error);
  expect(String(error)).not.toContain(sentinel);
  if (mode === 'http') {
    expect(String(error)).toContain('503');
    expect(readBody).not.toHaveBeenCalled();
    expect(cancelled).toHaveBeenCalledOnce();
  }
});

it('keeps successful JSON and request credentials unchanged', async () => {
  const data = [{ id: 'synthetic-customer', name: 'Synthetic' }];
  const fetch = vi.fn().mockResolvedValue(Response.json(data));
  vi.stubGlobal('fetch', fetch);
  expect(await new MyServiceClient('synthetic-key').listCustomers()).toEqual(data);
  expect(fetch).toHaveBeenCalledWith('https://api.myservice.example.com/v1/customers', {
    headers: { Authorization: 'Bearer synthetic-key', 'Content-Type': 'application/json' },
  });
});

it('does not return the external response body through an MCP tool error', async () => {
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  const handlers = new Map<string, (input: unknown) => Promise<unknown>>();
  registerExampleTool({ registerTool(name: string, _config: unknown, handler: (input: unknown) => Promise<unknown>) { handlers.set(name, handler); } } as never);
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(sentinel, { status: 503 })));
  const result = await handlers.get('lookup_customer')!({ customerId: 'synthetic-customer' });
  expect(JSON.stringify(result)).not.toContain(sentinel);
  expect(JSON.stringify(result)).toContain('503');
});


it('keeps published MCP object constraints and strips unknown input keys', () => {
  type Schema = { toJSONSchema(options: { io: 'input' }): Record<string, unknown>; parse(input: unknown): unknown };
  const schemas = new Map<string, Schema>();
  registerExampleTool({ registerTool(name: string, config: { inputSchema: Schema }) { schemas.set(name, config.inputSchema); } } as never);
  expect([...schemas.keys()]).toEqual(['lookup_customer', 'send_myservice_notification']);
  for (const [name, schema] of schemas) {
    expect(schema.toJSONSchema({ io: 'input' }).additionalProperties).toBe(false);
    const known = name === 'lookup_customer' ? { customerId: 'synthetic' } : { friendId: 'synthetic', notificationType: 'custom', message: 'synthetic' };
    expect(schema.parse({ ...known, extra: 'synthetic' })).toEqual(known);
    expect(() => schema.parse({})).toThrow();
  }
});
