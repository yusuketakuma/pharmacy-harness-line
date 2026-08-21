/**
 * Minimal structured logger. One JSON line per event; only allowlisted keys
 * survive, so PHI, credentials, and request bodies cannot leak by accident.
 */
const ALLOW = new Set([
  'tenant_id', 'line_account_id', 'staff_id', 'platform_admin_id',
  'route', 'method', 'status', 'reason', 'resource_type', 'resource_id',
  'count', 'ip', 'destination', 'realm', 'err',
]);

export type LogLevel = 'info' | 'warn' | 'error';

export function log(
  event: string,
  fields: Record<string, unknown> = {},
  level: LogLevel = 'info',
): void {
  const out: Record<string, unknown> = { ts: new Date().toISOString(), level, event };
  for (const [key, value] of Object.entries(fields)) {
    if (!ALLOW.has(key) || value === undefined) continue;
    out[key] = value instanceof Error ? `${value.name}: ${value.message}`.slice(0, 200) : value;
  }
  console[level === 'info' ? 'log' : level](JSON.stringify(out));
}
