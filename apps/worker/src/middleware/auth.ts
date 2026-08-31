import type { Context, Next } from 'hono';
import { getStaffByApiKey } from '@line-crm/db';
import type { Env } from '../index.js';
import type { AdminSameSite } from './admin-auth-config.js';
import { buildCookie } from './cookie.js';
import {
  hashTenantAdminSessionToken,
  isPlatformAdminSessionToken,
  isTenantAdminSessionToken,
} from '../custom/pharmacy/provisioning/credentials.js';
import { sameText } from '../custom/pharmacy/provisioning/line-credentials.js';
import { resolvePlatformAdminSession } from '../custom/pharmacy/platform-admin/auth.js';
import { recordPlatformAdminAccess } from '../custom/pharmacy/platform-admin/audit.js';
import { isPlatformTenantSettingsPath } from '../custom/pharmacy/platform-admin/settings-scope.js';
import { deny } from './deny.js';

export const ADMIN_AUTH_COOKIE = 'lh_admin_session';
export const TENANT_COOKIE = 'lh_tenant';
export const CSRF_COOKIE = 'lh_csrf';
export const CSRF_HEADER = 'x-csrf-token';
export const TENANT_HEADER = 'x-tenant-id';

// 7 days, matching the previous localStorage session longevity.
const SESSION_MAX_AGE = 604800;

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * decodeURIComponent throws on malformed percent escapes (e.g. `%`). Cookie
 * headers are client-controlled, so fall back to the raw value rather than
 * letting the exception turn a request into a 500.
 */
function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function parseCookieHeader(cookieHeader: string | undefined): Record<string, string> {
  if (!cookieHeader) return {};
  const cookies: Record<string, string> = {};
  for (const part of cookieHeader.split(';')) {
    const [rawName, ...rawValue] = part.trim().split('=');
    if (!rawName) continue;
    cookies[rawName] = safeDecode(rawValue.join('=') || '');
  }
  return cookies;
}

