import type { Context, MiddlewareHandler } from 'hono';
import type { Env } from '../../../index.js';
import { buildCookie } from '../../../middleware/auth.js';
import { deny } from '../../../middleware/deny.js';
import type { AdminSameSite } from '../../../middleware/admin-auth-config.js';
import {
  hashTenantAdminSessionToken,
  isPlatformAdminSessionToken,
} from '../provisioning/credentials.js';

// Deliberately separate from every tenant-admin cookie/table. A platform
// admin is not scoped to any tenant, so it must never be reachable through,
// or confusable with, a tenant-admin session.
export const PLATFORM_ADMIN_AUTH_COOKIE = 'lh_platform_admin_session';
export const PLATFORM_ADMIN_CSRF_COOKIE = 'lh_platform_admin_csrf';
export const PLATFORM_ADMIN_CSRF_HEADER = 'x-platform-admin-csrf-token';

const SESSION_MAX_AGE = 604800; // 7 days, matching tenant-admin sessions.
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export type AuthenticatedPlatformAdmin = {
  id: string;
  name: string;
};

type PlatformAdminSessionRow = {
  staff_id: string;
  name: string;
  must_change_password: number;
  credential_version: number;
  session_kind: 'bootstrap' | 'standard';
};

function parseCookieHeader(cookieHeader: string | undefined): Record<string, string> {
  if (!cookieHeader) return {};
  const cookies: Record<string, string> = {};
  for (const part of cookieHeader.split(';')) {
    const [rawName, ...rawValue] = part.trim().split('=');
    if (!rawName) continue;
    try {
      cookies[rawName] = decodeURIComponent(rawValue.join('=') || '');
    } catch {
      cookies[rawName] = rawValue.join('=') || '';
    }
  }
  return cookies;
}

export function platformAdminSessionTokenFromCookie(c: Context<Env>): string | null {
  return parseCookieHeader(c.req.header('Cookie'))[PLATFORM_ADMIN_AUTH_COOKIE] || null;
}

export function platformAdminCsrfTokenFromCookie(c: Context<Env>): string | null {
  return parseCookieHeader(c.req.header('Cookie'))[PLATFORM_ADMIN_CSRF_COOKIE] || null;
}

/**
 * The token hash identifying the request's session — the same value stored in
 * platform_admin_sessions.token_hash. Support-mode grants are bound to it so
 * a second live session for the same admin cannot ride along on a grant it
 * never re-authenticated for.
 *
 * Re-derived from the cookie rather than carried on the context: the
 * `platformAdmin` context variable is declared as `{ id, name }` in
 * apps/worker/src/index.ts, and widening a shared context key to smuggle one
 * value through is a worse trade than a second SHA-256 of a 43-character
 * token. Callers run behind platformAdminAuthMiddleware, which has already
 * proved this token resolves to a live session.
 */
export async function platformAdminSessionHash(c: Context<Env>): Promise<string | null> {
  const token = platformAdminSessionTokenFromCookie(c);
  if (!token || !isPlatformAdminSessionToken(token)) return null;
  return hashTenantAdminSessionToken(token);
}

// Scoped to /api/platform-admin, not site-wide: the browser then never
// attaches this cookie to any other same-origin request (tenant-admin API
// calls, static assets, etc.), narrowing the blast radius of any future
// same-origin script-injection bug even though Path scoping alone cannot
// stop a script that deliberately targets this exact prefix.
const PLATFORM_ADMIN_COOKIE_PATH = '/api/platform-admin';

export function platformAdminSessionCookie(token: string, sameSite: AdminSameSite): string {
  return buildCookie(PLATFORM_ADMIN_AUTH_COOKIE, token, sameSite, SESSION_MAX_AGE, true, PLATFORM_ADMIN_COOKIE_PATH);
}

export function platformAdminCsrfCookie(token: string, sameSite: AdminSameSite): string {
  return buildCookie(PLATFORM_ADMIN_CSRF_COOKIE, token, sameSite, SESSION_MAX_AGE, false, PLATFORM_ADMIN_COOKIE_PATH);
}

