import { afterEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { appErrorHandler } from './app-error-handler.js';

const SENTINEL = 'PHI_SENTINEL_患者名_090-0000-0000';

function makeApp(register = true) {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.header('X-Middleware', 'kept');
    await next();
  });
  const child = new Hono();
  child.get('/api/child/:id', () => {
    throw new Error(`storage failed for ${SENTINEL}`);
  });
  child.get('/api/http-exception', () => {
    throw new HTTPException(418, { message: 'teapot' });
  });
  child.get('/api/duck', () => {
    const err = new Error(SENTINEL) as Error & { getResponse: () => Response };
    err.getResponse = () => new Response('custom body', { status: 409, headers: { 'X-Custom': 'yes' } });
    throw err;
  });
  app.route('/', child);
  if (register) app.onError(appErrorHandler);
  return app;
}

function consoleOutput(spies: { mock: { calls: unknown[][] } }[]): string {
  return spies
    .flatMap((spy) => spy.mock.calls)
    .map((args) =>
      args.map((arg: unknown) => (arg instanceof Error ? `${arg.message}\n${arg.stack}` : String(arg))).join(' '),
    )
    .join('\n');
}

describe('appErrorHandler', () => {
  afterEach(() => vi.restoreAllMocks());

  it('keeps the default 500 response and middleware headers without logging the error', async () => {
    const spies = (['error', 'warn', 'log'] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation(() => undefined),
    );
    const res = await makeApp().request(`/api/child/${encodeURIComponent(SENTINEL)}`);

    expect(res.status).toBe(500);
    expect(await res.text()).toBe('Internal Server Error');
    expect(res.headers.get('X-Middleware')).toBe('kept');
    const output = consoleOutput(spies);
    expect(output).not.toContain(SENTINEL);
    expect(output).not.toContain('storage failed');
    const line = JSON.parse(spies[0].mock.calls[0][0] as string) as Record<string, unknown>;
    expect(line).toMatchObject({
      level: 'error',
      event: 'unhandled_route_error',
      method: 'GET',
      status: 500,
    });
  });

  it('matches the Hono default response for unexpected errors', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const path = `/api/child/x`;
    const [actual, expected] = await Promise.all([makeApp().request(path), makeApp(false).request(path)]);
    expect(actual.status).toBe(expected.status);
    expect(await actual.text()).toBe(await expected.text());
    expect(actual.headers.get('content-type')).toBe(expected.headers.get('content-type'));
  });

  it('forwards HTTPException and duck-typed getResponse errors unchanged', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const app = makeApp();

    const http = await app.request('/api/http-exception');
    expect(http.status).toBe(418);
    expect(await http.text()).toBe('teapot');

    const duck = await app.request('/api/duck');
    expect(duck.status).toBe(409);
    expect(await duck.text()).toBe('custom body');
    expect(duck.headers.get('X-Custom')).toBe('yes');
    expect(duck.headers.get('X-Middleware')).toBe('kept');
    expect(error).not.toHaveBeenCalled();
  });
});