function bearerToken(c: Context<Env>): string | null {
  const authHeader = c.req.header('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
  return authHeader.slice('Bearer '.length);
}

export function adminSessionTokenFromCookie(c: Context<Env>): string | null {
  return parseCookieHeader(c.req.header('Cookie'))[ADMIN_AUTH_COOKIE] || null;
}

function tenantToken(c: Context<Env>): string | null {
  return parseCookieHeader(c.req.header('Cookie'))[TENANT_COOKIE] || null;
}

export function csrfTokenFromCookie(c: Context<Env>): string | null {
  return parseCookieHeader(c.req.header('Cookie'))[CSRF_COOKIE] || null;
}

export { buildCookie } from './cookie.js';

/** HttpOnly cookie carrying only an opaque password session. */
export function adminSessionCookie(token: string, sameSite: AdminSameSite): string {
  return buildCookie(ADMIN_AUTH_COOKIE, token, sameSite, SESSION_MAX_AGE, true);
}

/** HttpOnly tenant binding paired with the admin session credential. */
export function tenantSessionCookie(tenantId: string, sameSite: AdminSameSite): string {
  return buildCookie(TENANT_COOKIE, tenantId, sameSite, SESSION_MAX_AGE, true);
}

/**
 * CSRF cookie. NOT HttpOnly so it can participate in double-submit, but in a
 * cross-site topology the SPA cannot read it (different registrable domain) —
 * the token is therefore also returned in the login/session response body and
 * the SPA echoes it via the X-CSRF-Token header. The Worker validates that
 * header against this cookie, which the browser does send back to the API
 * (SameSite=None).
 */
export function csrfCookie(token: string, sameSite: AdminSameSite): string {
  return buildCookie(CSRF_COOKIE, token, sameSite, SESSION_MAX_AGE, false);
}

export function expiredCookie(name: string, sameSite: AdminSameSite): string {
  return buildCookie(
    name,
    '',
    sameSite,
    0,
    name === ADMIN_AUTH_COOKIE || name === TENANT_COOKIE,
  );
}

export type AuthenticatedStaff = {
  id: string;
  name: string;
  role: 'owner' | 'admin' | 'staff';
};

export type AuthenticatedTenant = {
  id: string;
  code: string;
  name: string;
};

export type TenantBoundIdentity = {
  staff: AuthenticatedStaff;
  tenant: AuthenticatedTenant;
};

type RequestIdentity = TenantBoundIdentity & {
  authMethod: 'api_key' | 'password';
  credentialVersion: number | null;
  mustChangePassword: boolean;
};

async function resolvePlatformAdminTenant(
  db: D1Database,
  selector: string | null | undefined,
): Promise<AuthenticatedTenant | null> {
  const normalized = selector?.trim();
  if (!normalized) return null;
  try {
    const tenant = await db.prepare(
      `SELECT id, tenant_code, display_name
         FROM tenants
        WHERE status = 'active' AND (id = ? OR tenant_code = ? COLLATE NOCASE)
        LIMIT 1`,
    ).bind(normalized, normalized).first<{
      id: string;
      tenant_code: string;
      display_name: string;
    }>();
    return tenant ? { id: tenant.id, code: tenant.tenant_code, name: tenant.display_name } : null;
  } catch {
    return null;
  }
}

/**
 * Resolve and authorize the tenant independently of the request selector.
 * The selector chooses a tenant; membership remains the authority.
 */
export async function resolveAuthenticatedTenant(
  db: D1Database,
  staff: AuthenticatedStaff,
  selector: string | null | undefined,
): Promise<TenantBoundIdentity | null> {
  const normalized = selector?.trim();
  if (!normalized) return null;
  try {
    const tenant = await db.prepare(
      `SELECT tenant.id, tenant.tenant_code, tenant.display_name,
              EXISTS (
                SELECT 1
                  FROM tenant_line_accounts AS mapping
                 WHERE mapping.tenant_id = tenant.id
              ) AS pharmacy_mode
         FROM tenants AS tenant
        WHERE status = 'active' AND (id = ? OR tenant_code = ? COLLATE NOCASE)
        LIMIT 1`,
    ).bind(normalized, normalized).first<{
      id: string;
      tenant_code: string;
      display_name: string;
      pharmacy_mode: number;
    }>();
    if (!tenant) return null;

    const membership = await db.prepare(
      `SELECT role
         FROM tenant_staff_memberships
        WHERE tenant_id = ? AND staff_id = ? AND is_active = 1
        LIMIT 1`,
    ).bind(tenant.id, staff.id).first<{ role: AuthenticatedStaff['role'] }>();
    if (!membership) return null;
    return {
      staff: { ...staff, role: membership.role },
      tenant: { id: tenant.id, code: tenant.tenant_code, name: tenant.display_name },
    };
  } catch {
    return null;
  }
}

function setTenantIdentity(c: Context<Env>, identity: RequestIdentity): void {
  c.set('staff', identity.staff);
  c.set('tenantId', identity.tenant.id);
  c.set('tenantCode', identity.tenant.code);
  c.set('tenantName', identity.tenant.name);
  c.set('authMethod', identity.authMethod);
  c.set('credentialVersion', identity.credentialVersion);
  c.set('mustChangePassword', identity.mustChangePassword);
}

async function authenticateOpaqueSession(
  c: Context<Env>,
  token: string,
): Promise<RequestIdentity | null> {
  try {
    const tokenHash = await hashTenantAdminSessionToken(token);
    const now = new Date().toISOString();
    const row = await c.env.DB.prepare(
      `SELECT tenant.id, tenant.tenant_code, tenant.display_name,
              credential.staff_id, credential.must_change_password,
              credential.credential_version, staff.name, membership.role,
              session.session_kind
         FROM tenant_admin_sessions AS session
         INNER JOIN tenant_admin_credentials AS credential
                 ON credential.tenant_id = session.tenant_id
                AND credential.staff_id = session.staff_id
                AND credential.credential_version = session.credential_version
         INNER JOIN tenants AS tenant
                 ON tenant.id = credential.tenant_id AND tenant.status = 'active'
         INNER JOIN staff_members AS staff
                 ON staff.id = credential.staff_id AND staff.is_active = 1
         INNER JOIN tenant_staff_memberships AS membership
                 ON membership.tenant_id = credential.tenant_id
                AND membership.staff_id = credential.staff_id
                AND membership.is_active = 1
        WHERE session.token_hash = ?
          AND session.revoked_at IS NULL
          AND session.expires_at > ?
        LIMIT 1`,
    ).bind(tokenHash, now).first<{
      id: string;
      tenant_code: string;
      display_name: string;
      staff_id: string;
      name: string;
      role: AuthenticatedStaff['role'];
      must_change_password: number;
      credential_version: number;
      session_kind: 'bootstrap' | 'standard';
    }>();
    if (!row || tenantToken(c) !== row.id) return null;
    const mustChangePassword = row.must_change_password === 1;
    if ((row.session_kind === 'bootstrap') !== mustChangePassword) return null;
    return {
      staff: { id: row.staff_id, name: row.name, role: row.role },
      tenant: { id: row.id, code: row.tenant_code, name: row.display_name },
      authMethod: 'password',
      credentialVersion: row.credential_version,
      mustChangePassword,
    };
  } catch {
    return null;
  }
}

async function authenticateRequest(
  c: Context<Env>,
  bearer: string | null,
  cookie: string | null,
): Promise<RequestIdentity | null> {
  if (!bearer) {
    return cookie && isTenantAdminSessionToken(cookie)
      ? authenticateOpaqueSession(c, cookie)
      : null;
  }

  if (isPlatformAdminSessionToken(bearer)) {
    const path = new URL(c.req.url).pathname;
    if (!isPlatformTenantSettingsPath(c.req.method, path)) return null;
    const [resolved, tenant] = await Promise.all([
      resolvePlatformAdminSession(c.env.DB, bearer),
      resolvePlatformAdminTenant(c.env.DB, c.req.header(TENANT_HEADER)),
    ]);
    if (!resolved || resolved.mustChangePassword || !tenant) return null;
    c.set('platformAdmin', resolved.admin);
    await recordPlatformAdminAccess(
      c.env.DB,
      resolved.admin.id,
      tenant.id,
      'tenant_settings_cli_request',
      'api_path',
      path,
      { method: c.req.method.toUpperCase() },
    );
    return {
      staff: { id: resolved.admin.id, name: resolved.admin.name, role: 'owner' },
      tenant,
      authMethod: 'api_key',
      credentialVersion: null,
      mustChangePassword: false,
    };
  }

  const staff = await authenticateApiToken(c, bearer);
  if (!staff) return null;
  const identity = await resolveAuthenticatedTenant(
    c.env.DB,
    staff,
    c.req.header(TENANT_HEADER),
  );
  return identity ? {
    ...identity,
    authMethod: 'api_key',
    credentialVersion: null,
    mustChangePassword: false,
  } : null;
}

/**
 * Resolve a Bearer integration token to a staff identity.
 */
export async function authenticateApiToken(
  c: Context<Env>,
  token: string | null,
): Promise<AuthenticatedStaff | null> {
  if (!token) return null;

  const staff = await getStaffByApiKey(c.env.DB, token, c.env.STAFF_API_KEY_HASH_SECRET);
  if (staff) {
    return { id: staff.id, name: staff.name, role: staff.role };
  }

  // Fallback: env API_KEY acts as owner (current rotation slot)
  if (sameText(token, c.env.API_KEY)) {
    return { id: 'env-owner', name: 'Owner', role: 'owner' };
  }

  // Legacy fallback: LEGACY_API_KEY accepted during rotation grace period.
  // Same-value guard: if both env vars are set to the same secret, the primary
  // check above already accepts it; this branch must skip to avoid false
  // LEGACY counters. Logs accept_via=LEGACY_API_KEY so operators can confirm
  // zero legacy usage before deleting the secret.
  if (
    c.env.LEGACY_API_KEY &&
    c.env.LEGACY_API_KEY !== c.env.API_KEY &&
    sameText(token, c.env.LEGACY_API_KEY)
  ) {
    console.log('[auth] accept_via=LEGACY_API_KEY');
    return { id: 'env-owner', name: 'Owner', role: 'owner' };
  }

  return null;
}

export async function authMiddleware(c: Context<Env>, next: Next): Promise<Response | void> {
  // Skip auth for the LINE webhook endpoint — it uses signature verification instead
  // Skip auth for OpenAPI docs — public documentation
  const path = new URL(c.req.url).pathname;
  // LIFF / admin の SPA アセットは Authorization ヘッダなしで HTML を取りに
  // くる。Worker は API 以外のパスを ASSETS バインディングから配信するので、
  // /api/ で始まらないパスは認証 skip して static asset として返す。
  // (admin は別ホスト、Worker の non-API path はすべて LIFF/SPA 経由)
  const method = c.req.method.toUpperCase();
  if (!path.startsWith('/api/')) {
    // ただし内部用エンドポイント (/webhook, /auth, /setup) は元の skip 判定に任せる
    if (
      path !== '/webhook' &&
      !path.startsWith('/auth/') &&
      path !== '/setup' &&
      !path.startsWith('/t/') &&
      !path.startsWith('/r/') &&
      !path.startsWith('/pool/') &&
      !path.startsWith('/images/')
    ) {
      return next();
    }
  }

  // A form definition is public because the LIFF client must render it before
  // submission. Authenticate opportunistically so the same GET can still
  // return the full admin representation to SDK/admin callers, while an
  // unauthenticated LIFF caller receives the redacted public representation.
  // Crucially, this exception is method-aware: PUT/DELETE on the same path
  // must continue through the normal admin authentication below.
  const isPublicFormDefinition =
    method === 'GET' && /^\/api\/forms\/[^/]+$/.test(path);
  if (isPublicFormDefinition) {
    const identity = await authenticateRequest(c, bearerToken(c), adminSessionTokenFromCookie(c));
    if (identity && !identity.mustChangePassword) setTenantIdentity(c, identity);
    return next();
  }

  // These LIFF actions perform their own LINE ID-token verification inside
  // the route. They cannot use the admin auth gate because their Bearer token
  // is a LINE ID token, not a Harness staff API key.
  const isPublicFormAction =
    method === 'POST' &&
    (/^\/api\/forms\/[^/]+\/submit$/.test(path) ||
      /^\/api\/forms\/[^/]+\/opened$/.test(path) ||
      /^\/api\/forms\/[^/]+\/partial$/.test(path));
  if (isPublicFormAction) return next();

  // custom:pharmacy-prescriptions — these routes verify the LINE ID token
  // themselves. Keep the exception method-aware so adding another route under
  // this namespace cannot silently bypass staff authentication.
  const isPrescriptionPatientAction =
    (method === 'POST' && path === '/api/liff/pharmacy/prescriptions') ||
    (method === 'GET' && path === '/api/liff/pharmacy/prescriptions/me') ||
    (method === 'PUT' && /^\/api\/liff\/pharmacy\/prescriptions\/[^/]+\/files\/[^/]+$/.test(path)) ||
    (method === 'POST' && /^\/api\/liff\/pharmacy\/prescriptions\/[^/]+\/(submit|cancel|resubmission|arrival)$/.test(path));
  if (isPrescriptionPatientAction) return next();

  // custom:pharmacy-intake — patient profiles and intake revisions verify the
  // LINE ID token in their route middleware, just like prescription uploads.
  const isPharmacyIntakePatientAction =
    path === '/api/liff/pharmacy/patients' && (method === 'GET' || method === 'POST') ||
    /^\/api\/liff\/pharmacy\/patients\/[^/]+(\/intake|\/archive)?$/.test(path) &&
      (method === 'GET' || method === 'POST' || method === 'PATCH');
  if (isPharmacyIntakePatientAction) return next();

  // custom:pharmacy-myna — the handoff and self-report routes verify the
  // LINE ID token in their own middleware; admin verification remains staff-authenticated.
  const isMynaPatientAction =
    (method === 'POST' && path === '/api/liff/pharmacy/myna-handoffs') ||
    (method === 'GET' && path === '/api/liff/pharmacy/myna-handoffs/active') ||
    (method === 'POST' && /^\/api\/liff\/pharmacy\/myna-handoffs\/[^/]+\/(launch|patient-report)$/.test(path));
  if (isMynaPatientAction) return next();

  // custom:pharmacy-continuity — the patient view verifies the LINE ID token
  // in its route middleware; the admin collection remains staff-authenticated.
  const isContinuityPatientAction =
    (method === 'GET' && path === '/api/liff/pharmacy/continuity') ||
    (method === 'POST' && /^\/api\/liff\/pharmacy\/continuity\/[^/]+\/pause$/.test(path)) ||
    (method === 'POST' && /^\/api\/liff\/pharmacy\/continuity\/expectations\/[^/]+\/respond$/.test(path));
  if (isContinuityPatientAction) return next();

  // custom:pharmacy-follow-up/emergency-contraception — patient actions use
  // the same route-level LINE identity verification as the LIFF routes above.
  const isMedicationFollowUpPatientAction =
    (method === 'GET' && path === '/api/liff/pharmacy/medication-followups') ||
    (method === 'POST' && /^\/api\/liff\/pharmacy\/medication-followups\/[^/]+\/respond$/.test(path));
  const isEmergencyContraceptionPatientAction =
    (method === 'GET' && path === '/api/liff/pharmacy/emergency-contraception') ||
    (method === 'POST' && path === '/api/liff/pharmacy/emergency-contraception/intakes') ||
    (method === 'POST' && /^\/api\/liff\/pharmacy\/emergency-contraception\/intakes\/[^/]+\/cancel$/.test(path));
  const isPublicProfilePatientAction =
    method === 'GET' && (
      path === '/api/liff/pharmacy/public-profile' ||
      path === '/api/liff/pharmacy/privacy-policy' ||
      path === '/api/liff/pharmacy/feature-access'
    );
  if (isMedicationFollowUpPatientAction || isEmergencyContraceptionPatientAction || isPublicProfilePatientAction) return next();

  if (
    path === '/webhook' ||
    path === '/docs' ||
    path === '/openapi.json' ||
    path === '/api/affiliates/click' ||
    path.startsWith('/t/') ||
    path.startsWith('/r/') ||
    path.startsWith('/pool/') ||
    path.startsWith('/images/') ||
    (path.startsWith('/api/liff/') && !path.startsWith('/api/liff/pharmacy/')) ||
    // Admin login/logout — issue/clear the session cookie before auth exists.
    path === '/api/auth/login' ||
    path === '/api/auth/logout' ||
    // Platform CLI provisioning authenticates with PLATFORM_ADMIN_KEY in-route.
    (path === '/api/platform/pharmacy/tenants' && method === 'POST') ||
    (path === '/api/platform/pharmacy/platform-admins' && method === 'POST') ||
    (method === 'POST' &&
      /^\/api\/platform\/pharmacy\/tenants\/[^/]+\/admin-bootstrap$/.test(path)) ||
    (method === 'POST' &&
      /^\/api\/platform\/pharmacy\/tenants\/[^/]+\/cli-sessions(?:\/[^/]+\/revoke)?$/.test(path)) ||
    (method === 'POST' &&
      /^\/api\/platform\/pharmacy\/tenants\/[^/]+\/line-accounts\/[^/]+\/credentials\/(?:backfill|scrub|restore)$/.test(path)) ||
    (method === 'POST' &&
      /^\/api\/platform\/pharmacy\/tenants\/[^/]+\/line-accounts\/[^/]+\/intake-encryption\/(?:coverage|backfill|freeze|scrub|restore)$/.test(path)) ||
    path.startsWith('/auth/') ||
    path === '/setup' ||
    path === '/api/integrations/stripe/webhook' ||
    path.match(/^\/api\/webhooks\/incoming\/[^/]+\/receive$/) ||
    // Google OAuth redirects without admin headers. Route verifies a signed, expiring state.
    (path === '/api/booking/google-calendar/oauth/callback' && method === 'GET') ||
    path === '/api/qr' || // Public QR proxy — used by desktop landing pages
    path === '/api/health' || // Liveness probe (update CLI / self-update verify)
    // Public lead form. Origin validation and field validation happen in-route.
    (path === '/api/public/media-inquiries' && method === 'POST') ||
    // Platform-admin routes authenticate against their own, entirely
    // separate session cookie/table via platformAdminAuthMiddleware — see
    // custom/pharmacy/platform-admin/auth.ts. A tenant-admin session must
    // never grant access here, so this is a blanket prefix skip, not a
    // method-aware exception like the PHI patient routes above.
    path.startsWith('/api/platform-admin/')
  ) {
    return next();
  }

  const bearer = bearerToken(c);
  const cookie = adminSessionTokenFromCookie(c);
  const identity = await authenticateRequest(c, bearer, cookie);
  if (!identity) {
    return deny(c, 401, 'Unauthorized');
  }

  // CSRF protection applies ONLY to cookie-authenticated, state-changing
  // requests. Bearer callers (SDK/MCP) cannot be driven cross-site by a
  // browser (an attacker cannot set the Authorization header), so they are
  // exempt. Safe methods (GET/HEAD/OPTIONS) never mutate, so they are exempt.
  if (!bearer && cookie && !SAFE_METHODS.has(c.req.method.toUpperCase())) {
    const header = c.req.header(CSRF_HEADER);
    const expected = csrfTokenFromCookie(c);
    if (!header || !expected || header !== expected) {
      return deny(c, 403, 'csrf_mismatch', 'CSRF token mismatch');
    }
  }

  if (identity.mustChangePassword &&
      path !== '/api/auth/session' && path !== '/api/auth/change-password') {
    return deny(c, 403, 'password_change_required', 'Password change required');
  }

  setTenantIdentity(c, identity);
  return next();
}
