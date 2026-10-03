import type { Context, Next } from 'hono';
import type { Env } from '../index.js';

/**
 * Baseline security headers on every response — deny framing, disable MIME
 * sniffing, cap referrer leaks. The same rules are shipped to the Pages apps
 * via their public/_headers files.
 *
 * Routes with stricter needs (e.g. the myna redirect sets
 * Referrer-Policy: no-referrer and CSP default-src 'none') set their own
 * values first and are preserved.
 */
export async function securityHeadersMiddleware(c: Context<Env>, next: Next): Promise<void> {
  await next();
  const headers = c.res.headers;
  if (!headers.has('X-Frame-Options')) headers.set('X-Frame-Options', 'DENY');
  if (!headers.has('Content-Security-Policy')) headers.set('Content-Security-Policy', "frame-ancestors 'none'");
  if (!headers.has('X-Content-Type-Options')) headers.set('X-Content-Type-Options', 'nosniff');
  if (!headers.has('Referrer-Policy')) headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
}