export function expiredPlatformAdminCookie(name: string, sameSite: AdminSameSite): string {
  return buildCookie(name, '', sameSite, 0, name === PLATFORM_ADMIN_AUTH_COOKIE, PLATFORM_ADMIN_COOKIE_PATH);
}

/**
 * Resolves a platform-admin session cookie to an identity. Unlike tenant
 * auth there is no selector to reconcile — a platform admin has exactly one
 * scope: every tenant. must_change_password gates everything except the
 * password-change endpoint itself, same as tenant-admin bootstrap sessions.
 */
export async function resolvePlatformAdminSession(
  db: D1Database,
  token: string,
): Promise<{ admin: AuthenticatedPlatformAdmin; mustChangePassword: boolean } | null> {
  if (!isPlatformAdminSessionToken(token)) return null;
  try {
    const tokenHash = await hashTenantAdminSessionToken(token);
    const now = new Date().toISOString();
    const row = await db.prepare(
      `SELECT credential.staff_id, staff.name,
              credential.must_change_password, credential.credential_version,
              session.session_kind
         FROM platform_admin_sessions AS session
         INNER JOIN platform_admin_credentials AS credential
                 ON credential.staff_id = session.staff_id
                AND credential.credential_version = session.credential_version
         INNER JOIN platform_admins AS admin
                 ON admin.staff_id = credential.staff_id AND admin.is_active = 1
         INNER JOIN staff_members AS staff
                 ON staff.id = credential.staff_id AND staff.is_active = 1
        WHERE session.token_hash = ?
          AND session.revoked_at IS NULL
          AND session.expires_at > ?
        LIMIT 1`,
    ).bind(tokenHash, now).first<PlatformAdminSessionRow>();
    if (!row) return null;
    const mustChangePassword = row.must_change_password === 1;
    if ((row.session_kind === 'bootstrap') !== mustChangePassword) return null;
    return {
      admin: { id: row.staff_id, name: row.name },
      mustChangePassword,
    };
  } catch {
    return null;
  }
}

/**
 * Gates every /api/platform-admin/* route. Deliberately does not fall back
 * to any tenant-admin or PLATFORM_ADMIN_KEY mechanism — a platform admin is
 * its own identity with its own audit trail.
 */
export const platformAdminAuthMiddleware: MiddlewareHandler<Env> = async (c, next) => {
  // Set before any early return so it lands on 401/403 bodies too. This
  // middleware is mounted once on /api/platform-admin/* (see index.ts), so
  // putting it here covers every router under that prefix — including
  // dashboard-routes.ts and operations-routes.ts, which are separate Hono
  // instances — and a future router cannot be added without inheriting it.
  c.header('Cache-Control', 'no-store, private');

  const path = new URL(c.req.url).pathname;
  if (path === '/api/platform-admin/login') return next();

  const token = platformAdminSessionTokenFromCookie(c);
  if (!token) return deny(c, 401, 'platform_admin_session_missing', 'Unauthorized');

  const resolved = await resolvePlatformAdminSession(c.env.DB, token);
  if (!resolved) return deny(c, 401, 'platform_admin_session_invalid', 'Unauthorized');

  if (!SAFE_METHODS.has(c.req.method.toUpperCase())) {
    const header = c.req.header(PLATFORM_ADMIN_CSRF_HEADER);
    const expected = platformAdminCsrfTokenFromCookie(c);
    if (!header || !expected || header !== expected) {
      return deny(c, 403, 'platform_admin_csrf_mismatch', 'CSRF token mismatch');
    }
  }

  if (resolved.mustChangePassword &&
      path !== '/api/platform-admin/session' &&
      path !== '/api/platform-admin/change-password' &&
      path !== '/api/platform-admin/logout') {
    return deny(c, 403, 'platform_admin_password_change_required', 'Password change required');
  }

  c.set('platformAdmin', resolved.admin);
  return next();
};
