import type { Context } from 'hono';
import { log } from '../lib/log.js';

/**
 * Log an authz refusal, then return the same `{ success: false, error }` body
 * the call site used before. `reason` is a short machine label; `error` is the
 * client-facing message (defaults to the reason).
 */
export function deny(c: Context, status: 401 | 403, reason: string, error: string = reason): Response {
  log('authz.denied', {
    route: new URL(c.req.url).pathname,
    method: c.req.method.toUpperCase(),
    status,
    reason,
    tenant_id: c.get('tenantId') as string | undefined,
  }, 'warn');
  return c.json({ success: false, error }, status);
}
